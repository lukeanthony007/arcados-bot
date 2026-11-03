import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import type { DatabaseResult } from "../../../database/PostgreSQLManager";
import type { ConversationEntry } from "../types";
import {
  TopicDriftDetector,
  type ConversationSplit,
  type Message as DriftMessage,
} from "../semantic-analysis/TopicDriftDetector";
import { EmbeddingService } from "../semantic-analysis/EmbeddingService";
import { KNOWN_BOT_USER_IDS } from "./constants";
import { parseEmbedding as parseEmbeddingValue } from "./messageUtils";
import { ConversationScorer } from "./ConversationScorer";
import { ConversationValidator } from "./ConversationValidator";
import { ConversationGrouper } from "./ConversationGrouper";
import { ConversationGroup } from "./ConversationGroup";
import type { GroupingContext } from "./strategies/GroupingStrategy";
import { KeywordExtractor } from "../semantic-analysis/KeywordExtractor";
import type { KeywordMessage } from "../semantic-analysis/types";

interface ActiveConversation {
  participants: Set<string>;
  messageIds: Set<string>;
  lastActivity: Date;
  topicEmbedding?: number[]; // Semantic center of conversation
  topicEmbeddingCount?: number; // Number of embeddings included in topicEmbedding
}

interface ChannelBuffer {
  messages: Array<{
    id: string;
    author_id: string;
    content: string;
    created_at: Date;
    referenced_message_id?: string;
    mentioned_user_ids?: string[];
    embedding?: number[];
  }>;
  startTime: Date;
  lastActivity: Date;
  timeoutHandle?: NodeJS.Timeout;
  guildId: string;
  channelId: string;
  activeConversations: ActiveConversation[];
}

interface SegmentContext {
  id: string;
  start: Date;
  end: Date;
  participants: Set<string>;
  messageIds: string[];
  messages: DriftMessage[];
}

interface CachedEdgeData {
  data: any;
  expiredAt: number;
}

export class ConversationDetector {
  private db: PostgreSQLManager;
  private channelBuffers: Map<string, ChannelBuffer> = new Map();
  private finalizationLocks: Map<string, Promise<void>> = new Map();
  private edgeCache: Map<string, CachedEdgeData> = new Map(); // Cache for edge queries
  private embeddingService = EmbeddingService.getInstance();
  private readonly EDGE_CACHE_TTL = 5 * 60 * 1000; // 5 minute cache TTL
  private readonly INACTIVITY_MS = 10 * 60 * 1000; // 10 minute base inactivity (increased from 5 to better handle natural pauses)
  private readonly INACTIVITY_MS_WITH_REPLIES = 20 * 60 * 1000; // 20 minutes when there are active replies/mentions (increased from 15)
  private readonly MIN_MESSAGES = 3; // Minimum 3 messages required for a conversation
  private readonly PRE_CONVERSATION_GRACE_MS = 3 * 60 * 1000; // Include up to 3 minutes of prelude chatter (increased from 2)
  private topicDriftDetector: TopicDriftDetector;

  // New optimized components
  private scorer: ConversationScorer;
  private validator: ConversationValidator;
  private grouper: ConversationGrouper<any>;
  private keywordExtractor: KeywordExtractor;

  // Time-based constraints to prevent unrealistic conversation grouping
  private readonly MAX_REPLY_CHAIN_GAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days - don't follow reply chains older than this
  private readonly MAX_CONVERSATION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours - conversations can't span more than a day
  private readonly MAX_MESSAGE_GAP_MS = 8 * 60 * 60 * 1000; // 8 hours - max gap between consecutive messages in a conversation (increased from 4 for async discussions)
  private readonly FORCE_FLUSH_MESSAGE_COUNT = 50; // Force-finalize after 50 buffered messages even if conversation is active (increased from 25)
  private readonly FORCE_FLUSH_DURATION_MS = 30 * 60 * 1000; // Force-finalize after 30 minutes of continuous activity (increased from 15)
  private readonly ORPHAN_LOOKBACK_MS = 30 * 60 * 1000; // Look back 30 minutes when reconciling orphan messages

  // Pre-compile regex patterns for better performance
  private readonly mentionPattern = /<@!?(\d+)>/g;
  private readonly replyPatterns = [/^re:/i, /^>/, /^@\w+/, /^responding to/i];
  private readonly questionPatterns = [
    /\?$/,
    /^(what|how|why|when|where|who|can|could|would|should|do|does|did|is|are|was|were)\s/i,
    /^(hey|hi|hello)\s/i,
  ];
  private readonly directAddressPatterns = [
    /^(you|your|yours)\s/i,
    /^(i think|i believe|i feel|i know)\s/i,
    /^(thanks|thank you|thx)/i,
    /^(sorry|apologize|apologies)/i,
  ];
  private readonly reactionPatterns = [
    /(👍|👎|❤️|😀|😢|😮|😡|🤔|👏|🙌)/,
    /(lol|lmao|haha|hehe)/i,
    /(omg|wtf|wow|damn)/i,
  ];

  constructor(db: PostgreSQLManager) {
    this.db = db;
    this.topicDriftDetector = new TopicDriftDetector(this.db);

    // Initialize optimized components
    this.scorer = new ConversationScorer(this.db);
    this.validator = new ConversationValidator(
      this.MAX_CONVERSATION_DURATION_MS,
      this.MAX_MESSAGE_GAP_MS,
      this.MIN_MESSAGES
    );
    this.grouper = new ConversationGrouper(this.scorer);
    this.keywordExtractor = new KeywordExtractor(this.db);
  }

  /**
   * Get or retrieve edge data with caching
   */
  private async getCachedEdge(
    guildId: string,
    user1: string,
    user2: string
  ): Promise<any> {
    const cacheKey = `${guildId}:${user1}:${user2}`;
    const now = Date.now();

    // Check cache
    const cached = this.edgeCache.get(cacheKey);
    if (cached && cached.expiredAt > now) {
      return cached.data;
    }

    // Fetch from DB
    const data = await this.db.getEdgeForPair(guildId, user1, user2);

    // Update cache
    this.edgeCache.set(cacheKey, {
      data,
      expiredAt: now + this.EDGE_CACHE_TTL,
    });

    return data;
  }

  /**
   * Cleanup expired cache entries
   */
  private cleanupEdgeCache(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.edgeCache.entries()) {
      if (entry.expiredAt < now) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.edgeCache.delete(key);
    }
  }

  /**
   * Get lightweight conversation references for two users (optimized for relationship_network)
   * Returns segment references without full message data
   */
  async getConversationSegmentsForUsers(
    user1Id: string,
    user2Id: string,
    guildId: string,
    limit: number = 20
  ): Promise<DatabaseResult<ConversationEntry[]>> {
    try {
      // Get segments where both users are participants
      const result = await this.db.query(
        `
        SELECT
          id as segment_id,
          start_time,
          end_time,
          message_count,
          channel_id,
          array_length(participants, 1) as participant_count,
          EXTRACT(EPOCH FROM (end_time - start_time))/60::int as duration_minutes,
          features->>'interaction_types' as interaction_types
        FROM conversation_segments
        WHERE guild_id = $1
          AND participants @> $2::TEXT[]
          AND participants @> $3::TEXT[]
        ORDER BY end_time DESC
        LIMIT $4
        `,
        [guildId, [user1Id], [user2Id], limit]
      );

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      const conversations: ConversationEntry[] = (result.data || []).map((row: any) => ({
        segment_id: row.segment_id,
        start_time: new Date(row.start_time),
        end_time: new Date(row.end_time),
        message_count: row.message_count,
        participants: row.participants || [],
        channel_id: row.channel_id,
        interaction_types: row.interaction_types ? row.interaction_types.split(',') : [],
        duration_minutes: row.duration_minutes || 0,
      }));

      return { success: true, data: conversations };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Detect conversations between two users using interaction-driven clustering
   */
  async detectConversations(
    user1Id: string,
    user2Id: string,
    guildId: string,
    timeWindowMinutes: number = 5
  ): Promise<DatabaseResult<ConversationEntry[]>> {
    try {
      // Get all messages between the two users
      const messagesResult = await this.db.getMessagesBetweenUsers(
        user1Id,
        user2Id,
        guildId
      );

      if (!messagesResult.success || !messagesResult.data) {
        return {
          success: false,
          error: `Failed to get messages: ${messagesResult.error}`,
        };
      }

      const messages = messagesResult.data;
      if (messages.length === 0) {
        return { success: true, data: [] };
      }

      // Get user names for both users
      const [user1NamesResult, user2NamesResult] = await Promise.all([
        this.db.getUserNames(user1Id, guildId),
        this.db.getUserNames(user2Id, guildId),
      ]);

      const user1Names = user1NamesResult.success
        ? user1NamesResult.data || []
        : [];
      const user2Names = user2NamesResult.success
        ? user2NamesResult.data || []
        : [];

      // Cluster messages into conversations
      const conversations = this.clusterMessagesIntoConversations(
        messages,
        timeWindowMinutes,
        user1Id,
        user2Id,
        user1Names,
        user2Names
      );

      return { success: true, data: conversations };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Detect conversations in a channel using relationship-aware scoring
   * Supports multi-party conversations and uses guild-wide relationship context
   *
   * @param channelId - Channel to analyze
   * @param guildId - Guild ID for relationship context
   * @param timeWindowHours - How far back to analyze (default: 24h)
   * @param minMessages - Minimum messages to form a conversation (default: 3)
   * @returns Array of conversation segments with participants and message IDs
   */
  async detectConversationsEnhanced(
    channelId: string,
    guildId: string,
    timeWindowHours: number = 24,
    minMessages: number = 3
  ): Promise<DatabaseResult<ConversationEntry[]>> {
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - timeWindowHours);

      // Fetch messages from channel
      const messagesResult = await this.db.query(
        `SELECT
          m.id, m.author_id, m.content, m.created_at, m.referenced_message_id,
          u.display_name, u.username
        FROM messages m
        LEFT JOIN members u ON u.user_id = m.author_id AND u.guild_id = m.guild_id
        WHERE m.channel_id = $1 AND m.guild_id = $2
          AND m.created_at >= $3 AND m.active = true
        ORDER BY m.created_at ASC`,
        [channelId, guildId, cutoffTime]
      );

      if (!messagesResult.success || !messagesResult.data || messagesResult.data.length === 0) {
        return { success: true, data: [] };
      }

      type ChannelMessageRow = {
        id: string;
        author_id: string;
        content: string | null;
        created_at: Date;
        referenced_message_id?: string | null;
        display_name?: string | null;
        username?: string | null;
      };

      const messages = (messagesResult.data as ChannelMessageRow[]) || [];
      const uniqueAuthors = new Set<string>(messages.map((m) => m.author_id));

      // Build relationship context for all participants
      const relationshipContext = await this.buildRelationshipContextForChannel(
        Array.from(uniqueAuthors),
        guildId
      );

      // Group messages using relationship-aware scoring
      const conversations = this.clusterMessagesWithRelationships(
        messages,
        relationshipContext,
        guildId,
        minMessages
      );

      return { success: true, data: conversations };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Build relationship context for channel participants
   */
  private async buildRelationshipContextForChannel(
    userIds: string[],
    guildId: string
  ): Promise<Map<string, Map<string, number>>> {
    const affinityMatrix = new Map<string, Map<string, number>>();

    // Get relationship data for all user pairs
    for (let i = 0; i < userIds.length; i++) {
      for (let j = i + 1; j < userIds.length; j++) {
        const userA = userIds[i];
        const userB = userIds[j];

        if (!userA || !userB) continue;

        // Get bidirectional edge data
        const [edgeAB, edgeBA] = await Promise.all([
          this.getCachedEdge(guildId, userA, userB),
          this.getCachedEdge(guildId, userB, userA),
        ]);

        // Calculate combined interaction score
        let totalInteractions = 0;
        if (edgeAB?.success && edgeAB.data) {
          totalInteractions += edgeAB.data.total || 0;
        }
        if (edgeBA?.success && edgeBA.data) {
          totalInteractions += edgeBA.data.total || 0;
        }

        // Normalize using log scale
        const affinityScore = totalInteractions > 0
          ? Math.min(1.0, Math.log10(totalInteractions + 1) / 3)
          : 0;

        // Store bidirectionally
        if (!affinityMatrix.has(userA)) {
          affinityMatrix.set(userA, new Map());
        }
        if (!affinityMatrix.has(userB)) {
          affinityMatrix.set(userB, new Map());
        }

        affinityMatrix.get(userA)!.set(userB, affinityScore);
        affinityMatrix.get(userB)!.set(userA, affinityScore);
      }
    }

    return affinityMatrix;
  }

  /**
   * Cluster messages using relationship-aware scoring (similar to test script)
   */
  private clusterMessagesWithRelationships(
    messages: any[],
    affinityMatrix: Map<string, Map<string, number>>,
    guildId: string,
    minMessages: number
  ): ConversationEntry[] {
    interface TempConversation {
      id: string;
      participants: Set<string>;
      messageIds: Set<string>;
      messages: any[];
      startTime: Date;
      endTime: Date;
      avgAffinity: number;
    }

    const conversations: TempConversation[] = [];
    const processedMessages = new Set<string>();

    // Phase 1: Group by explicit signals (replies, mentions)
    for (const msg of messages) {
      if (processedMessages.has(msg.id)) continue;

      let targetConvo: TempConversation | undefined;

      // Check for reply chains
      if (msg.referenced_message_id) {
        targetConvo = conversations.find((c) => c.messageIds.has(msg.referenced_message_id));
      }

      // Check for mentions
      if (!targetConvo && msg.content) {
        const mentionMatches = msg.content.match(this.mentionPattern);
        if (mentionMatches) {
          const mentionedIds = mentionMatches.map((m: string) =>
            m.replace(/<@!?(\d+)>/, "$1")
          );

          // Find conversation with mentioned users
          for (const convo of conversations) {
            for (const mentionedId of mentionedIds) {
              if (convo.participants.has(mentionedId)) {
                const timeDelta = new Date(msg.created_at).getTime() - convo.endTime.getTime();
                if (timeDelta <= 5 * 60 * 1000) {
                  targetConvo = convo;
                  break;
                }
              }
            }
            if (targetConvo) break;
          }

          // Create new conversation with mentioned user
          if (!targetConvo && mentionedIds.length > 0) {
            targetConvo = {
              id: `conv_${msg.id}`,
              participants: new Set([msg.author_id, ...mentionedIds]),
              messageIds: new Set([msg.id]),
              messages: [msg],
              startTime: new Date(msg.created_at),
              endTime: new Date(msg.created_at),
              avgAffinity: 0,
            };
            conversations.push(targetConvo);
            processedMessages.add(msg.id);
            continue;
          }
        }
      }

      if (targetConvo) {
        targetConvo.messageIds.add(msg.id);
        targetConvo.participants.add(msg.author_id);
        targetConvo.messages.push(msg);
        targetConvo.endTime = new Date(msg.created_at);
        processedMessages.add(msg.id);
      }
    }

    // Phase 2: Score remaining messages against conversations
    for (const msg of messages) {
      if (processedMessages.has(msg.id)) continue;

      let bestScore = 0;
      let bestConvo: TempConversation | null = null;

      for (const convo of conversations) {
        const timeDelta = new Date(msg.created_at).getTime() - convo.endTime.getTime();
        const timeSinceEndMin = timeDelta / (1000 * 60);

        // Dynamic time window: base 45 min, extended for participant continuity
        const isParticipant = convo.participants.has(msg.author_id);
        const isSmallGroup = convo.participants.size <= 3;
        const maxTimeWindow = (isParticipant && isSmallGroup) ? 45 * 60 * 1000 : 20 * 60 * 1000;

        if (timeDelta > maxTimeWindow) continue; // Skip if too old

        // Calculate max affinity to conversation participants
        let maxAffinity = 0;
        for (const participantId of convo.participants) {
          if (participantId === msg.author_id) continue;
          const affinity = affinityMatrix.get(msg.author_id)?.get(participantId) || 0;
          if (affinity > maxAffinity) {
            maxAffinity = affinity;
          }
        }

        // Temporal score
        const temporalScore = Math.max(0, 1 - timeDelta / maxTimeWindow);

        // Combined score: relationship (60%) + temporal (40%)
        let score = maxAffinity * 0.6 + temporalScore * 0.4;

        // Participant continuity bonus: same small group within 45 min
        if (isParticipant && isSmallGroup && timeSinceEndMin <= 45) {
          score += 0.2;
        }

        if (score > bestScore) {
          bestScore = score;
          bestConvo = convo;
        }
      }

      // Assign if score > threshold
      if (bestScore > 0.25 && bestConvo) {
        bestConvo.messageIds.add(msg.id);
        bestConvo.participants.add(msg.author_id);
        bestConvo.messages.push(msg);
        bestConvo.endTime = new Date(msg.created_at);
        processedMessages.add(msg.id);
      } else {
        // Proximity fallback: Group if very close in time (2 min)
        for (const convo of conversations) {
          const timeDelta = Math.abs(
            new Date(msg.created_at).getTime() - convo.endTime.getTime()
          );
          if (timeDelta <= 2 * 60 * 1000) {
            convo.messageIds.add(msg.id);
            convo.participants.add(msg.author_id);
            convo.messages.push(msg);
            convo.endTime = new Date(msg.created_at);
            processedMessages.add(msg.id);
            break;
          }
        }
      }
    }

    // Calculate average affinity and convert to ConversationEntry
    const result: ConversationEntry[] = [];

    for (const convo of conversations) {
      if (convo.messages.length < minMessages) continue;

      // Sort messages chronologically to ensure accurate start/end times
      convo.messages.sort(
        (a, b) => a.created_at.getTime() - b.created_at.getTime()
      );
      convo.messageIds = new Set(convo.messages.map((m) => m.id));
      convo.startTime = convo.messages[0]
        ? new Date(convo.messages[0].created_at)
        : convo.startTime;
      convo.endTime = convo.messages[convo.messages.length - 1]
        ? new Date(convo.messages[convo.messages.length - 1].created_at)
        : convo.endTime;

      // Calculate average affinity between all participant pairs
      const participants = Array.from(convo.participants);
      let totalAffinity = 0;
      let pairCount = 0;

      for (let i = 0; i < participants.length; i++) {
        for (let j = i + 1; j < participants.length; j++) {
          const affinity = affinityMatrix.get(participants[i]!)?.get(participants[j]!) || 0;
          totalAffinity += affinity;
          pairCount++;
        }
      }

      convo.avgAffinity = pairCount > 0 ? totalAffinity / pairCount : 0;

      // Get channel ID from first message
      const channelId = convo.messages[0]?.channel_id || "";

      // Check for mentions
      const hasMentions = convo.messages.some(
        (m) => m.content && m.content.includes("<@")
      );

      result.push({
        segment_id: convo.id,
        conversation_id: convo.id,
        start_time: convo.startTime,
        end_time: convo.endTime,
        message_count: convo.messages.length,
        participants,
        channel_id: channelId,
        message_ids: Array.from(convo.messageIds),
        interaction_types: hasMentions ? ["mention"] : [],
        duration_minutes: Math.round(
          (convo.endTime.getTime() - convo.startTime.getTime()) / (1000 * 60)
        ),
      });
    }

    return result;
  }

  /**
   * Cluster messages into conversations based on interaction patterns
   */
  private clusterMessagesIntoConversations(
    messages: any[],
    timeWindowMinutes: number,
    user1Id: string,
    user2Id: string,
    user1Names: string[],
    user2Names: string[]
  ): ConversationEntry[] {
    if (messages.length === 0) {
      return [];
    }

    // Filter out bot commands and messages without meaningful content
    const validMessages = messages.filter(
      (m) =>
        !this.isBotCommand(m.content || "") &&
        this.hasMeaningfulContent(m.content || "")
    );

    if (validMessages.length === 0) {
      return [];
    }

    // Require at least one message with substantial content
    const hasSubstantialContent = validMessages.some(
      (m) => m.content && m.content.trim().length >= 10
    );
    if (!hasSubstantialContent) {
      return []; // All messages are too short/superficial
    }

    // Group messages by channel first, then cluster within each channel
    const messagesByChannel = new Map<string, any[]>();
    for (const msg of validMessages) {
      const channelId = msg.channel_id || "unknown";
      if (!messagesByChannel.has(channelId)) {
        messagesByChannel.set(channelId, []);
      }
      messagesByChannel.get(channelId)!.push(msg);
    }

    const conversations: ConversationEntry[] = [];
    const timeWindowMs = timeWindowMinutes * 60 * 1000;

    // Process each channel separately
    for (const [channelId, channelMessages] of messagesByChannel.entries()) {
      // Sort messages by time within this channel
      channelMessages.sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      let currentConversation: any[] = [];
      let conversationStartTime: Date | null = null;

      for (let i = 0; i < channelMessages.length; i++) {
        const message = channelMessages[i];

        // Check if this message starts a new conversation
        const shouldStartNewConversation = this.shouldStartNewConversation(
          message,
          channelMessages,
          i,
          currentConversation,
          conversationStartTime,
          timeWindowMs,
          user1Id,
          user2Id,
          user1Names,
          user2Names
        );

        if (shouldStartNewConversation && currentConversation.length > 0) {
          // Finalize current conversation
          conversations.push(
            this.createConversationEntry(
              currentConversation,
              conversationStartTime!,
              user1Id,
              user2Id,
              user1Names,
              user2Names
            )
          );

          // Start new conversation
          currentConversation = [message];
          conversationStartTime = new Date(message.created_at);
        } else if (currentConversation.length === 0) {
          // First message
          currentConversation = [message];
          conversationStartTime = new Date(message.created_at);
        } else {
          // Continue current conversation
          currentConversation.push(message);
        }
      }

      // Add the last conversation in this channel if it exists
      if (currentConversation.length > 0 && conversationStartTime) {
        conversations.push(
          this.createConversationEntry(
            currentConversation,
            conversationStartTime,
            user1Id,
            user2Id,
            user1Names,
            user2Names
          )
        );
      }
    }

    // Filter out conversations that don't have actual back-and-forth
    const validConversations = conversations.filter((conv) => {
      // Must have at least 2 messages
      if (conv.message_count < 2) return false;

      // Must have messages from both users
      const hasUser1Messages = conv.message_ids?.some((id: string) => {
        const message = validMessages.find((m) => m.id === id);
        return message && message.author_id === user1Id;
      });
      const hasUser2Messages = conv.message_ids?.some((id: string) => {
        const message = validMessages.find((m) => m.id === id);
        return message && message.author_id === user2Id;
      });

      return hasUser1Messages && hasUser2Messages;
    });

    return validConversations;
  }

  /**
   * Determine if a message should start a new conversation
   */
  private shouldStartNewConversation(
    message: any,
    allMessages: any[],
    currentIndex: number,
    currentConversation: any[],
    conversationStartTime: Date | null,
    timeWindowMs: number,
    user1Id: string,
    user2Id: string,
    user1Names: string[],
    user2Names: string[]
  ): boolean {
    if (currentConversation.length === 0) {
      return false; // No current conversation to compare against
    }

    const messageTime = new Date(message.created_at).getTime();
    const lastConversationTime = new Date(
      currentConversation[currentConversation.length - 1].created_at
    ).getTime();

    // Check for time gap - if more than timeWindowMs has passed
    if (messageTime - lastConversationTime > timeWindowMs) {
      return true;
    }

    return false;
  }

  /**
   * Check if a message has direct interaction (reply, mention, or name usage)
   */
  private hasDirectInteraction(
    message: any,
    allMessages: any[],
    currentIndex: number,
    user1Id: string,
    user2Id: string,
    user1Names: string[],
    user2Names: string[]
  ): boolean {
    const content = message.content;
    if (!content || content.length === 0) {
      return false;
    }

    // Check for mentions in content
    if (this.mentionPattern.test(content)) {
      return true;
    }

    // Check for name-based interactions
    const otherUserNames =
      message.author_id === user1Id ? user2Names : user1Names;
    for (const name of otherUserNames) {
      if (name && content.toLowerCase().includes(name.toLowerCase())) {
        return true;
      }
    }

    const trimmedContent = content.trim();

    // Check for reply patterns
    for (const pattern of this.replyPatterns) {
      if (pattern.test(trimmedContent)) {
        return true;
      }
    }

    // Check for question patterns
    for (const pattern of this.questionPatterns) {
      if (pattern.test(trimmedContent)) {
        return true;
      }
    }

    // Check for direct address patterns
    for (const pattern of this.directAddressPatterns) {
      if (pattern.test(trimmedContent)) {
        return true;
      }
    }

    // Check for reaction patterns
    for (const pattern of this.reactionPatterns) {
      if (pattern.test(content)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Create a ConversationEntry from a cluster of messages
   */
  private createConversationEntry(
    messages: any[],
    startTime: Date,
    user1Id: string,
    user2Id: string,
    user1Names: string[],
    user2Names: string[]
  ): ConversationEntry {
    const endTime = new Date(messages[messages.length - 1].created_at);
    const durationMs = endTime.getTime() - startTime.getTime();
    const durationMinutes = Math.round(durationMs / (1000 * 60));

    // Check for mentions efficiently
    const hasMentions = messages.some(
      (message) => message.content && message.content.includes("<@")
    );

    // Check for actual name usage in messages
    const hasNameUsage = messages.some((message) => {
      if (!message.content) return false;

      const otherUserNames =
        message.author_id === user1Id ? user2Names : user1Names;
      return otherUserNames.some(
        (name) =>
          name && message.content.toLowerCase().includes(name.toLowerCase())
      );
    });

    // Generate unique conversation ID
    const conversationId = `conv_${messages[0].id}_${
      messages[messages.length - 1].id
    }`;

    return {
      segment_id: conversationId,
      conversation_id: conversationId, // Legacy alias
      start_time: startTime,
      end_time: endTime,
      message_count: messages.length,
      participants: [user1Id, user2Id],
      channel_id: messages[0].channel_id, // Assume all messages in same channel
      message_ids: messages.map((m) => m.id),
      interaction_types: hasMentions ? ["mention"] : [],
      duration_minutes: durationMinutes,
      has_name_usage: hasNameUsage, // Add flag for actual name usage
    };
  }

  // ============================================================================
  // Streaming Mode - Realtime Conversation Detection
  // ============================================================================

  /**
   * Check if message is a bot command that should be excluded from conversations
   * Enhanced to check full patterns rather than just prefixes
   */
  private isBotCommand(content: string): boolean {
    if (!content || content.trim().length === 0) return false;
    const trimmed = content.trim().toLowerCase();

    // Common bot command prefixes
    const commandPrefixes = ["m!", ".", "!", "/", "?", "$", "-", "+", "~", ">"];

    // Check if starts with any command prefix AND has a command-like pattern
    for (const prefix of commandPrefixes) {
      if (trimmed.startsWith(prefix)) {
        // Extract what comes after the prefix
        const afterPrefix = trimmed.substring(prefix.length).trim();

        // It's a command if:
        // 1. Has a recognizable command word (no spaces in first 20 chars)
        // 2. Or is very short (likely just "!help" or ".ping")
        const firstWord = afterPrefix.split(/\s+/)[0] || "";
        if (firstWord.length > 0 && firstWord.length <= 20) {
          return true;
        }
      }
    }

    // Also check for slash commands that might appear in message content
    if (/^\/\w+/.test(trimmed)) {
      return true;
    }

    return false;
  }

  /**
   * Check if message has meaningful text content (not just emojis/attachments)
   */
  private hasMeaningfulContent(content: string): boolean {
    if (!content || content.trim().length === 0) return false;

    // Remove Discord emoji/animated emoji patterns: <:name:id> or <a:name:id>
    const withoutEmojis = content.replace(/<(a?):[\w]+:\d+>/g, "");

    // Remove unicode emojis (basic check - single emoji characters)
    const withoutUnicode = withoutEmojis.replace(/[\u{1F300}-\u{1F9FF}]/gu, "");

    // Remove whitespace and common punctuation
    const trimmed = withoutUnicode.trim().replace(/^[^\w]*$/, "");

    // Must have at least 3 alphanumeric characters to be meaningful
    return trimmed.length >= 3 && /\w/.test(trimmed);
  }

  /**
   * Ensure we have an embedding for the given message content.
   * Generates one on demand for meaningful text content.
   */
  private async ensureMessageEmbedding(
    content: string,
    existing?: number[]
  ): Promise<number[] | undefined> {
    if ((existing && existing.length > 0) || !this.hasMeaningfulContent(content)) {
      return existing;
    }

    try {
      return await this.embeddingService.generateEmbedding(content);
    } catch (error) {
      console.error("🔸 Failed to generate message embedding:", error);
      return existing;
    }
  }

  /**
   * Maintain a running average embedding for an active conversation.
   */
  private updateConversationTopicEmbedding(
    conversation: ActiveConversation,
    embedding?: number[]
  ): void {
    if (!embedding || embedding.length === 0) {
      return;
    }

    if (!conversation.topicEmbedding || !conversation.topicEmbeddingCount) {
      conversation.topicEmbedding = [...embedding];
      conversation.topicEmbeddingCount = 1;
      return;
    }

    const count = conversation.topicEmbeddingCount;
    const current = conversation.topicEmbedding;

    if (current.length !== embedding.length) {
      conversation.topicEmbedding = [...embedding];
      conversation.topicEmbeddingCount = 1;
      return;
    }

    const newCount = count + 1;
    for (let i = 0; i < current.length; i++) {
      const prevValue = current[i] ?? 0;
      const newValue = embedding[i] ?? 0;
      current[i] = (prevValue * count + newValue) / newCount;
    }
    conversation.topicEmbeddingCount = newCount;
  }

  /**
   * Get relationship score between author and participants (normalized 0-1)
   * Uses cached edge data to reduce DB queries
   */
  private async getRelationshipScore(
    authorId: string,
    participants: Set<string>,
    guildId: string
  ): Promise<number> {
    if (participants.size === 0) return 0;

    let maxScore = 0;

    for (const participantId of participants) {
      if (participantId === authorId) continue;

      // Check both directions (A->B and B->A) using cached data
      const edgeAtoB = await this.getCachedEdge(
        guildId,
        authorId,
        participantId
      );
      const edgeBtoA = await this.getCachedEdge(
        guildId,
        participantId,
        authorId
      );

      // Get total interaction count (bidirectional)
      let totalInteractions = 0;
      if (edgeAtoB?.success && edgeAtoB.data) {
        totalInteractions += edgeAtoB.data.total || 0;
      }
      if (edgeBtoA?.success && edgeBtoA.data) {
        totalInteractions += edgeBtoA.data.total || 0;
      }

      // Normalize: divide by 100 (can be adjusted based on typical interaction counts)
      // Cap at 1.0
      const normalizedScore = Math.min(totalInteractions / 100, 1.0);
      maxScore = Math.max(maxScore, normalizedScore);
    }

    // Periodically cleanup expired cache entries
    if (Math.random() < 0.1) {
      this.cleanupEdgeCache();
    }

    return maxScore;
  }

  /**
   * Score a message against active conversations
   * Returns sorted array of { conversation, score }
   */
  private async scoreMessageAgainstConversations(
    message: {
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      embedding?: number[];
    },
    conversations: ActiveConversation[],
    guildId: string
  ): Promise<Array<{ conversation: ActiveConversation; score: number }>> {
    const scores: Array<{ conversation: ActiveConversation; score: number }> =
      [];

    for (const conversation of conversations) {
      // Relationship score (0-1): Max affinity between author and participants
      const relationshipScore = await this.getRelationshipScore(
        message.author_id,
        conversation.participants,
        guildId
      );

      // Semantic score (0-1): Cosine similarity if embeddings exist
      let semanticScore = 0;
      const msgEmbed = message.embedding;
      const convEmbed = conversation.topicEmbedding;
      if (
        msgEmbed &&
        convEmbed &&
        msgEmbed.length === convEmbed.length
      ) {
        // Cosine similarity
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < msgEmbed.length; i++) {
          dotProduct += msgEmbed[i]! * convEmbed[i]!;
          normA += msgEmbed[i]! * msgEmbed[i]!;
          normB += convEmbed[i]! * convEmbed[i]!;
        }
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator > 0) {
          semanticScore = dotProduct / denominator;
          // Normalize to 0-1 (cosine similarity is -1 to 1)
          semanticScore = (semanticScore + 1) / 2;
        }
      }

      // Time score (0-1): Within 10 minute window
      const timeDiff =
        message.created_at.getTime() - conversation.lastActivity.getTime();
      const timeWindowMs = 10 * 60 * 1000; // 10 minutes
      const timeScore =
        timeDiff >= 0 && timeDiff <= timeWindowMs
          ? 1 - timeDiff / timeWindowMs
          : 0;

      // Weighted combination: relationship (0.5) + semantic (0.3) + time (0.2)
      const combinedScore =
        relationshipScore * 0.5 + semanticScore * 0.3 + timeScore * 0.2;

      scores.push({ conversation, score: combinedScore });
    }

    // Sort by score descending
    return scores.sort((a, b) => b.score - a.score);
  }

  /**
   * Add message to streaming buffer (realtime)
   */
  async addMessageToStream(message: {
    id: string;
    author_id: string;
    content: string;
    created_at: Date;
    guild_id: string;
    channel_id: string;
    referenced_message_id?: string;
    mentioned_user_ids?: string[];
    embedding?: number[];
  }): Promise<void> {
    // Skip bot commands
    if (this.isBotCommand(message.content)) {
      return;
    }

    const messageEmbedding = await this.ensureMessageEmbedding(
      message.content || "",
      message.embedding
    );

    const key = `${message.guild_id}:${message.channel_id}`;
    let buffer = this.channelBuffers.get(key);

    if (!buffer) {
      buffer = {
        messages: [],
        startTime: message.created_at,
        lastActivity: message.created_at,
        guildId: message.guild_id,
        channelId: message.channel_id,
        activeConversations: [],
      };
      this.channelBuffers.set(key, buffer);
    }

    // Check if message has direct signal (reply or mention)
    const hasDirectSignal =
      message.referenced_message_id ||
      (message.mentioned_user_ids && message.mentioned_user_ids.length > 0);

    // If no direct signal, try to route to existing conversation
    if (!hasDirectSignal && buffer.activeConversations.length > 0) {
      const scoredMatches = await this.scoreMessageAgainstConversations(
        {
          id: message.id,
          author_id: message.author_id,
          content: message.content || "",
          created_at: message.created_at,
          embedding: messageEmbedding,
        },
        buffer.activeConversations,
        message.guild_id || ""
      );

      if (scoredMatches.length > 0 && scoredMatches[0] && scoredMatches[0].score > 0.5) {
        const bestMatch = scoredMatches[0]!.conversation;
        
        // Check for topic drift if drift detector is available
        let shouldRoute = true;
        if (bestMatch.messageIds.size >= 3) {
          try {
            // Get conversation messages for drift detection
            const convMessages = buffer.messages
              .filter(m => bestMatch.messageIds.has(m.id))
              .map(m => ({
                id: m.id,
                author_id: m.author_id,
                content: m.content,
                created_at: m.created_at,
                embedding: m.embedding,
              }));

            // Real-time AI topic drift detection removed - now handled by batch enhancement
            // Topic splitting and labeling will be done in post-processing for better accuracy
            // and to avoid real-time latency from API calls
          } catch (error) {
            console.error("🔸 Conversation message extraction failed:", error);
          }
        }

        if (shouldRoute) {
          // Route to best matching conversation
          bestMatch.participants.add(message.author_id);
          bestMatch.messageIds.add(message.id);
          bestMatch.lastActivity = message.created_at;
          this.updateConversationTopicEmbedding(bestMatch, messageEmbedding);
        }
      }
    }

    // Add message to buffer
    buffer.messages.push({
      id: message.id,
      author_id: message.author_id,
      content: message.content,
      created_at: message.created_at,
      referenced_message_id: message.referenced_message_id,
      mentioned_user_ids: message.mentioned_user_ids,
      embedding: messageEmbedding,
    });
    buffer.lastActivity = message.created_at;

    const bufferDuration =
      message.created_at.getTime() - buffer.startTime.getTime();
    const exceedsCount =
      buffer.messages.length >= this.FORCE_FLUSH_MESSAGE_COUNT;
    const exceedsDuration = bufferDuration >= this.FORCE_FLUSH_DURATION_MS;

    if (exceedsCount || exceedsDuration) {
      if (buffer.timeoutHandle) {
        clearTimeout(buffer.timeoutHandle);
        buffer.timeoutHandle = undefined;
      }
      await this.finalizeSegment(key);
      return;
    }

    // Update or create active conversation
    if (hasDirectSignal) {
      // Find or create conversation for this interaction
      let activeConv: ActiveConversation | undefined = buffer.activeConversations.find(
        (conv) => {
          // Check if this message connects to this conversation
          if (message.referenced_message_id) {
            return conv.messageIds.has(message.referenced_message_id);
          }
          if (message.mentioned_user_ids) {
            return message.mentioned_user_ids.some((id) =>
              conv.participants.has(id)
            );
          }
          return false;
        }
      );

      if (!activeConv) {
        // Create new active conversation
        activeConv = {
          participants: new Set([message.author_id]),
          messageIds: new Set([message.id]),
          lastActivity: message.created_at,
          topicEmbedding: messageEmbedding ? [...messageEmbedding] : undefined,
          topicEmbeddingCount: messageEmbedding ? 1 : 0,
        };
        if (message.mentioned_user_ids) {
          message.mentioned_user_ids.forEach((id) =>
            activeConv!.participants.add(id)
          );
        }
        if (message.referenced_message_id) {
          activeConv.messageIds.add(message.referenced_message_id);
        }
        buffer.activeConversations.push(activeConv);
      } else {
        // Update existing conversation
        activeConv.participants.add(message.author_id);
        activeConv.messageIds.add(message.id);
        activeConv.lastActivity = message.created_at;
        this.updateConversationTopicEmbedding(activeConv, messageEmbedding);
        if (message.mentioned_user_ids) {
          message.mentioned_user_ids.forEach((id) =>
            activeConv!.participants.add(id)
          );
        }
      }
    }

    // Check if this message is a reply or has mentions - if so, use longer timeout
    const hasReplyOrMention =
      message.referenced_message_id ||
      (message.mentioned_user_ids && message.mentioned_user_ids.length > 0);

    // Also check if any recent message in buffer is a reply/mention to current participants
    const bufferMessages = buffer.messages; // Capture for closure
    const currentParticipants = new Set(bufferMessages.map((m) => m.author_id));
    const hasRecentReplyToParticipants = bufferMessages
      .slice(-10) // Check last 10 messages
      .some(
        (m) =>
          m.referenced_message_id &&
          bufferMessages.some(
            (prev) =>
              prev.id === m.referenced_message_id &&
              currentParticipants.has(prev.author_id)
          )
      );

    // Calculate conversation density (messages per minute)
    let conversationDensity = 0;
    if (bufferMessages.length > 1) {
      const bufferDurationMs = message.created_at.getTime() - buffer.startTime.getTime();
      const bufferDurationMin = bufferDurationMs / (1000 * 60);
      if (bufferDurationMin > 0) {
        conversationDensity = bufferMessages.length / bufferDurationMin;
      }
    }
    const isHighDensity = conversationDensity > 0.5; // More than 1 message per 2 minutes

    // Dynamic timeout based on conversation signals
    let inactivityTimeout = this.INACTIVITY_MS;
    if (hasReplyOrMention || hasRecentReplyToParticipants) {
      inactivityTimeout = this.INACTIVITY_MS_WITH_REPLIES;
    } else if (isHighDensity) {
      // High-density conversations get extended timeout (15 min)
      inactivityTimeout = 15 * 60 * 1000;
    }

    if (buffer.timeoutHandle) {
      clearTimeout(buffer.timeoutHandle);
    }

    buffer.timeoutHandle = setTimeout(() => {
      this.finalizeSegment(key);
    }, inactivityTimeout);
  }

  /**
   * Group messages by reply chains and mentions
   * Messages that reply to each other or mention each other are grouped together
   * Enhanced with relationship affinity weighting
   */
  private async groupByReplyChainsAndMentions(
    messages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      mentioned_user_ids?: string[];
      embedding?: number[];
    }>,
    guildId: string
  ): Promise<Array<{ messages: typeof messages }>> {
    if (messages.length === 0) return [];

    // Build a map of message ID to message
    const messageMap = new Map<string, (typeof messages)[0]>();
    for (const msg of messages) {
      messageMap.set(msg.id, msg);
    }

    // Build reply chains: message -> what it replies to -> what that replies to, etc.
    const replyChains = new Map<string, Set<string>>(); // message ID -> set of connected message IDs

    for (const msg of messages) {
      if (!msg.referenced_message_id) continue;

      // Find the root of the reply chain
      let currentMsg = msg;
      const chain = new Set<string>([msg.id]);

      // Walk up the reply chain
      while (currentMsg.referenced_message_id) {
        const referencedMsg = messageMap.get(currentMsg.referenced_message_id);
        if (!referencedMsg) break; // Referenced message not in this buffer

        // Check if we've hit a cycle (shouldn't happen, but safety check)
        if (chain.has(referencedMsg.id)) break;

        // Check time gap - don't follow reply chains older than MAX_REPLY_CHAIN_GAP_MS
        const timeDiff = Math.abs(
          msg.created_at.getTime() - referencedMsg.created_at.getTime()
        );
        if (timeDiff > this.MAX_REPLY_CHAIN_GAP_MS) {
          break; // Stop following old references - prevents grouping messages months apart
        }

        chain.add(referencedMsg.id);
        currentMsg = referencedMsg;
      }

      // Also walk down: find messages that reply to this one
      const walkDown = (msgId: string, visited: Set<string>) => {
        if (visited.has(msgId)) return;
        visited.add(msgId);
        const parentMsg = messageMap.get(msgId);
        if (!parentMsg) return;

        for (const m of messages) {
          if (m.referenced_message_id === msgId) {
            // Check time gap - don't follow reply chains with large time gaps
            const timeDiff = Math.abs(
              m.created_at.getTime() - parentMsg.created_at.getTime()
            );
            if (timeDiff > this.MAX_REPLY_CHAIN_GAP_MS) {
              continue; // Skip replies that are too old
            }

            chain.add(m.id);
            walkDown(m.id, visited);
          }
        }
      };
      walkDown(msg.id, new Set());

      // Store the chain for each message in it
      for (const msgId of chain) {
        if (!replyChains.has(msgId)) {
          replyChains.set(msgId, new Set());
        }
        const chainSet = replyChains.get(msgId)!;
        for (const otherMsgId of chain) {
          chainSet.add(otherMsgId);
        }
      }
    }

    // Build mention-based connections
    const mentionGroups = new Map<string, Set<string>>(); // participant ID -> set of message IDs

    for (const msg of messages) {
      if (!msg.mentioned_user_ids || msg.mentioned_user_ids.length === 0)
        continue;

      // Get all participants mentioned by this message
      const mentionedParticipants = new Set(msg.mentioned_user_ids);
      mentionedParticipants.add(msg.author_id); // Include the author

      // Group with messages from these participants or that mention them
      for (const otherMsg of messages) {
        const otherParticipants = new Set([otherMsg.author_id]);
        if (otherMsg.mentioned_user_ids) {
          otherMsg.mentioned_user_ids.forEach((id) =>
            otherParticipants.add(id)
          );
        }

        // Check if there's overlap
        const hasOverlap = Array.from(mentionedParticipants).some((p) =>
          otherParticipants.has(p)
        );
        if (hasOverlap) {
          for (const participant of mentionedParticipants) {
            if (!mentionGroups.has(participant)) {
              mentionGroups.set(participant, new Set());
            }
            mentionGroups.get(participant)!.add(msg.id);
            mentionGroups.get(participant)!.add(otherMsg.id);
          }
        }
      }
    }

    // Combine reply chains and mention groups
    const allGroups: Array<Set<string>> = [];
    const processedMessages = new Set<string>();

    // Add reply chain groups
    for (const chain of replyChains.values()) {
      if (chain.size >= 2) {
        // Only consider chains with at least 2 messages
        allGroups.push(new Set(chain));
        chain.forEach((id) => processedMessages.add(id));
      }
    }

    // Add mention groups
    for (const mentionGroup of mentionGroups.values()) {
      if (mentionGroup.size >= 2) {
        // Merge with existing groups if they overlap
        let merged = false;
        for (let i = 0; i < allGroups.length; i++) {
          const existingGroup = allGroups[i];
          if (!existingGroup) continue;
          // Check for overlap
          const hasOverlap = Array.from(mentionGroup).some((id) =>
            existingGroup.has(id)
          );
          if (hasOverlap) {
            // Merge
            mentionGroup.forEach((id) => existingGroup.add(id));
            merged = true;
            break;
          }
        }
        if (!merged) {
          allGroups.push(new Set(mentionGroup));
        }
        mentionGroup.forEach((id) => processedMessages.add(id));
      }
    }

    // Merge groups that share participants or messages
    // This ensures multi-participant conversations are unified early
    for (let i = 0; i < allGroups.length; i++) {
      for (let j = i + 1; j < allGroups.length; j++) {
        const groupA = allGroups[i];
        const groupB = allGroups[j];
        if (!groupA || !groupB) continue;

        // Check if groups share messages (strongest signal - always merge)
        const sharesMessages = Array.from(groupA).some((id) => groupB.has(id));
        if (sharesMessages) {
          groupB.forEach((id) => groupA.add(id));
          allGroups.splice(j, 1);
          j--; // Adjust index after removal
          continue;
        }

        // Get participants for each group
        const participantsA = new Set(
          Array.from(groupA)
            .map((id) => messageMap.get(id))
            .filter(Boolean)
            .map((m) => m!.author_id)
        );
        const participantsB = new Set(
          Array.from(groupB)
            .map((id) => messageMap.get(id))
            .filter(Boolean)
            .map((m) => m!.author_id)
        );

        // Check if groups share participants (merge to create multi-participant conversations)
        const sharesParticipants = Array.from(participantsA).some((p) =>
          participantsB.has(p)
        );

        if (sharesParticipants) {
          // Also check time overlap to avoid merging unrelated conversations
          const messagesA = Array.from(groupA)
            .map((id) => messageMap.get(id))
            .filter(Boolean);
          const messagesB = Array.from(groupB)
            .map((id) => messageMap.get(id))
            .filter(Boolean);

          if (messagesA.length > 0 && messagesB.length > 0) {
            const timeA = {
              min: Math.min(...messagesA.map((m) => m!.created_at.getTime())),
              max: Math.max(...messagesA.map((m) => m!.created_at.getTime())),
            };
            const timeB = {
              min: Math.min(...messagesB.map((m) => m!.created_at.getTime())),
              max: Math.max(...messagesB.map((m) => m!.created_at.getTime())),
            };

            // Allow 15 minute gap for overlapping participants
            const timeGap = 15 * 60 * 1000;
            const timeOverlap =
              timeA.max >= timeB.min - timeGap &&
              timeA.min <= timeB.max + timeGap;

            if (timeOverlap) {
              // Check if merged result would exceed maximum conversation duration
              const mergedDuration = Math.max(timeA.max, timeB.max) - Math.min(timeA.min, timeB.min);
              if (mergedDuration > this.MAX_CONVERSATION_DURATION_MS) {
                // Skip merge - would create unrealistic conversation span
                continue;
              }

              groupB.forEach((id) => groupA.add(id));
              allGroups.splice(j, 1);
              j--; // Adjust index after removal
              continue;
            }
          }
        }

        // Also check relationship strength for additional merging
        let maxRelationshipScore = 0;
        for (const participantA of participantsA) {
          for (const participantB of participantsB) {
            if (participantA === participantB) continue;
            const relationshipScore = await this.getRelationshipScore(
              participantA,
              new Set([participantB]),
              guildId
            );
            maxRelationshipScore = Math.max(maxRelationshipScore, relationshipScore);
          }
        }

        // If relationship score is high (>0.3), merge the groups
        if (maxRelationshipScore > 0.3) {
          // Check merged duration before allowing merge
          const messagesA = Array.from(groupA)
            .map((id) => messageMap.get(id))
            .filter(Boolean);
          const messagesB = Array.from(groupB)
            .map((id) => messageMap.get(id))
            .filter(Boolean);

          if (messagesA.length > 0 && messagesB.length > 0) {
            const timeA = {
              min: Math.min(...messagesA.map((m) => m!.created_at.getTime())),
              max: Math.max(...messagesA.map((m) => m!.created_at.getTime())),
            };
            const timeB = {
              min: Math.min(...messagesB.map((m) => m!.created_at.getTime())),
              max: Math.max(...messagesB.map((m) => m!.created_at.getTime())),
            };

            const mergedDuration = Math.max(timeA.max, timeB.max) - Math.min(timeA.min, timeB.min);
            if (mergedDuration > this.MAX_CONVERSATION_DURATION_MS) {
              // Skip merge - would create unrealistic conversation span
              continue;
            }
          }

          groupB.forEach((id) => groupA.add(id));
          allGroups.splice(j, 1);
          j--; // Adjust index after removal
        }
      }
    }

    // Add unconnected messages that don't have replies/mentions
    // Only if they're part of an ongoing conversation (within 5 minutes AND author is already a participant)
    const unprocessedMessages = messages.filter(
      (m) => !processedMessages.has(m.id)
    );
    const TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    // Score unprocessed messages against existing groups
    // Use relationship + semantic + time scoring (same as real-time routing)
    for (const msg of unprocessedMessages) {
      let bestScore = 0;
      let bestGroup: Set<string> | null = null;

      for (const group of allGroups) {
        const groupMessages = Array.from(group)
          .map((id) => messageMap.get(id))
          .filter(Boolean);

        if (groupMessages.length === 0) continue;

        // Get participants of this conversation group
        const groupParticipants = new Set(
          groupMessages.map((m) => m!.author_id)
        );

        // Relationship score (0-1)
        const relationshipScore = await this.getRelationshipScore(
          msg.author_id,
          groupParticipants,
          guildId
        );

        // Semantic score (0-1): Cosine similarity if embeddings exist
        let semanticScore = 0;
        if (msg.embedding) {
          // Calculate average embedding for the group
          const groupEmbeddings = groupMessages
            .map((m) => m!.embedding)
            .filter((emb): emb is number[] => emb !== undefined);
          if (groupEmbeddings.length > 0) {
            const avgEmbedding = new Array(msg.embedding.length).fill(0);
            for (const emb of groupEmbeddings) {
              for (let i = 0; i < emb.length && i < avgEmbedding.length; i++) {
                avgEmbedding[i] += emb[i];
              }
            }
            for (let i = 0; i < avgEmbedding.length; i++) {
              avgEmbedding[i] /= groupEmbeddings.length;
            }

            // Cosine similarity
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;
            const msgEmbed = msg.embedding;
            for (let i = 0; i < msgEmbed.length && i < avgEmbedding.length; i++) {
              dotProduct += msgEmbed[i]! * avgEmbedding[i]!;
              normA += msgEmbed[i]! * msgEmbed[i]!;
              normB += avgEmbedding[i]! * avgEmbedding[i]!;
            }
            const denominator = Math.sqrt(normA) * Math.sqrt(normB);
            if (denominator > 0) {
              semanticScore = dotProduct / denominator;
              semanticScore = (semanticScore + 1) / 2; // Normalize to 0-1
            }
          }
        }

        // Time score (0-1): Within 5 minute window
        const timeRange = {
          min: Math.min(...groupMessages.map((m) => m!.created_at.getTime())),
          max: Math.max(...groupMessages.map((m) => m!.created_at.getTime())),
        };
        const msgTime = msg.created_at.getTime();
        const timeDiff = Math.min(
          Math.abs(msgTime - timeRange.min),
          Math.abs(msgTime - timeRange.max)
        );
        const timeScore =
          timeDiff <= TIME_WINDOW_MS ? 1 - timeDiff / TIME_WINDOW_MS : 0;

        // Weighted combination: relationship (0.5) + semantic (0.3) + time (0.2)
        const combinedScore =
          relationshipScore * 0.5 + semanticScore * 0.3 + timeScore * 0.2;

        if (combinedScore > bestScore) {
          bestScore = combinedScore;
          bestGroup = group;
        }
      }

      // Only add if score meets threshold (0.35 - lowered from 0.5 for better coverage)
      if (bestScore > 0.35 && bestGroup) {
        bestGroup.add(msg.id);
        processedMessages.add(msg.id);
      }
      // Don't create new groups for messages without replies/mentions
      // They're just one-off messages, not part of actual conversations
    }

    // Convert groups back to message arrays, filtering out groups that are too small
    const result: Array<{ messages: typeof messages }> = [];
    for (const group of allGroups) {
      if (group.size >= this.MIN_MESSAGES) {
        const groupMessages = Array.from(group)
          .map((id) => messageMap.get(id))
          .filter((m): m is (typeof messages)[0] => m !== undefined);

        if (groupMessages.length >= this.MIN_MESSAGES) {
          // Sort chronologically for gap checking
          groupMessages.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

          // Check conversation duration
          const lastMsg = groupMessages[groupMessages.length - 1];
          const firstMsg = groupMessages[0];
          if (lastMsg && firstMsg) {
            const duration = lastMsg.created_at.getTime() - firstMsg.created_at.getTime();
            if (duration > this.MAX_CONVERSATION_DURATION_MS) {
              continue; // Skip - conversation spans too long (>24 hours)
            }

            // Check for large gaps between consecutive messages
            let hasLargeGap = false;
            for (let i = 1; i < groupMessages.length; i++) {
              const currentMsg = groupMessages[i];
              const prevMsg = groupMessages[i - 1];
              if (currentMsg && prevMsg) {
                const gap = currentMsg.created_at.getTime() - prevMsg.created_at.getTime();
                if (gap > this.MAX_MESSAGE_GAP_MS) {
                  hasLargeGap = true;
                  break;
                }
              }
            }
            if (hasLargeGap) {
              continue; // Skip - has unrealistic time gap (>4 hours)
            }
          }

          const hasReplyConnections = groupMessages.some(
            (m) => m.referenced_message_id && group.has(m.referenced_message_id)
          );
          const hasMentions = groupMessages.some(
            (m) => m.mentioned_user_ids && m.mentioned_user_ids.length > 0
          );

          if (groupMessages.length >= this.MIN_MESSAGES && (hasReplyConnections || hasMentions)) {
            result.push({ messages: groupMessages });
          }
        }
      }
    }

    // Proximity-based fallback: Group unprocessed messages within 10-minute windows from same participants
    const proximityGroups = this.groupByProximity(messages, processedMessages);
    result.push(...proximityGroups);

    return result;
  }

  /**
   * Group unprocessed messages by proximity (within 5-minute windows from same participants)
   * This catches organic conversations that don't have explicit reply chains or mentions
   * Reduced from 10 minutes to 5 minutes to reduce false grouping of unrelated messages
   */
  private groupByProximity<T extends { id: string; author_id: string; created_at: Date; content?: string }>(
    allMessages: T[],
    processedMessages: Set<string>
  ): Array<{ messages: T[] }> {
    const PROXIMITY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes (reduced from 10 to prevent false grouping)
    const MIN_PARTICIPANTS = 2; // Require at least 2 participants for proximity grouping
    const result: Array<{ messages: T[] }> = [];

    // Get unprocessed messages
    const unprocessed = allMessages.filter((m) => !processedMessages.has(m.id));
    if (unprocessed.length < 2) return result;

    // Sort by time
    const sorted = [...unprocessed].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    // Group messages within proximity windows
    let currentGroup: T[] = [];
    let lastMessageTime: number | null = null;
    const participantSet = new Set<string>();

    for (const msg of sorted) {
      const msgTime = msg.created_at.getTime();

      // Start new group if:
      // 1. First message
      // 2. Time gap > 5 minutes
      // 3. No participant overlap with current group
      if (
        lastMessageTime === null ||
        msgTime - lastMessageTime > PROXIMITY_WINDOW_MS ||
        (participantSet.size > 0 && !participantSet.has(msg.author_id))
      ) {
        // Save previous group if it has at least 2 messages and 2 participants
        if (currentGroup.length >= 2 && participantSet.size >= MIN_PARTICIPANTS) {
          result.push({ messages: currentGroup });
        }
        // Start new group
        currentGroup = [msg];
        participantSet.clear();
        participantSet.add(msg.author_id);
      } else {
        // Add to current group
        currentGroup.push(msg);
        participantSet.add(msg.author_id);
      }

      lastMessageTime = msgTime;
    }

    // Don't forget the last group (with participant requirement)
    if (currentGroup.length >= 2 && participantSet.size >= MIN_PARTICIPANTS) {
      result.push({ messages: currentGroup });
    }

    return result;
  }

  /**
   * Fallback: create time-windowed segments when higher-signal grouping fails.
   * Ensures we still produce segments for organic conversations even without explicit mentions/replies.
   */
  private createTemporalSegments(
    messages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      mentioned_user_ids?: string[];
      embedding?: number[];
    }>,
    windowMs: number = 10 * 60 * 1000
  ): Array<{ messages: typeof messages }> {
    if (messages.length < this.MIN_MESSAGES) {
      return [];
    }

    const sorted = [...messages].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime()
    );

    const fallbackGroups: Array<{ messages: typeof messages }> = [];
    let currentGroup: typeof messages = [];

    for (const msg of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(msg);
        continue;
      }

      const prev = currentGroup[currentGroup.length - 1]!;
      const gap = msg.created_at.getTime() - prev.created_at.getTime();

      if (gap <= windowMs) {
        currentGroup.push(msg);
      } else {
        if (this.isValidTemporalGroup(currentGroup)) {
          fallbackGroups.push({ messages: [...currentGroup] });
        }
        currentGroup = [msg];
      }
    }

    if (this.isValidTemporalGroup(currentGroup)) {
      fallbackGroups.push({ messages: currentGroup });
    }

    return fallbackGroups;
  }

  private isValidTemporalGroup(
    messages: Array<{ author_id: string }>
  ): boolean {
    if (messages.length < this.MIN_MESSAGES) {
      return false;
    }
    const participants = new Set(messages.map((m) => m.author_id));
    return participants.size >= 2;
  }

  /**
   * Attach single-speaker "prelude" messages that happen shortly before a confirmed conversation.
   * This lets us keep the ramp-up context once another user joins, improving coverage in logs.
   */
  private attachConversationPreludes(
    groups: Array<{
      messages: Array<{
        id: string;
        author_id: string;
        content: string;
        created_at: Date;
        referenced_message_id?: string;
        mentioned_user_ids?: string[];
        embedding?: number[];
      }>;
    }>,
    allMessages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      mentioned_user_ids?: string[];
      embedding?: number[];
    }>
  ): Array<{
    messages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      mentioned_user_ids?: string[];
      embedding?: number[];
    }>;
  }> {
    if (groups.length === 0 || allMessages.length === 0) {
      return groups;
    }

    const sortedAllMessages = [...allMessages].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime()
    );
    const consumedPreludeIds = new Set<string>();

    const groupsWithMeta = groups
      .map((group, index) => ({
        group,
        index,
        start: Math.min(
          ...group.messages.map((m) => m.created_at.getTime())
        ),
      }))
      .sort((a, b) => a.start - b.start);

    for (const { group } of groupsWithMeta) {
      if (!group || group.messages.length === 0) {
        continue;
      }

      const participantSet = new Set(
        group.messages.map((m) => m.author_id).filter(Boolean)
      );
      if (participantSet.size < 2) {
        continue;
      }

      const groupStart = Math.min(
        ...group.messages.map((m) => m.created_at.getTime())
      );
      const existingIds = new Set(group.messages.map((m) => m.id));

      const preludes = sortedAllMessages.filter((msg) => {
        if (existingIds.has(msg.id) || consumedPreludeIds.has(msg.id)) {
          return false;
        }
        if (!participantSet.has(msg.author_id)) {
          return false;
        }
        const delta = groupStart - msg.created_at.getTime();
        return delta > 0 && delta <= this.PRE_CONVERSATION_GRACE_MS;
      });

      if (preludes.length === 0) {
        continue;
      }

      preludes.forEach((msg) => consumedPreludeIds.add(msg.id));

      group.messages.push(...preludes);
      group.messages.sort(
        (a, b) => a.created_at.getTime() - b.created_at.getTime()
      );
    }

    return groups;
  }

  /**
   * Merge overlapping conversation groups into unified multi-participant conversations
   * Groups are merged if they:
   * 1. Share messages (same message IDs)
   * 2. Have overlapping participants AND overlapping time windows
   */
  private mergeOverlappingGroups<T extends { id: string; author_id: string; created_at: Date }>(
    groups: Array<{ messages: T[] }>
  ): Array<{ messages: T[] }> {
    if (groups.length <= 1) return groups;

    // Use iterative approach to handle transitive merges
    let currentGroups = [...groups];
    let changed = true;

    // Keep merging until no more changes occur
    while (changed) {
      changed = false;
      const newGroups: typeof currentGroups = [];
      const processed = new Set<number>();

      for (let i = 0; i < currentGroups.length; i++) {
        if (processed.has(i)) continue;

        const currentGroup = currentGroups[i];
        if (!currentGroup) continue;

        const currentMessages = new Set(currentGroup.messages.map((m) => m.id));
        const currentParticipants = new Set(
          currentGroup.messages.map((m) => m.author_id)
        );
        const currentTimeRange = {
          min: Math.min(...currentGroup.messages.map((m) => m.created_at.getTime())),
          max: Math.max(...currentGroup.messages.map((m) => m.created_at.getTime())),
        };

        // Collect all groups that should be merged with this one
        const toMerge = [currentGroup];
        processed.add(i);

        // Look for overlapping groups - iterate until no more merges found
        let foundMerge = true;
        while (foundMerge) {
          foundMerge = false;
          for (let j = 0; j < currentGroups.length; j++) {
            if (processed.has(j) || i === j) continue;

            const otherGroup = currentGroups[j];
            if (!otherGroup) continue;

            const otherMessages = new Set(otherGroup.messages.map((m) => m.id));
            const otherParticipants = new Set(
              otherGroup.messages.map((m) => m.author_id)
            );
            const otherTimeRange = {
              min: Math.min(...otherGroup.messages.map((m) => m.created_at.getTime())),
              max: Math.max(...otherGroup.messages.map((m) => m.created_at.getTime())),
            };

            // Check for overlap:
            // 1. Share messages (intersection) - strongest signal - ALWAYS merge
            const messageOverlap =
              Array.from(currentMessages).some((id) => otherMessages.has(id));

            // 2. Have overlapping participants
            const participantOverlap =
              Array.from(currentParticipants).some((p) => otherParticipants.has(p));
            
            // 3. Time window check - more lenient for participant overlap
            // TUNED: Increased from 15 to 30 minutes to reduce fragmentation
            // Analysis showed 5 conversation pairs < 5 min apart with shared participants
            const timeGap = participantOverlap
              ? 30 * 60 * 1000 // 30 minutes for overlapping participants (tuned from 15)
              : 10 * 60 * 1000;  // 10 minutes for non-overlapping participants (tuned from 5)
            const timeOverlap =
              (currentTimeRange.max >= otherTimeRange.min - timeGap &&
               currentTimeRange.min <= otherTimeRange.max + timeGap);

            // Merge if:
            // - Groups share messages (always merge)
            // - Groups share participants AND time windows overlap (even loosely)
            // - Groups are very close in time (within 5 min) even without participant overlap
            const shouldMerge = messageOverlap || 
              (participantOverlap && timeOverlap) ||
              (!participantOverlap && timeOverlap && 
               Math.abs(currentTimeRange.max - otherTimeRange.min) <= 5 * 60 * 1000 &&
               Math.abs(currentTimeRange.min - otherTimeRange.max) <= 5 * 60 * 1000);

            if (shouldMerge) {
              // Merge: combine message sets and participant sets
              toMerge.push(otherGroup);
              processed.add(j);
              foundMerge = true;
              changed = true;

              // Update current sets for next iteration
              otherMessages.forEach((id) => currentMessages.add(id));
              otherParticipants.forEach((p) => currentParticipants.add(p));
              currentTimeRange.min = Math.min(
                currentTimeRange.min,
                otherTimeRange.min
              );
              currentTimeRange.max = Math.max(
                currentTimeRange.max,
                otherTimeRange.max
              );
            }
          }
        }

        // Combine all messages from merged groups
        const mergedMessagesMap = new Map<
          string,
          (typeof groups[0]["messages"])[0]
        >();
        for (const group of toMerge) {
          for (const msg of group.messages) {
            mergedMessagesMap.set(msg.id, msg);
          }
        }

        newGroups.push({
          messages: Array.from(mergedMessagesMap.values()),
        });
      }

      currentGroups = newGroups;
    }

    return currentGroups;
  }

  /**
   * Include referenced messages that aren't already in the conversation group
   * This ensures reply chains are complete - if someone replies to a message,
   * that original message should be included in the conversation.
   * Recursively fetches the full reply chain.
   */
  private async includeReferencedMessages(
    group: {
      messages: Array<{
        id: string;
        author_id: string;
        content: string;
        created_at: Date;
        referenced_message_id?: string;
        mentioned_user_ids?: string[];
      }>;
    },
    buffer: ChannelBuffer
  ): Promise<typeof group> {
    const messageIdsInGroup = new Set(group.messages.map((m) => m.id));
    const MAX_REFERENCE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours - don't include very old references
    const fetchedMessages = new Map<string, (typeof group.messages)[0]>();

    // Recursively fetch all referenced messages in the reply chain
    const fetchReferencedChain = async (
      messageId: string,
      visited: Set<string>
    ): Promise<void> => {
      if (
        visited.has(messageId) ||
        messageIdsInGroup.has(messageId) ||
        fetchedMessages.has(messageId)
      ) {
        return; // Already processed, already in group, or already fetched
      }
      visited.add(messageId);

      try {
        const result = await this.db.query(
          `SELECT id, author_id, content, created_at, channel_id, referenced_message_id
           FROM messages
           WHERE id = $1 AND guild_id = $2 AND channel_id = $3 AND active = true`,
          [messageId, buffer.guildId, buffer.channelId]
        );

        if (result.success && result.data && result.data.length > 0) {
          const refMsg = result.data[0] as any;

          // Only include if:
          // 1. Same channel
          // 2. Within reasonable time window (24 hours)
          // 3. Has meaningful content (not bot command)
          const msgTime = new Date(refMsg.created_at).getTime();
          const bufferTime = buffer.startTime.getTime();
          const ageDiff = Math.abs(bufferTime - msgTime);

          if (
            refMsg.channel_id === buffer.channelId &&
            ageDiff <= MAX_REFERENCE_AGE_MS &&
            !this.isBotCommand(refMsg.content) &&
            this.hasMeaningfulContent(refMsg.content)
          ) {
            // Add this message
            const messageData: (typeof group.messages)[0] = {
              id: refMsg.id,
              author_id: refMsg.author_id,
              content: refMsg.content,
              created_at: new Date(refMsg.created_at),
              referenced_message_id: refMsg.referenced_message_id || undefined,
              mentioned_user_ids: undefined, // We don't store this for old messages
            };
            fetchedMessages.set(refMsg.id, messageData);

            // Recursively fetch what this message references (walk up the reply chain)
            if (refMsg.referenced_message_id) {
              await fetchReferencedChain(refMsg.referenced_message_id, visited);
            }
          }
        }
      } catch (error) {
        // Silently skip if fetch fails
        console.error(
          `🔸 Failed to fetch referenced message ${messageId}:`,
          error
        );
      }
    };

    // Find all referenced message IDs that aren't already in the group
    const referencedIdsToFetch = new Set<string>();
    for (const msg of group.messages) {
      if (
        msg.referenced_message_id &&
        !messageIdsInGroup.has(msg.referenced_message_id)
      ) {
        referencedIdsToFetch.add(msg.referenced_message_id);
      }
    }

    // Recursively fetch all referenced messages and their chains
    // Use a single visited set across all calls to avoid duplicate fetches and infinite loops
    const globalVisited = new Set<string>();
    for (const refId of referencedIdsToFetch) {
      await fetchReferencedChain(refId, globalVisited);
    }

    // Add all fetched messages to the group
    if (fetchedMessages.size > 0) {
      return {
        messages: [...group.messages, ...Array.from(fetchedMessages.values())],
      };
    }

    return group;
  }

  /**
   * Finalize a conversation segment and write to DB (thread-safe with locks)
   */
  private async finalizeSegment(bufferKey: string): Promise<void> {
    // Acquire or wait for existing lock
    if (this.finalizationLocks.has(bufferKey)) {
      await this.finalizationLocks.get(bufferKey);
      return; // Another coroutine already finalized this buffer
    }

    // Create lock promise for this buffer
    const lockPromise = this.performFinalization(bufferKey);
    this.finalizationLocks.set(bufferKey, lockPromise);

    try {
      await lockPromise;
    } finally {
      this.finalizationLocks.delete(bufferKey);
    }
  }

  /**
   * Perform the actual finalization work (called while locked)
   */
  private async performFinalization(bufferKey: string): Promise<void> {
    const buffer = this.channelBuffers.get(bufferKey);
    if (!buffer) return;

    this.channelBuffers.delete(bufferKey);
    if (buffer.timeoutHandle) {
      clearTimeout(buffer.timeoutHandle);
    }

    // Filter out bot commands and messages without meaningful content
    const validMessages = buffer.messages.filter(
      (m) =>
        !this.isBotCommand(m.content) && this.hasMeaningfulContent(m.content)
    );

    if (validMessages.length < this.MIN_MESSAGES) {
      return; // Not enough valid messages
    }

    // Require at least one message with substantial content (not just short responses)
    const hasSubstantialContent = validMessages.some(
      (m) => m.content && m.content.trim().length >= 10
    );
    if (!hasSubstantialContent) {
      return; // All messages are too short/superficial
    }

    // Group messages by reply chains and mentions before determining participants
    // This ensures messages that reply to each other stay together
    // OPTIMIZED: Use new strategy-based grouping
    const groupedMessages = await this.groupMessagesOptimized(
      validMessages,
      buffer.guildId,
      buffer.channelId
    );

    // Merge overlapping groups into a single multi-participant conversation
    // Groups overlap if they share messages or have overlapping participants in the same time window
    const mergedGroups = this.mergeOverlappingGroups(groupedMessages);

    // Check for existing segments that might overlap with these messages
    // to avoid creating duplicate segments
    const messageIdsInGroups = new Set<string>();
    for (const group of mergedGroups) {
      for (const msg of group.messages) {
        messageIdsInGroups.add(msg.id);
      }
    }

    // Query for existing segments that contain any of these messages
    const existingSegmentsResult = await this.db.query(
      `
      SELECT id, message_ids, participants
      FROM conversation_segments
      WHERE guild_id = $1 AND channel_id = $2
        AND message_ids && $3::TEXT[]
    `,
      [
        buffer.guildId,
        buffer.channelId,
        Array.from(messageIdsInGroups),
      ]
    );

    const existingMessageIds = new Set<string>();
    if (existingSegmentsResult.success && existingSegmentsResult.data) {
      for (const segment of existingSegmentsResult.data) {
        if (segment.message_ids && Array.isArray(segment.message_ids)) {
          segment.message_ids.forEach((id: string) =>
            existingMessageIds.add(id)
          );
        }
      }
    }

    // Filter out messages that are already in existing segments
    const filteredMergedGroups = mergedGroups
      .map((group) => ({
        messages: group.messages.filter((msg) => !existingMessageIds.has(msg.id)),
      }))
      .filter((group) => group.messages.length >= this.MIN_MESSAGES);



    if (filteredMergedGroups.length === 0) {
      return; // All messages already in segments
    }

    // Merge again after filtering to ensure groups that share remaining messages are combined
    // This prevents creating duplicate segments from groups that had overlapping messages
    let candidateGroups = this.mergeOverlappingGroups(filteredMergedGroups);

    if (candidateGroups.length === 0) {
      candidateGroups = this.createTemporalSegments(validMessages);
      console.log(
        `🔸 Buffer ${bufferKey}: fallback temporal groups ${candidateGroups.length}`
      );
    }

    candidateGroups = this.attachConversationPreludes(
      candidateGroups,
      validMessages
    );

    // Process all merged groups (not just the largest)
    // This creates one unified multi-participant conversation instead of multiple pairwise ones
    const createdSegmentIds: string[] = [];
    for (const group of candidateGroups) {
      // Deduplicate messages within the group (in case merging combined duplicates)
      const uniqueMessages = new Map<string, typeof group.messages[0]>();
      for (const msg of group.messages) {
        if (!uniqueMessages.has(msg.id)) {
          uniqueMessages.set(msg.id, msg);
        }
      }
      const deduplicatedGroup = {
        messages: Array.from(uniqueMessages.values()),
      };

      if (deduplicatedGroup.messages.length < this.MIN_MESSAGES) {
        console.log(
          `   ↪ Skipping group with ${deduplicatedGroup.messages.length} messages (< ${this.MIN_MESSAGES})`
        );
        continue; // Skip if not enough messages after deduplication
      }

      const participantSet = new Set(
        deduplicatedGroup.messages
          .map((m) => m.author_id)
          .filter((id) => id && id.trim().length > 0)
      );

      if (participantSet.size < 2) {
        console.log(
          `   ↪ Skipping group with only ${participantSet.size} participant(s)`
        );
        continue;
      }
      // Fetch and include any referenced messages that aren't already in the group
      let processedGroup = await this.includeReferencedMessages(deduplicatedGroup, buffer);

      // Sort messages chronologically after adding referenced messages
      processedGroup.messages.sort(
        (a, b) => a.created_at.getTime() - b.created_at.getTime()
      );

      const participants = Array.from(
        new Set(
          processedGroup.messages
            .map((m) => m.author_id)
            .filter((id) => id && id.trim().length > 0)
        )
      ).sort();

      // Use the grouped messages for this segment (already sorted chronologically)
      const segmentMessages = processedGroup.messages;

      // segmentMessages is guaranteed to have at least MIN_MESSAGES items at this point
      const segmentId = `seg_${segmentMessages[0]!.id}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const endTime = segmentMessages[segmentMessages.length - 1]!.created_at;

    const features: Record<string, any> = {
        mention_count: segmentMessages.filter(
          (m) => m.mentioned_user_ids && m.mentioned_user_ids.length > 0
      ).length,
        reply_count: segmentMessages.filter(
          (m) =>
            m.referenced_message_id !== undefined &&
            m.referenced_message_id !== null
      ).length,
    };

      // Extract keywords for this conversation segment
      try {
        const keywordMessages: KeywordMessage[] = segmentMessages.map((m) => ({
          id: m.id,
          content: m.content,
          embedding: (m as any).embedding, // Embedding might not be in type but can be present
          author_id: m.author_id,
        }));

        const keywords = await this.keywordExtractor.extractKeywords(
          keywordMessages,
          buffer.guildId,
          { topN: 10, method: "hybrid" }
        );

        features.keywords = keywords;
      } catch (error) {
        console.error(
          `🔸 Failed to extract keywords for segment ${segmentId}:`,
          error
        );
        // Continue without keywords if extraction fails
      }

      // Summary should be undefined until generated by LLM
      const summary = undefined;

    // Calculate actual start time from the first message in the segment
    const actualStartTime = segmentMessages.length > 0 && segmentMessages[0]
      ? segmentMessages[0].created_at
      : buffer.startTime;

    await this.db.upsertConversationSegment({
      id: segmentId,
      guildId: buffer.guildId,
      channelId: buffer.channelId,
      participants,
      startTime: actualStartTime,
      endTime,
      messageIds: segmentMessages.map((m) => m.id),
      messageCount: segmentMessages.length,
      features,
      summary,
      status: "finalized", // Segments created from finalization are finalized
    });

      createdSegmentIds.push(segmentId);

      // Trigger enrichment pipeline for significant conversations
      try {
        const { EnrichmentPipelineOrchestrator } = await import(
          "../enrichment-pipeline/EnrichmentPipelineOrchestrator"
        );
        const orchestrator = EnrichmentPipelineOrchestrator.getInstance();

        // Check significance
        const isSignificant = orchestrator.isConversationSignificant(
          participants.length,
          segmentMessages.length,
        );

        if (isSignificant) {
          const significance =
            participants.length >= 5
              ? "high"
              : participants.length >= 3
                ? "medium"
                : "low";

          orchestrator.enqueueConversation(segmentId, buffer.guildId, significance);
        }
      } catch (error) {
        // Silently fail - enrichment trigger is non-critical
        console.warn(
          `🔸 Failed to trigger enrichment for conversation ${segmentId}: ${error}`,
        );
      }

      // Clear finalized conversations from activeConversations
      buffer.activeConversations = buffer.activeConversations.filter(
        (conv) =>
          !Array.from(conv.messageIds).every((id) =>
            segmentMessages.some((m) => m.id === id)
          )
      );

      // Try to merge with nearby segments in the same channel
      await this.mergeNearbySegments(
        buffer.guildId,
        buffer.channelId,
        segmentId,
        participants,
        buffer.startTime,
        endTime
      );
    }

    if (createdSegmentIds.length > 0) {
      try {
        await this.reconcileOrphanMessages(
          buffer.guildId,
          buffer.channelId,
          new Date(buffer.startTime.getTime() - this.ORPHAN_LOOKBACK_MS)
        );
      } catch (error) {
        console.error(
          `🔸 Failed to reconcile orphan messages for ${buffer.guildId}:${buffer.channelId}`,
          error
        );
      }

      try {
        await this.splitSegmentsByTopic(
          buffer.guildId,
          buffer.channelId,
          createdSegmentIds
        );
      } catch (error) {
        console.error(
          `🔸 Failed to split segments by topic for ${buffer.guildId}:${buffer.channelId}`,
          error
        );
      }
    }
  }

  private async reconcileOrphanMessages(
    guildId: string,
    channelId: string,
    since: Date
  ): Promise<number> {

    const effectiveSince = new Date(Math.max(0, since.getTime()));
    const orphanResult = await this.db.query(
      `
        SELECT id, author_id, content, created_at
        FROM messages m
        WHERE m.guild_id = $1
          AND m.channel_id = $2
          AND m.active = true
          AND m.created_at >= $3
          AND m.author_id != ALL($4::TEXT[])
          AND NOT EXISTS (
            SELECT 1
            FROM conversation_segments cs
            WHERE cs.guild_id = m.guild_id
              AND cs.channel_id = m.channel_id
              AND m.id = ANY(cs.message_ids)
          )
        ORDER BY m.created_at ASC
      `,
      [guildId, channelId, effectiveSince, KNOWN_BOT_USER_IDS]
    );

    if (
      !orphanResult.success ||
      !orphanResult.data ||
      orphanResult.data.length === 0
    ) {
      return 0;
    }

    const windowStart = new Date(
      effectiveSince.getTime() - this.ORPHAN_LOOKBACK_MS
    );
    const segmentsResult = await this.db.query(
      `
        SELECT id, start_time, end_time, participants, message_ids
        FROM conversation_segments
        WHERE guild_id = $1
          AND channel_id = $2
          AND end_time >= $3
      `,
      [guildId, channelId, windowStart]
    );

    if (
      !segmentsResult.success ||
      !segmentsResult.data ||
      segmentsResult.data.length === 0
    ) {
      return 0;
    }

    const segmentsRaw = segmentsResult.data;
    const allSegmentMessageIds = new Set<string>();
    for (const seg of segmentsRaw) {
      if (Array.isArray(seg.message_ids)) {
        for (const id of seg.message_ids) {
          allSegmentMessageIds.add(id);
        }
      }
    }

    const segmentMessagesMap = new Map<
      string,
      DriftMessage & { embedding?: number[] }
    >();
    if (allSegmentMessageIds.size > 0) {
      const detailsResult = await this.db.query(
        `
          SELECT id, author_id, content, created_at
          FROM messages
          WHERE guild_id = $1
            AND channel_id = $2
            AND id = ANY($3::TEXT[])
        `,
        [guildId, channelId, Array.from(allSegmentMessageIds)]
      );

      if (detailsResult.success && detailsResult.data) {
        for (const row of detailsResult.data) {
          segmentMessagesMap.set(row.id, {
            id: row.id,
            author_id: row.author_id,
            content: row.content || "",
            created_at: new Date(row.created_at),
          });
        }
      }
    }

    const segments: SegmentContext[] = segmentsRaw.map((seg: any) => {
      const messageIds: string[] = Array.isArray(seg.message_ids)
        ? seg.message_ids
        : [];
      const messages: DriftMessage[] = messageIds
        .map((id) => segmentMessagesMap.get(id))
        .filter((m): m is DriftMessage => Boolean(m))
        .sort(
          (a, b) => a.created_at.getTime() - b.created_at.getTime()
        );
      return {
        id: seg.id,
        start: new Date(seg.start_time),
        end: new Date(seg.end_time),
        participants: new Set(
          Array.isArray(seg.participants) ? seg.participants : []
        ),
        messageIds,
        messages,
      };
    });

    const recentOrphans: DriftMessage[] = orphanResult.data.map((row: any) => ({
      id: row.id,
      author_id: row.author_id,
      content: row.content || "",
      created_at: new Date(row.created_at),
    }));

    let attached = 0;
    for (const orphan of recentOrphans) {
      const candidates = segments
        .filter((segment) => this.isWithinSegmentWindow(segment, orphan))
        .sort((a, b) => {
          const gapA = this.timeGapToSegment(a, orphan.created_at);
          const gapB = this.timeGapToSegment(b, orphan.created_at);
          return gapA - gapB;
        });

      if (candidates.length === 0) {
        continue;
      }

      for (const candidate of candidates) {
        const shouldAttach = await this.shouldAttachOrphanToSegment(
          candidate,
          orphan,
          guildId
        );
        if (shouldAttach) {
          await this.attachOrphanToSegment(candidate, orphan, guildId);
          attached++;
          break;
        }
      }
    }

    return attached;
  }

  private isWithinSegmentWindow(
    segment: SegmentContext,
    message: DriftMessage
  ): boolean {
    const windowBefore = 10 * 60 * 1000; // 10 minutes
    const windowAfter = 10 * 60 * 1000;
    const messageTime = message.created_at.getTime();
    return (
      messageTime >= segment.start.getTime() - windowBefore &&
      messageTime <= segment.end.getTime() + windowAfter
    );
  }

  private timeGapToSegment(segment: SegmentContext, time: Date): number {
    const t = time.getTime();
    if (t < segment.start.getTime()) {
      return segment.start.getTime() - t;
    }
    if (t > segment.end.getTime()) {
      return t - segment.end.getTime();
    }
    return 0;
  }

  private async shouldAttachOrphanToSegment(
    segment: SegmentContext,
    orphan: DriftMessage,
    guildId: string
  ): Promise<boolean> {
    // AI-based topic drift detection removed - now handled by batch enhancement
    // Using programmatic heuristics only for real-time orphan attachment

    const timeGap = this.timeGapToSegment(segment, orphan.created_at);

    // Attach if same participant and close temporal proximity (5 min)
    if (segment.participants.has(orphan.author_id) && timeGap <= 5 * 60 * 1000) {
      return true;
    }

    // Very close temporal proximity (2 min) - likely part of conversation
    if (timeGap <= 2 * 60 * 1000) {
      return true;
    }

    return false;
  }

  private async attachOrphanToSegment(
    segment: SegmentContext,
    message: DriftMessage,
    guildId: string
  ): Promise<void> {
    if (segment.messageIds.includes(message.id)) {
      return;
    }

    segment.messageIds.push(message.id);
    segment.messages.push(message);
    segment.messages.sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime()
    );

    segment.participants.add(message.author_id);
    segment.start = new Date(
      Math.min(segment.start.getTime(), message.created_at.getTime())
    );
    segment.end = new Date(
      Math.max(segment.end.getTime(), message.created_at.getTime())
    );

    const newMessageIds = Array.from(new Set(segment.messageIds));
    segment.messageIds = newMessageIds;
    const newParticipants = Array.from(segment.participants).sort();

    await this.db.query(
      `UPDATE conversation_segments
         SET message_ids = $2::TEXT[],
             message_count = $3,
             participants = $4::TEXT[],
             start_time = LEAST(start_time, $5),
             end_time = GREATEST(end_time, $5)
       WHERE id = $1`,
      [
        segment.id,
        newMessageIds,
        newMessageIds.length,
        newParticipants,
        message.created_at,
      ]
    );

  }

  private async splitSegmentsByTopic(
    guildId: string,
    channelId: string,
    segmentIds: string[]
  ): Promise<void> {
    if (segmentIds.length === 0) {
      return;
    }

    for (const segmentId of segmentIds) {
      await this.splitSegmentByTopic(guildId, channelId, segmentId);
    }
  }

  private async splitSegmentByTopic(
    guildId: string,
    channelId: string,
    segmentId: string
  ): Promise<void> {
    const segmentResult = await this.db.query(
      `SELECT id, start_time, end_time, participants, message_ids
       FROM conversation_segments
       WHERE id = $1`,
      [segmentId]
    );

    if (
      !segmentResult.success ||
      !segmentResult.data ||
      segmentResult.data.length === 0
    ) {
      return;
    }

    const row = segmentResult.data[0];
    const messageIds: string[] = Array.isArray(row.message_ids)
      ? row.message_ids
      : [];

    if (messageIds.length < 10) {
      return; // Too small to bother splitting
    }

    const messagesResult = await this.db.query(
      `SELECT id, author_id, content, created_at, referenced_message_id, embedding
       FROM messages
       WHERE guild_id = $1
         AND channel_id = $2
         AND id = ANY($3::TEXT[])
       ORDER BY created_at ASC`,
      [guildId, channelId, messageIds]
    );

    if (!messagesResult.success || !messagesResult.data) {
      return;
    }

    const dbMessages = messagesResult.data.map((msg: any) => ({
      id: msg.id,
      author_id: msg.author_id,
      content: msg.content || "",
      created_at: new Date(msg.created_at),
      referenced_message_id: msg.referenced_message_id || undefined,
      embedding: parseEmbeddingValue(msg.embedding),
    }));

    const driftMessages: DriftMessage[] = dbMessages.map(
      (msg): DriftMessage => ({
        id: msg.id,
        author_id: msg.author_id,
        content: msg.content,
        created_at: msg.created_at,
        embedding: msg.embedding,
      })
    );

    const participants = Array.isArray(row.participants)
      ? row.participants
      : [];
    const durationMinutes =
      (row.end_time && row.start_time
        ? (new Date(row.end_time).getTime() -
            new Date(row.start_time).getTime()) /
          (60 * 1000)
        : 0) || 0;

    let splits: ConversationSplit[] = [];
    try {
      splits = await this.topicDriftDetector.analyzeConversationForSplits(
        driftMessages,
        guildId,
        "system",
        {
          participantCount: participants.length,
          durationMinutes,
        }
      );
    } catch (error) {
      console.warn(
        "🔸 Topic split analysis failed; keeping segment intact:",
        error instanceof Error ? error.message : error
      );
      return;
    }

    if (!splits || splits.length === 0) {
      return;
    }

    const boundaries = [0];
    const maxIndex = driftMessages.length;
    for (const split of splits) {
      const lastBoundary = boundaries[boundaries.length - 1] ?? 0;
      const rawIndex = Math.round(split.splitIndex);
      const clamped = Math.max(
        this.MIN_MESSAGES,
        Math.min(maxIndex - this.MIN_MESSAGES, rawIndex)
      );
      if (
        clamped > lastBoundary &&
        clamped < maxIndex
      ) {
        boundaries.push(clamped);
      }
    }
    boundaries.push(maxIndex);

    if (boundaries.length <= 2) {
      return; // No usable split points
    }

    const chunkData: Array<{
      messageIds: string[];
      participants: string[];
      startTime: Date;
      endTime: Date;
      features: Record<string, any>;
      summary: string;
      messages: typeof dbMessages;
    }> = [];

    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      const chunkMessages = dbMessages.slice(start, end);
      const chunk = this.buildSegmentChunk(chunkMessages);
      if (!chunk) {
        return; // Abort entire split if any chunk invalid
      }
      chunkData.push({
        ...chunk,
        messages: chunkMessages,
      });
    }

    if (chunkData.length <= 1) {
      return;
    }

    const originalParticipants = Array.isArray(row.participants)
      ? row.participants
      : [];

    const firstChunk = chunkData[0];
    if (!firstChunk) {
      return;
    }
    const extraChunks = chunkData.slice(1);

    await this.db.upsertConversationSegment({
      id: segmentId,
      guildId,
      channelId,
      participants: firstChunk.participants,
      startTime: firstChunk.startTime,
      endTime: firstChunk.endTime,
      messageIds: firstChunk.messageIds,
      messageCount: firstChunk.messageIds.length,
      features: firstChunk.features,
      summary: firstChunk.summary,
      status: "finalized",
    });

    for (const chunk of extraChunks) {
      const firstMessageId = chunk.messageIds[0];
      if (!firstMessageId) {
        continue;
      }
      const newSegmentId = `seg_${firstMessageId}_${Date.now()}_${Math.random()
        .toString(36)
        .substring(7)}`;
      await this.db.upsertConversationSegment({
        id: newSegmentId,
        guildId,
        channelId,
        participants: chunk.participants,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        messageIds: chunk.messageIds,
        messageCount: chunk.messageIds.length,
        features: chunk.features,
        summary: chunk.summary,
        status: "finalized",
      });

    }
  }

  private buildSegmentChunk(
    messages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
    }>
  ):
    | {
        messageIds: string[];
        participants: string[];
        startTime: Date;
        endTime: Date;
        features: Record<string, any>;
        summary: string;
      }
    | null {
    if (!messages || messages.length < this.MIN_MESSAGES) {
      return null;
    }

    const participants = Array.from(
      new Set(
        messages
          .map((m) => m.author_id)
          .filter((id) => id && id.trim().length > 0)
      )
    ).sort();

    if (participants.length < 2) {
      return null;
    }

    const messageIds = messages.map((m) => m.id);
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    if (!firstMessage || !lastMessage) {
      return null;
    }
    const startTime = firstMessage.created_at;
    const endTime = lastMessage.created_at;
    const features: Record<string, any> = {
      mention_count: 0,
      reply_count: messages.filter((m) => m.referenced_message_id).length,
    };
    // Summary should be empty string until generated by LLM
    const summary = "";

    return {
      messageIds,
      participants,
      startTime,
      endTime,
      features,
      summary,
    };
  }

  /**
   * Merge segments that are close in time with overlapping participants
   */
  private async mergeNearbySegments(
    guildId: string,
    channelId: string,
    newSegmentId: string,
    participants: string[],
    startTime: Date,
    endTime: Date
  ): Promise<void> {
    try {
      const mergeWindowMs = 60 * 60 * 1000; // 60 minutes
      const semanticSimilarityThreshold = 0.82;
      const participantJaccardThreshold = 0.5;
      const participantCoverageThreshold = 0.6;
      const minSharedForAutoMerge = 2;

      const nearbyResult = await this.db.query(
        `SELECT id, participants, start_time, end_time, message_ids, message_count
         FROM conversation_segments
         WHERE guild_id = $1 
           AND channel_id = $2
           AND id != $3
           AND (
             (start_time BETWEEN $4::timestamp - interval '60 minutes' AND $5::timestamp + interval '60 minutes')
             OR (end_time BETWEEN $4::timestamp - interval '60 minutes' AND $5::timestamp + interval '60 minutes')
             OR ($4 BETWEEN start_time - interval '60 minutes' AND end_time + interval '60 minutes')
           )
         ORDER BY start_time ASC`,
        [guildId, channelId, newSegmentId, startTime, endTime]
      );

      if (
        !nearbyResult.success ||
        !nearbyResult.data ||
        nearbyResult.data.length === 0
      ) {
        return;
      }

      const participantsSet = new Set(participants);
      const segmentsToMerge: Array<{
        id: string;
        participants: string[];
        message_ids: string[];
        start_time: Date;
        end_time: Date;
      }> = [];

      // Fetch current segment message IDs (needed for semantic comparisons and merge aggregation)
      const currentSegmentResult = await this.db.query(
        `SELECT message_ids FROM conversation_segments WHERE id = $1`,
        [newSegmentId]
      );

      const currentMsgIds = this.normalizeIdArray(
        currentSegmentResult.success && currentSegmentResult.data
          ? currentSegmentResult.data[0]?.message_ids
          : []
      );

      let currentEmbeddingPromise: Promise<number[] | null> | null = null;
      const getCurrentEmbedding = () => {
        if (!currentEmbeddingPromise) {
          currentEmbeddingPromise = this.computeConversationEmbedding(
            guildId,
            channelId,
            currentMsgIds
          );
        }
        return currentEmbeddingPromise;
      };

      for (const seg of nearbyResult.data) {
        const segParticipants = this.extractParticipants(seg.participants);
        if (segParticipants.length === 0) continue;

        const overlapStats = this.calculateParticipantOverlap(
          participantsSet,
          segParticipants
        );
        const segStart = new Date(seg.start_time);
        const segEnd = new Date(seg.end_time);
        const gapMs = this.calculateSegmentGap(
          startTime,
          endTime,
          segStart,
          segEnd
        );

        let shouldMergeSegment =
          overlapStats.jaccard >= participantJaccardThreshold ||
          (overlapStats.shared >= minSharedForAutoMerge &&
            overlapStats.coverage >= participantCoverageThreshold);

        if (
          !shouldMergeSegment &&
          gapMs <= mergeWindowMs &&
          (overlapStats.shared > 0 || participantsSet.size <= 2)
        ) {
          const segMsgIds = this.normalizeIdArray(seg.message_ids);
          if (segMsgIds.length > 0 && currentMsgIds.length > 0) {
            const semanticScore = await this.computeSemanticSimilarity(
              guildId,
              channelId,
              segMsgIds,
              getCurrentEmbedding
            );
            if (
              semanticScore !== null &&
              semanticScore >= semanticSimilarityThreshold
            ) {
              shouldMergeSegment = true;
            }
          }
        }

        if (shouldMergeSegment) {
          segmentsToMerge.push({
            id: seg.id,
            participants: segParticipants,
            message_ids: this.normalizeIdArray(seg.message_ids),
            start_time: segStart,
            end_time: segEnd,
          });
        }
      }

      if (segmentsToMerge.length === 0) return;

      const allParticipants = new Set(participants);
      const allMessageIds = new Set(currentMsgIds);

      for (const seg of segmentsToMerge) {
        seg.participants.forEach((p: string) => allParticipants.add(p));
        seg.message_ids.forEach((id: string) => allMessageIds.add(id));
      }

      const mergedParticipants = Array.from(allParticipants).sort();
      const mergedMessageIds = Array.from(allMessageIds);

      const allStartTimes = [
        startTime,
        ...segmentsToMerge.map((s) => new Date(s.start_time)),
      ];
      const allEndTimes = [
        endTime,
        ...segmentsToMerge.map((s) => new Date(s.end_time)),
      ];
      const mergedStartTime = new Date(
        Math.min(...allStartTimes.map((d) => d.getTime()))
      );
      const mergedEndTime = new Date(
        Math.max(...allEndTimes.map((d) => d.getTime()))
      );

      const mergedDuration = mergedEndTime.getTime() - mergedStartTime.getTime();
      if (mergedDuration > this.MAX_CONVERSATION_DURATION_MS) {
        return;
      }

      await this.db.query(
        `UPDATE conversation_segments
         SET participants = $1::TEXT[],
             message_ids = $2::TEXT[],
             message_count = $3,
             start_time = $4,
             end_time = $5
         WHERE id = $6`,
        [
          mergedParticipants,
          mergedMessageIds,
          mergedMessageIds.length,
          mergedStartTime,
          mergedEndTime,
          newSegmentId,
        ]
      );

      const deleteIds = segmentsToMerge.map((s) => s.id);
      if (deleteIds.length > 0) {
        await this.db.query(
          `DELETE FROM conversation_segments WHERE id = ANY($1::TEXT[])`,
          [deleteIds]
        );
      }
    } catch (error) {
      // Silently fail - merging is optional
    }
  }

  private extractParticipants(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }

    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }

    return [];
  }

  private normalizeIdArray(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }

    if (typeof raw === "string") {
      return raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    }

    return [];
  }

  private calculateParticipantOverlap(
    baseParticipants: Set<string>,
    otherParticipants: string[]
  ): { shared: number; jaccard: number; coverage: number } {
    const otherSet = new Set(otherParticipants);
    let shared = 0;
    for (const participant of otherSet) {
      if (baseParticipants.has(participant)) {
        shared++;
      }
    }

    const unionSize = new Set([
      ...Array.from(baseParticipants),
      ...Array.from(otherSet),
    ]).size;
    const minGroupSize = Math.min(
      baseParticipants.size || 1,
      otherSet.size || 1
    );
    const coverage = minGroupSize > 0 ? shared / minGroupSize : 0;
    const jaccard = unionSize > 0 ? shared / unionSize : 0;
    return { shared, jaccard, coverage };
  }

  private calculateSegmentGap(
    currentStart: Date,
    currentEnd: Date,
    otherStart: Date,
    otherEnd: Date
  ): number {
    if (otherEnd.getTime() < currentStart.getTime()) {
      return currentStart.getTime() - otherEnd.getTime();
    }
    if (otherStart.getTime() > currentEnd.getTime()) {
      return otherStart.getTime() - currentEnd.getTime();
    }
    return 0; // Overlapping or touching segments
  }

  private async computeSemanticSimilarity(
    guildId: string,
    channelId: string,
    messageIds: string[],
    getReferenceEmbedding: () => Promise<number[] | null>
  ): Promise<number | null> {
    const [referenceEmbedding, candidateEmbedding] = await Promise.all([
      getReferenceEmbedding(),
      this.computeConversationEmbedding(guildId, channelId, messageIds),
    ]);

    if (!referenceEmbedding || !candidateEmbedding) {
      return null;
    }

    return this.cosineSimilarity(referenceEmbedding, candidateEmbedding);
  }

  private async computeConversationEmbedding(
    guildId: string,
    channelId: string,
    messageIds: string[]
  ): Promise<number[] | null> {
    if (messageIds.length === 0) {
      return null;
    }

    const textSample = await this.buildSegmentTextSample(
      guildId,
      channelId,
      messageIds
    );

    if (!textSample) {
      return null;
    }

    try {
      return await this.embeddingService.generateEmbedding(textSample);
    } catch (error) {
      console.error("🔸 Failed to compute conversation embedding:", error);
      return null;
    }
  }

  private async buildSegmentTextSample(
    guildId: string,
    channelId: string,
    messageIds: string[],
    limit: number = 20
  ): Promise<string | null> {
    if (messageIds.length === 0) {
      return null;
    }

    const result = await this.db.query(
      `SELECT content, created_at
       FROM messages
       WHERE guild_id = $1
         AND channel_id = $2
         AND id = ANY($3::TEXT[])
       ORDER BY created_at ASC`,
      [guildId, channelId, messageIds]
    );

    if (!result.success || !result.data || result.data.length === 0) {
      return null;
    }

    const contents = result.data
      .map((row: any) => row.content)
      .filter((content: any) => typeof content === "string" && content.trim().length > 0)
      .slice(0, limit);

    if (contents.length === 0) {
      return null;
    }

    return contents.join("\n");
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number | null {
    if (vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
      return null;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i]!;
      const b = vecB[i]!;
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return null;
    }
    return dot / denominator;
  }

  /**
   * Manually finalize all active segments (for shutdown/cleanup)
   */
  async finalizeAllSegments(): Promise<void> {
    const keys = Array.from(this.channelBuffers.keys());
    for (const key of keys) {
      await this.finalizeSegment(key);
    }
  }

  /**
   * Flush channel buffers that have been inactive longer than the configured timeout.
   * Helps ensure real-time coverage even if timers are delayed or the process sleeps.
   */
  async flushInactiveBuffers(
    maxIdleMs: number = this.INACTIVITY_MS
  ): Promise<void> {
    if (this.channelBuffers.size === 0) {
      return;
    }

    const now = Date.now();
    const keysToFlush: string[] = [];

    for (const [key, buffer] of this.channelBuffers.entries()) {
      const idleTime = now - buffer.lastActivity.getTime();
      if (idleTime >= maxIdleMs) {
        keysToFlush.push(key);
      }
    }

    for (const key of keysToFlush) {
      await this.finalizeSegment(key);
    }
  }

  /**
   * Load and restore active conversations from database on bot startup
   * Resumes streaming mode for conversations that were active before shutdown
   */
  async loadActiveConversations(guildId: string): Promise<void> {
    const result = await this.db.loadActiveConversations(guildId);
    if (!result.success || !result.data) {
      return;
    }

    let restoredCount = 0;

    // Restore each active conversation to the appropriate channel buffer
    for (const segment of result.data) {
      try {
        const bufferKey = `${guildId}:${segment.channel_id}`;
        let buffer = this.channelBuffers.get(bufferKey);

        // Create buffer if it doesn't exist
        if (!buffer) {
          buffer = {
            messages: [],
            startTime: new Date(segment.start_time),
            lastActivity: new Date(segment.last_activity_at || segment.end_time),
            guildId,
            channelId: segment.channel_id,
            activeConversations: [],
          };
          this.channelBuffers.set(bufferKey, buffer);
        }

        // Restore as active conversation
        const activeConv: ActiveConversation = {
          participants: new Set(segment.participants || []),
          messageIds: new Set(segment.message_ids || []),
          lastActivity: new Date(segment.last_activity_at || segment.end_time),
          topicEmbedding: undefined,
          topicEmbeddingCount: 0,
        };

        buffer.activeConversations.push(activeConv);
        restoredCount++;

        // Set timeout for finalization (use normal inactivity timeout)
        if (buffer.timeoutHandle) {
          clearTimeout(buffer.timeoutHandle);
        }

        buffer.timeoutHandle = setTimeout(() => {
          this.finalizeSegment(bufferKey);
        }, this.INACTIVITY_MS);
      } catch (err) {
        console.error(`🔸 Failed to restore active conversation ${segment.id}:`, err);
      }
    }

    if (restoredCount > 0) {
      console.log(
        `🔄 Restored ${restoredCount} active conversations for guild ${guildId}`
      );
    }
  }

  /**
   * Update conversation activity (for active conversations tracking)
   */
  async updateConversationActivity(
    segmentId: string,
    status: "active" | "paused" | "finalized" = "active"
  ): Promise<void> {
    await this.db.updateConversationStatus(segmentId, status);
  }

  /**
   * Get active conversations for a user (real-time)
   */
  async getActiveConversationsForUser(
    userId: string,
    guildId: string,
    limit: number = 20
  ): Promise<any[]> {
    const result = await this.db.getActiveConversationsForUser(userId, guildId, limit);
    return result.success && result.data ? result.data : [];
  }

  /**
   * Get active conversations in a channel (real-time)
   */
  async getActiveConversationsInChannel(
    channelId: string,
    guildId: string,
    limit: number = 20
  ): Promise<any[]> {
    const result = await this.db.getActiveConversationsInChannel(channelId, guildId, limit);
    return result.success && result.data ? result.data : [];
  }

  /**
   * Get conversation history for a user (paginated)
   */
  async getUserConversationHistory(
    userId: string,
    guildId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<any[]> {
    const result = await this.db.getUserConversationHistory(userId, guildId, limit, offset);
    return result.success && result.data ? result.data : [];
  }

  /**
   * Cleanup stale active conversations (older than 1 hour without activity)
   */
  async cleanupStaleConversations(guildId: string): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    try {
      await this.db.query(
        `UPDATE conversation_segments
         SET status = 'finalized'
         WHERE guild_id = $1
           AND status = 'active'
           AND last_activity_at < $2`,
        [guildId, oneHourAgo]
      );
    } catch (error) {
      console.error("🔸 Failed to cleanup stale conversations:", error);
    }
  }

  /**
   * Hydrate full conversation data from segment reference
   * Useful for when you have a segment_id and need full details
   */
  async hydrateConversationSegment(
    segmentId: string
  ): Promise<DatabaseResult<any>> {
    try {
      const result = await this.db.query(
        `
        SELECT
          id,
          guild_id,
          channel_id,
          participants,
          start_time,
          end_time,
          message_ids,
          message_count,
          features,
          summary,
          status,
          created_at,
          last_activity_at
        FROM conversation_segments
        WHERE id = $1
        `,
        [segmentId]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        return {
          success: false,
          error: "Conversation segment not found",
        };
      }

      return { success: true, data: result.data[0] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Hydrate multiple conversation segments (useful for relationship data)
   */
  async hydrateConversationSegments(
    segmentIds: string[]
  ): Promise<DatabaseResult<any[]>> {
    if (segmentIds.length === 0) {
      return { success: true, data: [] };
    }

    try {
      const result = await this.db.query(
        `
        SELECT
          id,
          guild_id,
          channel_id,
          participants,
          start_time,
          end_time,
          message_ids,
          message_count,
          features,
          summary,
          status,
          created_at,
          last_activity_at
        FROM conversation_segments
        WHERE id = ANY($1::TEXT[])
        ORDER BY end_time DESC
        `,
        [segmentIds]
      );

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      return { success: true, data: result.data || [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ============================================================================
  // Analytics & Metrics
  // ============================================================================

  /**
   * Get conversation metrics for a guild
   */
  async getConversationMetrics(
    guildId: string,
    daysBack: number = 7
  ): Promise<DatabaseResult<any>> {
    try {
      const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

      const result = await this.db.query(
        `
        SELECT
          COUNT(*) as total_conversations,
          COUNT(DISTINCT channel_id) as channels_with_conversations,
          AVG(array_length(participants, 1)) as avg_participants,
          AVG(message_count) as avg_messages_per_conversation,
          AVG(EXTRACT(EPOCH FROM (end_time - start_time))/60) as avg_duration_minutes,
          MIN(start_time) as earliest_conversation,
          MAX(end_time) as latest_conversation,
          ROUND(SUM(message_count)::numeric)::int as total_messages_in_conversations
        FROM conversation_segments
        WHERE guild_id = $1 AND status = 'finalized' AND created_at >= $2
        `,
        [guildId, sinceDate]
      );

      if (!result.success) {
        return { success: false, error: result.error };
      }

      const metrics = result.data?.[0] || {};
      return {
        success: true,
        data: {
          time_period_days: daysBack,
          total_conversations: parseInt(metrics.total_conversations) || 0,
          channels_with_conversations: parseInt(metrics.channels_with_conversations) || 0,
          avg_participants: parseFloat(metrics.avg_participants) || 0,
          avg_messages_per_conversation: parseFloat(metrics.avg_messages_per_conversation) || 0,
          avg_duration_minutes: parseFloat(metrics.avg_duration_minutes) || 0,
          total_messages: parseInt(metrics.total_messages_in_conversations) || 0,
          earliest_conversation: metrics.earliest_conversation ? new Date(metrics.earliest_conversation) : null,
          latest_conversation: metrics.latest_conversation ? new Date(metrics.latest_conversation) : null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get top conversation participant pairs
   */
  async getTopConversationPairs(
    guildId: string,
    limit: number = 20
  ): Promise<DatabaseResult<any[]>> {
    try {
      const result = await this.db.query(
        `
        WITH pair_stats AS (
          SELECT
            array_agg(DISTINCT participant) as participants,
            COUNT(*) as conversation_count,
            SUM(message_count) as total_messages,
            AVG(array_length(participants, 1)) as avg_segment_size,
            MAX(end_time) as last_conversation
          FROM (
            SELECT DISTINCT ON (cs.id)
              UNNEST(cs.participants) as participant,
              cs.id,
              cs.message_count,
              cs.participants,
              cs.end_time
            FROM conversation_segments cs
            WHERE cs.guild_id = $1 AND cs.status = 'finalized'
          ) t
          GROUP BY (SELECT ARRAY_AGG(p) FROM UNNEST(participants) p ORDER BY p)
          HAVING array_length(ARRAY_AGG(DISTINCT participant), 1) >= 2
        )
        SELECT
          participants,
          conversation_count,
          total_messages,
          avg_segment_size,
          last_conversation
        FROM pair_stats
        ORDER BY conversation_count DESC, total_messages DESC
        LIMIT $2
        `,
        [guildId, limit]
      );

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true, data: result.data || [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get conversation frequency for a user
   */
  async getUserConversationFrequency(
    userId: string,
    guildId: string,
    daysBack: number = 30
  ): Promise<DatabaseResult<any>> {
    try {
      const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

      const result = await this.db.query(
        `
        SELECT
          COUNT(*) as total_conversations,
          COUNT(DISTINCT channel_id) as channels_participated_in,
          AVG(array_length(participants, 1)) as avg_conversation_size,
          AVG(message_count) as avg_messages_per_conversation,
          SUM(message_count) as total_messages,
          STRING_AGG(DISTINCT participant, ',') as frequent_partners
        FROM (
          SELECT
            cs.id,
            cs.channel_id,
            cs.participants,
            cs.message_count,
            UNNEST(cs.participants) as participant
          FROM conversation_segments cs
          WHERE cs.guild_id = $1
            AND cs.status = 'finalized'
            AND cs.created_at >= $2
        ) t
        WHERE participant = $3
        `,
        [guildId, sinceDate, userId]
      );

      if (!result.success) {
        return { success: false, error: result.error };
      }

      const data = result.data?.[0] || {};
      return {
        success: true,
        data: {
          user_id: userId,
          time_period_days: daysBack,
          total_conversations: parseInt(data.total_conversations) || 0,
          channels_participated_in: parseInt(data.channels_participated_in) || 0,
          avg_conversation_size: parseFloat(data.avg_conversation_size) || 0,
          avg_messages_per_conversation: parseFloat(data.avg_messages_per_conversation) || 0,
          total_messages: parseInt(data.total_messages) || 0,
          frequent_partners: data.frequent_partners ? data.frequent_partners.split(',') : [],
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ============================================================================
  // Semantic Merging - Auto-combine related conversations
  // ============================================================================

  /**
   * Calculate semantic similarity between two conversation summaries
   * Simplified heuristic: overlap of keywords and similar participant sets
   */
  private calculateSummarySimilarity(
    summary1: string,
    summary2: string,
    participants1: string[],
    participants2: string[]
  ): number {
    if (!summary1 || !summary2) return 0;

    // Extract keywords (simple word-level overlap)
    const words1 = new Set(summary1.toLowerCase().split(/\W+/));
    const words2 = new Set(summary2.toLowerCase().split(/\W+/));

    const commonWords = Array.from(words1).filter((w) => words2.has(w)).length;
    const totalWords = Math.max(words1.size, words2.size);
    const wordSimilarity = totalWords > 0 ? commonWords / totalWords : 0;

    // Participant overlap score
    const p1Set = new Set(participants1);
    const p2Set = new Set(participants2);
    const commonParticipants = Array.from(p1Set).filter((p) => p2Set.has(p)).length;
    const totalParticipants = new Set([...participants1, ...participants2]).size;
    const participantSimilarity =
      totalParticipants > 0 ? commonParticipants / totalParticipants : 0;

    // Weighted average (60% text, 40% participants)
    return wordSimilarity * 0.6 + participantSimilarity * 0.4;
  }

  /**
   * Find and merge semantically similar conversations
   * Merges conversations in the same channel with similar summaries and overlapping participants
   */
  async mergeSimilarConversations(
    guildId: string,
    channelId: string,
    similarityThreshold: number = 0.75,
    timeGapMinutes: number = 30
  ): Promise<DatabaseResult<{ merged_count: number }>> {
    try {
      // Get all finalized conversations in the channel
      const result = await this.db.query(
        `
        SELECT
          id,
          participants,
          summary,
          start_time,
          end_time,
          message_ids,
          message_count
        FROM conversation_segments
        WHERE guild_id = $1
          AND channel_id = $2
          AND status = 'finalized'
        ORDER BY end_time DESC
        `,
        [guildId, channelId]
      );

      if (!result.success || !result.data || result.data.length < 2) {
        return { success: true, data: { merged_count: 0 } };
      }

      const segments = result.data;
      const mergedSet = new Set<string>();
      let mergeCount = 0;

      // Compare adjacent and nearby segments
      for (let i = 0; i < segments.length; i++) {
        if (mergedSet.has(segments[i].id)) continue;

        const current = segments[i];
        const currentEnd = new Date(current.end_time);

        // Look ahead for similar segments within time window
        for (let j = i + 1; j < segments.length; j++) {
          if (mergedSet.has(segments[j].id)) continue;

          const candidate = segments[j];
          const candidateStart = new Date(candidate.start_time);
          const timeDiffMinutes = (currentEnd.getTime() - candidateStart.getTime()) / (1000 * 60);

          // Only merge if within time window
          if (timeDiffMinutes > timeGapMinutes) break;

          // Calculate similarity
          const similarity = this.calculateSummarySimilarity(
            current.summary,
            candidate.summary,
            current.participants,
            candidate.participants
          );

          // Merge if similar enough
          if (similarity >= similarityThreshold) {
            await this.mergeConversationSegments(current.id, candidate.id);
            mergedSet.add(candidate.id);
            mergeCount++;
          }
        }
      }

      return { success: true, data: { merged_count: mergeCount } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Merge two conversation segments into one
   */
  private async mergeConversationSegments(
    primarySegmentId: string,
    secondarySegmentId: string
  ): Promise<void> {
    try {
      // Get both segments
      const [primary, secondary] = await Promise.all([
        this.hydrateConversationSegment(primarySegmentId),
        this.hydrateConversationSegment(secondarySegmentId),
      ]);

      if (!primary.success || !secondary.success) {
        throw new Error("Failed to hydrate segments for merging");
      }

      const seg1 = primary.data;
      const seg2 = secondary.data;

      // Merge data
      const mergedParticipants = Array.from(
        new Set([...(seg1.participants || []), ...(seg2.participants || [])])
      ).sort();

      const mergedMessageIds = Array.from(
        new Set([...(seg1.message_ids || []), ...(seg2.message_ids || [])])
      );

      const mergedStartTime = new Date(
        Math.min(
          new Date(seg1.start_time).getTime(),
          new Date(seg2.start_time).getTime()
        )
      );

      const mergedEndTime = new Date(
        Math.max(
          new Date(seg1.end_time).getTime(),
          new Date(seg2.end_time).getTime()
        )
      );

      const mergedMessageCount = (seg1.message_count || 0) + (seg2.message_count || 0);

      // Merge features
      const mergedFeatures = {
        mention_count: ((seg1.features?.mention_count || 0) + (seg2.features?.mention_count || 0)),
        reply_count: ((seg1.features?.reply_count || 0) + (seg2.features?.reply_count || 0)),
        merged_from: [seg1.id, seg2.id],
      };

      // Update primary segment with merged data
      await this.db.query(
        `
        UPDATE conversation_segments
        SET
          participants = $1,
          message_ids = $2,
          start_time = $3,
          end_time = $4,
          message_count = $5,
          features = $6,
          summary = 'Merged conversation: ' || summary
        WHERE id = $7
        `,
        [mergedParticipants, mergedMessageIds, mergedStartTime, mergedEndTime, mergedMessageCount, JSON.stringify(mergedFeatures), primarySegmentId]
      );

      // Delete secondary segment
      await this.db.query(
        `DELETE FROM conversation_segments WHERE id = $1`,
        [secondarySegmentId]
      );
    } catch (error) {
      console.error(`🔸 Failed to merge conversation segments:`, error);
    }
  }

  /**
   * Run semantic merging for all channels in a guild (background task)
   */
  async runSemanticMergingForGuild(guildId: string): Promise<void> {
    try {
      // Get all channels with conversations
      const channelsResult = await this.db.query(
        `
        SELECT DISTINCT channel_id
        FROM conversation_segments
        WHERE guild_id = $1 AND status = 'finalized'
        `,
        [guildId]
      );

      if (!channelsResult.success || !channelsResult.data) {
        return;
      }

      let totalMerged = 0;

      for (const row of channelsResult.data) {
        const mergeResult = await this.mergeSimilarConversations(guildId, row.channel_id);
        if (mergeResult.success) {
          totalMerged += mergeResult.data?.merged_count || 0;
        }
      }

      if (totalMerged > 0) {
        console.log(`🔄 Semantic merging: merged ${totalMerged} conversation pairs in guild ${guildId}`);
      }
    } catch (error) {
      console.error("🔸 Failed to run semantic merging:", error);
    }
  }

  /**
   * Helper: Extract keywords from message content (stopword filtering + stemming)
   */
  private extractKeywords(content: string): Set<string> {
    const stopwords = new Set([
      "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
      "by", "from", "as", "is", "was", "are", "were", "be", "been", "being", "have", "has",
      "had", "do", "does", "did", "will", "would", "should", "could", "may", "might", "must",
      "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
      "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
      "im", "ive", "youre", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent",
      "just", "so", "like", "yeah", "oh", "um", "uh", "lol", "lmao", "tbh", "ngl"
    ]);

    const keywords = new Set<string>();
    const words = content
      .toLowerCase()
      .replace(/<@!?\d+>/g, "") // Remove mentions
      .replace(/[^\w\s]/g, " ") // Remove punctuation
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));

    words.forEach(word => keywords.add(word));
    return keywords;
  }

  /**
   * Helper: Calculate topic overlap using Jaccard similarity
   */
  private calculateTopicOverlapFromKeywords(keywords1: Set<string>, keywords2: Set<string>): number {
    if (keywords1.size === 0 && keywords2.size === 0) return 0;
    if (keywords1.size === 0 || keywords2.size === 0) return 0;

    let intersection = 0;
    for (const word of keywords1) {
      if (keywords2.has(word)) {
        intersection++;
      }
    }

    const union = keywords1.size + keywords2.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Helper: Calculate cosine similarity between embeddings
   */
  private calculateCosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length || vec1.length === 0) return 0;

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i]! * vec2[i]!;
      norm1 += vec1[i]! * vec1[i]!;
      norm2 += vec2[i]! * vec2[i]!;
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (norm1 * norm2);
  }

  /**
   * Helper: Calculate average embedding from array of embeddings
   */
  private calculateAverageEmbedding(embeddings: number[][]): number[] | null {
    if (embeddings.length === 0) return null;

    const dim = embeddings[0]!.length;
    const avg = new Array(dim).fill(0);

    for (const emb of embeddings) {
      if (emb.length !== dim) continue;
      for (let i = 0; i < dim; i++) {
        avg[i] += emb[i]!;
      }
    }

    for (let i = 0; i < dim; i++) {
      avg[i] /= embeddings.length;
    }

    return avg;
  }

  /**
   * Batch regeneration using sophisticated algorithm from test script
   * Includes all Phase 2 & 3 improvements: keyword caching, multiplicative scoring,
   * empty content handling, participant pair continuity, rapid-fire detection, etc.
   */
  async regenerateConversationsAdvanced(
    channelId: string,
    guildId: string,
    messages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      embedding?: number[];
    }>
  ): Promise<DatabaseResult<ConversationEntry[]>> {
    try {
      interface MessageWithKeywords {
        id: string;
        author_id: string;
        content: string;
        created_at: Date;
        referenced_message_id?: string;
        embedding?: number[];
        keywords: Set<string>;
      }

      interface ConversationGroup {
        id: string;
        participants: Set<string>;
        messageIds: Set<string>;
        messages: MessageWithKeywords[];
        startTime: Date;
        endTime: Date;
        avgAffinity: number;
      }

      // Pre-compute keywords for all messages
      const messagesWithKeywords: MessageWithKeywords[] = messages.map(m => ({
        ...m,
        keywords: this.extractKeywords(m.content || "")
      }));

      const uniqueAuthors = new Set(messagesWithKeywords.map(m => m.author_id));

      // Build affinity matrix
      const affinityMatrix = await this.buildRelationshipContextForChannel(
        Array.from(uniqueAuthors),
        guildId
      );

      const conversations: ConversationGroup[] = [];
      const processedMessages = new Set<string>();

      // Phase 1: Explicit signals (reply chains, mentions)
      for (const msg of messagesWithKeywords) {
        if (processedMessages.has(msg.id)) continue;

        let targetConvo: ConversationGroup | undefined;

        // Reply chains
        if (msg.referenced_message_id) {
          targetConvo = conversations.find(c => c.messageIds.has(msg.referenced_message_id!));

          // If no conversation exists, create new one with referenced message
          if (!targetConvo) {
            const referencedMsg = messagesWithKeywords.find(m => m.id === msg.referenced_message_id);
            if (referencedMsg) {
              targetConvo = {
                id: `conv_${referencedMsg.id}`,
                participants: new Set([referencedMsg.author_id, msg.author_id]),
                messageIds: new Set([referencedMsg.id, msg.id]),
                messages: [referencedMsg, msg],
                startTime: referencedMsg.created_at,
                endTime: msg.created_at,
                avgAffinity: 0
              };
              conversations.push(targetConvo);
              processedMessages.add(referencedMsg.id);
              processedMessages.add(msg.id);
              continue;
            }
          }
        }

        // Mentions
        if (!targetConvo) {
          const mentionMatches = msg.content.match(this.mentionPattern);
          if (mentionMatches) {
            const mentionedIds = mentionMatches.map(m => m.replace(/<@!?(\d+)>/, "$1"));

            for (const convo of conversations) {
              for (const mentionedId of mentionedIds) {
                if (convo.participants.has(mentionedId)) {
                  const timeDelta = msg.created_at.getTime() - convo.endTime.getTime();
                  if (timeDelta <= 5 * 60 * 1000) {
                    targetConvo = convo;
                    break;
                  }
                }
              }
              if (targetConvo) break;
            }
          }
        }

        if (targetConvo) {
          targetConvo.messageIds.add(msg.id);
          targetConvo.participants.add(msg.author_id);
          targetConvo.messages.push(msg);
          targetConvo.endTime = msg.created_at;
          processedMessages.add(msg.id);
        }
      }

      // Phase 2: Enhanced scoring with all improvements
      const BASE_EXTEND_MINUTES = 45;
      const RECENT_MESSAGES_WINDOW = 5;

      for (const msg of messagesWithKeywords) {
        if (processedMessages.has(msg.id)) continue;

        let bestScore = 0;
        let bestConvo: ConversationGroup | null = null;
        let bestMaxAffinity = 0;

        const mentionMatches = msg.content.match(this.mentionPattern);
        const mentionedIds = mentionMatches ? mentionMatches.map(m => m.replace(/<@!?(\d+)>/, "$1")) : [];

        for (const convo of conversations) {
          const timeDelta = msg.created_at.getTime() - convo.endTime.getTime();
          const timeSinceEnd = timeDelta / (1000 * 60);

          // Special handling for empty content (images/attachments)
          const isEmptyContent = !msg.content || msg.content.trim().length === 0;
          if (isEmptyContent && convo.participants.has(msg.author_id) && timeSinceEnd <= 10) {
            bestScore = 1.0;
            bestConvo = convo;
            break;
          }

          const mentionsParticipant = mentionedIds.some(id => convo.participants.has(id));
          const repliesToParticipant = msg.referenced_message_id && convo.messageIds.has(msg.referenced_message_id);
          const isParticipant = convo.participants.has(msg.author_id);

          // Calculate max affinity
          let maxAffinity = 0;
          for (const participantId of convo.participants) {
            if (participantId === msg.author_id) continue;
            const affinity = affinityMatrix.get(msg.author_id)?.get(participantId) || 0;
            if (affinity > maxAffinity) {
              maxAffinity = affinity;
            }
          }

          // Semantic similarity
          let semanticScore = 0;
          if (msg.embedding && convo.messages.length > 0) {
            const convEmbeddings = convo.messages
              .map(m => m.embedding)
              .filter((emb): emb is number[] => emb !== undefined);
            if (convEmbeddings.length > 0) {
              const avgEmb = this.calculateAverageEmbedding(convEmbeddings);
              if (avgEmb) {
                semanticScore = this.calculateCosineSimilarity(msg.embedding, avgEmb);
              }
            }
          }

          // Topic overlap with recent messages
          const recentMessages = convo.messages.slice(-RECENT_MESSAGES_WINDOW);
          let recentTopicScore = 0;
          if (recentMessages.length > 0) {
            let totalOverlap = 0;
            for (const convMsg of recentMessages) {
              totalOverlap += this.calculateTopicOverlapFromKeywords(msg.keywords, convMsg.keywords);
            }
            recentTopicScore = totalOverlap / recentMessages.length;
          }

          // Overall topic score
          let overallTopicScore = 0;
          if (convo.messages.length > 0) {
            let weightedOverlap = 0;
            let totalWeight = 0;
            for (let i = 0; i < convo.messages.length; i++) {
              const convMsg = convo.messages[i]!;
              const overlap = this.calculateTopicOverlapFromKeywords(msg.keywords, convMsg.keywords);
              const weight = i >= convo.messages.length - 10 ? 1.0 : 0.5;
              weightedOverlap += overlap * weight;
              totalWeight += weight;
            }
            overallTopicScore = totalWeight > 0 ? weightedOverlap / totalWeight : 0;
          }

          // Rapid-fire detection
          const isRapidFire = convo.messages.length >= 3 && timeSinceEnd <= 3;

          // Dynamic extend window
          let extendWindow = BASE_EXTEND_MINUTES;
          if (isParticipant && recentTopicScore > 0.05) {
            extendWindow = 180;
          } else if (semanticScore > 0.7) {
            extendWindow = 120;
          } else if (semanticScore > 0.6) {
            extendWindow = 90;
          } else if (recentTopicScore > 0.2) {
            extendWindow = 120;
          } else if (recentTopicScore > 0.1) {
            extendWindow = 60;
          }

          if (isRapidFire) {
            extendWindow = Math.max(extendWindow, 120);
          }

          if (timeSinceEnd > extendWindow) continue;

          const timeScore = Math.max(0, 1 - (timeSinceEnd / extendWindow));

          // Base score with multiplicative bonuses
          let baseScore = (
            maxAffinity * 0.20 +
            timeScore * 0.10 +
            semanticScore * 0.40 +
            recentTopicScore * 0.20 +
            overallTopicScore * 0.10
          );

          let scoreMultiplier = 1.0;
          if (repliesToParticipant) scoreMultiplier *= 1.50;
          if (mentionsParticipant) scoreMultiplier *= 1.15;
          if (isParticipant) scoreMultiplier *= 1.10;

          // Participant pair continuity
          const isExactPairMatch = convo.participants.size === 2 && convo.participants.has(msg.author_id) && timeSinceEnd <= 15;
          if (isExactPairMatch) {
            scoreMultiplier *= 1.40;
          }

          if (convo.participants.size <= 3 && convo.participants.has(msg.author_id) && timeSinceEnd <= 45) {
            scoreMultiplier *= 1.25;
          }

          baseScore *= scoreMultiplier;

          if (baseScore > bestScore) {
            bestScore = baseScore;
            bestConvo = convo;
            bestMaxAffinity = maxAffinity;
          }
        }

        // Thresholds
        const hasStrongSignal = bestConvo && (
          mentionedIds.some(id => bestConvo!.participants.has(id)) ||
          bestConvo.participants.has(msg.author_id)
        );

        const isSameSmallGroup = bestConvo && bestConvo.participants.size <= 2 && bestConvo.participants.has(msg.author_id);

        const threshold = hasStrongSignal ? 0.15 :
                         isSameSmallGroup ? 0.12 :
                         (bestMaxAffinity > 0.3 && bestScore > 0.35 ? 0.30 : 0.40);

        if (bestScore > threshold && bestConvo) {
          bestConvo.messageIds.add(msg.id);
          bestConvo.participants.add(msg.author_id);
          bestConvo.messages.push(msg);
          bestConvo.endTime = msg.created_at;
          processedMessages.add(msg.id);
        }
      }

      // Phase 3: Topic drift analysis and splitting
      console.log(`🔸 Running Phase 3: Topic drift analysis on ${conversations.length} conversations`);
      const splitConversations: ConversationGroup[] = [];
      
      for (const convo of conversations) {
          // Only analyze conversations with 10+ messages or 60+ minutes duration
          if (convo.messages.length < 10) {
            splitConversations.push(convo);
            continue;
          }
          
          const duration = (convo.endTime.getTime() - convo.startTime.getTime()) / (1000 * 60);
          if (duration < 60) {
            splitConversations.push(convo);
            continue;
          }
          
          try {
            // Analyze for topic splits
            const splits = await this.topicDriftDetector.analyzeConversationForSplits(
              convo.messages,
              guildId,
              "system"
            );
            
            if (splits.length === 0) {
              // No splits detected
              splitConversations.push(convo);
              continue;
            }
            
            // Split conversation at detected points
            console.log(`🔸 Splitting conversation ${convo.id} at ${splits.length} points`);
            let currentSegment: typeof convo.messages = [];
            let segmentStart = 0;
            
            for (let i = 0; i < splits.length; i++) {
              const split = splits[i]!;
              const segmentMessages = convo.messages.slice(segmentStart, split.splitIndex);
              
              if (segmentMessages.length >= 3) {
                splitConversations.push({
                  id: `${convo.id}_split_${i}`,
                  participants: new Set(segmentMessages.map(m => m.author_id)),
                  messageIds: new Set(segmentMessages.map(m => m.id)),
                  messages: segmentMessages,
                  startTime: segmentMessages[0]!.created_at,
                  endTime: segmentMessages[segmentMessages.length - 1]!.created_at,
                  avgAffinity: convo.avgAffinity,
                });
              }
              
              segmentStart = split.splitIndex;
            }
            
            // Add remaining messages as final segment
            const finalSegment = convo.messages.slice(segmentStart);
            if (finalSegment.length >= 3) {
              splitConversations.push({
                id: `${convo.id}_split_final`,
                participants: new Set(finalSegment.map(m => m.author_id)),
                messageIds: new Set(finalSegment.map(m => m.id)),
                messages: finalSegment,
                startTime: finalSegment[0]!.created_at,
                endTime: finalSegment[finalSegment.length - 1]!.created_at,
                avgAffinity: convo.avgAffinity,
              });
            }
          } catch (error) {
            console.error(`🔸 Failed to analyze conversation ${convo.id} for topic drift:`, error);
            // On error, keep conversation as-is
            splitConversations.push(convo);
          }
      }
      
      // Replace conversations with split versions
      conversations.splice(0, conversations.length, ...splitConversations);
      console.log(`🔸 After topic drift analysis: ${conversations.length} conversations`);

      // Phase 4: Merge pass with same-participant priority
      let merged = true;
      while (merged) {
        merged = false;

        for (let i = 0; i < conversations.length; i++) {
          for (let j = i + 1; j < conversations.length; j++) {
            const convoA = conversations[i]!;
            const convoB = conversations[j]!;

            const timeGap = Math.abs(convoA.endTime.getTime() - convoB.startTime.getTime()) / (1000 * 60);
            if (timeGap > 180) continue;

            // Same participants check (highest priority)
            const sameParticipants = convoA.participants.size === convoB.participants.size &&
                                    [...convoA.participants].every(p => convoB.participants.has(p));

            if (sameParticipants && timeGap <= 30) {
              // Merge
              for (const msgId of convoB.messageIds) convoA.messageIds.add(msgId);
              for (const p of convoB.participants) convoA.participants.add(p);
              convoA.messages.push(...convoB.messages);
              convoA.endTime = new Date(Math.max(convoA.endTime.getTime(), convoB.endTime.getTime()));
              convoA.startTime = new Date(Math.min(convoA.startTime.getTime(), convoB.startTime.getTime()));
              conversations.splice(j, 1);
              merged = true;
              break;
            }
          }
          if (merged) break;
        }
      }

      // Convert to ConversationEntry
      const result: ConversationEntry[] = [];
      for (const convo of conversations) {
        if (convo.messages.length < 3) continue;

        // Calculate avg affinity
        const participants = Array.from(convo.participants);
        let totalAffinity = 0;
        let pairCount = 0;
        for (let i = 0; i < participants.length; i++) {
          for (let j = i + 1; j < participants.length; j++) {
            const affinity = affinityMatrix.get(participants[i]!)?.get(participants[j]!) || 0;
            totalAffinity += affinity;
            pairCount++;
          }
        }
        convo.avgAffinity = pairCount > 0 ? totalAffinity / pairCount : 0;

        result.push({
          segment_id: convo.id,
          conversation_id: convo.id,
          start_time: convo.startTime,
          end_time: convo.endTime,
          message_count: convo.messages.length,
          participants: Array.from(convo.participants),
          channel_id: channelId,
          message_ids: Array.from(convo.messageIds),
          interaction_types: [],
          duration_minutes: Math.round((convo.endTime.getTime() - convo.startTime.getTime()) / (1000 * 60)),
        });
      }

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      };
    }
  }

  // ============================================================================
  // PUBLIC ACCESSORS - Live Conversation State (for AI Context Integration)
  // ============================================================================

  /**
   * Get live conversation state for a channel
   * Returns current buffer and active conversations before finalization
   * Used by AI assistant to understand ongoing conversations when bot is mentioned
   */
  getLiveConversationInChannel(
    channelId: string,
    guildId: string
  ): {
    buffer: ChannelBuffer | null;
    activeConversations: ActiveConversation[];
    recentMessages: Array<{
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      mentioned_user_ids?: string[];
    }>;
  } {
    const key = `${guildId}:${channelId}`;
    const buffer = this.channelBuffers.get(key);

    if (!buffer) {
      return {
        buffer: null,
        activeConversations: [],
        recentMessages: [],
      };
    }

    return {
      buffer,
      activeConversations: buffer.activeConversations,
      recentMessages: buffer.messages,
    };
  }

  /**
   * Get participant IDs from active conversations in a channel
   * Returns unique set of user IDs participating in ongoing conversations
   */
  getActiveParticipantsInChannel(
    channelId: string,
    guildId: string
  ): string[] {
    const key = `${guildId}:${channelId}`;
    const buffer = this.channelBuffers.get(key);

    if (!buffer || buffer.activeConversations.length === 0) {
      return [];
    }

    // Combine participants from all active conversations
    const allParticipants = new Set<string>();
    for (const convo of buffer.activeConversations) {
      for (const participantId of convo.participants) {
        allParticipants.add(participantId);
      }
    }

    return Array.from(allParticipants);
  }

  /**
   * Get recent messages from buffer (before finalization)
   * Returns last N messages from the channel's active buffer
   */
  getRecentBufferedMessages(
    channelId: string,
    guildId: string,
    limit: number = 10
  ): Array<{
    id: string;
    author_id: string;
    content: string;
    created_at: Date;
    referenced_message_id?: string;
    mentioned_user_ids?: string[];
  }> {
    const key = `${guildId}:${channelId}`;
    const buffer = this.channelBuffers.get(key);

    if (!buffer) {
      return [];
    }

    return buffer.messages.slice(-limit);
  }

  /**
   * Check if a message is part of an active conversation
   * Returns conversation metadata if found
   */
  isPartOfActiveConversation(
    messageId: string,
    channelId: string,
    guildId: string
  ): {
    isActive: boolean;
    conversationIndex?: number;
    participants?: string[];
    messageCount?: number;
  } {
    const key = `${guildId}:${channelId}`;
    const buffer = this.channelBuffers.get(key);

    if (!buffer) {
      return { isActive: false };
    }

    // Check each active conversation for this message
    for (let i = 0; i < buffer.activeConversations.length; i++) {
      const convo = buffer.activeConversations[i];
      if (convo && convo.messageIds.has(messageId)) {
        return {
          isActive: true,
          conversationIndex: i,
          participants: Array.from(convo.participants),
          messageCount: convo.messageIds.size,
        };
      }
    }

    return { isActive: false };
  }

  /**
   * Generate a short hash from a string (for readable IDs)
   */
  private generateShortHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36).slice(0, 6);
  }

  /**
   * Extract mentioned user IDs from message content
   */
  private extractMentionedUserIds(content: string): string[] {
    const mentions: string[] = [];
    const mentionPattern = /<@!?(\d+)>/g;
    let match;

    while ((match = mentionPattern.exec(content)) !== null) {
      if (match[1]) {
        mentions.push(match[1]);
      }
    }

    return mentions;
  }

  /**
   * OPTIMIZED: Group messages into conversations using the new strategy-based approach
   * This replaces the old groupReplyChains method with improved performance and maintainability
   *
   * Key optimizations:
   * - Messages are pre-sorted once (no redundant sorting)
   * - Scoring logic centralized in ConversationScorer
   * - Validation logic centralized in ConversationValidator
   * - Strategy pattern for clean separation of grouping approaches
   * - Cached metadata for repeated operations
   */
  private async groupMessagesOptimized<
    T extends {
      id: string;
      author_id: string;
      content: string;
      created_at: Date;
      referenced_message_id?: string;
      mentioned_user_ids?: string[];
      embedding?: number[];
    }
  >(
    messages: T[],
    guildId: string,
    channelId: string
  ): Promise<Array<{ messages: T[] }>> {
    if (messages.length === 0) {
      return [];
    }

    // PRE-SORT OPTIMIZATION: Sort messages once at the beginning
    // All subsequent operations assume messages are sorted
    const sortedMessages = [...messages].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime()
    );

    // Build message map for quick lookup
    const messageMap = new Map<string, T>();
    for (const msg of sortedMessages) {
      messageMap.set(msg.id, msg);
    }

    // Create grouping context
    const context: GroupingContext = {
      guildId,
      channelId,
      messageMap,
    };

    // Use the strategy-based grouper to detect conversations
    const groups = await this.grouper.groupMessages(sortedMessages, context);

    // Filter and validate groups
    const validGroups: Array<{ messages: T[] }> = [];

    for (const group of groups) {
      const groupMessages = group.getMessages(messageMap);
      const messageIds = group.getMessageIds();

      // Validate the conversation
      if (this.validator.isValidConversation(groupMessages, messageIds)) {
        validGroups.push({ messages: groupMessages });
      }
    }

    return validGroups;
  }

  /**
   * Public method to use the optimized grouping
   * Can be called externally for testing or direct usage
   */
  async detectConversationsOptimized(
    channelId: string,
    guildId: string,
    timeWindowHours: number = 24,
    minMessages: number = 3
  ): Promise<DatabaseResult<ConversationEntry[]>> {
    const perfStart = Date.now();
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - timeWindowHours);

      // Fetch messages from channel
      const fetchStart = Date.now();
      const messagesResult = await this.db.query(
        `SELECT
          m.id, m.author_id, m.content, m.created_at, m.referenced_message_id,
          m.embedding
        FROM messages m
        WHERE m.channel_id = $1
          AND m.guild_id = $2
          AND m.created_at >= $3
          AND m.author_id NOT IN (${KNOWN_BOT_USER_IDS.map((_, i) => `$${i + 4}`).join(", ")})
        ORDER BY m.created_at ASC`,
        [channelId, guildId, cutoffTime, ...KNOWN_BOT_USER_IDS]
      );

      if (!messagesResult.success || !messagesResult.data) {
        return { success: false, error: messagesResult.error };
      }

      const fetchTime = Date.now() - fetchStart;
      const messages = messagesResult.data.map((row: any) => ({
        id: row.id,
        author_id: row.author_id,
        content: row.content || "",
        created_at: new Date(row.created_at),
        referenced_message_id: row.referenced_message_id,
        mentioned_user_ids: this.extractMentionedUserIds(row.content || ""),
        embedding: row.embedding ? parseEmbeddingValue(row.embedding) : undefined,
      }));

      // Use optimized grouping
      const groupStart = Date.now();
      const groups = await this.groupMessagesOptimized(messages, guildId, channelId);
      const groupTime = Date.now() - groupStart;

      // Convert to ConversationEntry format
      const conversations: ConversationEntry[] = [];
      for (const group of groups) {
        if (group.messages.length < minMessages) continue;

        const participants = new Set(group.messages.map((m) => m.author_id));
        const messageIds = group.messages.map((m) => m.id);
        const startTime = group.messages[0]!.created_at;
        const endTime = group.messages[group.messages.length - 1]!.created_at;

        // Create readable segment ID: conv_YYYYMMDD_HHMM_hash
        const dateStr = startTime.toISOString().split('T')[0]!.replace(/-/g, '');
        const timeStr = startTime.toISOString().split('T')[1]!.slice(0, 5).replace(':', '');
        const hash = this.generateShortHash(`${channelId}-${startTime.getTime()}`);
        const readableId = `conv_${dateStr}_${timeStr}_${hash}`;

        conversations.push({
          segment_id: readableId,
          conversation_id: readableId,
          start_time: startTime,
          end_time: endTime,
          message_count: group.messages.length,
          participants: Array.from(participants),
          channel_id: channelId,
          message_ids: messageIds,
          interaction_types: [],
          duration_minutes: Math.round(
            (endTime.getTime() - startTime.getTime()) / (1000 * 60)
          ),
        });
      }

      const totalTime = Date.now() - perfStart;
      console.log(
        `📊 [OPTIMIZED] Detected ${conversations.length} conversations from ${messages.length} messages ` +
        `(fetch: ${fetchTime}ms, group: ${groupTime}ms, total: ${totalTime}ms)`
      );

      return { success: true, data: conversations };
    } catch (error) {
      console.error("Error detecting conversations (optimized):", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
