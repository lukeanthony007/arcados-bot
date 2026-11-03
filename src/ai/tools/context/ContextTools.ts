import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
} from "../registry/DatabaseTools";
import { getConnections } from "../../../features/social-intelligence/facts/closeness";

/**
 * Fetch recent guild messages for context-rich AI responses
 */
export const getRecentGuildMessagesTool: DatabaseTool = {
  name: "getRecentGuildMessages",
  description:
    "Get recent messages across the guild (optionally a single channel) within a lookback window. Useful for summarising recent storylines and activity.",
  parameters: {
    type: "object",
    properties: {
      lookbackHours: {
        type: "number",
        description: "Hours to look back from now (default: 24)",
      },
      lookbackDays: {
        type: "number",
        description: "Days to look back from now (alternative to hours)",
      },
      channelId: {
        type: "string",
        description: "Optional channel to scope results",
      },
      limit: {
        type: "number",
        description: "Maximum messages to return (default: 200)",
      },
    },
    required: [],
  },
  execute: async (
    params: {
      lookbackHours?: number;
      lookbackDays?: number;
      channelId?: string;
      limit?: number;
    },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const hours = params.lookbackDays
        ? params.lookbackDays * 24
        : params.lookbackHours || 24;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const limit = Math.max(1, Math.min(params.limit || 200, 1000));

      let query = `SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at,
                           c.name AS channel_name,
                           mem.display_name, mem.username
                    FROM messages m
                    LEFT JOIN channels c ON c.id = m.channel_id AND c.guild_id = m.guild_id
                    LEFT JOIN members mem ON mem.user_id = m.author_id AND mem.guild_id = m.guild_id
                    WHERE m.guild_id = $1 AND m.active = true AND m.created_at >= $2`;

      const queryParams: any[] = [context.guildId, since];

      if (params.channelId) {
        query += ` AND m.channel_id = $3`;
        queryParams.push(params.channelId);
      }

      query += ` ORDER BY m.created_at ASC LIMIT $${queryParams.length + 1}`;
      queryParams.push(limit);

      const result = await context.db.query(query, queryParams);
      if (!result.success || !result.data) {
        return { success: false, error: "Failed to fetch recent messages" };
      }

      const messages = result.data as Array<{
        id: string;
        channel_id: string;
        author_id: string;
        content: string;
        created_at: string | Date;
        channel_name?: string;
        display_name?: string;
        username?: string;
      }>;

      if (messages.length === 0) {
        return {
          success: true,
          summary: `No recent messages in the last ${hours}h`,
          data: { formatted: "No recent messages", messages: [], count: 0 },
        };
      }

      const formatted = messages
        .map((m) => {
          const when = new Date(m.created_at).toLocaleString();
          const channel = m.channel_name || m.channel_id;
          const author = m.display_name || m.username || m.author_id;
          const content = (m.content || "(no content)").replace(/\s+/g, " ").trim();
          const snippet = content.length > 180 ? `${content.substring(0, 180)}...` : content;
          return `[${when}] #${channel} — ${author}: ${snippet}`;
        })
        .join("\n");

      return {
        success: true,
        summary: `Fetched ${messages.length} recent message(s) over ~${hours}h`,
        data: { formatted, messages, count: messages.length },
      };
    } catch (error) {
      console.error("🔸 Error in getRecentGuildMessages:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch recent messages",
      };
    }
  },
};

/**
 * What is going on right now: active conversations across the guild
 */
export const getActiveConversationsTool: DatabaseTool = {
  name: "getActiveConversations",
  description:
    "Get what is going on in the server right now: conversations still in progress (channel, who is talking, last message time, opening lines). If nothing is active, returns the most recent conversations from the last 2 hours. Optionally scoped to a channel.",
  parameters: {
    type: "object",
    properties: {
      channelId: {
        type: "string",
        description: "Optional channel to scope conversations",
      },
      limit: {
        type: "number",
        description: "Maximum conversations to return (default: 10)",
      },
      sampleMessages: {
        type: "number",
        description: "Number of opening messages to show per conversation (default: 5)",
      },
    },
    required: [],
  },
  execute: async (
    params: {
      channelId?: string;
      limit?: number;
      sampleMessages?: number;
    },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const limit = Math.max(1, Math.min(params.limit || 10, 25));
      const samples = Math.max(1, Math.min(params.sampleMessages || 5, 10));
      const channelFilter = params.channelId ? "AND cs.channel_id = $3" : "";
      const baseParams: unknown[] = [context.guildId, limit];
      if (params.channelId) baseParams.push(params.channelId);

      interface Row {
        id: string;
        channel_id: string;
        channel_name: string | null;
        participants: string[];
        message_ids: string[] | null;
        message_count: number;
        start_time: Date;
        end_time: Date;
        topic_label: string | null;
        summary: string | null;
        status: string;
      }
      const select = `SELECT cs.id, cs.channel_id, c.name AS channel_name, cs.participants,
                cs.message_ids, cs.message_count, cs.start_time, cs.end_time,
                cs.topic_label, cs.summary, cs.status
         FROM conversation_segments cs
         LEFT JOIN channels c ON c.id = cs.channel_id AND c.guild_id = cs.guild_id`;

      let rows: Row[] = [];
      let mode: "active" | "recent" = "active";
      const activeResult = await context.db.query(
        `${select}
         WHERE cs.guild_id = $1 AND cs.status = 'active' ${channelFilter}
         ORDER BY cs.end_time DESC
         LIMIT $2`,
        baseParams
      );
      if (activeResult.success && activeResult.data) rows = activeResult.data;

      if (rows.length === 0) {
        mode = "recent";
        const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const recentParams = [...baseParams, since];
        const sinceIdx = recentParams.length;
        const recentResult = await context.db.query(
          `${select}
           WHERE cs.guild_id = $1 AND cs.status = 'finalized' AND cs.end_time >= $${sinceIdx} ${channelFilter}
           ORDER BY cs.end_time DESC
           LIMIT $2`,
          recentParams
        );
        if (recentResult.success && recentResult.data) rows = recentResult.data;
      }

      if (rows.length === 0) {
        return {
          success: true,
          summary: "Nothing is going on right now",
          data: {
            formatted: "No active conversations, and none in the last 2 hours.",
            conversations: [],
            count: 0,
          },
        };
      }

      const firstIds = rows.flatMap((r) => (r.message_ids ?? []).slice(0, samples));
      const messagesResult =
        firstIds.length > 0
          ? await context.db.query(
              `SELECT id, author_id, content, created_at
               FROM messages
               WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true
               ORDER BY created_at ASC`,
              [firstIds, context.guildId]
            )
          : null;
      const messageById = new Map<
        string,
        { id: string; author_id: string; content: string | null; created_at: Date }
      >();
      if (messagesResult?.success && messagesResult.data) {
        for (const m of messagesResult.data) messageById.set(m.id, m);
      }

      const userIds = [
        ...new Set([
          ...rows.flatMap((r) => r.participants),
          ...[...messageById.values()].map((m) => m.author_id),
        ]),
      ];
      const namesResult = await context.db.query(
        `SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
         FROM members
         WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
        [context.guildId, userIds]
      );
      const nameMap = new Map<string, string>();
      if (namesResult.success && namesResult.data) {
        for (const r of namesResult.data) nameMap.set(r.user_id, r.name);
      }

      const conversations = rows.map((r) => ({
        id: r.id,
        channel: r.channel_name || r.channel_id,
        participants: r.participants.map((id) => nameMap.get(id) ?? id),
        messageCount: r.message_count,
        startedAt: r.start_time,
        lastMessageAt: r.end_time,
        ongoing: r.status === "active",
        topic: r.topic_label,
        summary: r.summary,
        openingLines: (r.message_ids ?? [])
          .slice(0, samples)
          .map((id) => messageById.get(id))
          .filter((m): m is NonNullable<typeof m> => m !== undefined)
          .map((m) => {
            const content = (m.content || "(no content)").replace(/\s+/g, " ").trim();
            const snippet = content.length > 160 ? `${content.substring(0, 160)}...` : content;
            return `[${new Date(m.created_at).toLocaleTimeString()}] ${
              nameMap.get(m.author_id) ?? m.author_id
            }: ${snippet}`;
          }),
      }));

      const header =
        mode === "active"
          ? "Conversations happening right now:"
          : "Nothing active right now. Most recent conversations (last 2 hours):";
      const formatted = [
        header,
        ...conversations.map((c) => {
          const lines = [
            `#${c.channel}: ${c.participants.join(", ")} (${c.messageCount} messages, last message ${new Date(
              c.lastMessageAt
            ).toLocaleTimeString()})${c.topic ? ` — ${c.topic}` : ""}`,
          ];
          if (c.summary) lines.push(`  Summary: ${c.summary}`);
          lines.push(...c.openingLines.map((l) => `  ${l}`));
          return lines.join("\n");
        }),
      ].join("\n\n");

      return {
        success: true,
        summary: `${conversations.length} ${mode === "active" ? "active" : "recent"} conversation(s)`,
        data: { formatted, conversations, count: conversations.length, mode },
      };
    } catch (error) {
      console.error("🔸 Error in getActiveConversations:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch recent conversations",
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Holistic user context aggregator
// ---------------------------------------------------------------------------
export const getHolisticUserContextTool: DatabaseTool = {
  name: "getHolisticUserContext",
  description:
    "Get detailed message-level context for analyzing a user's recent activity and communication patterns. Includes actual message content from the past 2 weeks. NOTE: For general user information (who they are, roles, relationships), use getUserInfo instead - it provides better narrative context without overwhelming detail.",
  parameters: {
    type: "object",
    properties: {
      userId: { type: "string", description: "Target Discord user ID" },
      lookbackDays: {
        type: "number",
        description: "Days of message history to include (default: 14)",
      },
      messageLimit: {
        type: "number",
        description: "Max recent messages to include (default: 25)",
      },
      relationshipsLimit: {
        type: "number",
        description: "Max relationships to include (default: 5)",
      },
    },
    required: ["userId"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { userId, lookbackDays: lookbackDaysParam, messageLimit: messageLimitParam, relationshipsLimit: relationshipsLimitParam } = params as { userId: string; lookbackDays?: number; messageLimit?: number; relationshipsLimit?: number };
    try {
      const lookbackDays = Math.max(1, Math.min(lookbackDaysParam || 14, 90));
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const messageLimit = Math.max(5, Math.min(messageLimitParam || 25, 100));
      const relationshipsLimit = Math.max(1, Math.min(relationshipsLimitParam || 5, 15));

      // Member profile (Discord data)
      const memberResult = await context.db.query(
        `SELECT user_id, display_name, username, global_name, nick, roles, joined_at, active
         FROM members
         WHERE user_id = $1 AND guild_id = $2
         ORDER BY active DESC
         LIMIT 1`,
        [userId, context.guildId]
      );

      if (!memberResult.success || !memberResult.data || memberResult.data.length === 0) {
        return { success: false, error: `User ${userId} not found in this server` };
      }

      const member = memberResult.data[0];

      // Get user profile data (AI-focused data from user_profiles)
      const profileResult = await context.db.getUserProfile(userId, context.guildId);
      const profile = profileResult.success && profileResult.data ? profileResult.data : null;

      // Role names
      let roleNames: string[] = [];
      if (member.roles && member.roles.length > 0) {
        const rolesResult = await context.db.query(
          `SELECT name FROM roles WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true ORDER BY name`,
          [member.roles, context.guildId]
        );
        if (rolesResult.success && rolesResult.data) {
          roleNames = rolesResult.data.map((r: any) => r.name);
        }
      }

      // Closest people, computed on demand from replies, mentions and shared conversations
      const connections = await getConnections(context.db, context.guildId, userId, relationshipsLimit);

      // Recent messages by the user
      const messagesResult = await context.db.query(
        `SELECT m.id, m.content, m.created_at, m.channel_id, c.name AS channel_name
         FROM messages m
         LEFT JOIN channels c ON c.id = m.channel_id AND c.guild_id = m.guild_id
         WHERE m.guild_id = $1 AND m.author_id = $2 AND m.active = true AND m.created_at >= $3
         ORDER BY m.created_at DESC
         LIMIT $4`,
        [context.guildId, userId, since, messageLimit]
      );

      let recentMessagesFormatted = "No recent messages";
      let recentMessages: any[] = [];
      if (messagesResult.success && messagesResult.data) {
        recentMessages = messagesResult.data;
        if (recentMessages.length > 0) {
          recentMessagesFormatted = recentMessages
            .slice()
            .reverse() // chronological
            .map((m: any) => {
              const when = new Date(m.created_at).toLocaleString();
              const channel = m.channel_name || m.channel_id;
              const content = (m.content || "(no content)").replace(/\s+/g, " ").trim();
              const snippet = content.length > 180 ? `${content.substring(0, 180)}...` : content;
              return `[${when}] #${channel}: ${snippet}`;
            })
            .join("\n");
        }
      }

      const identity = `${member.display_name || member.global_name || member.nick || member.username || userId} (@${member.username || userId})`;
      const joinedAt = member.joined_at ? new Date(member.joined_at) : null;
      const header: string[] = [];
      header.push(identity);
      if (profile?.summary) header.push(`Summary: ${profile.summary}`);
      if (roleNames.length > 0) header.push(`Roles: ${roleNames.join(", ")}`);
      if (joinedAt) header.push(`Joined: ${joinedAt.toLocaleDateString()}`);

      // Get recent conversation topics/keywords from conversation_segments
      const conversationSegmentsResult = await context.db.query(
        `SELECT cs.id, cs.channel_id, cs.start_time, cs.end_time, cs.summary, cs.topic_label, c.name as channel_name
         FROM conversation_segments cs
         LEFT JOIN channels c ON cs.channel_id = c.id AND cs.guild_id = c.guild_id
         WHERE cs.guild_id = $1
           AND $2 = ANY(cs.participants)
           AND cs.start_time >= $3
           AND cs.status = 'finalized'
           AND cs.message_count >= 3
         ORDER BY cs.start_time DESC
         LIMIT 10`,
        [context.guildId, userId, since]
      );

      let conversationTopicsFormatted = "";
      if (conversationSegmentsResult.success && conversationSegmentsResult.data && conversationSegmentsResult.data.length > 0) {
        const convSegments = conversationSegmentsResult.data;
        const topicsLines: string[] = [];

        for (const seg of convSegments.slice(0, 5)) {
          const channel = seg.channel_name || seg.channel_id;
          const date = new Date(seg.start_time).toLocaleDateString();

          const summary = seg.summary || "discussion";
          topicsLines.push(
            `  • #${channel} (${date})${seg.topic_label ? ` [${seg.topic_label}]` : ""}: ${summary}`
          );
        }

        if (topicsLines.length > 0) {
          conversationTopicsFormatted = `Recent discussion topics:\n${topicsLines.join("\n")}`;
        }
      }

      // Build conversational context (minimal stats, focus on content and relationships)
      const parts: string[] = [];
      parts.push(header.join(" \u2014 "));

      // Closest people by interaction (computed from replies, mentions, shared conversations)
      if (connections.length > 0) {
        parts.push(`Close connections: ${connections.slice(0, 3).map((c) => c.name).join(", ")}`);
      }

      // Add conversation topics if available (prioritize over raw messages)
      if (conversationTopicsFormatted) {
        parts.push(conversationTopicsFormatted);
      }

      // Lead with recent message content (the most important context)
      if (recentMessagesFormatted !== "No recent messages") {
        parts.push(`Recent activity:\n${recentMessagesFormatted}`);
      }

      const formatted = parts.join("\n\n");

      return {
        success: true,
        summary: `${member.display_name || member.username} — holistic context ready`,
        data: {
          formatted,
          member,
          roleNames,
          connections,
          recentMessages,
          lookbackDays,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getHolisticUserContext:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get holistic user context",
      };
    }
  },
};

export const contextTools: DatabaseTool[] = [
  getRecentGuildMessagesTool,
  getActiveConversationsTool,
  getHolisticUserContextTool,
];
