/**
 * ConversationEnrichmentPipeline (Layer 3 enrichment)
 *
 * Enriches a conversation segment with:
 * - an AI-written summary and a short topic label (one structured call)
 * - a semantic embedding of the summary
 *
 * Budget checking, skipped semantics and retries live here; the segment itself is
 * produced by the deterministic segmenter.
 */

import { pgvector, type PostgreSQLManager } from "../../../../database/PostgreSQLManager.js";
import { type JsonObjectSchema, OmpRuntime } from "../../../../ai/runtime/OmpRuntime";
import { SLUR_PATTERN } from "../../../user-personas/personaPrompt";
import { ENRICHMENT_SYSTEM_PROMPT } from "../enrichmentPrompt";
import { EmbeddingService } from "../../semantic-analysis/EmbeddingService.js";
import { EnrichmentRateLimiter } from "../EnrichmentRateLimiter";

const SLUR_MASK = new RegExp(SLUR_PATTERN.source, "gi");

const SUMMARY_SCHEMA: JsonObjectSchema = {
	type: "object",
	properties: {
		summary: {
			type: "string",
			description: "1-2 concise sentences stating the key topics/actions directly",
		},
		topic_label: {
			type: "string",
			description:
				"2-5 words naming the subject, e.g. 'A Plague Tale' or \"JOHNNY's work suspension\"",
		},
	},
	required: ["summary", "topic_label"],
};

interface WrittenSummary {
	summary: string;
	topic_label: string;
}

interface GeneratedSummary {
	summary: string;
	topicLabel: string;
}

interface PreviewMessage {
	author_id: string;
	content: string | null;
	attachments: string[] | null;
	embeds: string[] | null;
}

export interface EnrichmentResult {
	success: boolean;
	summary?: string;
	topicLabel?: string;
	embedding?: number[];
	significance: number;
	confidence: number;
	error?: string;
	/** True when there is nothing to enrich (segment gone, messages deleted); retrying cannot help */
	skipped?: boolean;
}

export class ConversationEnrichmentPipeline {
	private db: PostgreSQLManager;
	private rateLimiter: EnrichmentRateLimiter;
	private embeddingService: EmbeddingService;

	constructor(db: PostgreSQLManager) {
		this.db = db;
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

			// Sample messages for preview, attributed by author name
			const names = await this.loadNames(guildId, messages, segment.participants);
			const messagePreview = this.buildMessagePreview(this.sampleMessages(messages), names);

			const generated = await this.generateSummary(
				messages.length,
				participantCount,
				messagePreview,
			);

			if (!generated) {
				return {
					success: false,
					significance,
					confidence: 0,
					error: "Failed to generate summary",
				};
			}
			const { summary, topicLabel } = generated;

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

			const updateResult = await this.db.query(
				`
				UPDATE conversation_segments
				SET summary = $2,
					topic_label = $3,
					embedding = COALESCE($4::vector, embedding),
					enrichment_version = $5,
					last_enriched_at = NOW(),
					enrichment_confidence = $6,
					ai_processing_status = 'completed',
					ai_processed_at = NOW()
				WHERE id = $1
				RETURNING id
				`,
				[
					conversationId,
					summary,
					topicLabel,
					embedding ? pgvector.toSql(embedding) : null,
					enrichmentVersion,
					confidence,
				],
			);

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
				topicLabel,
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
	): number {
		let score = 0;
		if (participantCount >= 3) score += 0.5;
		if (participantCount >= 5) score += 0.2; // Bonus for larger groups
		if (messageCount >= 10) score += 0.3;
		return Math.min(1.0, score);
	}

	/**
	 * Display names for the authors and participants of a segment
	 */
	private async loadNames(
		guildId: string,
		messages: PreviewMessage[],
		participants: unknown,
	): Promise<Map<string, string>> {
		const ids = new Set<string>(messages.map((m) => m.author_id));
		if (Array.isArray(participants)) for (const p of participants) ids.add(String(p));
		const result = await this.db.query(
			`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
			 FROM members WHERE guild_id = $1 AND user_id = ANY($2::TEXT[])`,
			[guildId, [...ids]],
		);
		if (!result.success) throw new Error(`failed to read member names: ${result.error}`);
		const names = new Map<string, string>();
		for (const row of result.data ?? []) names.set(String(row.user_id), String(row.name));
		return names;
	}

	/**
	 * Sample messages for preview (beginning, middle, end)
	 */
	private sampleMessages(messages: PreviewMessage[]): PreviewMessage[] {
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
	private buildMessagePreview(sampledMessages: PreviewMessage[], names: Map<string, string>): string {
		const scrub = (text: string): string =>
			text
				.replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.get(id) ?? "someone"}`)
				.replace(SLUR_MASK, "[slur]");
		return sampledMessages
			.map((m) => {
				const author = scrub(names.get(m.author_id) ?? "Unknown");
				const content = (m.content || "").trim();
				// Skip bot commands
				if (content.match(/^(m!|!|\.)\w+/i)) {
					return `${author}: (bot command)`;
				}

				// Check for attachments and embeds
				const hasAttachments =
					m.attachments && Array.isArray(m.attachments) && m.attachments.length > 0;
				const hasEmbeds = m.embeds && Array.isArray(m.embeds) && m.embeds.length > 0;

				let mediaPlaceholder = "";
				if (hasAttachments || hasEmbeds) {
					const allUrls = [
						...(hasAttachments ? (m.attachments ?? []) : []),
						...(hasEmbeds
							? (m.embeds ?? [])
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

				return `${author}: ${scrub(fullContent)}`;
			})
			.join("\n")
			.substring(0, 3000);
	}

	/**
	 * Generate summary using AI
	 */
	private async generateSummary(
		messageCount: number,
		participantCount: number,
		messagePreview: string,
	): Promise<GeneratedSummary | null> {
		const prompt = `Summarize this Discord conversation. Return a "summary" (1-2 concise sentences stating the key topics/actions directly) and a "topic_label" (2-5 words naming the subject, e.g. "A Plague Tale", "JOHNNY's work suspension").

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
5. Refer to people by the names shown before each line; never use Discord user IDs like <@123456>
6. IGNORE bot commands (lines marked as "(bot command)")
7. Start directly with the content - no meta-commentary like "The conversation was about..."
8. If there is a conflict or repeated grievance, you MUST capture it explicitly
9. When multiple topics appear, emphasize the ones that span the most messages or have emotional weight (arguments, complaints, requests)
10. The topic_label names the dominant subject (a game, event, person's situation), not a generic activity like "chatting" or "banter"

Conversation (${messageCount} messages, ${participantCount} participants):
${messagePreview}

Each line is "Name: message".`;

		// Retry logic for rate limits
		const isRateLimit = (message: string): boolean => {
			const lower = message.toLowerCase();
			return lower.includes("429") || lower.includes("quota") || lower.includes("rate limit");
		};

		let retries = 3;

		while (retries > 0) {
			let failure = "";
			try {
				const written = await OmpRuntime.get().generateStructured<WrittenSummary>({
					systemPrompt: ENRICHMENT_SYSTEM_PROMPT,
					prompt,
					schema: SUMMARY_SCHEMA,
					label: "enrichment.conversation-summary",
				});
				const summary = written?.summary?.trim();
				const topicLabel = written?.topic_label?.trim();
				if (summary && topicLabel) {
					return { summary, topicLabel };
				}
				failure = "no structured summary submitted";
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}

			if (!isRateLimit(failure)) {
				break;
			}
			retries--;
			if (retries > 0) {
				const waitTime = 10000; // Wait 10 seconds
				console.log(`⏳ Rate limit hit, waiting ${waitTime / 1000}s before retry...`);
				await new Promise((resolve) => setTimeout(resolve, waitTime));
			}
		}

		return null;
	}
}

