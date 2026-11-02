/**
 * Social Intelligence System - Unified Public API
 *
 * This is the main entry point for the Social Intelligence System.
 * It orchestrates conversation detection, semantic analysis, relationship mapping,
 * and enrichment pipelines.
 *
 * Usage:
 *   const socialIntelligence = new SocialIntelligence(postgresManager);
 *   await socialIntelligence.processMessage(message); // Called by LiveEventSync
 *   const conversations = await socialIntelligence.getConversations(channelId); // Called by AI tools
 */

import type { Message } from "discord.js";
import type { PostgreSQLManager } from "../../database/PostgreSQLManager";
import type {
	StreamingConversation,
	FinalizedConversation,
	ConversationQueryOptions,
	SemanticSearchOptions,
	ConversationFeatures,
	KeywordScore,
} from "./types";

// Import components
import { ConversationDetector } from "./conversation-detection/ConversationDetector";
import { RelationshipMapper } from "./relationship-mapping/RelationshipMapper";
import { KeywordExtractor } from "./semantic-analysis/KeywordExtractor";
import { EmbeddingService } from "./semantic-analysis/EmbeddingService";

/**
 * Main orchestrator for Social Intelligence System
 *
 * Provides a unified API for:
 * - Processing Discord messages (real-time)
 * - Querying conversations (streaming + finalized)
 * - Querying relationships (live view)
 * - Semantic search
 */
export class SocialIntelligence {
	private db: PostgreSQLManager;

	// Component instances
	private conversationDetector: ConversationDetector;
	private relationshipMapper: RelationshipMapper;
	private keywordExtractor: KeywordExtractor;
	private embeddingService: EmbeddingService;

	constructor(db: PostgreSQLManager) {
		this.db = db;

		// Initialize components
		this.conversationDetector = new ConversationDetector(db);
		this.relationshipMapper = new RelationshipMapper(db);
		this.keywordExtractor = new KeywordExtractor(db);
		this.embeddingService = EmbeddingService.getInstance();
	}

	// ============================================================================
	// REAL-TIME MESSAGE PROCESSING (Called by LiveEventSync)
	// ============================================================================

	/**
	 * Process a Discord message through the Social Intelligence pipeline
	 *
	 * Flow:
	 * 1. Track interaction edges (relationship mapping)
	 * 2. Buffer message for conversation detection
	 * 3. Create/update streaming conversation if applicable
	 * 4. Extract preliminary keywords (fast TF-IDF)
	 *
	 * @param message Discord message
	 */
	async processMessage(message: Message): Promise<void> {
		if (!message.guildId || !message.channelId) {
			return;
		}

		const author = message.author;
		if (!author || author.bot) {
			// Skip bot authored content for social graph + conversation detection
			return;
		}

		const guildId = message.guildId;
		const channelId = message.channelId;
		const authorId = author.id;
		const timestamp = message.createdAt ?? new Date();
		const content = message.content || "";

		const mentionedUserIds = Array.from(message.mentions.users.values())
			.filter((user) => !user.bot && user.id !== authorId)
			.map((user) => user.id);

		// Track mention interactions first for affinity context
		await Promise.all(
			mentionedUserIds.map((mentionedId) =>
				this.recordInteractionAndQueue(
					guildId,
					authorId,
					mentionedId,
					"mention",
					"a_to_b",
					timestamp
				)
			)
		);

		// Buffer message for conversation detection (streaming + finalization)
		try {
			await this.conversationDetector.addMessageToStream({
				id: message.id,
				author_id: authorId,
				content,
				created_at: timestamp,
				guild_id: guildId,
				channel_id: channelId,
				referenced_message_id: message.reference?.messageId || undefined,
				mentioned_user_ids: mentionedUserIds,
			});
		} catch (error) {
			console.error(
				`[SocialIntelligence] Failed to buffer message ${message.id}:`,
				error
			);
		}

		await this.handleReplyInteractions(message, timestamp);
		await this.handleProximityInteractions(message, timestamp);
	}

	private async handleReplyInteractions(
		message: Message,
		timestamp: Date
	): Promise<void> {
		if (!message.guildId || !message.reference?.messageId || !message.author) {
			return;
		}

		try {
			const referencedMessage = await message.channel.messages.fetch(
				message.reference.messageId
			);
			const repliedAuthor = referencedMessage?.author;
			if (
				referencedMessage &&
				repliedAuthor &&
				!repliedAuthor.bot &&
				repliedAuthor.id !== message.author.id
			) {
				await this.recordInteractionAndQueue(
					message.guildId,
					message.author.id,
					repliedAuthor.id,
					"reply",
					"a_to_b",
					timestamp
				);
			}

			if (
				referencedMessage?.reference?.messageId &&
				referencedMessage.reference.messageId !== message.reference.messageId
			) {
				try {
					const originalMessage = await message.channel.messages.fetch(
						referencedMessage.reference.messageId
					);
					const originalAuthor = originalMessage?.author;
					if (
						originalAuthor &&
						!originalAuthor.bot &&
						originalAuthor.id !== message.author.id &&
						originalAuthor.id !== repliedAuthor?.id
					) {
						await this.recordInteractionAndQueue(
							message.guildId,
							message.author.id,
							originalAuthor.id,
							"message",
							"a_to_b",
							timestamp
						);
					}
				} catch {
					// Nested reference may no longer exist
				}
			}
		} catch {
			// Ignore missing referenced messages
		}
	}

	private async handleProximityInteractions(
		message: Message,
		timestamp: Date
	): Promise<void> {
		if (!message.guildId || !message.channelId || !message.author) {
			return;
		}

		const recentMessages = await this.getRecentChannelMessages(
			message.guildId,
			message.channelId,
			10
		);

		for (const otherMsg of recentMessages) {
			if (
				otherMsg.author_id === message.author.id ||
				Math.abs(timestamp.getTime() - otherMsg.created_at.getTime()) > 30_000
			) {
				continue;
			}

			await this.recordInteractionAndQueue(
				message.guildId,
				message.author.id,
				otherMsg.author_id,
				"message",
				"a_to_b",
				timestamp
			);
		}
	}

	// ============================================================================
	// CONVERSATION QUERIES (Called by AI tools)
	// ============================================================================

	/**
	 * Get conversations for a channel
	 *
	 * Returns both streaming (active) and finalized conversations by default.
	 * Streaming conversations have preliminary keywords/embeddings.
	 * Finalized conversations have full enrichment (hybrid keywords, AI labels).
	 *
	 * @param channelId Channel ID
	 * @param options Query options
	 * @returns Array of conversations (streaming + finalized)
	 */
	async getConversations(
		channelId: string,
		options?: ConversationQueryOptions
	): Promise<Array<StreamingConversation | FinalizedConversation>> {
		const opts: ConversationQueryOptions = {
			includeStreaming: true,
			includeFinalized: true,
			...options,
		};

		const conditions: string[] = ["cu.channel_id = $1"];
		const params: any[] = [channelId];
		let paramIndex = 2;

		if (!opts.includeStreaming && opts.includeFinalized) {
			conditions.push("cu.is_streaming = false");
		} else if (opts.includeStreaming && !opts.includeFinalized) {
			conditions.push("cu.is_streaming = true");
		}

		if (opts.minMessages) {
			conditions.push(`cu.message_count >= $${paramIndex}`);
			params.push(opts.minMessages);
			paramIndex++;
		}

		if (opts.startDate) {
			conditions.push(`cu.start_time >= $${paramIndex}`);
			params.push(opts.startDate);
			paramIndex++;
		}

		if (opts.endDate) {
			conditions.push(`cu.end_time <= $${paramIndex}`);
			params.push(opts.endDate);
			paramIndex++;
		}

		if (opts.participants && opts.participants.length > 0) {
			conditions.push(`cu.participants @> $${paramIndex}::TEXT[]`);
			params.push(opts.participants);
			paramIndex++;
		}

		const query = `
			SELECT
				cu.*,
				sc.created_at AS streaming_created_at,
				sc.updated_at AS streaming_updated_at,
				cs.created_at AS finalized_created_at,
				cs.updated_at AS finalized_updated_at
			FROM conversations_unified cu
			LEFT JOIN streaming_conversations sc
				ON cu.is_streaming = true AND sc.id = cu.id
			LEFT JOIN conversation_segments cs
				ON cu.is_streaming = false AND cs.id = cu.id
			WHERE ${conditions.join(" AND ")}
			ORDER BY cu.start_time DESC
			LIMIT 200
		`;

		const result = await this.db.query(query, params);
		if (!result.success || !result.data) {
			return [];
		}

		return result.data
			.map((row: any) => this.mapUnifiedConversation(row))
			.filter(
				(
					conv: StreamingConversation | FinalizedConversation | null
				): conv is StreamingConversation | FinalizedConversation => Boolean(conv)
			);
	}

	/**
	 * Get a specific conversation by ID
	 *
	 * Checks streaming_conversations first, then conversation_segments.
	 *
	 * @param conversationId Conversation ID
	 * @returns Conversation or null
	 */
	async getConversation(
		conversationId: string
	): Promise<StreamingConversation | FinalizedConversation | null> {
		const result = await this.db.query(
			`
			SELECT
				cu.*,
				sc.created_at AS streaming_created_at,
				sc.updated_at AS streaming_updated_at,
				cs.created_at AS finalized_created_at,
				cs.updated_at AS finalized_updated_at
			FROM conversations_unified cu
			LEFT JOIN streaming_conversations sc
				ON cu.is_streaming = true AND sc.id = cu.id
			LEFT JOIN conversation_segments cs
				ON cu.is_streaming = false AND cs.id = cu.id
			WHERE cu.id = $1
			LIMIT 1
		`,
			[conversationId]
		);

		if (!result.success || !result.data || result.data.length === 0) {
			return null;
		}

		return this.mapUnifiedConversation(result.data[0]) ?? null;
	}

	/**
	 * Search conversations by semantic similarity
	 *
	 * Uses embedding cosine similarity + keyword matching.
	 * Searches both streaming and finalized conversations.
	 *
	 * @param query Search query (natural language)
	 * @param guildId Guild ID
	 * @param options Search options
	 * @returns Ranked conversation results
	 */
	async searchConversationsByTopic(
		query: string,
		guildId: string,
		options?: SemanticSearchOptions
	): Promise<Array<StreamingConversation | FinalizedConversation>> {
		const opts: SemanticSearchOptions = {
			includeStreaming: true,
			minSimilarity: 0.3,
			limit: 20,
			...options,
		};

		const baseConditions: string[] = ["cu.guild_id = $1"];
		const params: any[] = [guildId];

		if (opts.includeStreaming === false) {
			baseConditions.push("cu.is_streaming = false");
		}

		const candidateLimit = Math.max((opts.limit ?? 20) * 5, 50);
		const querySql = `
			SELECT
				cu.*,
				sc.created_at AS streaming_created_at,
				sc.updated_at AS streaming_updated_at,
				cs.created_at AS finalized_created_at,
				cs.updated_at AS finalized_updated_at
			FROM conversations_unified cu
			LEFT JOIN streaming_conversations sc
				ON cu.is_streaming = true AND sc.id = cu.id
			LEFT JOIN conversation_segments cs
				ON cu.is_streaming = false AND cs.id = cu.id
			WHERE ${baseConditions.join(" AND ")}
			ORDER BY cu.end_time DESC NULLS LAST, cu.start_time DESC
			LIMIT ${candidateLimit}
		`;

		const dbResult = await this.db.query(querySql, params);
		if (!dbResult.success || !dbResult.data || dbResult.data.length === 0) {
			return [];
		}

		const rows = dbResult.data;
		const queryEmbedding = await this.embeddingService.generateEmbedding(query);
		const queryTokens = query
			.toLowerCase()
			.split(/\s+/)
			.filter((token) => token.trim().length > 2);

		const rowsNeedingEmbedding: Array<{ row: any; text: string }> = [];
		for (const row of rows) {
			if (!row.embedding) {
				const text = this.buildConversationSearchText(row);
				if (text.trim().length > 0) {
					rowsNeedingEmbedding.push({ row, text });
				}
			}
		}

		if (rowsNeedingEmbedding.length > 0) {
			const embeddings = await this.embeddingService.generateBatch(
				rowsNeedingEmbedding.map((entry) => entry.text)
			);
			rowsNeedingEmbedding.forEach((entry, index) => {
				entry.row.embedding = embeddings[index];
			});
		}

		const scoredCandidates: Array<
			{ score: number; similarity: number; row: any } | null
		> = rows.map((row: any) => {
			const embedding = this.ensureNumberArray(row.embedding);
			if (!embedding || embedding.length === 0) {
				return null;
			}

			const similarity = this.cosineSimilarity(queryEmbedding, embedding);
			const keywordBoost = this.computeKeywordBoost(
				queryTokens,
				this.buildConversationSearchText(row)
			);
			const score = similarity + keywordBoost;

			return {
				score,
				similarity,
				row,
			};
		});

		const scored = scoredCandidates
			.filter(
				(
					entry
				): entry is { score: number; similarity: number; row: any } =>
					Boolean(entry && entry.score >= (opts.minSimilarity ?? 0.3))
			)
			.sort(
				(
					a: { score: number; similarity: number; row: any },
					b: { score: number; similarity: number; row: any }
				) => b.score - a.score
			)
			.slice(0, opts.limit ?? 20);

		return scored
			.map((entry) => this.mapUnifiedConversation(entry.row))
			.filter(
				(
					conv: StreamingConversation | FinalizedConversation | null
				): conv is StreamingConversation | FinalizedConversation => Boolean(conv)
			);
	}

	// ============================================================================
	// SEMANTIC ANALYSIS (Called by AI tools or enrichment pipeline)
	// ============================================================================

	/**
	 * Extract keywords from text
	 *
	 * Uses hybrid TF-IDF + semantic clustering by default.
	 *
	 * @param messages Array of messages
	 * @param guildId Guild ID
	 * @param method Extraction method (default: "hybrid")
	 * @returns Array of keyword scores
	 */
	async extractKeywords(
		messages: Array<{ id: string; content: string; author_id: string }>,
		guildId: string,
		method: "tfidf" | "semantic" | "hybrid" = "hybrid"
	): Promise<KeywordScore[]> {
		if (messages.length === 0) {
			return [];
		}

		const keywordMessages = messages.map((message) => ({
			id: message.id,
			content: message.content || "",
			author_id: message.author_id,
		}));

			try {
				const keywords = await this.keywordExtractor.extractKeywords(
					keywordMessages,
					guildId,
					{ method, topN: 12 }
				);

				return this.coerceKeywordScores(keywords.terms || []);
			} catch (error) {
			console.error("[SocialIntelligence] Keyword extraction failed:", error);
			return [];
		}
	}

	/**
	 * Generate embedding for text
	 *
	 * Uses local transformer model (Xenova/all-mpnet-base-v2).
	 *
	 * @param text Text to embed
	 * @returns 768-dimensional embedding vector
	 */
	async generateEmbedding(text: string): Promise<number[]> {
		return this.embeddingService.generateEmbedding(text);
	}

	// ============================================================================
	// ENRICHMENT PIPELINE (Background tasks)
	// ============================================================================

	/**
	 * Enrich a conversation with AI-generated topic labels and summaries
	 *
	 * @param conversationId Conversation ID
	 * @returns Updated conversation
	 */
	async enrichConversation(conversationId: string): Promise<void> {
		const conversationResult = await this.db.query(
			`
			SELECT
				id,
				guild_id,
				channel_id,
				start_time,
				end_time,
				message_ids,
				message_count,
				participants,
				features,
				summary
			FROM conversation_segments
			WHERE id = $1
			LIMIT 1
		`,
			[conversationId]
		);

		if (!conversationResult.success || !conversationResult.data || conversationResult.data.length === 0) {
			throw new Error(`Conversation ${conversationId} not found`);
		}

		const conversation = conversationResult.data[0];
		const guildId: string = conversation.guild_id;
		const channelId: string = conversation.channel_id;
		const messageIds = this.ensureArray<string>(conversation.message_ids);

		let keywordScores: KeywordScore[] = [];
		if (messageIds.length > 0) {
			const messagesResult = await this.db.query(
				`
				SELECT id, author_id, content
				FROM messages
				WHERE id = ANY($1::TEXT[])
				ORDER BY created_at ASC
			`,
				[messageIds]
			);

			if (messagesResult.success && messagesResult.data) {
				const keywordMessages = messagesResult.data.map((row: any) => ({
					id: row.id,
					content: row.content || "",
					author_id: row.author_id,
				}));

					const keywords = await this.keywordExtractor.extractKeywords(
						keywordMessages,
						guildId,
						{ method: "hybrid", topN: 12 }
					);

					keywordScores = this.coerceKeywordScores(keywords.terms || []);

					// Log if no keywords extracted
					if (keywordScores.length === 0) {
						console.warn(
							`[SocialIntelligence] No keywords extracted for conversation ${conversationId} ` +
							`(${keywordMessages.length} messages, method: ${keywords.method})`
						);
					}
			}
		}

		// Summary should only be set if it already exists (generated by LLM)
		// Don't create fallback summaries - they should be null until LLM generates them
		const summary = conversation.summary || null;

		const nextFeatures = {
			...(this.parseJSON<Record<string, any>>(conversation.features) || {}),
			keywords: keywordScores,
		};

		// Update features and processing status
		// Only update summary if it's not null (has been generated by LLM)
		if (summary !== null) {
			await this.db.query(
				`
				UPDATE conversation_segments
				SET
					features = $2,
					summary = $3,
					ai_processing_status = 'completed',
					ai_processed_at = NOW()
				WHERE id = $1
			`,
				[conversationId, JSON.stringify(nextFeatures), summary]
			);
		} else {
			await this.db.query(
				`
				UPDATE conversation_segments
				SET
					features = $2,
					ai_processing_status = 'completed',
					ai_processed_at = NOW()
				WHERE id = $1
			`,
				[conversationId, JSON.stringify(nextFeatures)]
			);
		}
	}

	/**
	 * Build guild vocabulary for TF-IDF keyword extraction
	 *
	 * Analyzes all finalized conversations to build IDF scores.
	 *
	 * @param guildId Guild ID
	 */
	async buildGuildVocabulary(guildId: string): Promise<void> {
		await this.keywordExtractor.buildVocabulary(guildId);
	}

	// ============================================================================
	// UTILITIES
	// ============================================================================

	/**
	 * Get statistics for monitoring
	 *
	 * Returns counts of streaming conversations, finalized conversations,
	 * relationship edges, and vocabulary terms.
	 */
	async getStats(guildId: string): Promise<{
		streaming_conversations: number;
		finalized_conversations: number;
		relationship_edges: number;
		vocabulary_terms: number;
	}> {
		// TODO: Implement stats query
		const streamingResult = await this.db.query(
			"SELECT COUNT(*) as count FROM streaming_conversations WHERE guild_id = $1 AND status = 'active'",
			[guildId]
		);
		const finalizedResult = await this.db.query(
			"SELECT COUNT(*) as count FROM conversation_segments WHERE guild_id = $1 AND status = 'finalized'",
			[guildId]
		);
		const edgesResult = await this.db.query(
			"SELECT COUNT(*) as count FROM relationship_edges WHERE guild_id = $1",
			[guildId]
		);
		const vocabResult = await this.db.query(
			"SELECT COUNT(*) as count FROM guild_vocabulary WHERE guild_id = $1",
			[guildId]
		);

		return {
			streaming_conversations:
				streamingResult.success && streamingResult.data
					? parseInt(streamingResult.data[0].count, 10)
					: 0,
			finalized_conversations:
				finalizedResult.success && finalizedResult.data
					? parseInt(finalizedResult.data[0].count, 10)
					: 0,
			relationship_edges:
				edgesResult.success && edgesResult.data
					? parseInt(edgesResult.data[0].count, 10)
					: 0,
			vocabulary_terms:
				vocabResult.success && vocabResult.data
					? parseInt(vocabResult.data[0].count, 10)
					: 0,
		};
	}

	private async recordInteractionAndQueue(
		guildId: string,
		authorId: string,
		otherId: string,
		kind: "message" | "mention" | "reply" | "reaction",
		direction: "a_to_b" | "b_to_a",
		timestamp: Date
	): Promise<void> {
		try {
			await this.relationshipMapper.recordInteraction(
				guildId,
				authorId,
				otherId,
				kind,
				direction,
				timestamp
			);
		} catch (error) {
			console.error(
				`[SocialIntelligence] Failed to record ${kind} interaction for ${authorId} -> ${otherId}:`,
				error
			);
		}
	}

	private async getRecentChannelMessages(
		guildId: string,
		channelId: string,
		limit: number
	): Promise<Array<{ author_id: string; created_at: Date; id: string }>> {
		const result = await this.db.query(
			`
			SELECT author_id, created_at, id
			FROM messages
			WHERE guild_id = $1 AND channel_id = $2
			ORDER BY created_at DESC
			LIMIT $3
		`,
			[guildId, channelId, limit]
		);

		if (!result.success || !result.data) {
			return [];
		}

		return result.data.map((row: any) => ({
			author_id: row.author_id,
			created_at: new Date(row.created_at),
			id: row.id,
		}));
	}

	private mapUnifiedConversation(
		row: any
	): StreamingConversation | FinalizedConversation | null {
		if (!row) {
			return null;
		}

		return row.is_streaming
			? this.mapStreamingConversation(row)
			: this.mapFinalizedConversation(row);
	}

	private mapStreamingConversation(row: any): StreamingConversation {
		const status: StreamingConversation["status"] =
			row.status === "finalizing" ? "finalizing" : "active";

		return {
			id: row.id,
			guild_id: row.guild_id,
			channel_id: row.channel_id,
			participants: this.ensureArray<string>(row.participants),
			message_ids: this.ensureArray<string>(row.message_ids),
			message_count: Number(row.message_count) || 0,
			start_time: new Date(row.start_time),
			last_activity: new Date(
				row.end_time || row.streaming_updated_at || row.start_time
			),
			status,
			preliminary_keywords: this.normalizeKeywords(row.keywords),
			preliminary_embedding: this.ensureNumberArray(row.embedding),
			created_at: row.streaming_created_at
				? new Date(row.streaming_created_at)
				: new Date(row.start_time),
			updated_at: row.streaming_updated_at
				? new Date(row.streaming_updated_at)
				: new Date(row.end_time || row.start_time),
		};
	}

	private mapFinalizedConversation(row: any): FinalizedConversation {
		const features =
			this.parseJSON<ConversationFeatures>(row.features) ||
			(row.features as ConversationFeatures) ||
			({});

		return {
			id: row.id,
			guild_id: row.guild_id,
			channel_id: row.channel_id,
			participants: this.ensureArray<string>(row.participants),
			message_ids: this.ensureArray<string>(row.message_ids),
			message_count: Number(row.message_count) || 0,
			start_time: new Date(row.start_time),
			end_time: new Date(row.end_time || row.start_time),
			status: "finalized",
			features: features,
			summary: row.summary || undefined,
			ai_processing_status: row.ai_processing_status || undefined,
			ai_metadata: row.ai_metadata || undefined,
		};
	}

	private coerceKeywordScores(rawScores: any[]): KeywordScore[] {
		return rawScores
			.map((item: any) => {
				const word = item?.word || item?.term || "";
				if (!word) {
					return null;
				}

				const scoreValue =
					typeof item?.score === "number"
						? item.score
						: typeof item?.tfidf === "number"
						? item.tfidf
						: Number(item?.tfidf) || 0;

				const keyword: KeywordScore = {
					word,
					score: scoreValue,
					type: this.normalizeKeywordType(item?.type),
				};

				const frequency = item?.count ?? item?.frequency;
				if (typeof frequency === "number") {
					keyword.frequency = frequency;
				}

				return keyword;
			})
			.filter((item): item is KeywordScore => Boolean(item));
	}

	private normalizeKeywordType(type: unknown): KeywordScore["type"] {
		return type === "semantic" || type === "tfidf" ? type : "hybrid";
	}

	private normalizeKeywords(value: any): KeywordScore[] {
		if (!value) {
			return [];
		}

		const parsedArray =
			(Array.isArray(value) ? value : undefined) ||
			this.parseJSON<any[]>(value) ||
			(Array.isArray(value?.terms) ? value.terms : undefined);

		if (!Array.isArray(parsedArray)) {
			return [];
		}

		return this.coerceKeywordScores(parsedArray);
	}

	private parseJSON<T>(value: any): T | undefined {
		if (!value) {
			return undefined;
		}
		if (typeof value === "object") {
			return value as T;
		}
		if (typeof value === "string") {
			try {
				return JSON.parse(value) as T;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	private ensureArray<T>(value: any): T[] {
		if (Array.isArray(value)) {
			return value as T[];
		}
		if (value === null || value === undefined) {
			return [];
		}
		if (typeof value === "string") {
			if (value.startsWith("{") && value.endsWith("}")) {
				return value
					.slice(1, -1)
					.split(",")
					.map((entry) => entry.replace(/"/g, "").trim())
					.filter(Boolean) as T[];
			}

			try {
				const parsed = JSON.parse(value);
				return Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				return value ? ([value] as T[]) : [];
			}
		}

		return [value as T];
	}

	private ensureNumberArray(value: any): number[] | undefined {
		if (!value) {
			return undefined;
		}

		const arrayValue = Array.isArray(value) ? value : this.parseJSON<any[]>(value);
		if (!Array.isArray(arrayValue)) {
			return undefined;
		}

		const numbers = arrayValue.map((num) => Number(num)).filter((num) => Number.isFinite(num));
		return numbers.length > 0 ? numbers : undefined;
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length === 0 || b.length === 0 || a.length !== b.length) {
			return 0;
		}

		let dot = 0;
		let aNorm = 0;
		let bNorm = 0;

		for (let i = 0; i < a.length; i++) {
			dot += a[i]! * b[i]!;
			aNorm += a[i]! * a[i]!;
			bNorm += b[i]! * b[i]!;
		}

		if (aNorm === 0 || bNorm === 0) {
			return 0;
		}

		return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
	}

	private buildConversationSearchText(row: any): string {
		const keywords = this.normalizeKeywords(row.keywords)
			.map((k) => k.word)
			.join(" ");
		const summary = row.summary || "";
		return [summary, keywords].filter(Boolean).join(" | ");
	}

	private computeKeywordBoost(tokens: string[], haystack: string): number {
		if (tokens.length === 0 || !haystack) {
			return 0;
		}

		const lowerHaystack = haystack.toLowerCase();
		let matches = 0;
		for (const token of tokens) {
			if (lowerHaystack.includes(token)) {
				matches++;
			}
		}

		return Math.min(matches * 0.02, 0.1);
	}
}

// Export types for convenience
export * from "./types";

// Export workflow manager for bot initialization
export { ConversationWorkflowManager } from "./conversation-detection/ConversationWorkflowManager";
