/**
 * Psychological Profiler
 *
 * Main coordinator for user psychological profiling. Orchestrates:
 * 1. Data gathering (messages, conversations, relationships)
 * 2. Statistical analysis (communication, temporal, response patterns)
 * 3. AI-powered trait estimation (Big Five)
 * 4. Database updates (psych_profile, behavior_patterns, temporal_profile)
 * 5. Staleness tracking
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { pgvector } from "../../../database/PostgreSQLManager.js";
import type { AIEngine } from "../../../ai/core/AIEngine";
import { CommunicationStyleAnalyzer } from "./analyzers/CommunicationStyleAnalyzer";
import { TemporalPatternAnalyzer } from "./analyzers/TemporalPatternAnalyzer";
import { ResponsePatternAnalyzer } from "./analyzers/ResponsePatternAnalyzer";
import { BigFiveEstimator } from "./analyzers/BigFiveEstimator";
import { MBTIEstimator } from "./analyzers/MBTIEstimator";
import type {
	ProfilingStats,
	UserAnalysisData,
	PsychProfile,
	BehaviorPatterns,
	TemporalProfile,
	MessageData,
	EmojiSignature,
	InteractionStyle,
	TopicAffinityMap,
	ResponseInteractionData,
	ConversationData,
} from "./types";

export interface PsychologicalProfilerConfig {
	minMessagesForProfiling?: number; // Minimum messages needed (default: 10)
	stalenessThreshold?: number; // Messages before re-analysis (default: 50)
	batchSize?: number; // Users per batch (default: 10)
	sleepBetweenBatchesMs?: number; // Sleep between batches (default: 1000)
	skipBigFive?: boolean; // Skip Big Five AI analysis for testing (default: false)
	skipMBTI?: boolean; // Skip MBTI analysis for testing (default: false)
}

/** A term must recur in this many of the user's conversations to count as a topic. */
const MIN_TOPIC_CONVERSATIONS = 3;
/** ...and be this many times more common in the user's conversations than the guild's. */
const MIN_TOPIC_LIFT = 2;

export class PsychologicalProfiler {
	private db: PostgreSQLManager;
	private aiEngine: AIEngine | null;
	private bigFiveEstimator: BigFiveEstimator | null;
	private mbtiEstimator: MBTIEstimator;
	private config: Required<PsychologicalProfilerConfig>;
	private stats: ProfilingStats;

	constructor(
		db: PostgreSQLManager,
		aiEngine?: AIEngine,
		config: PsychologicalProfilerConfig = {}
	) {
		this.db = db;
		this.aiEngine = aiEngine || null;
		this.bigFiveEstimator = aiEngine ? new BigFiveEstimator(aiEngine) : null;
		this.mbtiEstimator = new MBTIEstimator(aiEngine);

		this.config = {
			minMessagesForProfiling: config.minMessagesForProfiling ?? 10,
			stalenessThreshold: config.stalenessThreshold ?? 50,
			batchSize: config.batchSize ?? 10,
			sleepBetweenBatchesMs: config.sleepBetweenBatchesMs ?? 1000,
			skipBigFive: config.skipBigFive ?? false,
			skipMBTI: config.skipMBTI ?? false,
		};

		this.stats = {
			users_processed: 0,
			profiles_created: 0,
			profiles_updated: 0,
			errors: 0,
			api_calls_made: 0,
			start_time: new Date(),
		};
	}

	/**
	 * Profile a single user
	 */
	async profileUser(userId: string, guildId: string): Promise<boolean> {
		try {
			console.log(`   [User ${userId.slice(0, 8)}] Profiling...`);

			// 1. Gather user data
			const data = await this.gatherUserData(userId, guildId);

			if (!data) {
				console.log(`   [User ${userId.slice(0, 8)}] ⚠️  Insufficient data`);
				return false;
			}

			// 2. Run statistical analyzers
			const communicationStyle = await CommunicationStyleAnalyzer.analyze(
				data.messages,
				data.guildAuthorAvgLengths
			);
			const temporalProfile = await TemporalPatternAnalyzer.analyze(
				data.messages
			);
			const responsePatterns = await ResponsePatternAnalyzer.analyze(
				userId,
				data.messages,
				data.conversations,
				data.responseInteractions
			);

			// 3. Extract emoji signature
			const emojiSignature = this.extractEmojiSignature(data.messages);

			// 4. Run Big Five estimator (AI)
			let bigFive = undefined;
			if (!this.config.skipBigFive && this.bigFiveEstimator) {
				const result = await this.bigFiveEstimator.estimate(
					data,
					communicationStyle.data,
					responsePatterns.data,
					emojiSignature
				);

				if (result.success && result.data) {
					bigFive = result.data;
					this.stats.api_calls_made++;
				} else {
					console.warn(
						`   [User ${userId.slice(0, 8)}] ⚠️  Big Five estimation failed: ${result.error}`
					);
				}
			}

			// 4.5. Run MBTI estimator (hybrid: derive from Big Five + behavioral validation)
			let mbtiType = undefined;
			if (!this.config.skipMBTI && bigFive) {
				const mbtiResult = await this.mbtiEstimator.estimate(
					bigFive,
					communicationStyle.data,
					responsePatterns.data,
					temporalProfile.data,
					data
				);

				if (mbtiResult.success && mbtiResult.data) {
					mbtiType = mbtiResult.data;
					// Only increment API calls if AI validation was actually used
					// (MBTIEstimator only calls AI for low-confidence cases < 0.5)
					if (mbtiResult.data.confidence < 0.5 && data.messages.length >= 100) {
						this.stats.api_calls_made++;
					}
				} else {
					console.warn(
						`   [User ${userId.slice(0, 8)}] ⚠️  MBTI estimation failed: ${mbtiResult.error}`
					);
				}
			}

			// 5. Build profiles
			const psychProfile: PsychProfile = {
				big_five_proxies: bigFive,
				mbti_type: mbtiType,
				communication_style: communicationStyle.data,
				topic_affinity: this.buildTopicAffinity(data),
				profile_metadata: {
					message_count_at_analysis: data.messages.length,
					confidence_overall:
						((communicationStyle.confidence ?? 0) +
							(temporalProfile.confidence ?? 0) +
							(responsePatterns.confidence ?? 0)) /
						3,
					last_updated: new Date().toISOString(),
					staleness_threshold: this.config.stalenessThreshold,
				},
			};

			const behaviorPatterns: BehaviorPatterns = {
				response_patterns: responsePatterns.data,
				emoji_signature: emojiSignature,
				interaction_style: this.buildInteractionStyle(data),
			};

			const temporal: TemporalProfile = temporalProfile.data || {};

			// 6. Update database
			const updated = await this.updateDatabase(
				userId,
				guildId,
				psychProfile,
				behaviorPatterns,
				temporal
			);

			if (updated) {
				console.log(
					`   [User ${userId.slice(0, 8)}] 🔹 Profile updated (confidence: ${(psychProfile.profile_metadata.confidence_overall * 100).toFixed(0)}%)`
				);
				this.stats.profiles_updated++;
				return true;
			}

			this.stats.errors++;
			return false;
		} catch (error) {
			console.error(`   [User ${userId.slice(0, 8)}] ❌ Error: ${error}`);
			this.stats.errors++;
			return false;
		}
	}

	/**
	 * Profile a batch of users with rate limiting
	 */
	async profileBatch(guildId: string, userIds: string[]): Promise<number> {
		console.log(`\n📊 Profiling ${userIds.length} users in batches of ${this.config.batchSize}...\n`);

		this.stats = {
			users_processed: 0,
			profiles_created: 0,
			profiles_updated: 0,
			errors: 0,
			api_calls_made: 0,
			start_time: new Date(),
		};

		let successCount = 0;

		for (let i = 0; i < userIds.length; i += this.config.batchSize) {
			const batch = userIds.slice(i, i + this.config.batchSize);
			console.log(`   [Batch ${Math.floor(i / this.config.batchSize) + 1}/${Math.ceil(userIds.length / this.config.batchSize)}]`);

			for (const userId of batch) {
				const success = await this.profileUser(userId, guildId);
				if (success) successCount++;
				this.stats.users_processed++;
			}

			// Sleep between batches (rate limiting)
			if (i + this.config.batchSize < userIds.length) {
				await this.sleep(this.config.sleepBetweenBatchesMs);
			}
		}

		this.stats.end_time = new Date();
		this.stats.duration_seconds =
			(this.stats.end_time.getTime() - this.stats.start_time.getTime()) / 1000;

		this.printSummary();

		return successCount;
	}

	/**
	 * Detect users with stale profiles (50+ new messages OR 7+ days old)
	 */
	async detectStaleProfiles(guildId: string): Promise<string[]> {
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

		// psych_profile is owned by user_profiles (members.psych_profile is a legacy column
		// that is no longer written). Members without a profile row are stale by definition.
		const result = await this.db.query(
			`
      SELECT m.user_id
      FROM members m
      LEFT JOIN user_profiles up ON up.guild_id = m.guild_id AND up.user_id = m.user_id
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS current_count
        FROM messages msg
        WHERE msg.author_id = m.user_id AND msg.guild_id = m.guild_id
      ) mc
      WHERE m.guild_id = $1
        AND m.bot = false
        AND m.active = true
        AND mc.current_count >= $4
        AND (
          up.psych_profile->'profile_metadata'->>'last_updated' IS NULL
          OR (up.psych_profile->'profile_metadata'->>'last_updated')::timestamptz < $2
          OR COALESCE((up.psych_profile->'profile_metadata'->>'message_count_at_analysis')::int, 0) + $3 <= mc.current_count
        )
      `,
			[
				guildId,
				sevenDaysAgo.toISOString(),
				this.config.stalenessThreshold,
				this.config.minMessagesForProfiling,
			]
		);

		if (!result.success) {
			throw new Error(`Failed to detect stale profiles for guild ${guildId}: ${result.error}`);
		}

		return (result.data ?? []).map((row: { user_id: string }) => row.user_id);
	}

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	/**
	 * Gather all data needed for user analysis
	 */
	async gatherUserData(
		userId: string,
		guildId: string
	): Promise<UserAnalysisData | null> {
		// Get user messages (last 200)
		const messagesResult = await this.db.query(
			`
      SELECT id, content, created_at, author_id, referenced_message_id, attachments, embeds
      FROM messages
      WHERE guild_id = $1 AND author_id = $2
      ORDER BY created_at DESC
      LIMIT 200
      `,
			[guildId, userId]
		);

		if (
			!messagesResult.success ||
			!messagesResult.data ||
			messagesResult.data.length < this.config.minMessagesForProfiling
		) {
			return null;
		}

		const messages: MessageData[] = messagesResult.data.map((row: any) => ({
			id: row.id,
			content: row.content || "",
			created_at: new Date(row.created_at),
			author_id: row.author_id,
			referenced_message_id: row.referenced_message_id,
			attachments: row.attachments,
			embeds: row.embeds,
		}));

		// Get user conversations (last 50)
		const conversationsResult = await this.db.query(
			`
      SELECT c.id, c.participants, c.message_count, c.start_time, c.end_time, c.keywords,
        (SELECT COUNT(*)::int FROM messages m
          WHERE m.id = ANY(c.message_ids) AND m.author_id = $2) AS user_message_count,
        (SELECT m.author_id FROM messages m
          WHERE m.id = ANY(c.message_ids)
          ORDER BY m.created_at, m.id LIMIT 1) AS first_author_id
      FROM conversations_unified c
      WHERE c.guild_id = $1 AND $2 = ANY(c.participants)
      ORDER BY c.start_time DESC
      LIMIT 50
      `,
			[guildId, userId]
		);

		const conversations =
			conversationsResult.success && conversationsResult.data
				? conversationsResult.data.map((row: any) => ({
						id: row.id,
						participants: row.participants,
						message_count: row.message_count,
						start_time: new Date(row.start_time),
						end_time: new Date(row.end_time),
						user_message_count: row.user_message_count,
						first_author_id: row.first_author_id ?? undefined,
						// Keywords are stored as JSONB; they may be an array of strings
						// or a ConversationKeywords object with a `terms` array.
						keywords: Array.isArray(row.keywords)
							? row.keywords
							: row.keywords?.terms
									?.map((k: any) => k?.word)
									.filter((w: unknown): w is string => typeof w === "string") ?? [],
					}))
				: [];

		// Get user relationships and profile data (from user_profiles)
		const profileResult = await this.db.getUserProfile(userId, guildId);

		const relationships =
			profileResult.success && profileResult.data
				? (profileResult.data.relationship_network || [])
				: [];

		const keywords =
			profileResult.success && profileResult.data
				? (profileResult.data.keywords || [])
				: [];

		const emojis =
			profileResult.success && profileResult.data
				? (profileResult.data.emojis || [])
				: [];

		// Guild-wide conversation frequency of the user's recurring terms (topic distinctiveness)
		let guildTermStats: UserAnalysisData["guildTermStats"];
		const recurringTerms = [...PsychologicalProfiler.termWeeks(conversations).termWeeks.entries()]
			.filter(([, weeks]) => weeks.length >= MIN_TOPIC_CONVERSATIONS)
			.map(([term]) => term);
		if (recurringTerms.length > 0) {
			const termCountsResult = await this.db.query(
				`
      SELECT LOWER(t->>'word') AS term, COUNT(DISTINCT c.id)::int AS conversations
      FROM conversations_unified c, jsonb_array_elements(c.keywords->'terms') t
      WHERE c.guild_id = $1 AND LOWER(t->>'word') = ANY($2::text[])
      GROUP BY 1
      `,
				[guildId, recurringTerms]
			);
			const totalResult = await this.db.query(
				"SELECT COUNT(*)::int AS total FROM conversations_unified WHERE guild_id = $1",
				[guildId]
			);
			const total: number | undefined = totalResult.success ? totalResult.data?.[0]?.total : undefined;
			if (termCountsResult.success && termCountsResult.data && total !== undefined) {
				const rows = termCountsResult.data as { term: string; conversations: number }[];
				guildTermStats = {
					totalConversations: total,
					conversationCounts: new Map(rows.map((r) => [r.term, r.conversations])),
				};
			}
		}

		// Guild-wide per-author average message length (verbosity percentile baseline)
		const lengthsResult = await this.db.query(
			`
      SELECT AVG(LENGTH(BTRIM(content)))::float AS avg_length
      FROM messages
      WHERE guild_id = $1 AND LENGTH(BTRIM(content)) > 0
      GROUP BY author_id
      HAVING COUNT(*) >= $2
      `,
			[guildId, this.config.minMessagesForProfiling]
		);
		const guildAuthorAvgLengths =
			lengthsResult.success && lengthsResult.data
				? (lengthsResult.data as { avg_length: number }[]).map((row) => row.avg_length)
				: undefined;

		// Replies the user sent to other people's messages, and questions others asked them.
		// These live in other authors' messages, so they cannot come from the user's own list.
		const latencyResult = await this.db.query(
			`
      SELECT EXTRACT(EPOCH FROM (r.created_at - ref.created_at)) / 60 AS minutes
      FROM messages r
      JOIN messages ref ON ref.id = r.referenced_message_id
      WHERE r.guild_id = $1 AND r.author_id = $2
        AND ref.author_id <> $2
        AND r.created_at >= ref.created_at
        AND r.created_at - ref.created_at <= INTERVAL '24 hours'
      ORDER BY r.created_at DESC
      LIMIT 200
      `,
			[guildId, userId]
		);
		const questionsResult = await this.db.query(
			`
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM messages r
          WHERE r.guild_id = q.guild_id AND r.author_id = $2
            AND r.channel_id = q.channel_id
            AND r.created_at > q.created_at
            AND r.created_at <= q.created_at + INTERVAL '1 hour'
        ))::int AS answered
      FROM (
        SELECT guild_id, channel_id, created_at
        FROM messages
        WHERE guild_id = $1 AND author_id <> $2
          AND content ~ ('<@!?' || $2 || '>') AND content ~ '[?？]'
        ORDER BY created_at DESC
        LIMIT 200
      ) q
      `,
			[guildId, userId]
		);
		const questionsRow: { received: number; answered: number } | undefined =
			questionsResult.success ? questionsResult.data?.[0] : undefined;
		const responseInteractions: ResponseInteractionData | undefined =
			latencyResult.success && questionsResult.success && questionsRow
				? {
						reply_latencies_minutes: (
							(latencyResult.data ?? []) as { minutes: number | string }[]
						).map((row) => Number(row.minutes)),
						questions_received: questionsRow.received,
						questions_answered: questionsRow.answered,
					}
				: undefined;

		// Conversation coverage: which of the user's messages belong to a tracked conversation.
		// Conversation tracking may not span the whole message history, so coverage starts at
		// the user's earliest tracked conversation within the analysed message window.
		const oldestMessage = messages[messages.length - 1];
		let conversationCoverage: UserAnalysisData["conversationCoverage"];
		if (oldestMessage) {
			const coverageResult = await this.db.query(
				`
      SELECT start_time, message_ids
      FROM conversations_unified
      WHERE guild_id = $1 AND $2 = ANY(participants) AND end_time >= $3
      `,
				[guildId, userId, oldestMessage.created_at]
			);

			if (coverageResult.success && coverageResult.data && coverageResult.data.length > 0) {
				const messageIds = new Set<string>();
				let since = oldestMessage.created_at;
				let earliestStart: Date | undefined;
				for (const row of coverageResult.data as { start_time: Date; message_ids: string[] | null }[]) {
					const start = new Date(row.start_time);
					if (!earliestStart || start < earliestStart) earliestStart = start;
					for (const id of row.message_ids ?? []) messageIds.add(id);
				}
				if (earliestStart && earliestStart > since) since = earliestStart;
				conversationCoverage = { since, messageIds };
			}
		}

		return {
			userId,
			guildId,
			messages,
			conversations,
			relationships,
			keywords,
			emojis,
			conversationCoverage,
			guildAuthorAvgLengths,
			guildTermStats,
			responseInteractions,
		};
	}

	/**
	 * Extract emoji signature from messages
	 */
	extractEmojiSignature(messages: MessageData[]): EmojiSignature {
		const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
		const emojiCounts: Record<string, number> = {};
		let totalEmojis = 0;

		for (const msg of messages) {
			const emojis = msg.content.match(emojiRegex) || [];
			totalEmojis += emojis.length;

			for (const emoji of emojis) {
				emojiCounts[emoji] = (emojiCounts[emoji] || 0) + 1;
			}
		}

		// Get top emojis
		const topEmojis: Record<string, number> = {};
		const sorted = Object.entries(emojiCounts)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10);

		for (const [emoji, count] of sorted) {
			topEmojis[emoji] = count;
		}

		// Determine timing (simplified)
		const emojiTiming: "reactive" | "proactive" | "mixed" = "mixed";

		return {
			top_emojis: topEmojis,
			emoji_per_message: messages.length > 0 ? totalEmojis / messages.length : 0,
			emoji_timing: emojiTiming,
		};
	}

	/**
	 * Weeks (since epoch) in which each term appeared across the user's conversations, one
	 * entry per conversation containing the term, plus the set of weeks with any conversation.
	 */
	private static termWeeks(conversations: ConversationData[]): {
		termWeeks: Map<string, number[]>;
		activeWeeks: Set<number>;
	} {
		const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
		const activeWeeks = new Set<number>();
		const termWeeks = new Map<string, number[]>();
		for (const conversation of conversations) {
			const week = Math.floor(conversation.start_time.getTime() / WEEK_MS);
			activeWeeks.add(week);
			for (const term of new Set((conversation.keywords ?? []).map((k) => k.toLowerCase()))) {
				const weeks = termWeeks.get(term);
				if (weeks) {
					weeks.push(week);
				} else {
					termWeeks.set(term, [week]);
				}
			}
		}
		return { termWeeks, activeWeeks };
	}

	/**
	 * Build topic affinity from the keywords of the user's recent conversations. A topic is a
	 * term that (a) recurs in at least MIN_TOPIC_CONVERSATIONS of them and (b) is at least
	 * MIN_TOPIC_LIFT times more common in the user's conversations than in the guild's overall
	 * (so filler words like "what" don't count). Frequency is the number of the user's
	 * conversations containing it; consistency is the share of the user's active weeks it
	 * appears in. Returns undefined when nothing qualifies (no topic is invented).
	 */
	private buildTopicAffinity(data: UserAnalysisData): TopicAffinityMap | undefined {
		const MAX_TOPICS = 10;
		const guild = data.guildTermStats;
		if (!guild || guild.totalConversations === 0 || data.conversations.length === 0) {
			return undefined;
		}

		const { termWeeks, activeWeeks } = PsychologicalProfiler.termWeeks(data.conversations);
		const topics = [...termWeeks.entries()]
			.filter(([term, weeks]) => {
				if (weeks.length < MIN_TOPIC_CONVERSATIONS) return false;
				const guildShare = (guild.conversationCounts.get(term) ?? weeks.length) / guild.totalConversations;
				const userShare = weeks.length / data.conversations.length;
				return userShare / guildShare >= MIN_TOPIC_LIFT;
			})
			.map(([term, weeks]) => ({
				term,
				frequency: weeks.length,
				consistency: new Set(weeks).size / activeWeeks.size,
			}))
			.sort((a, b) => b.frequency - a.frequency || b.consistency - a.consistency)
			.slice(0, MAX_TOPICS);

		const topicAffinity: TopicAffinityMap = {};
		for (const topic of topics) {
			topicAffinity[topic.term] = {
				frequency: topic.frequency,
				consistency: Number(topic.consistency.toFixed(2)),
			};
		}

		return topics.length > 0 ? topicAffinity : undefined;
	}

	/**
	 * Build interaction style metrics. Reaction counts are not stored per user in the
	 * database (relationship_edges.reactions is pair-level and undirected), so no
	 * reactions metric is produced.
	 */
	private buildInteractionStyle(data: UserAnalysisData): InteractionStyle {
		const totalMessages = data.messages.length;
		const style: InteractionStyle = {
			mentions_given_per_100msg:
				totalMessages > 0
					? (data.messages.filter((m) => /<@\d+>/.test(m.content)).length /
							totalMessages) *
						100
					: 0,
		};

		if (data.conversations.length > 0) {
			style.avg_conversation_length_messages =
				data.conversations.reduce((sum, c) => sum + c.message_count, 0) /
				data.conversations.length;
		}

		// Only judge messages from the period conversation tracking has covered
		const coverage = data.conversationCoverage;
		if (coverage) {
			const covered = data.messages.filter((m) => m.created_at >= coverage.since);
			if (covered.length > 0) {
				const solo = covered.filter((m) => !coverage.messageIds.has(m.id)).length;
				style.solo_message_rate = solo / covered.length;
			}
		}

		return style;
	}

	/**
	 * Update database with profiles
	 */
	private async updateDatabase(
		userId: string,
		guildId: string,
		psychProfile: PsychProfile,
		behaviorPatterns: BehaviorPatterns,
		temporalProfile: TemporalProfile
	): Promise<boolean> {
		const result = await this.db.updateUserProfilePsych(
			userId,
			guildId,
			psychProfile,
			behaviorPatterns,
			temporalProfile
		);

		return result.success;
	}

	/**
	 * Sleep for specified milliseconds
	 */
	private async sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Print profiling summary
	 */
	private printSummary(): void {
		const duration = this.stats.duration_seconds || 0;

		console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log("📊 PSYCHOLOGICAL PROFILING SUMMARY");
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
		console.log(`   Users Processed:     ${this.stats.users_processed}`);
		console.log(`   Profiles Updated:    ${this.stats.profiles_updated}`);
		console.log(`   API Calls Made:      ${this.stats.api_calls_made}`);
		console.log(`   Errors:              ${this.stats.errors}`);
		console.log(`   Duration:            ${duration.toFixed(1)}s`);
		console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	}

	/**
	 * Get current stats
	 */
	getStats(): ProfilingStats {
		return { ...this.stats };
	}
}
