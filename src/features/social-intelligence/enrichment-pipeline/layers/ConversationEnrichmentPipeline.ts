/**
 * ConversationEnrichmentPipeline (Layer 1)
 *
 * Enriches conversation segments with:
 * - AI-generated summaries
 * - Semantic embeddings
 * - Topic keywords
 * - Media detection
 *
 * Extracted from EnhancementOrchestrator with budget checking and enrichment tracking.
 */

import { pgvector, type PostgreSQLManager } from "../../../../database/PostgreSQLManager.js";
import type { AIEngine } from "../../../../ai/core/AIEngine";
import type { AIResponse } from "../../../../ai/providers/base/AIProvider";
import { AIRequestBuilder } from "../../../../ai/core/AIRequestBuilder";
import { AIContextBuilder } from "../../../../ai/core/AIContext.js";
import { EmbeddingService } from "../../semantic-analysis/EmbeddingService.js";
import { EnrichmentRateLimiter } from "../EnrichmentRateLimiter";

const SUMMARY_STOP_WORDS = new Set([
	"the", "and", "but", "that", "with", "for", "you", "your", "are", "was", "were",
	"this", "have", "has", "had", "about", "from", "they", "their", "them", "what",
	"when", "where", "how", "why", "there", "then", "just", "like", "that's", "thats",
	"aint", "dont", "didnt", "doesnt", "cant", "im", "ive", "ill", "its", "lol",
]);

export interface EnrichmentResult {
	success: boolean;
	summary?: string;
	embedding?: number[];
	significance: number;
	confidence: number;
	error?: string;
	/** True when there is nothing to enrich (segment gone, messages deleted); retrying cannot help */
	skipped?: boolean;
}

export class ConversationEnrichmentPipeline {
	private db: PostgreSQLManager;
	private aiEngine: AIEngine;
	private rateLimiter: EnrichmentRateLimiter;
	private embeddingService: EmbeddingService;

	constructor(db: PostgreSQLManager, aiEngine: AIEngine) {
		this.db = db;
		this.aiEngine = aiEngine;
		this.rateLimiter = EnrichmentRateLimiter.getInstance();
		this.embeddingService = EmbeddingService.getInstance();
	}

	/**
	 * Enrich a conversation segment
	 */
	async enrichConversation(
		conversationId: string,
		guildId: string,
	): Promise<EnrichmentResult> {
		try {
			// Fetch conversation segment
			const segmentResult = await this.db.query(
				`
				SELECT 
					id, 
					channel_id, 
					message_ids, 
					start_time, 
					end_time, 
					message_count,
					participants,
					enrichment_version,
					last_enriched_at
				FROM conversation_segments
				WHERE id = $1 AND guild_id = $2
				`,
				[conversationId, guildId],
			);

			if (!segmentResult.success) {
				throw new Error(`failed to read segment: ${segmentResult.error}`);
			}
			if (!segmentResult.data || segmentResult.data.length === 0) {
				return {
					success: false,
					significance: 0,
					confidence: 0,
					error: "Conversation segment not found",
					skipped: true,
				};
			}

			const segment = segmentResult.data[0];

			// Fetch messages
			const messagesResult = await this.db.query(
				`
				SELECT id, author_id, content, created_at, attachments, embeds
				FROM messages
				WHERE id = ANY($1::TEXT[])
				ORDER BY created_at ASC
				`,
				[segment.message_ids],
			);

			if (!messagesResult.success) {
				throw new Error(`failed to read messages: ${messagesResult.error}`);
			}
			if (!messagesResult.data || messagesResult.data.length === 0) {
				await this.markSkipped(conversationId, "no messages found for segment");
				return {
					success: false,
					significance: 0,
					confidence: 0,
					error: "No messages found for conversation",
					skipped: true,
				};
			}

			const messages = messagesResult.data;
			const participantCount = Array.isArray(segment.participants)
				? segment.participants.length
				: 0;

			// Calculate significance
			const significance = this.calculateSignificance(
				participantCount,
				messages.length,
				undefined, // TODO: Extract keywords from segment.features
			);

			// Estimate cost and check budget
			const costEstimate = this.rateLimiter.estimateConversationCost(messages.length);
			const canAfford = await this.rateLimiter.canAffordEnrichment(
				costEstimate.estimatedCost,
			);

			if (!canAfford.canAfford) {
				return {
					success: false,
					significance,
					confidence: 0,
					error: canAfford.reason || "Budget exceeded",
					// Not a failure: the segment stays 'pending' and the backlog sweep re-queues it later
					skipped: true,
				};
			}

			// Extract topic hints
			const topicHintText = this.extractTopicHints(messages);

			// Sample messages for preview
			const sampledMessages = this.sampleMessages(messages);
			const messagePreview = this.buildMessagePreview(sampledMessages);

			// Generate summary using AI
			const summary = await this.generateSummary(
				guildId,
				messages.length,
				participantCount,
				messagePreview,
				topicHintText,
			);

			if (!summary) {
				return {
					success: false,
					significance,
					confidence: 0,
					error: "Failed to generate summary",
				};
			}

			// Generate embedding
			let embedding: number[] | null = null;
			try {
				embedding = await this.embeddingService.generateEmbedding(summary);
			} catch (error) {
				console.warn(
					`⚠️  Failed to generate embedding for conversation ${conversationId.slice(0, 8)}: ${error}`,
				);
			}

			// Calculate confidence based on message count and participant count
			const confidence = Math.min(
				1.0,
				0.5 + (messages.length / 50) * 0.3 + (participantCount / 10) * 0.2,
			);

			// Update database with enrichment metadata
			const enrichmentVersion = (segment.enrichment_version || 0) + 1;

			let updateResult;
			if (embedding) {
				updateResult = await this.db.query(
					`
					UPDATE conversation_segments
					SET summary = $2,
						embedding = $3::vector,
						enrichment_version = $4,
						last_enriched_at = NOW(),
						enrichment_confidence = $5,
						ai_processing_status = 'completed',
						ai_processed_at = NOW()
					WHERE id = $1
					RETURNING id
					`,
					[conversationId, summary, pgvector.toSql(embedding), enrichmentVersion, confidence],
				);
			} else {
				updateResult = await this.db.query(
					`
					UPDATE conversation_segments
					SET summary = $2,
						enrichment_version = $3,
						last_enriched_at = NOW(),
						enrichment_confidence = $4,
						ai_processing_status = 'completed',
						ai_processed_at = NOW()
					WHERE id = $1
					RETURNING id
					`,
					[conversationId, summary, enrichmentVersion, confidence],
				);
			}

			if (!updateResult.success) {
				throw new Error(`failed to save conversation: ${updateResult.error}`);
			}
			if (!updateResult.data?.length) {
				// Segment was merged/deleted while the LLM call was in flight
				return {
					success: false,
					significance,
					confidence: 0,
					error: "Conversation segment disappeared before save",
					skipped: true,
				};
			}

			// Track actual cost (approximate)
			await this.rateLimiter.trackCost(costEstimate.estimatedCost, "conversation");

			return {
				success: true,
				summary,
				embedding: embedding || undefined,
				significance,
				confidence,
			};
		} catch (error) {
			console.error(
				`❌ Error enriching conversation ${conversationId.slice(0, 8)}:`,
				error,
			);
			return {
				success: false,
				significance: 0,
				confidence: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Mark a segment as permanently not enrichable so it is not re-queued forever
	 */
	private async markSkipped(conversationId: string, reason: string): Promise<void> {
		const result = await this.db.query(
			`
			UPDATE conversation_segments
			SET ai_processing_status = 'skipped',
				ai_metadata = COALESCE(ai_metadata, '{}'::jsonb) || jsonb_build_object(
					'skip_reason', $2::text,
					'skipped_at', NOW()
				)
			WHERE id = $1
			`,
			[conversationId, reason],
		);
		if (!result.success) {
			throw new Error(`failed to mark conversation skipped: ${result.error}`);
		}
	}

	/**
	 * Calculate significance score (0-1)
	 */
	private calculateSignificance(
		participantCount: number,
		messageCount: number,
		keywords?: string[],
	): number {
		let score = 0;
		if (participantCount >= 3) score += 0.5;
		if (participantCount >= 5) score += 0.2; // Bonus for larger groups
		if (messageCount >= 10) score += 0.3;
		if (keywords && keywords.length > 0) score += 0.2;
		return Math.min(1.0, score);
	}

	/**
	 * Extract topic hints from messages
	 */
	private extractTopicHints(messages: any[]): string {
		const termCounts = new Map<string, number>();

		for (const rawMessage of messages) {
			const content = (rawMessage.content || "")
				.toLowerCase()
				.replace(/https?:\/\/\S+/g, " ")
				.replace(/[^\w@#]+/g, " ");

			const tokens = content.split(/\s+/);
			for (const token of tokens) {
				const normalized = token.trim();
				if (!normalized || normalized.length < 3) continue;
				if (SUMMARY_STOP_WORDS.has(normalized)) continue;
				termCounts.set(normalized, (termCounts.get(normalized) || 0) + 1);
			}
		}

		const topTerms = Array.from(termCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);

		return topTerms.map(([term, count]) => `${term} (${count})`).join(", ");
	}

	/**
	 * Sample messages for preview (beginning, middle, end)
	 */
	private sampleMessages(messages: any[]): any[] {
		if (messages.length <= 30) {
			return messages;
		}

		// Take first 10, middle 10, last 10
		const start = messages.slice(0, 10);
		const middleIndex = Math.floor(messages.length / 2) - 5;
		const middle = messages.slice(middleIndex, middleIndex + 10);
		const end = messages.slice(-10);
		return [...start, ...middle, ...end];
	}

	/**
	 * Build message preview with media detection
	 */
	private buildMessagePreview(sampledMessages: any[]): string {
		return sampledMessages
			.map((m: any) => {
				const content = (m.content || "").trim();
				// Skip bot commands
				if (content.match(/^(m!|!|\.)\w+/i)) {
					return "(bot command)";
				}

				// Check for attachments and embeds
				const hasAttachments =
					m.attachments && Array.isArray(m.attachments) && m.attachments.length > 0;
				const hasEmbeds = m.embeds && Array.isArray(m.embeds) && m.embeds.length > 0;

				let mediaPlaceholder = "";
				if (hasAttachments || hasEmbeds) {
					const allUrls = [
						...(hasAttachments ? m.attachments : []),
						...(hasEmbeds
							? m.embeds
									.map((e: string) => {
										try {
											const embed = JSON.parse(e);
											return (
												embed.url ||
												embed.thumbnail?.url ||
												embed.image?.url ||
												embed.video?.url
											);
										} catch {
											return null;
										}
									})
									.filter(Boolean)
							: []),
					];

					const hasVideo = allUrls.some(
						(url: string) =>
							/\.(mp4|webm|mov|avi|mkv|gifv)$/i.test(url) ||
							/youtube\.com|youtu\.be|vimeo\.com|twitch\.tv/i.test(url) ||
							/tenor\.com/i.test(url),
					);
					const hasImage = allUrls.some(
						(url: string) =>
							/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url) ||
							/i\.imgur\.com|cdn\.discordapp\.com.*\.(jpg|jpeg|png|gif|webp)/i.test(
								url,
							),
					);

					if (hasVideo) {
						mediaPlaceholder = " [posts video]";
					} else if (hasImage) {
						mediaPlaceholder = " [posts image]";
					} else {
						mediaPlaceholder = " [posts media]";
					}
				}

				const fullContent =
					content.length > 0
						? content + mediaPlaceholder
						: mediaPlaceholder
							? mediaPlaceholder.trim()
							: "(no text content)";

				return fullContent;
			})
			.join("\n")
			.substring(0, 3000);
	}

	/**
	 * Generate summary using AI
	 */
	private async generateSummary(
		guildId: string,
		messageCount: number,
		participantCount: number,
		messagePreview: string,
		topicHintText: string,
	): Promise<string | null> {
		const prompt = `Summarize this Discord conversation in 1-2 concise sentences. State the key topics/actions directly.

BAD EXAMPLES (DO NOT USE):
❌ "Discussed suggestive humor and innuendos..." (generic "discussed", euphemistic)
❌ "Talked about politics..." (vague "talked about")
❌ "Shared a YouTube link" (too vague, missing context)
❌ "Mentioned food and feelings" (passive "mentioned")
❌ "User <@886340655671046176> said..." (Discord user IDs)

GOOD EXAMPLES (USE THIS STYLE):
🔹 "Trump allegedly performed oral sex on Bill Clinton; Hitler had a micropenis; white supremacists struggling"
🔹 "Boyfriend getting halal food; recent meals included steak, rice, green beans, Hawaiian rolls"
🔹 "Invited to walk to gas station; jokingly called 'a bit gay'"
🔹 "Not invited to watch BattleBots; called friends 'fakes'"
🔹 "Shared flying fish video; joked about fish spinning"
🔹 "Joked about ejaculation ('nuttin'), putting it on someone's face; described 11lb processed ham as unnatural abhorrence"
🔹 "Flirting in public as turn-on; already met up for sex"
🔹 "Masturbation jokes, sexual positions, graphic descriptions; compared sex to Jason Statham's Transporter role"

RULES:
1. Use ACTIVE, SPECIFIC language - avoid generic verbs like "discussed", "talked about", "mentioned"
2. Use semicolons to separate multiple topics within the summary
3. For sexual/crude content: state it plainly (e.g., "joked about masturbation", "made crude sexual remarks")
4. Public figures (Trump, celebrities) CAN be mentioned by name
5. Avoid Discord user IDs like <@123456> or usernames
6. IGNORE bot commands (lines marked as "(bot command)")
7. Start directly with the content - no meta-commentary like "The conversation was about..."
8. Prioritize the dominant subject matter indicated by the top recurring terms below; if there's a conflict or repeated grievance, you MUST capture it explicitly
9. When multiple topics appear, emphasize the ones that span the most messages or have emotional weight (arguments, complaints, requests)

Conversation (${messageCount} messages, ${participantCount} participants):
${messagePreview}

Top recurring terms (by frequency): ${topicHintText || "none"}

Summary:`;

		// Try Grok first (better rate limits), fallback to Ollama
		let provider = "grok";
		if (!process.env.GROK_API_KEY) {
			if (process.env.OLLAMA_URL) {
				provider = "ollama";
			}
		}

		// Retry logic for rate limits
		let retries = 3;
		let lastError: Error | null = null;

		while (retries > 0) {
			try {
				const builder = new AIRequestBuilder(this.aiEngine);
				const ctx = new AIContextBuilder()
					.user("system-summarizer")
					.guild(guildId)
					.build();
				// Structured mode: the chat preset caps output at 60 tokens, truncating summaries.
				// The prompt asks for 1-2 sentences; 300 tokens is headroom, not a target.
				const result = await builder
					.blocking()
					.mode("structured")
					.maxTokens(300)
					.withContext(ctx)
					.provider(provider as "grok" | "ollama")
					.persona("casual")
					.withoutTools()
					.generate(prompt);

				const response = result as AIResponse;
				if (response.success && response.content) {
					return response.content.trim();
				}
				break;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				const errorMsg = lastError.message.toLowerCase();

				if (
					errorMsg.includes("429") ||
					errorMsg.includes("quota") ||
					errorMsg.includes("rate limit")
				) {
					retries--;
					if (retries > 0) {
						const waitTime = 10000; // Wait 10 seconds
						console.log(
							`⏳ Rate limit hit, waiting ${waitTime / 1000}s before retry...`,
						);
						await new Promise((resolve) => setTimeout(resolve, waitTime));
					}
				} else {
					break;
				}
			}
		}

		return null;
	}
}

