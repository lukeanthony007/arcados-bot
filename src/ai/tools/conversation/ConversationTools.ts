import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
  resolveUserId,
} from "../registry/DatabaseTools";
import { pgvector } from "../../../database/PostgreSQLManager.js";
import { EmbeddingService } from "../../../features/social-intelligence/semantic-analysis/EmbeddingService.js";

interface SegmentRow {
  id: string;
  channel_id: string;
  channel_name: string | null;
  start_time: Date;
  end_time: Date;
  message_count: number;
  summary: string | null;
  topic_label: string | null;
  status: string;
  participants: string[];
}

async function loadNames(context: ToolContext, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const result = await context.db.query(
    `SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
     FROM members
     WHERE user_id = ANY($1::text[]) AND guild_id = $2`,
    [[...new Set(ids)], context.guildId]
  );
  if (result.success && result.data) {
    for (const member of result.data) names.set(member.user_id, member.name);
  }
  return names;
}

async function resolvePair(
  user1: string,
  user2: string,
  context: ToolContext
): Promise<{ a: string; b: string } | { error: string }> {
  const first = await resolveUserId(user1, context.guildId, context.db);
  if (!first.success || !first.userId) return { error: first.error ?? `User "${user1}" not found` };
  const second = await resolveUserId(user2, context.guildId, context.db);
  if (!second.success || !second.userId) {
    return { error: second.error ?? `User "${user2}" not found` };
  }
  return { a: first.userId, b: second.userId };
}

async function queryPairSegments(
  context: ToolContext,
  a: string,
  b: string,
  limit: number
): Promise<SegmentRow[]> {
  const result = await context.db.query(
    `SELECT cs.id, cs.channel_id, c.name AS channel_name, cs.start_time, cs.end_time,
            cs.message_count, cs.summary, cs.topic_label, cs.status, cs.participants
     FROM conversation_segments cs
     LEFT JOIN channels c ON c.id = cs.channel_id AND c.guild_id = cs.guild_id
     WHERE cs.guild_id = $1 AND cs.participants @> ARRAY[$2, $3]::text[]
     ORDER BY cs.end_time DESC
     LIMIT $4`,
    [context.guildId, a, b, limit]
  );
  if (!result.success || !result.data) {
    throw new Error(`Failed to get conversations: ${result.error}`);
  }
  return result.data;
}

function formatSegment(seg: SegmentRow, names: Map<string, string>): string {
  const who = seg.participants.map((id) => names.get(id) ?? id).join(", ");
  const minutes = Math.round(
    (new Date(seg.end_time).getTime() - new Date(seg.start_time).getTime()) / 60000
  );
  const lines = [
    `${seg.id}: #${seg.channel_name ?? seg.channel_id}, ${new Date(
      seg.start_time
    ).toLocaleString()} (${seg.message_count} messages, ${minutes} min${
      seg.status === "active" ? ", still going" : ""
    })`,
    `  Participants: ${who}`,
  ];
  if (seg.topic_label) lines.push(`  Topic: ${seg.topic_label}`);
  if (seg.summary) lines.push(`  Summary: ${seg.summary}`);
  return lines.join("\n");
}

/**
 * Get conversations between two users
 */
export const getConversationsBetweenTool: DatabaseTool = {
  name: "getConversationsBetween",
  description:
    "Get the stored conversations two users both took part in, newest first, with topic, summary, channel, date and message count. Accepts names or IDs. Use this to understand how users interact.",
  parameters: {
    type: "object",
    properties: {
      user1Id: {
        type: "string",
        description: "First user's name or Discord ID",
      },
      user2Id: {
        type: "string",
        description: "Second user's name or Discord ID",
      },
      limit: {
        type: "number",
        description: "Maximum number of conversations to return (default: 10)",
      },
    },
    required: ["user1Id", "user2Id"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { user1Id, user2Id, limit } = params as {
      user1Id: string;
      user2Id: string;
      limit?: number;
    };
    try {
      const pair = await resolvePair(user1Id, user2Id, context);
      if ("error" in pair) return { success: false, error: pair.error };

      const conversations = await queryPairSegments(context, pair.a, pair.b, limit || 10);
      const names = await loadNames(
        context,
        conversations.flatMap((c) => c.participants)
      );
      const formatted = conversations.map((c) => formatSegment(c, names)).join("\n\n");
      const totalMessages = conversations.reduce((sum, c) => sum + c.message_count, 0);

      return {
        success: true,
        summary: `Found ${conversations.length} conversation(s) with ${totalMessages} total messages`,
        data: {
          formatted: formatted || "No conversations found between these users",
          conversations: conversations.map((c) => ({
            conversation_id: c.id,
            channel: c.channel_name,
            start_time: c.start_time,
            end_time: c.end_time,
            message_count: c.message_count,
            topic_label: c.topic_label,
            summary: c.summary,
            status: c.status,
            participants: c.participants.map((id) => names.get(id) ?? id),
          })),
          count: conversations.length,
          totalMessages,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getConversationsBetween:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get conversations",
      };
    }
  },
};

/**
 * Get details and messages for a specific stored conversation
 */
export const getConversationDetailsTool: DatabaseTool = {
  name: "getConversationDetails",
  description:
    "Get a stored conversation by its ID: topic, summary, participants and the actual messages (with author names). Use this when you have a conversation ID and need to see what was said.",
  parameters: {
    type: "object",
    properties: {
      conversationId: {
        type: "string",
        description: "Conversation ID",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to return (default: 50)",
      },
    },
    required: ["conversationId"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { conversationId, limit } = params as { conversationId: string; limit?: number };
    try {
      const segResult = await context.db.query(
        `SELECT cs.id, cs.channel_id, c.name AS channel_name, cs.start_time, cs.end_time,
                cs.message_count, cs.summary, cs.topic_label, cs.status, cs.participants,
                cs.message_ids
         FROM conversation_segments cs
         LEFT JOIN channels c ON c.id = cs.channel_id AND c.guild_id = cs.guild_id
         WHERE cs.guild_id = $1 AND cs.id = $2`,
        [context.guildId, conversationId]
      );
      const seg: (SegmentRow & { message_ids: string[] | null }) | undefined =
        segResult.success && segResult.data ? segResult.data[0] : undefined;
      if (!seg) {
        return { success: false, error: `Conversation ${conversationId} not found` };
      }

      const messageIds = (seg.message_ids ?? []).slice(0, limit || 50);
      const messages: Array<{
        id: string;
        author_id: string;
        content: string | null;
        created_at: Date;
      }> = [];
      if (messageIds.length > 0) {
        const msgResult = await context.db.query(
          `SELECT id, author_id, content, created_at
           FROM messages
           WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true
           ORDER BY created_at ASC`,
          [messageIds, context.guildId]
        );
        if (!msgResult.success || !msgResult.data) {
          return { success: false, error: "Failed to get messages" };
        }
        messages.push(...msgResult.data);
      }

      const names = await loadNames(context, [
        ...seg.participants,
        ...messages.map((m) => m.author_id),
      ]);
      const transcript = messages
        .map((m) => {
          const time = new Date(m.created_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          return `[${time}] ${names.get(m.author_id) ?? m.author_id}: ${m.content || "(no content)"}`;
        })
        .join("\n");
      const formatted = `${formatSegment(seg, names)}\n\nMessages:\n${transcript || "(none)"}`;

      return {
        success: true,
        summary: `Conversation: ${seg.message_count} messages, ${messages.length} returned`,
        data: {
          formatted,
          conversation: {
            conversation_id: seg.id,
            channel: seg.channel_name,
            start_time: seg.start_time,
            end_time: seg.end_time,
            message_count: seg.message_count,
            topic_label: seg.topic_label,
            summary: seg.summary,
            status: seg.status,
            participants: seg.participants.map((id) => names.get(id) ?? id),
          },
          messages: messages.map((m) => ({
            author: names.get(m.author_id) ?? m.author_id,
            content: m.content,
            created_at: m.created_at,
          })),
        },
      };
    } catch (error) {
      console.error("🔸 Error in getConversationDetails:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get conversation details",
      };
    }
  },
};

/**
 * Get user's recent conversations, newest first
 */
export const getRecentConversationsTool: DatabaseTool = {
  name: "getRecentConversations",
  description:
    "Get a user's most recent finalized conversations (newest first) with who took part, channel and summary. Use this to understand who someone has been talking to recently.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID to get recent conversations for",
      },
      limit: {
        type: "number",
        description: "Maximum number of conversations to return (default: 10)",
      },
    },
    required: ["userId"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { userId, limit } = params as { userId: string; limit?: number };
    try {
      const segmentsResult = await context.db.query(
        `SELECT cs.id, cs.start_time, cs.end_time, cs.summary, cs.message_count,
                cs.participants, c.name AS channel_name
         FROM conversation_segments cs
         LEFT JOIN channels c ON c.id = cs.channel_id AND c.guild_id = cs.guild_id
         WHERE cs.guild_id = $1 AND $2 = ANY(cs.participants) AND cs.status = 'finalized'
         ORDER BY cs.end_time DESC
         LIMIT $3`,
        [context.guildId, userId, limit || 10]
      );

      if (!segmentsResult.success || !segmentsResult.data) {
        return {
          success: false,
          error: `Failed to get conversations: ${segmentsResult.error}`,
        };
      }

      const segments: Array<{
        id: string;
        start_time: Date;
        end_time: Date;
        summary: string | null;
        message_count: number;
        participants: string[];
        channel_name: string | null;
      }> = segmentsResult.data;

      const participantIds = [...new Set(segments.flatMap((s) => s.participants))];
      const nameMap = new Map<string, string>();
      if (participantIds.length > 0) {
        const namesResult = await context.db.query(
          `SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
           FROM members
           WHERE user_id = ANY($1::text[]) AND guild_id = $2`,
          [participantIds, context.guildId]
        );
        if (namesResult.success && namesResult.data) {
          for (const member of namesResult.data) {
            nameMap.set(member.user_id, member.name);
          }
        }
      }

      const limited = segments.map((seg) => ({
        conversation_id: seg.id,
        channel: seg.channel_name,
        start_time: seg.start_time,
        end_time: seg.end_time,
        message_count: seg.message_count,
        summary: seg.summary,
        participants: seg.participants
          .filter((id) => id !== userId)
          .map((id) => nameMap.get(id) ?? id),
      }));

      const formatted = limited
        .map((conv, idx) => {
          const others = conv.participants.join(", ") || "no one else";
          const where = conv.channel ? ` in #${conv.channel}` : "";
          return `${idx + 1}. With ${others}${where} (${conv.conversation_id}):\n   ${
            conv.message_count
          } messages, ${new Date(conv.end_time).toLocaleDateString()}${
            conv.summary ? `\n   ${conv.summary}` : ""
          }`;
        })
        .join("\n\n");

      return {
        success: true,
        summary: `Found ${limited.length} recent conversation(s)`,
        data: {
          formatted,
          conversations: limited,
          count: limited.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getRecentConversations:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get recent conversations",
      };
    }
  },
};

/**
 * Analyze conversation patterns between users
 */
export const analyzeConversationPatternsTool: DatabaseTool = {
  name: "analyzeConversationPatterns",
  description:
    "Simple stats over the stored conversations two users took part in together: how many, how long they usually run, per-month counts, busiest hours, channels and recurring topics. Accepts names or IDs.",
  parameters: {
    type: "object",
    properties: {
      user1Id: {
        type: "string",
        description: "First user's name or Discord ID",
      },
      user2Id: {
        type: "string",
        description: "Second user's name or Discord ID",
      },
    },
    required: ["user1Id", "user2Id"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { user1Id, user2Id } = params as { user1Id: string; user2Id: string };
    try {
      const pair = await resolvePair(user1Id, user2Id, context);
      if ("error" in pair) return { success: false, error: pair.error };

      const rows = await queryPairSegments(context, pair.a, pair.b, 2000);
      const names = await loadNames(context, [pair.a, pair.b]);
      const label = `${names.get(pair.a) ?? pair.a} & ${names.get(pair.b) ?? pair.b}`;

      if (rows.length === 0) {
        return {
          success: true,
          summary: `No conversations found between ${label}`,
          data: { formatted: `No conversations found between ${label}`, patterns: {} },
        };
      }

      const median = (values: number[]): number => {
        const sorted = [...values].sort((x, y) => x - y);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      };
      const tally = (keys: string[]): Array<[string, number]> => {
        const counts = new Map<string, number>();
        for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
        return [...counts.entries()].sort((x, y) => y[1] - x[1]);
      };

      const totalMessages = rows.reduce((sum, r) => sum + r.message_count, 0);
      const durations = rows.map(
        (r) => (new Date(r.end_time).getTime() - new Date(r.start_time).getTime()) / 60000
      );
      const typicalMessages = median(rows.map((r) => r.message_count));
      const typicalMinutes = median(durations);

      const perMonth = tally(
        rows.map((r) => {
          const d = new Date(r.start_time);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        })
      ).sort((x, y) => x[0].localeCompare(y[0]));
      const topHours = tally(rows.map((r) => String(new Date(r.start_time).getHours()))).slice(0, 3);
      const topChannels = tally(rows.map((r) => r.channel_name ?? "unknown")).slice(0, 3);
      const topTopics = tally(
        rows.map((r) => r.topic_label?.trim().toLowerCase() ?? "").filter((t) => t.length > 0)
      ).slice(0, 5);

      const first = rows[rows.length - 1]!;
      const last = rows[0]!;
      const dateRange = `${new Date(first.start_time).toLocaleDateString()} to ${new Date(
        last.end_time
      ).toLocaleDateString()}`;

      const parts: string[] = [`Conversation patterns for ${label}:`];
      parts.push(`  - Conversations: ${rows.length} (${dateRange})`);
      parts.push(`  - Total messages: ${totalMessages}`);
      parts.push(
        `  - Typical conversation: ${typicalMessages} messages over ${typicalMinutes.toFixed(0)} minutes`
      );
      parts.push(`  - Per month: ${perMonth.map(([m, n]) => `${m}: ${n}`).join(", ")}`);
      parts.push(`  - Busiest hours: ${topHours.map(([h, n]) => `${h}:00 (${n})`).join(", ")}`);
      parts.push(`  - Channels: ${topChannels.map(([c, n]) => `#${c} (${n})`).join(", ")}`);
      if (topTopics.length > 0) {
        parts.push(`  - Recurring topics: ${topTopics.map(([t, n]) => `${t} (${n})`).join(", ")}`);
      }

      return {
        success: true,
        summary: `${rows.length} conversations, ${totalMessages} messages, typically ${typicalMessages} messages`,
        data: {
          formatted: parts.join("\n"),
          patterns: {
            totalConversations: rows.length,
            totalMessages,
            typicalMessages,
            typicalMinutes,
            perMonth: Object.fromEntries(perMonth),
            hours: Object.fromEntries(topHours),
            dateRange,
          },
        },
      };
    } catch (error) {
      console.error("🔸 Error in analyzeConversationPatterns:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to analyze conversation patterns",
      };
    }
  },
};

/**
 * Search conversations using semantic similarity and programmatic filters
 * Hybrid approach: embeddings for semantic meaning + SQL for identity/structure
 */
export const searchConversationsSemanticTool: DatabaseTool = {
  name: "searchConversationsSemantic",
  description:
    "Search for conversations using semantic similarity (what was discussed) combined with optional filters (who, where, when). Perfect for queries like 'remember when alex converted a server', 'what did people discuss in guy-chat', 'conversations about politics'. Uses AI embeddings to understand meaning, not just keywords.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search for (e.g., 'converting a server', 'politics discussion', 'funny moments'). User names will be automatically extracted as filters.",
      },
      userIds: {
        type: "string",
        description:
          "Optional: Comma-separated user IDs to filter by participants (e.g., '123,456'). Leave empty to search all conversations.",
      },
      channelIds: {
        type: "string",
        description:
          "Optional: Comma-separated channel IDs to filter by channel. Leave empty to search all channels.",
      },
      lookbackDays: {
        type: "number",
        description:
          "Optional: Only search conversations from the last N days (default: 30 days)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5, max: 20)",
      },
    },
    required: ["query"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const query = String(params.query);
      const limit = Math.min(params.limit || 5, 20);
      const lookbackDays = params.lookbackDays || 30;

      // Parse user IDs and channel IDs
      const userIds = params.userIds
        ? String(params.userIds)
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [];
      const channelIds = params.channelIds
        ? String(params.channelIds)
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [];

      // Generate embedding for the query
      let queryEmbedding: number[] | null = null;
      try {
        const embeddingService = EmbeddingService.getInstance();
        queryEmbedding = await embeddingService.generateEmbedding(query);
      } catch (error) {
        console.warn("⚠️  Failed to generate query embedding:", error);
        // Fall back to keyword search if embedding fails
      }

      // Build SQL query with programmatic filters
      let whereConditions = ["cs.guild_id = $1", "cs.status = 'finalized'"];
      const queryParams: any[] = [context.guildId];
      let paramIndex = 2;

      // Add embedding condition if available
      if (queryEmbedding) {
        whereConditions.push("cs.embedding IS NOT NULL");
      }

      // Filter by participants
      if (userIds.length > 0) {
        whereConditions.push(`cs.participants && $${paramIndex}::text[]`);
        queryParams.push(userIds);
        paramIndex++;
      }

      // Filter by channels
      if (channelIds.length > 0) {
        whereConditions.push(`cs.channel_id = ANY($${paramIndex}::text[])`);
        queryParams.push(channelIds);
        paramIndex++;
      }

      // Filter by time
      const lookbackTime = new Date(
        Date.now() - lookbackDays * 24 * 60 * 60 * 1000
      );
      whereConditions.push(`cs.start_time >= $${paramIndex}`);
      queryParams.push(lookbackTime);
      paramIndex++;

      // Build the main query
      let orderByClause: string;
      if (queryEmbedding) {
        // Use vector similarity if embedding is available
        // Convert to pgvector format using toSql()
        queryParams.push(pgvector.toSql(queryEmbedding));
        orderByClause = `(cs.embedding <=> $${paramIndex}::vector) ASC`;
        paramIndex++;
      } else {
        // Fallback to recency if no embedding
        orderByClause = "cs.start_time DESC";
      }

      const result = await context.db.query(
        `
        SELECT
          cs.id,
          cs.channel_id,
          cs.participants,
          cs.start_time,
          cs.end_time,
          cs.message_count,
          cs.summary,
          cs.topic_label,
          c.name as channel_name,
          ${queryEmbedding ? `(cs.embedding <=> $${paramIndex - 1}::vector) as similarity_score` : "0 as similarity_score"}
        FROM conversation_segments cs
        LEFT JOIN channels c ON cs.channel_id = c.id
        WHERE ${whereConditions.join(" AND ")}
        ORDER BY ${orderByClause}
        LIMIT $${paramIndex}
        `,
        [...queryParams, limit]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        return {
          success: true,
          summary: "No conversations found matching your query",
          data: {
            formatted: "No matching conversations found",
            conversations: [],
            count: 0,
          },
        };
      }

      const conversations = result.data;

      // Get participant display names
      const allParticipantIds = [
        ...new Set(conversations.flatMap((c: any) => c.participants || [])),
      ];

      const namesResult = await context.db.query(
        `SELECT user_id, display_name, username
         FROM members
         WHERE user_id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
        [allParticipantIds, context.guildId]
      );

      const nameMap = new Map();
      if (namesResult.success && namesResult.data) {
        for (const member of namesResult.data) {
          nameMap.set(member.user_id, member.display_name || member.username);
        }
      }

      // Format results
      const formatted = conversations
        .map((conv: any, idx: number) => {
          const participantNames = (conv.participants || [])
            .map((id: string) => nameMap.get(id) || id)
            .join(", ");
          const date = new Date(conv.start_time).toLocaleDateString();
          const time = new Date(conv.start_time).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const summary = conv.summary || "(no summary)";
          const simScore = queryEmbedding
            ? `(similarity: ${(1 - conv.similarity_score).toFixed(2)})`
            : "";

          return `${idx + 1}. [#${conv.channel_name || "unknown"}] ${date} ${time} ${simScore}
   Participants: ${participantNames}
   ${conv.topic_label ? `Topic: ${conv.topic_label}\n   ` : ""}Summary: ${summary}
   ${conv.message_count} messages`;
        })
        .join("\n\n");

      return {
        success: true,
        summary: `Found ${conversations.length} conversation(s) matching "${query}"`,
        data: {
          formatted,
          conversations,
          count: conversations.length,
          usedEmbedding: !!queryEmbedding,
        },
      };
    } catch (error) {
      console.error("🔸 Error in searchConversationsSemantic:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to search conversations",
      };
    }
  },
};

/**
 * Get recent conversation messages with full content for top conversations
 * Returns full message content for the most important conversations in a time window
 */
export const getRecentConversationMessagesTool: DatabaseTool = {
  name: "getRecentConversationMessages",
  description:
    "Get FULL MESSAGE CONTENT for recent conversations, ranked by importance. CRITICAL: Use this tool when generating server summaries or when you need to understand what actually happened (e.g., 'what happened today in the server?', 'summarize recent drama'). This tool returns actual message text, not just summaries, so you can capture important details like users leaving, conflicts, or specific events that might be missed in pre-generated summaries. Returns full chronological messages for top conversations and summaries for others. PREFER THIS over getServerActivitySummary or getStorylineAggregation when detailed context is needed.",
  parameters: {
    type: "object",
    properties: {
      lookbackHours: {
        type: "number",
        description:
          "How many hours to look back for conversations (default: 24, max: 168)",
      },
      maxConversations: {
        type: "number",
        description:
          "Maximum number of top conversations to return full messages for (default: 5, max: 10)",
      },
      minMessageCount: {
        type: "number",
        description:
          "Minimum message count to include a conversation (default: 10)",
      },
      rankBy: {
        type: "string",
        description:
          "How to rank conversations: 'message_count' (default) or 'recent'",
        enum: ["message_count", "recent"],
      },
    },
    required: [],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const lookbackHours = Math.min(params.lookbackHours || 24, 168);
      const maxConversations = Math.min(params.maxConversations || 5, 10);
      const minMessageCount = params.minMessageCount || 10;
      const rankBy = params.rankBy || "message_count";

      const lookbackTime = new Date(
        Date.now() - lookbackHours * 60 * 60 * 1000
      );

      // Build ranking ORDER BY clause
      let orderByClause: string;
      switch (rankBy) {
        case "recent":
          orderByClause = "end_time DESC";
          break;
        case "message_count":
        default:
          orderByClause = "message_count DESC, end_time DESC";
          break;
      }

      // Query conversation segments
      const segmentsResult = await context.db.query(
        `SELECT
          id,
          channel_id,
          participants,
          start_time,
          end_time,
          message_count,
          topic_label,
          summary,
          message_ids,
          status
        FROM conversation_segments
        WHERE guild_id = $1
          AND end_time >= $2
          AND message_count >= $3
          AND status = 'finalized'
          AND message_ids IS NOT NULL
          AND array_length(message_ids, 1) > 0
        ORDER BY ${orderByClause}
        LIMIT $4`,
        [context.guildId, lookbackTime, minMessageCount, maxConversations * 2]
      );

      if (
        !segmentsResult.success ||
        !segmentsResult.data ||
        segmentsResult.data.length === 0
      ) {
        return {
          success: true,
          summary: "No recent conversations found",
          data: {
            formatted: `No conversations found in the past ${lookbackHours} hours with at least ${minMessageCount} messages.`,
            conversations: [],
          },
        };
      }

      const allSegments = segmentsResult.data;
      const topSegments = allSegments.slice(0, maxConversations);
      const otherSegments = allSegments.slice(maxConversations);

      // Get channel names
      const channelIds = Array.from(
        new Set(allSegments.map((s: any) => s.channel_id))
      );
      const channelsResult = await context.db.query(
        `SELECT id, name FROM channels WHERE guild_id = $1 AND id = ANY($2::text[])`,
        [context.guildId, channelIds]
      );

      const channelMap = new Map<string, string>();
      if (channelsResult.success && channelsResult.data) {
        for (const ch of channelsResult.data) {
          channelMap.set(ch.id, ch.name);
        }
      }

      // Get all participant IDs
      const allParticipantIds = new Set<string>();
      for (const seg of allSegments) {
        const participantIds = seg.participants || [];
        for (const pid of participantIds) {
          allParticipantIds.add(pid);
        }
      }

      // Get participant display names
      const participantNamesResult = await context.db.query(
        `SELECT user_id, display_name, username, global_name
         FROM members
         WHERE guild_id = $1 AND user_id = ANY($2::text[]) AND active = true`,
        [context.guildId, Array.from(allParticipantIds)]
      );

      const participantNameMap = new Map<string, string>();
      if (participantNamesResult.success && participantNamesResult.data) {
        for (const p of participantNamesResult.data) {
          participantNameMap.set(
            p.user_id,
            p.display_name || p.global_name || p.username || "Unknown"
          );
        }
      }

      // Format output
      let formatted = `Recent Conversations with Full Messages (past ${lookbackHours}h):\n\n`;

      // Process top conversations with full messages
      for (let idx = 0; idx < topSegments.length; idx++) {
        const seg = topSegments[idx];
        const channelName = channelMap.get(seg.channel_id) || "unknown-channel";
        const participantNames = (seg.participants || [])
          .map((pid: string) => participantNameMap.get(pid) || pid)
          .filter((name: string) => name !== "Unknown");

        const startTime = new Date(seg.start_time);
        const endTime = new Date(seg.end_time);
        const timeStr = `${startTime.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })} - ${endTime.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;

        formatted += `[Conversation ${idx + 1}] - #${channelName} (${seg.message_count} messages, ${participantNames.length} participants)\n`;
        formatted += `Time: ${timeStr}\n`;
        formatted += `Participants: ${participantNames.join(", ")}\n\n`;

        // Fetch full messages for this conversation
        const messageIds = Array.isArray(seg.message_ids)
          ? seg.message_ids
          : [];
        if (messageIds.length > 0) {
          const messagesResult = await context.db.query(
            `SELECT id, author_id, content, created_at
             FROM messages
             WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true
             ORDER BY created_at ASC`,
            [messageIds, context.guildId]
          );

          if (messagesResult.success && messagesResult.data) {
            formatted += `Messages:\n`;
            for (const msg of messagesResult.data) {
              const authorName =
                participantNameMap.get(msg.author_id) || msg.author_id;
              const timestamp = new Date(msg.created_at).toLocaleTimeString(
                [],
                {
                  hour: "2-digit",
                  minute: "2-digit",
                }
              );
              const content = msg.content || "(no content)";
              formatted += `${timestamp} @${authorName}: ${content}\n`;
            }
          } else {
            formatted += `(Unable to fetch messages)\n`;
          }
        } else {
          formatted += `(No messages found)\n`;
        }

        formatted += `\n`;
      }

      // Add summaries for other conversations
      if (otherSegments.length > 0) {
        formatted += `Other Conversations (summaries only):\n`;
        for (const seg of otherSegments) {
          const channelName =
            channelMap.get(seg.channel_id) || "unknown-channel";
          const summary = seg.summary || "(no summary)";
          formatted += `- [#${channelName}] ${seg.message_count} messages: ${summary}\n`;
        }
      }

      return {
        success: true,
        summary: `Retrieved ${topSegments.length} conversation(s) with full messages, ${otherSegments.length} with summaries only`,
        data: {
          formatted,
          topConversations: topSegments.length,
          otherConversations: otherSegments.length,
          totalConversations: allSegments.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getRecentConversationMessages:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get recent conversation messages",
      };
    }
  },
};

/**
 * Export all conversation tools for registration
 */
export const conversationTools: DatabaseTool[] = [
  getConversationsBetweenTool,
  getConversationDetailsTool,
  getRecentConversationsTool,
  analyzeConversationPatternsTool,
  searchConversationsSemanticTool,
  getRecentConversationMessagesTool,
];
