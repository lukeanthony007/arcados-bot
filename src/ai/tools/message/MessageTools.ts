import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
} from "../registry/DatabaseTools";

/**
 * Get messages by a user
 */
export const getUserMessagesTool: DatabaseTool = {
  name: "getUserMessages",
  description:
    "Get messages sent by a user. Use this to see what someone has posted or understand their communication style.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID to get messages for",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages to return (default: 50)",
      },
      channelId: {
        type: "string",
        description: "Optional channel ID to filter messages",
      },
    },
    required: ["userId"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { userId, limit, channelId } = params as { userId: string; limit?: number; channelId?: string };
    try {
      let query = `SELECT id, channel_id, content, created_at, edited_at
                   FROM messages
                   WHERE author_id = $1 AND guild_id = $2 AND active = true`;
      const queryParams: any[] = [userId, context.guildId];

      if (channelId) {
        query += ` AND channel_id = $3`;
        queryParams.push(channelId);
      }

      query += ` ORDER BY created_at DESC LIMIT $${queryParams.length + 1}`;
      queryParams.push(limit || 50);

      const result = await context.db.query(query, queryParams);

      if (!result.success || !result.data) {
        return {
          success: false,
          error: "Failed to get messages",
        };
      }

      const messages = result.data;

      // Get channel names if available
      const channelIds = [...new Set(messages.map((m: any) => m.channel_id))];
      const channelsResult = await context.db.query(
        `SELECT id, name FROM channels 
         WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
        [channelIds, context.guildId]
      );

      const channelMap = new Map();
      if (channelsResult.success && channelsResult.data) {
        for (const channel of channelsResult.data) {
          channelMap.set(channel.id, channel.name);
        }
      }

      const formatted = messages
        .map((msg: any) => {
          const channelName = channelMap.get(msg.channel_id) || msg.channel_id;
          const date = new Date(msg.created_at).toLocaleString();
          const content = msg.content || "(no content)";
          return `[${date}] #${channelName}: ${content.substring(0, 100)}${
            content.length > 100 ? "..." : ""
          }`;
        })
        .join("\n");

      return {
        success: true,
        summary: `Found ${messages.length} message(s)`,
        data: {
          formatted,
          messages,
          count: messages.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getUserMessages:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get user messages",
      };
    }
  },
};

/**
 * Search messages by content or user
 */
export const searchMessagesTool: DatabaseTool = {
  name: "searchMessages",
  description:
    "Search messages by content text or author. Use this to find specific messages or topics discussed.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to match against message content",
      },
      authorId: {
        type: "string",
        description: "Optional author ID to filter messages",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 20)",
      },
    },
    required: ["query"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { query, authorId, limit } = params as { query: string; authorId?: string; limit?: number };
    try {
      let searchQuery = `SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at,
                                mem.display_name, mem.username
                         FROM messages m
                         JOIN members mem ON m.author_id = mem.user_id AND m.guild_id = mem.guild_id
                         WHERE m.guild_id = $1
                           AND m.active = true
                           AND LOWER(m.content) LIKE $2`;

      const queryParams: any[] = [
        context.guildId,
        `%${query.toLowerCase()}%`,
      ];

      if (authorId) {
        searchQuery += ` AND m.author_id = $3`;
        queryParams.push(authorId);
      }

      searchQuery += ` ORDER BY m.created_at DESC LIMIT $${
        queryParams.length + 1
      }`;
      queryParams.push(limit || 20);

      const result = await context.db.query(searchQuery, queryParams);

      if (!result.success || !result.data) {
        return {
          success: false,
          error: "Failed to search messages",
        };
      }

      const messages = result.data;

      if (messages.length === 0) {
        return {
          success: true,
          summary: `No messages found matching "${query}"`,
          data: {
            formatted: "No matching messages found",
            messages: [],
            count: 0,
          },
        };
      }

      const formatted = messages
        .map((msg: any) => {
          const author = msg.display_name || msg.username || msg.author_id;
          const date = new Date(msg.created_at).toLocaleString();
          const content = msg.content || "(no content)";
          return `[${date}] ${author}: ${content.substring(0, 150)}${
            content.length > 150 ? "..." : ""
          }`;
        })
        .join("\n");

      return {
        success: true,
        summary: `Found ${messages.length} message(s) matching "${query}"`,
        data: {
          formatted,
          messages,
          count: messages.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in searchMessages:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to search messages",
      };
    }
  },
};

/**
 * Get message interactions involving a user
 */
export const getMessageInteractionsTool: DatabaseTool = {
  name: "getMessageInteractions",
  description:
    "Get recent mentions of and replies to a user within a time window (newest first). Use this to see who has just been talking to someone; for long-term closeness use getUserConnections.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID to get interactions for",
      },
      timeWindow: {
        type: "number",
        description: "Time window in minutes (default: 60)",
      },
    },
    required: ["userId"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { userId, timeWindow } = params as { userId: string; timeWindow?: number };
    try {
      const timeWindowMinutes = timeWindow || 60;
      const since = new Date();
      since.setMinutes(since.getMinutes() - timeWindowMinutes);

      // Get messages that mention the user
      const mentionsResult = await context.db.query(
        `SELECT DISTINCT m.author_id, m.channel_id, m.created_at,
                mem.display_name, mem.username
         FROM messages m
         JOIN members mem ON m.author_id = mem.user_id AND m.guild_id = mem.guild_id
         WHERE m.guild_id = $1
           AND m.active = true
           AND m.created_at >= $2
           AND m.content LIKE $3`,
        [context.guildId, since, `%<@${userId}>%`]
      );

      // Get replies to the user's messages in the window
      const repliesResult = await context.db.query(
        `SELECT DISTINCT m.author_id, m.created_at, mem.display_name, mem.username
         FROM messages m
         JOIN messages p ON p.id = m.referenced_message_id
         JOIN members mem ON m.author_id = mem.user_id AND m.guild_id = mem.guild_id
         WHERE m.guild_id = $1
           AND m.active = true
           AND m.created_at >= $2
           AND p.author_id = $3
           AND m.author_id <> $3`,
        [context.guildId, since, userId]
      );

      const interactions: any[] = [];

      if (mentionsResult.success && mentionsResult.data) {
        for (const msg of mentionsResult.data) {
          interactions.push({
            type: "mention",
            authorId: msg.author_id,
            authorName: msg.display_name || msg.username,
            timestamp: msg.created_at,
          });
        }
      }

      if (repliesResult.success && repliesResult.data) {
        for (const msg of repliesResult.data) {
          interactions.push({
            type: "reply",
            authorId: msg.author_id,
            authorName: msg.display_name || msg.username,
            timestamp: msg.created_at,
          });
        }
      }

      interactions.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      // Get author names for interactions
      const authorIds = [...new Set(interactions.map((i) => i.authorId))];
      if (authorIds.length > 0) {
        const namesResult = await context.db.query(
          `SELECT user_id, display_name, username 
           FROM members 
           WHERE user_id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
          [authorIds, context.guildId]
        );

        if (namesResult.success && namesResult.data) {
          const nameMap = new Map(
            namesResult.data.map((m: any) => [
              m.user_id,
              m.display_name || m.username,
            ])
          );
          interactions.forEach((i) => {
            i.authorName = nameMap.get(i.authorId) || i.authorId;
          });
        }
      }

      const formatted = interactions
        .slice(0, 20)
        .map((i) => {
          const date = new Date(i.timestamp).toLocaleString();
          return `[${date}] ${i.type}: ${i.authorName}`;
        })
        .join("\n");

      return {
        success: true,
        summary: `Found ${interactions.length} interaction(s) in the last ${timeWindowMinutes} minutes`,
        data: {
          formatted,
          interactions,
          count: interactions.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getMessageInteractions:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get message interactions",
      };
    }
  },
};

/**
 * Export all message tools for registration
 */
export const messageTools: DatabaseTool[] = [
  getUserMessagesTool,
  searchMessagesTool,
  getMessageInteractionsTool,
];
