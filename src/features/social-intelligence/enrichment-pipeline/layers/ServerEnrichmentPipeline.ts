/**
 * ServerEnrichmentPipeline (Layer 4)
 *
 * Enriches guild/server summaries based on:
 * - Top conversations (by participant count, message count, recency)
 * - Top topics from conversation keywords
 * - Enriched relationship profiles
 * - Community structure analysis (optional, Phase 5)
 *
 * Throws on real failures so the enrichment queue records and retries them; returns false
 * for legitimate skips (no recent conversations, nothing new, over budget).
 */

import type { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import type { AIEngine } from "../../../../ai/core/AIEngine";
import type { AIResponse } from "../../../../ai/providers/base/AIProvider";
import { AIRequestBuilder } from "../../../../ai/core/AIRequestBuilder";
import { AIContextBuilder } from "../../../../ai/core/AIContext.js";
import { EnrichmentRateLimiter } from "../EnrichmentRateLimiter";
import {
	IncrementalEnrichment,
	type EnrichmentHistory,
} from "../utils/IncrementalEnrichment";

interface TopConversationRow {
	id: string;
	summary: string;
	participants: string[];
	message_count: number;
	start_time: Date;
	keywords: { terms?: Array<{ word?: string } | string> } | string[] | null;
}

interface RelationshipSummaryRow {
	user_a: string;
	user_b: string;
	summary: string | null;
	relationship_type: string | null;
}

interface TopicEntry {
	topic: string;
	frequency: number;
	trend: "up" | "stable" | "down";
}

/** Re-enrich an already summarized guild at least this often, even without new relationships */
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** New enriched relationships needed to refresh sooner than REFRESH_INTERVAL_MS */
const MIN_NEW_RELATIONSHIPS = 10;

export class ServerEnrichmentPipeline {
	private db: PostgreSQLManager;
	private aiEngine: AIEngine;
	private rateLimiter: EnrichmentRateLimiter;

	constructor(db: PostgreSQLManager, aiEngine: AIEngine) {
		this.db = db;
		this.aiEngine = aiEngine;
		this.rateLimiter = EnrichmentRateLimiter.getInstance();
	}

	/**
	 * Enrich guild summary.
	 * Returns true when guild_metadata was written, false when skipped (no recent
	 * conversations, nothing new, over budget). Throws on failure so the queue retries.
	 */
	async enrichGuild(guildId: string): Promise<boolean> {
		try {
			// Aggregate top conversations (last 7 days)
			const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

			const topConversationsResult = await this.db.query(
				`
				SELECT 
					cs.id,
					cs.summary,
					cs.participants,
					cs.message_count,
					cs.start_time,
					cs.features->'keywords' as keywords
				FROM conversation_segments cs
				WHERE cs.guild_id = $1
				AND cs.start_time >= $2
				AND cs.status = 'finalized'
				AND cs.ai_processing_status = 'completed'
				AND cs.summary IS NOT NULL
				ORDER BY 
					array_length(cs.participants, 1) DESC,
					cs.message_count DESC,
					cs.start_time DESC
				LIMIT 20
				`,
				[guildId, sevenDaysAgo],
			);
			if (!topConversationsResult.success) {
				throw new Error(`failed to read conversations: ${topConversationsResult.error}`);
			}

			const topConversations: TopConversationRow[] = topConversationsResult.data ?? [];
			if (topConversations.length === 0) {
				console.log(`   ℹ️  No recent conversations found for guild ${guildId}`);
				return false;
			}

			// Extract top topics from conversation keywords (weighted by recency)
			const topTopics = this.extractTopTopics(topConversations);

			// Enriched relationship profiles: newest 15 for context, true count for gating
			const relationshipsResult = await this.db.query(
				`
				SELECT 
					user_a,
					user_b,
					summary,
					relationship_type,
					COUNT(*) OVER () AS total_count
				FROM relationship_profiles
				WHERE guild_id = $1
				AND last_enriched_at IS NOT NULL
				ORDER BY last_enriched_at DESC
				LIMIT 15
				`,
				[guildId],
			);
			if (!relationshipsResult.success) {
				throw new Error(`failed to read relationships: ${relationshipsResult.error}`);
			}
			const topRelationships: RelationshipSummaryRow[] = relationshipsResult.data ?? [];
			const currentRelationshipCount = Number(relationshipsResult.data?.[0]?.total_count ?? 0);

			// Existing guild summary
			const existingResult = await this.db.query(
				`
				SELECT summary, enrichment_history, last_enriched_relationship_count, last_enriched_at
				FROM guild_metadata
				WHERE guild_id = $1
				`,
				[guildId],
			);
			if (!existingResult.success) {
				throw new Error(`failed to read guild metadata: ${existingResult.error}`);
			}
			const existing = existingResult.data?.[0] ?? null;
			const hasExistingSummary = Boolean(existing?.summary?.trim());

			if (hasExistingSummary) {
				const newRelationships =
					currentRelationshipCount - (existing?.last_enriched_relationship_count ?? 0);
				const lastEnrichedAt = existing?.last_enriched_at
					? new Date(existing.last_enriched_at).getTime()
					: 0;
				const stale = Date.now() - lastEnrichedAt >= REFRESH_INTERVAL_MS;
				if (newRelationships < MIN_NEW_RELATIONSHIPS && !stale) {
					console.log(
						`   ℹ️  Guild ${guildId} summary is fresh (${Math.max(0, newRelationships)} new relationships), skipping`,
					);
					return false;
				}
			}

			// Estimate cost and check budget
			const costEstimate = this.rateLimiter.estimateGuildCost(topConversations.length);
			const canAfford = await this.rateLimiter.canAffordEnrichment(
				costEstimate.estimatedCost,
			);
			if (!canAfford.canAfford) {
				console.warn(`⚠️  Cannot afford guild enrichment: ${canAfford.reason}`);
				return false;
			}

			let enrichmentHistory: EnrichmentHistory;

			if (hasExistingSummary) {
				const existingHistory = IncrementalEnrichment.parseHistory(existing?.enrichment_history);
				// Fall back to the stored summary as base when no usable history exists
				const baseSummary = existingHistory
					? IncrementalEnrichment.getCompositeSummary(existingHistory)
					: (existing?.summary ?? "");

				const contextRange = IncrementalEnrichment.timeContextRange(7);
				const newContext = this.buildGuildContext(topTopics, topRelationships, []);

				const deltaPrompt = IncrementalEnrichment.createDeltaPrompt(
					"guild",
					baseSummary,
					newContext,
					contextRange,
				);
				const delta = await this.generate(deltaPrompt, guildId, 400);

				enrichmentHistory = IncrementalEnrichment.appendDelta(
					existingHistory ?? IncrementalEnrichment.createHistory(baseSummary),
					contextRange,
					delta,
					0.85,
				);
			} else {
				const initialSummary = await this.generateInitialSummary(
					topTopics,
					topRelationships,
					[],
					guildId,
				);
				enrichmentHistory = IncrementalEnrichment.createHistory(initialSummary);
			}

			// Consolidate accumulated deltas into a fresh base summary when needed
			if (IncrementalEnrichment.needsConsolidation(enrichmentHistory)) {
				const consolidationPrompt = IncrementalEnrichment.createConsolidationPrompt(
					"guild",
					enrichmentHistory,
				);
				const consolidated = await this.generate(consolidationPrompt, guildId, 500);
				enrichmentHistory = IncrementalEnrichment.consolidate(consolidated);
			}

			const guildSummary = IncrementalEnrichment.getCompositeSummary(enrichmentHistory);

			// Upsert so a missing guild_metadata row cannot silently swallow the result
			const saveResult = await this.db.query(
				`
				INSERT INTO guild_metadata (
					guild_id, summary, enrichment_history, top_topics,
					last_enriched_relationship_count, last_enriched_at, enrichment_error
				)
				VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NOW(), NULL)
				ON CONFLICT (guild_id)
				DO UPDATE SET
					summary = EXCLUDED.summary,
					enrichment_history = EXCLUDED.enrichment_history,
					top_topics = EXCLUDED.top_topics,
					last_enriched_relationship_count = EXCLUDED.last_enriched_relationship_count,
					last_enriched_at = NOW(),
					enrichment_error = NULL,
					enrichment_version = guild_metadata.enrichment_version + 1,
					updated_at = NOW()
				RETURNING enrichment_version
				`,
				[
					guildId,
					guildSummary,
					JSON.stringify(enrichmentHistory),
					JSON.stringify(topTopics),
					currentRelationshipCount,
				],
			);
			if (!saveResult.success) {
				throw new Error(`failed to save guild metadata: ${saveResult.error}`);
			}
			if (!saveResult.data?.length) {
				throw new Error("guild metadata upsert returned no row");
			}

			await this.rateLimiter.trackCost(costEstimate.estimatedCost, "guild");

			console.log(
				`🔹 Enriched guild ${guildId} (${topConversations.length} conversations, ${currentRelationshipCount} relationships)`,
			);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Guild enrichment failed for ${guildId}: ${message}`, {
				cause: error,
			});
		}
	}

	/**
	 * Extract top topics from conversations (weighted by recency)
	 */
	private extractTopTopics(conversations: TopConversationRow[]): TopicEntry[] {
		const topicCounts = new Map<string, number>();
		const now = Date.now();

		for (const conv of conversations) {
			const keywords = conv.keywords;
			if (!keywords) continue;

			// Weight by recency (more recent = higher weight)
			const age = now - new Date(conv.start_time).getTime();
			const recencyWeight = Math.max(0.5, 1 - age / (7 * 24 * 60 * 60 * 1000));

			const keywordArray: Array<string | undefined> = Array.isArray(keywords)
				? keywords
				: (keywords.terms ?? []).map((t) => (typeof t === "string" ? t : t.word));

			for (const keyword of keywordArray) {
				if (typeof keyword === "string" && keyword.length >= 3) {
					topicCounts.set(
						keyword.toLowerCase(),
						(topicCounts.get(keyword.toLowerCase()) || 0) + recencyWeight,
					);
				}
			}
		}

		const topTopics = Array.from(topicCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([topic, frequency]) => ({
				topic,
				frequency: Math.round(frequency),
				trend: "stable" as const, // Simplified - could analyze trends
			}));

		return topTopics;
	}

	/**
	 * Build guild context string for prompts
	 */
	private buildGuildContext(
		topTopics: TopicEntry[],
		topRelationships: RelationshipSummaryRow[],
		clusters: Array<{ id: string; members: string[]; description?: string }>,
	): string {
		let context = "";

		if (topTopics.length > 0) {
			context += `**Top Conversation Topics** (last 7 days):\n`;
			context += topTopics
				.map((t) => `- ${t.topic}: ${t.frequency} conversations, trending ${t.trend}`)
				.join("\n");
			context += "\n\n";
		}

		if (topRelationships.length > 0) {
			context += `**Top Relationships**:\n`;
			context += topRelationships
				.map(
					(r) =>
						`- ${r.user_a.slice(0, 8)} & ${r.user_b.slice(0, 8)}: ${r.summary || "No summary"}`,
				)
				.join("\n");
			context += "\n\n";
		}

		if (clusters.length > 0) {
			context += `**Community Clusters**:\n`;
			context += clusters
				.map(
					(c) =>
						`- Cluster ${c.id}: ${c.members.length} members, ${c.description || "No description"}`,
				)
				.join("\n");
		}

		return context.trim();
	}

	/**
	 * Generate initial guild summary using LLM
	 */
	private async generateInitialSummary(
		topTopics: TopicEntry[],
		topRelationships: RelationshipSummaryRow[],
		clusters: Array<{ id: string; members: string[]; description?: string }>,
		guildId: string,
	): Promise<string> {
		const context = this.buildGuildContext(topTopics, topRelationships, clusters);

		const prompt = `Summarize this Discord server based on recent activity and community structure.

${context}

**Task**: Write 3-4 sentences describing the server's focus, culture, and recent trends.

**Guild Summary**:`;

		return await this.generate(prompt, guildId, 400);
	}

	/**
	 * Generate text with the LLM. Throws if generation fails or returns nothing.
	 */
	private async generate(prompt: string, guildId: string, maxTokens: number): Promise<string> {
		let provider = "grok";
		if (!process.env.GROK_API_KEY) {
			if (process.env.OLLAMA_URL) {
				provider = "ollama";
			}
		}

		const builder = new AIRequestBuilder(this.aiEngine);
		const ctx = new AIContextBuilder()
			.user("system-enricher")
			.guild(guildId)
			.build();
		// Structured mode: the chat preset caps output at 60 tokens, truncating summaries
		const result = await builder
			.blocking()
			.mode("structured")
			.maxTokens(maxTokens)
			.withContext(ctx)
			.provider(provider as "grok" | "ollama")
			.persona("casual")
			.withoutTools()
			.generate(prompt);

		const response = result as AIResponse;
		if (!response.success || !response.content?.trim()) {
			throw new Error(`LLM generation failed: ${response.error ?? "empty response"}`);
		}
		return response.content.trim();
	}
}
