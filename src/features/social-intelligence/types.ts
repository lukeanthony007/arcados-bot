/**
 * Unified types for Social Intelligence System
 *
 * This system transforms raw Discord interactions into structured,
 * queryable relationship and conversation insights.
 */

// ============================================================================
// CONVERSATION TYPES
// ============================================================================

export interface StreamingConversation {
	id: string;
	guild_id: string;
	channel_id: string;
	participants: string[]; // user IDs
	message_ids: string[];
	message_count: number;
	start_time: Date;
	last_activity: Date;
	status: "active" | "finalizing";
	preliminary_keywords: KeywordScore[];
	preliminary_embedding?: number[];
	created_at: Date;
	updated_at: Date;
}

export interface FinalizedConversation {
	id: string;
	guild_id: string;
	channel_id: string;
	participants: string[];
	message_ids: string[];
	message_count: number;
	start_time: Date;
	end_time: Date;
	status: "finalized";
	features: ConversationFeatures;
	summary?: string;
	ai_processing_status?: string;
	ai_metadata?: Record<string, any>;
}

export interface ConversationFeatures {
	keywords: KeywordScore[];
	embeddings?: number[][];
	interaction_types: InteractionType[];
	topic_center?: number[];
	semantic_score?: number;
}

export type InteractionType =
	| "message"
	| "mention"
	| "reply"
	| "reaction"
	| "same_channel"
	| "conversation";

export interface ConversationEntry {
	segment_id: string;
	participants: string[];
	start_time: Date;
	end_time: Date;
	message_count: number;
	summary?: string;
	keywords?: string[];
	channel_id?: string;
	message_ids?: string[];
	interaction_types?: InteractionType[];
	duration_minutes?: number;
	conversation_id?: string;
	has_name_usage?: boolean;
}

// ============================================================================
// SEMANTIC TYPES
// ============================================================================

export interface KeywordScore {
	word: string;
	score: number;
	type: "tfidf" | "semantic" | "hybrid";
	frequency?: number;
}

export interface ConversationKeywords {
	terms: KeywordScore[];
	method: "tfidf" | "semantic" | "hybrid";
	extracted_at: Date;
}

export interface GuildVocabulary {
	guild_id: string;
	term: string;
	idf_score: number;
	document_frequency: number;
	total_documents: number;
	is_stopword: boolean;
	updated_at: Date;
}

// ============================================================================
// GROUPING STRATEGY TYPES
// ============================================================================

export interface GroupingContext {
	guildId: string;
	channelId: string;
	messages: GroupableMessage[];
	existingGroups: ConversationGroupData[];
	scorer: any; // ConversationScorer
}

export interface GroupableMessage {
	id: string;
	author_id: string;
	content: string;
	created_at: Date;
	guild_id: string;
	channel_id: string;
	referenced_message_id?: string;
	mentioned_user_ids?: string[];
	embedding?: number[];
}

export interface ConversationGroupData {
	id: string;
	messageIds: string[];
	participants: Set<string>;
	startTime: Date;
	endTime: Date;
	embeddings: number[][];
	keywords?: string[];
}

export interface GroupingResult {
	messageId: string;
	groupId: string | null;
	confidence: number;
	strategy: string;
}

// ============================================================================
// STORAGE TYPES
// ============================================================================

export interface DatabaseResult<T> {
	success: boolean;
	data?: T;
	error?: string;
}

// ============================================================================
// QUERY OPTIONS
// ============================================================================

export interface ConversationQueryOptions {
	includeStreaming?: boolean; // Include active conversations (default: true)
	includeFinalized?: boolean; // Include finalized conversations (default: true)
	minMessages?: number; // Minimum message count
	startDate?: Date; // Filter by start time
	endDate?: Date; // Filter by end time
	participants?: string[]; // Filter by participant user IDs
}

export interface SemanticSearchOptions {
	includeStreaming?: boolean; // Search streaming conversations (default: true)
	minSimilarity?: number; // Minimum cosine similarity (default: 0.3)
	limit?: number; // Max results (default: 20)
}
