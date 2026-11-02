/**
 * RelationshipEnrichmentPipeline (Layer 3)
 *
 * Enriches relationship profiles between pairs of users based on:
 * - Shared conversations
 * - User profile updates (cascade trigger)
 * - Interaction metrics
 *
 * Throws on real failures so the enrichment queue records and retries them; returns false
 * for legitimate skips (not enough shared conversations, nothing new, over budget).
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

interface SharedConversationRow {
	id: string;
	summary: string;
	keywords: { terms?: Array<{ word?: string; score?: number }> } | null;
}

interface InteractionMetrics {
	total: number;
	msg_a_to_b: number;
	msg_b_to_a: number;
	mentions: number;
	replies: number;
}

interface UserProfileRow {
	summary: string | null;
	profile_version: number | null;
}

/** Minimum shared conversations before a relationship profile is created or updated */
const MIN_SHARED_CONVERSATIONS = 3;

export class RelationshipEnrichmentPipeline {
	private db: PostgreSQLManager;
	private aiEngine: AIEngine;
	private rateLimiter: EnrichmentRateLimiter;

	constructor(db: PostgreSQLManager, aiEngine: AIEngine) {
		this.db = db;
		this.aiEngine = aiEngine;
		this.rateLimiter = EnrichmentRateLimiter.getInstance();
	}

	/**
	 * Normalize user pair (ensure userA < userB; matches the check_user_order constraint)
	 */
	private normalizeUserPair(userA: string, userB: string): [string, string] {
		return userA < userB ? [userA, userB] : [userB, userA];
	}

	/**
	 * Enrich relationship between two users.
	 * Returns true when the profile was written, false when skipped (not enough shared
	 * conversations, nothing new since the last run, over budget).
	 * Throws on failure so the enrichment queue records and retries it.
	 */
	async enrichRelationship(
		userA: string,
		userB: string,
		guildId: string,
	): Promise<boolean> {
		try {
			const [normalizedA, normalizedB] = this.normalizeUserPair(userA, userB);

			// Shared finalized + summarized conversations: true count, plus the 20 newest for context
			const countResult = await this.db.query(
				`
				SELECT COUNT(DISTINCT cs.id) AS count
				FROM conversation_segments cs
				WHERE cs.guild_id = $1
				AND $2 = ANY(cs.participants)
				AND $3 = ANY(cs.participants)
				AND cs.status = 'finalized'
				AND cs.ai_processing_status = 'completed'
				AND cs.summary IS NOT NULL
				`,
				[guildId, normalizedA, normalizedB],
			);
			if (!countResult.success) {
				throw new Error(`failed to count shared conversations: ${countResult.error}`);
			}
			const currentSharedCount = Number(countResult.data?.[0]?.count ?? 0);

			if (currentSharedCount < MIN_SHARED_CONVERSATIONS) {
				console.log(
					`   ℹ️  Only ${currentSharedCount} shared conversations (need ${MIN_SHARED_CONVERSATIONS}+) for ${normalizedA.slice(0, 8)} & ${normalizedB.slice(0, 8)}`,
				);
				return false;
			}

			// Existing relationship profile (if any)
			const existingProfileResult = await this.db.query(
				`
				SELECT summary, enrichment_history, last_enriched_conversation_count
				FROM relationship_profiles
				WHERE guild_id = $1 AND user_a = $2 AND user_b = $3
				`,
				[guildId, normalizedA, normalizedB],
			);
			if (!existingProfileResult.success) {
				throw new Error(`failed to read relationship profile: ${existingProfileResult.error}`);
			}
			const existingProfile = existingProfileResult.data?.[0] ?? null;
			const lastEnrichedCount: number = existingProfile?.last_enriched_conversation_count ?? 0;
			const hasExistingSummary = Boolean(existingProfile?.summary?.trim());
			const newSharedCount = currentSharedCount - lastEnrichedCount;

			// Already enriched: only continue when enough new shared conversations exist
			if (hasExistingSummary && newSharedCount < MIN_SHARED_CONVERSATIONS) {
				console.log(
					`   ℹ️  Only ${Math.max(0, newSharedCount)} new shared conversations (need ${MIN_SHARED_CONVERSATIONS}+) for ${normalizedA.slice(0, 8)} & ${normalizedB.slice(0, 8)}`,
				);
				return false;
			}

			const sharedResult = await this.db.query(
				`
				SELECT cs.id, cs.summary, cs.features->'keywords' AS keywords
				FROM conversation_segments cs
				WHERE cs.guild_id = $1
				AND $2 = ANY(cs.participants)
				AND $3 = ANY(cs.participants)
				AND cs.status = 'finalized'
				AND cs.ai_processing_status = 'completed'
				AND cs.summary IS NOT NULL
				ORDER BY cs.start_time DESC
				LIMIT 20
				`,
				[guildId, normalizedA, normalizedB],
			);
			if (!sharedResult.success || !sharedResult.data) {
				throw new Error(`failed to read shared conversations: ${sharedResult.error}`);
			}
			const sharedConversations: SharedConversationRow[] = sharedResult.data;

			// User profiles (summary + version)
			const profileResult = await this.db.query(
				`
				SELECT user_id, summary, profile_version
				FROM user_profiles
				WHERE guild_id = $1 AND user_id = ANY($2::text[])
				`,
				[guildId, [normalizedA, normalizedB]],
			);
			if (!profileResult.success) {
				throw new Error(`failed to read user profiles: ${profileResult.error}`);
			}
			const profileRows: Array<UserProfileRow & { user_id: string }> = profileResult.data ?? [];
			const userAProfile = profileRows.find((r) => r.user_id === normalizedA) ?? null;
			const userBProfile = profileRows.find((r) => r.user_id === normalizedB) ?? null;

			const edges = await this.getInteractionMetrics(guildId, normalizedA, normalizedB);

			// Estimate cost and check budget
			const costEstimate = this.rateLimiter.estimateRelationshipCost(
				sharedConversations.length,
			);
			const canAfford = await this.rateLimiter.canAffordEnrichment(
				costEstimate.estimatedCost,
			);
			if (!canAfford.canAfford) {
				console.warn(`⚠️  Cannot afford relationship enrichment: ${canAfford.reason}`);
				return false;
			}

			let enrichmentHistory: EnrichmentHistory;

			if (hasExistingSummary) {
				const existingHistory = IncrementalEnrichment.parseHistory(
					existingProfile?.enrichment_history,
				);
				// Fall back to the stored summary as base when no usable history exists
				const baseSummary = existingHistory
					? IncrementalEnrichment.getCompositeSummary(existingHistory)
					: (existingProfile?.summary ?? "");

				const newConversations = sharedConversations.slice(0, newSharedCount);
				const conversationSummaries = newConversations
					.map((c) => c.summary)
					.filter(Boolean)
					.join("\n\n");

				const contextRange = IncrementalEnrichment.relationshipContextRange(
					lastEnrichedCount,
					currentSharedCount,
				);

				const deltaPrompt = IncrementalEnrichment.createDeltaPrompt(
					"relationship",
					baseSummary,
					conversationSummaries,
					contextRange,
				);
				const delta = await this.generate(deltaPrompt, guildId, 400);

				enrichmentHistory = IncrementalEnrichment.appendDelta(
					existingHistory ?? IncrementalEnrichment.createHistory(baseSummary),
					contextRange,
					delta,
					0.8,
				);
			} else {
				const initialSummary = await this.generateInitialSummary(
					userAProfile?.summary ?? null,
					userBProfile?.summary ?? null,
					sharedConversations,
					currentSharedCount,
					edges,
					guildId,
				);
				enrichmentHistory = IncrementalEnrichment.createHistory(initialSummary);
			}

			// Consolidate accumulated deltas into a fresh base summary when needed
			if (IncrementalEnrichment.needsConsolidation(enrichmentHistory)) {
				const consolidationPrompt = IncrementalEnrichment.createConsolidationPrompt(
					"relationship",
					enrichmentHistory,
				);
				const consolidated = await this.generate(consolidationPrompt, guildId, 500);
				enrichmentHistory = IncrementalEnrichment.consolidate(consolidated);
			}

			const relationshipSummary = IncrementalEnrichment.getCompositeSummary(enrichmentHistory);
			const keywords = this.extractSharedKeywords(sharedConversations);
			const relationshipType = this.classifyRelationshipType(edges, currentSharedCount);
			const confidence = IncrementalEnrichment.getAverageConfidence(enrichmentHistory);

			// Upsert relationship profile (columns match the live relationship_profiles table)
			const upsertResult = await this.db.query(
				`
				INSERT INTO relationship_profiles (
					guild_id, user_a, user_b,
					summary,
					enrichment_history,
					relationship_type,
					keywords,
					shared_conversations,
					recent_conversation_ids,
					user_a_profile_version,
					user_b_profile_version,
					last_enriched_conversation_count,
					enrichment_confidence,
					enrichment_error,
					last_enriched_at
				)
				VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $8, $12, NULL, NOW())
				ON CONFLICT (guild_id, user_a, user_b)
				DO UPDATE SET
					summary = EXCLUDED.summary,
					enrichment_history = EXCLUDED.enrichment_history,
					relationship_type = EXCLUDED.relationship_type,
					keywords = EXCLUDED.keywords,
					shared_conversations = EXCLUDED.shared_conversations,
					recent_conversation_ids = EXCLUDED.recent_conversation_ids,
					user_a_profile_version = EXCLUDED.user_a_profile_version,
					user_b_profile_version = EXCLUDED.user_b_profile_version,
					last_enriched_conversation_count = EXCLUDED.last_enriched_conversation_count,
					enrichment_confidence = EXCLUDED.enrichment_confidence,
					enrichment_error = NULL,
					enrichment_version = relationship_profiles.enrichment_version + 1,
					last_enriched_at = NOW()
				RETURNING enrichment_version
				`,
				[
					guildId,
					normalizedA,
					normalizedB,
					relationshipSummary,
					JSON.stringify(enrichmentHistory),
					relationshipType,
					keywords,
					currentSharedCount,
					sharedConversations.map((c) => c.id),
					userAProfile?.profile_version ?? 0,
					userBProfile?.profile_version ?? 0,
					confidence,
				],
			);
			if (!upsertResult.success) {
				throw new Error(`failed to save relationship profile: ${upsertResult.error}`);
			}
			if (!upsertResult.data?.length) {
				throw new Error("relationship profile upsert returned no row");
			}

			await this.rateLimiter.trackCost(costEstimate.estimatedCost, "relationship");

			console.log(
				`🔹 Enriched relationship ${normalizedA.slice(0, 8)} & ${normalizedB.slice(0, 8)} (${currentSharedCount} shared conversations)`,
			);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Relationship enrichment failed for ${userA}:${userB}: ${message}`, {
				cause: error,
			});
		}
	}

	/**
	 * Interaction metrics for a pair, oriented A->B. relationship_edges rows are not
	 * guaranteed to be stored in normalized order (and a pair can exist in both orders),
	 * so aggregate both orientations.
	 */
	private async getInteractionMetrics(
		guildId: string,
		userA: string,
		userB: string,
	): Promise<InteractionMetrics> {
		const result = await this.db.query(
			`
			SELECT
				COALESCE(SUM(total), 0)::int AS total,
				COALESCE(SUM(CASE WHEN user_a = $2 THEN msg_a_to_b ELSE msg_b_to_a END), 0)::int AS msg_a_to_b,
				COALESCE(SUM(CASE WHEN user_a = $2 THEN msg_b_to_a ELSE msg_a_to_b END), 0)::int AS msg_b_to_a,
				COALESCE(SUM(mentions), 0)::int AS mentions,
				COALESCE(SUM(replies), 0)::int AS replies
			FROM relationship_edges
			WHERE guild_id = $1
			AND ((user_a = $2 AND user_b = $3) OR (user_a = $3 AND user_b = $2))
			`,
			[guildId, userA, userB],
		);
		if (!result.success) {
			throw new Error(`failed to read interaction metrics: ${result.error}`);
		}
		const row = result.data?.[0];
		return {
			total: row?.total ?? 0,
			msg_a_to_b: row?.msg_a_to_b ?? 0,
			msg_b_to_a: row?.msg_b_to_a ?? 0,
			mentions: row?.mentions ?? 0,
			replies: row?.replies ?? 0,
		};
	}

	/**
	 * Generate initial relationship summary using LLM
	 */
	private async generateInitialSummary(
		userASummary: string | null,
		userBSummary: string | null,
		sharedConversations: SharedConversationRow[],
		sharedCount: number,
		edges: InteractionMetrics,
		guildId: string,
	): Promise<string> {
		const conversationSummaries = sharedConversations
			.map((c) => c.summary)
			.filter(Boolean)
			.join("\n\n");

		const prompt = `Analyze the relationship between these two Discord users based on their shared conversations and interaction patterns.

**User A Profile**:
${userASummary || "No profile data available."}

**User B Profile**:
${userBSummary || "No profile data available."}

**Shared Conversations (${sharedCount} total, newest ${sharedConversations.length} shown)**:
${conversationSummaries}

**Interaction Metrics**:
- Total interactions: ${edges.total}
- Messages A→B: ${edges.msg_a_to_b}
- Messages B→A: ${edges.msg_b_to_a}
- Mentions: ${edges.mentions}
- Replies: ${edges.replies}

**Task**: Write 2-3 sentences describing their relationship dynamic, shared interests, and interaction patterns.

**Relationship Summary**:`;

		return await this.generate(prompt, guildId, 400);
	}

	/**
	 * Top shared keywords: sum the extractor's term scores stored on each shared conversation
	 */
	private extractSharedKeywords(conversations: SharedConversationRow[]): string[] {
		const counts = new Map<string, number>();

		for (const conv of conversations) {
			for (const term of conv.keywords?.terms ?? []) {
				const word = term.word?.toLowerCase();
				if (!word || word.length < 4) continue;
				counts.set(word, (counts.get(word) ?? 0) + (term.score ?? 0));
			}
		}

		return Array.from(counts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([word]) => word);
	}

	/**
	 * Classify relationship type based on interaction patterns
	 */
	private classifyRelationshipType(edges: InteractionMetrics, sharedCount: number): string {
		// Simplified classification - could be enhanced with LLM
		if (edges.mentions > 20 || edges.replies > 30) {
			return "close_friends";
		}
		if (sharedCount > 10) {
			return "regular_collaborators";
		}
		if (edges.msg_a_to_b > 50 || edges.msg_b_to_a > 50) {
			return "mentor_mentee";
		}
		return "acquaintances";
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
