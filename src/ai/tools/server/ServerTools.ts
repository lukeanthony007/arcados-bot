import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
} from "../registry/DatabaseTools";
import { summarizeGraph } from "../../../features/social-intelligence/facts/graph";

/**
 * Get server/guild statistics
 */
export const getServerStatsTool: DatabaseTool = {
  name: "getServerStats",
  description:
    "Get server statistics including member count, active users, message counts, and channel information. Use this to understand the server's overall activity.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: async (
    params: {},
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      // Get member count
      const membersResult = await context.db.query(
        `SELECT COUNT(*) as count FROM members 
         WHERE guild_id = $1 AND active = true`,
        [context.guildId]
      );

      // Get message count
      const messagesResult = await context.db.query(
        `SELECT COUNT(*) as count FROM messages 
         WHERE guild_id = $1 AND active = true`,
        [context.guildId]
      );

      // Get channel count
      const channelsResult = await context.db.query(
        `SELECT COUNT(*) as count FROM channels 
         WHERE guild_id = $1 AND active = true`,
        [context.guildId]
      );

      // Get recent activity (last 24 hours)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const recentMessagesResult = await context.db.query(
        `SELECT COUNT(*) as count FROM messages 
         WHERE guild_id = $1 AND active = true AND created_at >= $2`,
        [context.guildId, yesterday]
      );

      const memberCount =
        membersResult.success && membersResult.data?.[0]
          ? parseInt(membersResult.data[0].count, 10)
          : 0;
      const messageCount =
        messagesResult.success && messagesResult.data?.[0]
          ? parseInt(messagesResult.data[0].count, 10)
          : 0;
      const channelCount =
        channelsResult.success && channelsResult.data?.[0]
          ? parseInt(channelsResult.data[0].count, 10)
          : 0;
      const recentMessages =
        recentMessagesResult.success && recentMessagesResult.data?.[0]
          ? parseInt(recentMessagesResult.data[0].count, 10)
          : 0;

      const parts: string[] = [];
      parts.push(`Server Statistics:`);
      parts.push(`  - Total Members: ${memberCount}`);
      parts.push(`  - Total Messages: ${messageCount}`);
      parts.push(`  - Channels: ${channelCount}`);
      parts.push(`  - Messages (last 24h): ${recentMessages}`);

      return {
        success: true,
        summary: `${memberCount} members, ${messageCount} messages, ${recentMessages} recent`,
        data: {
          formatted: parts.join("\n"),
          stats: {
            memberCount,
            messageCount,
            channelCount,
            recentMessages,
          },
        },
      };
    } catch (error) {
      console.error("🔸 Error in getServerStats:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get server stats",
      };
    }
  },
};

/**
 * Get most active members
 */
export const getActiveMembersTool: DatabaseTool = {
  name: "getActiveMembers",
  description:
    "Get the most active members in the server based on message count. Use this to see who is most engaged.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Number of members to return (default: 10)",
      },
      timeWindow: {
        type: "number",
        description: "Time window in days to analyze (default: 7)",
      },
    },
    required: [],
  },
  execute: async (
    params: { limit?: number; timeWindow?: number },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const limit = params.limit || 10;
      const timeWindowDays = params.timeWindow || 7;
      const since = new Date();
      since.setDate(since.getDate() - timeWindowDays);

      const result = await context.db.query(
        `SELECT m.author_id, mem.display_name, mem.username, COUNT(*) as message_count
         FROM messages m
         JOIN members mem ON m.author_id = mem.user_id AND m.guild_id = mem.guild_id
         WHERE m.guild_id = $1 
           AND m.active = true
           AND m.created_at >= $2
           AND mem.bot = false
         GROUP BY m.author_id, mem.display_name, mem.username
         ORDER BY message_count DESC
         LIMIT $3`,
        [context.guildId, since, limit]
      );

      if (!result.success || !result.data) {
        return {
          success: false,
          error: "Failed to get active members",
        };
      }

      const activeMembers = result.data;

      if (activeMembers.length === 0) {
        return {
          success: true,
          summary: `No active members found in the last ${timeWindowDays} days`,
          data: {
            formatted: "No active members",
            members: [],
            count: 0,
          },
        };
      }

      const formatted = activeMembers
        .map(
          (member: any, idx: number) =>
            `${idx + 1}. ${member.display_name || member.username}: ${
              member.message_count
            } messages`
        )
        .join("\n");

      return {
        success: true,
        summary: `Top ${activeMembers.length} active member(s) in the last ${timeWindowDays} days`,
        data: {
          formatted,
          members: activeMembers,
          count: activeMembers.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getActiveMembers:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get active members",
      };
    }
  },
};

/**
 * Get trending topics/keywords
 */
export const getTrendingTopicsTool: DatabaseTool = {
  name: "getTrendingTopics",
  description:
    "Analyze trending keywords and topics from recent conversations. Returns conversation summaries and top keywords aggregated from the specified time window. Use this when users ask 'what have people been talking about', 'what's trending', 'recent topics', or similar broad questions about server activity.",
  parameters: {
    type: "object",
    properties: {
      timeWindow: {
        type: "number",
        description: "Time window in days to analyze (default: 7)",
      },
      limit: {
        type: "number",
        description: "Number of topics to return (default: 10)",
      },
    },
    required: [],
  },
  execute: async (
    params: { timeWindow?: number; limit?: number },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const timeWindowDays = params.timeWindow || 7;
      const limit = params.limit || 10;
      const since = new Date();
      since.setDate(since.getDate() - timeWindowDays);

      // Get recent conversations with summaries and keywords
      const conversationsResult = await context.db.query(
        `SELECT
          id,
          channel_id,
          start_time,
          end_time,
          message_count,
          summary,
          features,
          participants
        FROM conversation_segments
        WHERE guild_id = $1
          AND status = 'finalized'
          AND start_time >= $2
        ORDER BY start_time DESC`,
        [context.guildId, since]
      );

      if (!conversationsResult.success || !conversationsResult.data) {
        return {
          success: false,
          error: "Failed to retrieve conversations",
        };
      }

      const conversations = conversationsResult.data;

      if (conversations.length === 0) {
        return {
          success: true,
          summary: `No conversations found in the last ${timeWindowDays} days`,
          data: {
            formatted: `No recent conversations to analyze from the past ${timeWindowDays} days`,
            topics: [],
            conversations: [],
          },
        };
      }

      // Extract and aggregate keywords from conversations
      interface KeywordScore {
        word: string;
        totalScore: number;
        frequency: number;
        conversationCount: number;
      }

      const keywordMap = new Map<string, KeywordScore>();

      for (const conv of conversations) {
        if (conv.features?.keywords) {
          let keywords: any[] = [];

          // Handle both array and object formats for keywords
          if (Array.isArray(conv.features.keywords)) {
            keywords = conv.features.keywords;
          } else if (conv.features.keywords.terms) {
            keywords = conv.features.keywords.terms;
          }

          for (const kw of keywords) {
            const word = kw.word;
            const existing = keywordMap.get(word);

            if (existing) {
              existing.totalScore += kw.score || 1;
              existing.frequency += kw.frequency || 1;
              existing.conversationCount += 1;
            } else {
              keywordMap.set(word, {
                word,
                totalScore: kw.score || 1,
                frequency: kw.frequency || 1,
                conversationCount: 1,
              });
            }
          }
        }
      }

      // Sort keywords by total score and conversation count
      const topKeywords = Array.from(keywordMap.values())
        .sort((a, b) => {
          // Prioritize keywords appearing in multiple conversations
          const scoreDiff = (b.totalScore * b.conversationCount) - (a.totalScore * a.conversationCount);
          return scoreDiff;
        })
        .slice(0, limit);

      // Get channel names
      const channelIds = [...new Set(conversations.map((c: any) => c.channel_id))];
      const channelsResult = await context.db.query(
        `SELECT id, name FROM channels WHERE id = ANY($1::text[])`,
        [channelIds]
      );

      const channelMap = new Map();
      if (channelsResult.success && channelsResult.data) {
        for (const channel of channelsResult.data) {
          channelMap.set(channel.id, channel.name);
        }
      }

      // Format summary of recent topics
      const parts: string[] = [];
      parts.push(`**Recent Topics (last ${timeWindowDays} days)**\n`);

      if (topKeywords.length > 0) {
        parts.push(`**Top Keywords:**`);
        topKeywords.slice(0, Math.min(8, limit)).forEach((kw, idx) => {
          parts.push(`${idx + 1}. *${kw.word}* - appeared in ${kw.conversationCount} conversation(s)`);
        });
        parts.push("");
      }

      // Include recent conversation summaries
      parts.push(`**Recent Conversations (${conversations.length} total):**`);
      conversations.slice(0, 5).forEach((conv: any, idx: number) => {
        const channelName = channelMap.get(conv.channel_id) || "unknown";
        const date = new Date(conv.start_time).toLocaleDateString();
        const summary = conv.summary || "(no summary)";
        parts.push(`${idx + 1}. [#${channelName}] ${date}: ${summary}`);
      });

      return {
        success: true,
        summary: `Found ${topKeywords.length} trending topics from ${conversations.length} conversations`,
        data: {
          formatted: parts.join("\n"),
          keywords: topKeywords,
          conversations: conversations.slice(0, 5),
          totalConversations: conversations.length,
          timeWindow: timeWindowDays,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getTrendingTopics:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get trending topics",
      };
    }
  },
};

/**
 * Get overall relationship network insights
 */
export const getServerNetworkTool: DatabaseTool = {
  name: "getServerNetwork",
  description:
    "Get the shape of the server's social network from real interactions (replies, mentions, shared conversations): the biggest hubs (members with the most total interaction strength), the strongest pairs, friend-group communities, and how many members have no interactions. Strength is a recency-weighted interaction score; reciprocity is 1 for balanced pairs and 0 for one-sided.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: async (
    params: {},
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const graph = await summarizeGraph(context.db, context.guildId);
      const { hubs, communities } = graph;
      const pairs = graph.strongestPairs.map((p) => ({
        a: p.a.name,
        b: p.b.name,
        strength: p.strength,
        reciprocity: p.reciprocity,
      }));

      const parts = [
        `Server network: ${graph.members} members, ${graph.connectedPairs} connected pairs, ${graph.isolated} members with no interactions.`,
        `Top hubs (total interaction strength): ${hubs.map((h) => `${h.name} (${h.strength})`).join(", ") || "none"}`,
        `Strongest pairs:`,
        ...pairs.map(
          (p) =>
            `  - ${p.a} ↔ ${p.b}: strength ${p.strength}, ${(p.reciprocity * 100).toFixed(0)}% reciprocal`
        ),
        `Communities (clusters of strongly connected members):`,
        ...communities.map((c, i) => `  ${i + 1}. ${c.map((m) => m.name).join(", ")}`),
      ];

      return {
        success: true,
        summary: `${graph.connectedPairs} connected pairs among ${graph.members} members`,
        data: {
          formatted: parts.join("\n"),
          network: {
            totalMembers: graph.members,
            connectedPairs: graph.connectedPairs,
            isolatedMembers: graph.isolated,
            hubs: hubs.map((h) => ({ name: h.name, strength: h.strength })),
            strongestPairs: pairs,
            communities: communities.map((c) => c.map((m) => m.name)),
          },
        },
      };
    } catch (error) {
      console.error("🔸 Error in getServerNetwork:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get server network",
      };
    }
  },
};

/**
 * Export all server tools for registration
 */
export const serverTools: DatabaseTool[] = [
  getServerStatsTool,
  getActiveMembersTool,
  getTrendingTopicsTool,
  getServerNetworkTool,
];
