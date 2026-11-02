/**
 * Psychological Profiling Types
 *
 * Comprehensive type definitions for user psychological profiles,
 * behavioral patterns, and temporal activity analysis.
 */

// ============================================================================
// Big Five Personality Traits
// ============================================================================

export interface PersonalityTrait {
	score: number; // 0-1 scale
	confidence: number; // 0-1, based on data quality
	indicators: string[]; // Behavioral indicators supporting this score
}

export interface BigFiveProxies {
	extraversion: PersonalityTrait; // Sociability, activity level, positive emotions
	agreeableness: PersonalityTrait; // Cooperation, empathy, conflict avoidance
	conscientiousness: PersonalityTrait; // Organization, consistency, reliability
	neuroticism: PersonalityTrait; // Emotional stability, volatility, stress response
	openness: PersonalityTrait; // Curiosity, creativity, topic diversity
}

// ============================================================================
// Myers-Briggs Type Indicator (MBTI)
// ============================================================================

/**
 * MBTI dichotomy (E/I, S/N, T/F, J/P)
 */
export interface MBTIDichotomy {
	score: number; // -1.0 to +1.0 (positive = E/N/F/P, negative = I/S/T/J)
	preference: "E" | "I" | "S" | "N" | "T" | "F" | "J" | "P" | "X"; // Leaning letter; X = no lean (|score| < 0.1). Weak leans are reflected in `confidence`, not X.
	confidence: number; // 0-1, based on data quality and consistency
	indicators: string[]; // Behavioral evidence supporting this preference
}

/**
 * Myers-Briggs Type Indicator (MBTI) personality type
 */
export interface MBTIType {
	type: string; // e.g., "INTJ", "ENFP"; a letter is "X" only when that dichotomy has no lean at all
	confidence: number; // Overall confidence (average of dichotomies)
	dichotomies: {
		E_I: MBTIDichotomy; // Extraversion vs Introversion
		S_N: MBTIDichotomy; // Sensing vs Intuition
		T_F: MBTIDichotomy; // Thinking vs Feeling
		J_P: MBTIDichotomy; // Judging vs Perceiving
	};
	descriptors: string[]; // e.g., ["analytical", "strategic", "independent"]
}

// ============================================================================
// Communication Style
// ============================================================================

export type ElaborationStyle = "brief" | "balanced" | "verbose";

export interface CommunicationStyle {
	formality: number; // 0=casual, 1=formal
	verbosity?: number; // Avg message length percentile within the guild (0-1); omitted without guild data
	emoji_richness: number; // Diversity + frequency (0-1)
	question_frequency: number; // Questions per 100 messages (0-1)
	elaboration_style: ElaborationStyle;
}

// ============================================================================
// Topic Affinity
// ============================================================================

export interface TopicAffinity {
	frequency: number; // Number of the user's recent conversations whose keywords include this topic
	consistency: number; // 0-1, share of the user's active weeks (weeks with a conversation) that included this topic
}

export interface TopicAffinityMap {
	[topic: string]: TopicAffinity;
}

// ============================================================================
// Profile Metadata
// ============================================================================

export interface ProfileMetadata {
	message_count_at_analysis: number; // Message count when profile was generated
	confidence_overall: number; // 0-1, overall confidence in profile accuracy
	last_updated: string; // ISO 8601 timestamp
	staleness_threshold: number; // Messages before re-analysis needed (default 50)
}

// ============================================================================
// Psychological Profile (psych_profile JSONB)
// ============================================================================

export interface PsychProfile {
	big_five_proxies?: BigFiveProxies;
	mbti_type?: MBTIType; // Myers-Briggs personality type (derived from Big Five + behavioral validation)
	communication_style?: CommunicationStyle;
	topic_affinity?: TopicAffinityMap;
	profile_metadata: ProfileMetadata;
}

// ============================================================================
// Response Patterns
// ============================================================================

// Fields are omitted when the underlying data is unavailable rather than defaulted.
export interface ResponsePatterns {
	avg_response_latency_minutes?: number; // Median time to reply to others' messages
	question_answer_rate?: number; // 0-1, % of questions mentioning the user that were answered within 1h
	turn_taking_balance?: number; // 0-1, balance in conversation participation
	conversation_initiation_rate?: number; // 0-1, % of convos user initiated
}

// ============================================================================
// Emoji Signature
// ============================================================================

export type EmojiTiming = "reactive" | "proactive" | "mixed";

export interface EmojiSignature {
	top_emojis: Record<string, number>; // Emoji -> frequency count
	emoji_per_message: number; // Average emojis per message
	emoji_timing: EmojiTiming;
}

// ============================================================================
// Interaction Style
// ============================================================================

export interface InteractionStyle {
	mentions_given_per_100msg: number; // Mentions given per 100 messages
	avg_conversation_length_messages?: number; // Avg messages per conversation (omitted when the user has no conversations)
	solo_message_rate?: number; // 0-1, % of messages (since the user's first tracked conversation) not in any conversation; omitted when no conversations
}

// ============================================================================
// Behavior Patterns (behavior_patterns JSONB)
// ============================================================================

export interface BehaviorPatterns {
	response_patterns?: ResponsePatterns;
	emoji_signature?: EmojiSignature;
	interaction_style?: InteractionStyle;
}

// ============================================================================
// Circadian Rhythm
// ============================================================================

export interface CircadianRhythm {
	peak_hours_utc: number[]; // Peak activity hours (0-23)
	timezone_estimate: string; // IANA timezone (e.g., "America/New_York")
	regularity_score: number; // 0-1, consistency of activity timing
	night_owl_score: number; // 0-1, tendency to be active late night
}

// ============================================================================
// Activity Patterns
// ============================================================================

export interface ActivityPatterns {
	messages_per_day_avg: number; // Average messages per day
	active_days_per_week: number; // Average days active per week
	longest_active_streak_days: number; // Longest consecutive active days
	burst_tendency: number; // 0-1, tendency to send messages in bursts
}

// ============================================================================
// Temporal Profile (temporal_profile JSONB)
// ============================================================================

export interface TemporalProfile {
	circadian_rhythm?: CircadianRhythm;
	activity_patterns?: ActivityPatterns;
}

// ============================================================================
// Analyzer Input Data
// ============================================================================

export interface MessageData {
	id: string;
	content: string;
	created_at: Date;
	author_id: string;
	referenced_message_id?: string;
	attachments?: string[];
	embeds?: string[];
}

export interface ConversationData {
	id: string;
	participants: string[];
	message_count: number;
	start_time: Date;
	end_time: Date;
	keywords?: string[];
	user_message_count?: number; // Messages the user sent in this conversation
	first_author_id?: string; // Author of the earliest message in the conversation
}

export interface RelationshipData {
	user_id: string;
	affinity_percentage: number;
	interaction_count: number;
	last_interaction: Date;
}

export interface UserAnalysisData {
	userId: string;
	guildId: string;
	messages: MessageData[];
	conversations: ConversationData[];
	relationships: RelationshipData[];
	keywords?: string[];
	emojis?: string[];
	/**
	 * Message IDs from every conversation the user took part in since their first tracked
	 * conversation, plus that conversation's start time. Undefined when no conversations exist.
	 */
	conversationCoverage?: { since: Date; messageIds: Set<string> };
	/** Per-author average message length across the guild (for verbosity percentiles). */
	guildAuthorAvgLengths?: number[];
	/** Guild-wide number of conversations containing each term (topic distinctiveness baseline). */
	guildTermStats?: { totalConversations: number; conversationCounts: Map<string, number> };
	/** Reply/question interaction data the user's own messages cannot provide. */
	responseInteractions?: ResponseInteractionData;
}

/**
 * Facts about the user's interactions with other people's messages, queried from the
 * database (the user's own message list does not contain them).
 */
export interface ResponseInteractionData {
	/** Minutes between someone else's message and the user's reply to it (<= 24h). */
	reply_latencies_minutes: number[];
	/** Messages from others that mention the user and contain a question mark. */
	questions_received: number;
	/** Of those, how many the user answered by posting in the same channel within 1 hour. */
	questions_answered: number;
}

// ============================================================================
// Analyzer Results
// ============================================================================

export interface AnalyzerResult<T> {
	success: boolean;
	data?: T;
	error?: string;
	confidence?: number; // 0-1, confidence in the analysis
}

// ============================================================================
// Community Structure
// ============================================================================

export interface CommunityCluster {
	cluster_id: string;
	participant_ids: string[];
	cluster_size: number;
	internal_edge_density: number; // 0-1, how tightly connected
	external_edge_density: number; // 0-1, connections outside cluster
	avg_internal_affinity: number; // Average affinity within cluster
	cluster_label?: string; // AI-generated label (e.g., "gaming crew")
}

export interface InfluenceRanking {
	user_id: string;
	influence_score: number; // 0-1, normalized influence
	rank: number; // 1-indexed rank in guild
	engagement_score: number; // Total reactions + replies received
}

export interface GuildMetadata {
	guild_id: string;
	community_clusters: CommunityCluster[];
	influence_rankings: Record<string, InfluenceRanking>; // user_id -> ranking
	last_analysis: Date;
	created_at: Date;
	updated_at: Date;
}

// ============================================================================
// Profiling Statistics
// ============================================================================

export interface ProfilingStats {
	users_processed: number;
	profiles_created: number;
	profiles_updated: number;
	errors: number;
	api_calls_made: number;
	start_time: Date;
	end_time?: Date;
	duration_seconds?: number;
}
