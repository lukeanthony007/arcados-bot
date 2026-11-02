/**
 * UserProfileEnrichmentPipeline (Layer 2)
 *
 * Enriches user profiles with incremental updates based on new conversations.
 * Uses IncrementalEnrichment to append deltas instead of full regeneration.
 *
 * Extracted from PsychologicalProfiler with incremental enrichment support.
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
import { CommunicationStyleAnalyzer } from "../../psychological-profiling/analyzers/CommunicationStyleAnalyzer";
import { TemporalPatternAnalyzer } from "../../psychological-profiling/analyzers/TemporalPatternAnalyzer";
import { ResponsePatternAnalyzer } from "../../psychological-profiling/analyzers/ResponsePatternAnalyzer";
import { BigFiveEstimator } from "../../psychological-profiling/analyzers/BigFiveEstimator";
import { MBTIEstimator } from "../../psychological-profiling/analyzers/MBTIEstimator";
import { PsychologicalProfiler } from "../../psychological-profiling/PsychologicalProfiler";

export class UserProfileEnrichmentPipeline {
	private db: PostgreSQLManager;
	private aiEngine: AIEngine;
	private rateLimiter: EnrichmentRateLimiter;
	private bigFiveEstimator: BigFiveEstimator;
	private mbtiEstimator: MBTIEstimator;
	// Shares data gathering with the profiler so both feed the analyzers the same inputs
	private profiler: PsychologicalProfiler;

	constructor(db: PostgreSQLManager, aiEngine: AIEngine) {
		this.db = db;
		this.aiEngine = aiEngine;
		this.rateLimiter = EnrichmentRateLimiter.getInstance();
		this.bigFiveEstimator = new BigFiveEstimator(aiEngine);
		this.mbtiEstimator = new MBTIEstimator(aiEngine);
		this.profiler = new PsychologicalProfiler(db, aiEngine);
	}

	/**
	 * Enrich user profile based on new conversations
	 * Returns new profile_version, or null when skipped (not enough new data, over budget).
	 * Throws on failure so the enrichment queue records and retries it.
	 */
	async enrichUser(userId: string, guildId: string): Promise<number | null> {
		try {
			// Get current profile state
			const profileResult = await this.db.getUserProfile(userId, guildId);

			if (!profileResult.success) {
				throw new Error(`failed to read profile: ${profileResult.error}`);
			}

			const existingProfile = profileResult.data;
			const lastEnrichedConversationId =
				existingProfile?.last_enriched_conversation_id || null;
			const lastEnrichedConversationCount =
				existingProfile?.last_enriched_conversation_count || 0;
			const existingSummary = existingProfile?.summary || "";
			const existingHistoryJson = existingProfile?.enrichment_history || null;

			// Parse existing enrichment history
			let existingHistory: EnrichmentHistory | null = null;
			if (existingHistoryJson) {
				existingHistory = IncrementalEnrichment.parseHistory(existingHistoryJson);
			}

			// Query NEW conversations since last enrichment
			const newConversationsQuery = lastEnrichedConversationId
				? `
					SELECT cs.id, cs.summary, cs.participants, cs.message_count, cs.start_time, cs.end_time
					FROM conversation_segments cs
					WHERE cs.guild_id = $1
					AND $2 = ANY(cs.participants)
					AND cs.id > $3
					AND cs.status = 'finalized'
					AND cs.ai_processing_status = 'completed'
					AND cs.summary IS NOT NULL
					ORDER BY cs.start_time DESC
					LIMIT 5
				`
				: `
					SELECT cs.id, cs.summary, cs.participants, cs.message_count, cs.start_time, cs.end_time
					FROM conversation_segments cs
					WHERE cs.guild_id = $1
					AND $2 = ANY(cs.participants)
					AND cs.status = 'finalized'
					AND cs.ai_processing_status = 'completed'
					AND cs.summary IS NOT NULL
					ORDER BY cs.start_time DESC
					LIMIT 5
				`;

			const newConversationsResult = await this.db.query(
				newConversationsQuery,
				lastEnrichedConversationId
					? [guildId, userId, lastEnrichedConversationId]
					: [guildId, userId],
			);

			if (
				!newConversationsResult.success ||
				!newConversationsResult.data ||
				newConversationsResult.data.length === 0
			) {
				console.log(
					`   ℹ️  No new conversations for user ${userId.slice(0, 8)}`,
				);
				return null;
			}

			const newConversations = newConversationsResult.data;

			// Get current conversation count
			const countResult = await this.db.query(
				`
				SELECT COUNT(DISTINCT cs.id) as count
				FROM conversation_segments cs
				WHERE cs.guild_id = $1
				AND $2 = ANY(cs.participants)
				AND cs.status = 'finalized'
				AND cs.ai_processing_status = 'completed'
				`,
				[guildId, userId],
			);

			const currentConversationCount =
				countResult.success && countResult.data && countResult.data.length > 0
					? parseInt(countResult.data[0].count)
					: 0;

			// Check if we have enough new conversations (5+ threshold)
			const newConversationCount =
				currentConversationCount - lastEnrichedConversationCount;
			if (newConversationCount < 5) {
				console.log(
					`   ℹ️  Only ${newConversationCount} new conversations (need 5+) for user ${userId.slice(0, 8)}`,
				);
				return null;
			}

			// Estimate cost and check budget
			const costEstimate = this.rateLimiter.estimateUserProfileCost(
				newConversations.length,
			);
			const canAfford = await this.rateLimiter.canAffordEnrichment(
				costEstimate.estimatedCost,
			);

			if (!canAfford.canAfford) {
				console.warn(
					`⚠️  Cannot afford user enrichment for ${userId.slice(0, 8)}: ${canAfford.reason}`,
				);
				return null;
			}

			// Gather user data for analysis
			const userData = await this.profiler.gatherUserData(userId, guildId);
			if (!userData) {
				console.warn(
					`⚠️  Insufficient data for user ${userId.slice(0, 8)}`,
				);
				return null;
			}

			// Run statistical analyzers
			const communicationStyle = await CommunicationStyleAnalyzer.analyze(
				userData.messages,
				userData.guildAuthorAvgLengths,
			);
			const temporalProfile = await TemporalPatternAnalyzer.analyze(
				userData.messages,
			);
			const responsePatterns = await ResponsePatternAnalyzer.analyze(
				userId,
				userData.messages,
				userData.conversations,
				userData.responseInteractions,
			);
			const emojiSignature = this.profiler.extractEmojiSignature(userData.messages);

			// Generate Big Five and MBTI (if needed)
			let bigFive = undefined;
			let mbtiType = undefined;

			try {
				const bigFiveResult = await this.bigFiveEstimator.estimate(
					userData,
					communicationStyle.data,
					responsePatterns.data,
					emojiSignature,
				);
				if (bigFiveResult.success && bigFiveResult.data) {
					bigFive = bigFiveResult.data;
				}
			} catch (error) {
				console.warn(
					`⚠️  Big Five estimation failed for ${userId.slice(0, 8)}: ${error}`,
				);
			}

			if (bigFive) {
				try {
					const mbtiResult = await this.mbtiEstimator.estimate(
						bigFive,
						communicationStyle.data,
						responsePatterns.data,
						temporalProfile.data,
						userData,
					);
					if (mbtiResult.success && mbtiResult.data) {
						mbtiType = mbtiResult.data;
					}
				} catch (error) {
					console.warn(
						`⚠️  MBTI estimation failed for ${userId.slice(0, 8)}: ${error}`,
					);
				}
			}

			// Build conversation summaries for delta prompt
			const conversationSummaries = newConversations
				.map((c: any) => c.summary)
				.filter(Boolean)
				.join("\n\n");

			// Generate context range
			const contextRange = IncrementalEnrichment.userContextRange(
				lastEnrichedConversationCount,
				currentConversationCount,
			);

			// Get base summary (from history or existing summary)
			const baseSummary = existingHistory
				? IncrementalEnrichment.getCompositeSummary(existingHistory)
				: existingSummary;

			// Generate delta using LLM
			const deltaPrompt = IncrementalEnrichment.createDeltaPrompt(
				"user",
				baseSummary || "No previous profile data.",
				conversationSummaries,
				contextRange,
			);

			const delta = await this.generateDelta(deltaPrompt, guildId);
			if (!delta) {
				throw new Error("failed to generate summary delta");
			}

			// Calculate confidence
			const confidence = Math.min(
				1.0,
				0.6 + (newConversations.length / 10) * 0.2 + (userData.messages.length / 200) * 0.2,
			);

			// Append delta to history
			let newHistory: EnrichmentHistory;
			if (existingHistory) {
				newHistory = IncrementalEnrichment.appendDelta(
					existingHistory,
					contextRange,
					delta,
					confidence,
				);
			} else {
				// First enrichment - create history with base summary
				const initialHistory = IncrementalEnrichment.createHistory(baseSummary);
				newHistory = IncrementalEnrichment.appendDelta(
					initialHistory,
					contextRange,
					delta,
					confidence,
				);
			}

			// Check if consolidation is needed
			if (IncrementalEnrichment.needsConsolidation(newHistory)) {
				const consolidationPrompt =
					IncrementalEnrichment.createConsolidationPrompt("user", newHistory);
				const consolidatedSummary = await this.generateDelta(
					consolidationPrompt,
					guildId,
				);

				if (consolidatedSummary) {
					newHistory = IncrementalEnrichment.consolidate(consolidatedSummary);
				}
			}

			// Get final composite summary
			const finalSummary = IncrementalEnrichment.getCompositeSummary(newHistory);

			// Get new profile version
			const currentProfileVersion = existingProfile?.profile_version || 0;
			const newProfileVersion = currentProfileVersion + 1;

			// Get latest conversation ID
			const latestConversationId =
				newConversations.length > 0 ? newConversations[0].id : lastEnrichedConversationId;

			// Ensure a profile row exists; the UPDATE below would otherwise match nothing
			const ensureResult = await this.db.query(
				`INSERT INTO user_profiles (guild_id, user_id) VALUES ($1, $2)
				ON CONFLICT (guild_id, user_id) DO NOTHING`,
				[guildId, userId],
			);
			if (!ensureResult.success) {
				throw new Error(`failed to create profile row: ${ensureResult.error}`);
			}

			// Update database (strip nulls so a failed estimate keeps the previous value)
			const updateResult = await this.db.query(
				`
				UPDATE user_profiles
				SET summary = $3,
					enrichment_history = $4::jsonb,
					profile_version = $5,
					last_enriched_at = NOW(),
					last_enriched_conversation_count = $6,
					last_enriched_conversation_id = $7,
					psych_profile = COALESCE(psych_profile, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
						'big_five_proxies', $8::jsonb,
						'mbti_type', $9::jsonb
					)),
					behavior_patterns = COALESCE(behavior_patterns, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
						'communication_style', $10::jsonb,
						'response_patterns', $11::jsonb,
						'emoji_signature', $12::jsonb,
						'temporal_profile', $13::jsonb
					)),
					updated_at = NOW()
				WHERE user_id = $1 AND guild_id = $2
				RETURNING profile_version
				`,
				[
					userId,
					guildId,
					finalSummary,
					JSON.stringify(newHistory),
					newProfileVersion,
					currentConversationCount,
					latestConversationId,
					bigFive ? JSON.stringify(bigFive) : null,
					mbtiType ? JSON.stringify(mbtiType) : null,
					JSON.stringify(communicationStyle.data),
					JSON.stringify(responsePatterns.data),
					JSON.stringify(emojiSignature),
					JSON.stringify(temporalProfile.data),
				],
			);

			if (!updateResult.success) {
				throw new Error(`failed to save profile: ${updateResult.error}`);
			}
			if (!updateResult.data?.length) {
				throw new Error("profile update matched no row");
			}

			// Track cost
			await this.rateLimiter.trackCost(costEstimate.estimatedCost, "user_profile");

			console.log(
				`🔹 Enriched user ${userId.slice(0, 8)} (version ${newProfileVersion}, ${newConversationCount} new conversations)`,
			);

			return newProfileVersion;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`User enrichment failed for ${userId}: ${message}`, {
				cause: error,
			});
		}
	}

	/**
	 * Generate delta using LLM
	 */
	private async generateDelta(prompt: string, guildId: string): Promise<string | null> {
		let provider = "grok";
		if (!process.env.GROK_API_KEY) {
			if (process.env.OLLAMA_URL) {
				provider = "ollama";
			}
		}

		try {
			const builder = new AIRequestBuilder(this.aiEngine);
			const ctx = new AIContextBuilder()
				.user("system-enricher")
				.guild(guildId)
				.build();
			// Structured mode: the chat preset caps output at 60 tokens, truncating summaries
			const result = await builder
				.blocking()
				.mode("structured")
				.maxTokens(500)
				.withContext(ctx)
				.provider(provider as "grok" | "ollama")
				.persona("casual")
				.withoutTools()
				.generate(prompt);

			const response = result as AIResponse;
			if (response.success && response.content) {
				return response.content.trim();
			}
		} catch (error) {
			console.error(`❌ Failed to generate delta: ${error}`);
		}

		return null;
	}
}

