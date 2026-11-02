import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
} from "../registry/DatabaseTools";

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
 * Fetch recent active user-to-user conversations within a window
 */
export const getActiveConversationsTool: DatabaseTool = {
  name: "getActiveConversations",
  description:
    "Get recent active user-to-user conversations based on relationship edges and recent messages, optionally scoped to a channel.",
  parameters: {
    type: "object",
    properties: {
      lookbackHours: {
        type: "number",
        description: "Hours to look back from now (default: 72)",
      },
      lookbackDays: {
        type: "number",
        description: "Days to look back from now (alternative to hours)",
      },
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
        description: "Number of sample messages per conversation (default: 5)",
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
      sampleMessages?: number;
    },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const hours = params.lookbackDays
        ? params.lookbackDays * 24
        : params.lookbackHours || 72;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const limit = Math.max(1, Math.min(params.limit || 10, 25));
      const samples = Math.max(1, Math.min(params.sampleMessages || 5, 10));

      // Find recent edges (active pairs) in the window
      const edgesResult = await context.db.query(
        `SELECT user_a, user_b, last_interaction, rolling_7d, total
         FROM relationship_edges
         WHERE guild_id = $1 AND last_interaction >= $2
         ORDER BY rolling_7d DESC, total DESC
         LIMIT $3`,
        [context.guildId, since, limit * 3]
      );

      if (!edgesResult.success || !edgesResult.data || edgesResult.data.length === 0) {
        return {
          success: true,
          summary: `No active conversations in the last ${hours}h`,
          data: { formatted: "No recent conversations", conversations: [], count: 0 },
        };
      }

      const candidatePairs: Array<{ a: string; b: string }> = [];
      const seen = new Set<string>();
      for (const row of edgesResult.data) {
        const a = row.user_a as string;
        const b = row.user_b as string;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidatePairs.push({ a, b });
        }
        if (candidatePairs.length >= limit) break;
      }

      if (candidatePairs.length === 0) {
        return {
          success: true,
          summary: `No active conversations in the last ${hours}h`,
          data: { formatted: "No recent conversations", conversations: [], count: 0 },
        };
      }

      // Resolve names for users
      const userIds = Array.from(
        new Set(candidatePairs.flatMap((p) => [p.a, p.b]))
      );
      const namesResult = await context.db.query(
        `SELECT user_id, display_name, username
         FROM members
         WHERE guild_id = $1 AND active = true AND user_id = ANY($2::text[])`,
        [context.guildId, userIds]
      );
      const nameMap = new Map<string, string>();
      if (namesResult.success && namesResult.data) {
        for (const r of namesResult.data) {
          nameMap.set(r.user_id, r.display_name || r.username || r.user_id);
        }
      }

      const conversations: Array<{
        users: { a: string; b: string; aName: string; bName: string };
        samples: Array<{ when: string; channel: string; author: string; content: string }>;
      }> = [];

      for (const pair of candidatePairs) {
        const between = await context.db.getMessagesBetweenUsers(
          pair.a,
          pair.b,
          context.guildId
        );
        if (!between.success || !between.data) continue;

        // Filter to window and optional channel, take last N chronologically
        const filtered = (between.data as any[])
          .filter((m) => new Date(m.created_at) >= since)
          .filter((m) => (params.channelId ? m.channel_id === params.channelId : true))
          .slice(-samples);

        if (filtered.length === 0) continue;

        // Resolve channel names in bulk per pair
        const chIds = Array.from(new Set(filtered.map((m) => m.channel_id)));
        const channelsResult = await context.db.query(
          `SELECT id, name FROM channels WHERE guild_id = $1 AND id = ANY($2::text[])`,
          [context.guildId, chIds]
        );
        const channelMap = new Map<string, string>();
        if (channelsResult.success && channelsResult.data) {
          for (const c of channelsResult.data) channelMap.set(c.id, c.name);
        }

        const aName = nameMap.get(pair.a) || pair.a;
        const bName = nameMap.get(pair.b) || pair.b;

        const samplesFmt = filtered.map((m) => {
          const when = new Date(m.created_at).toLocaleString();
          const channel = channelMap.get(m.channel_id) || m.channel_id;
          const author = m.author_id === pair.a ? aName : m.author_id === pair.b ? bName : m.author_id;
          const content = (m.content || "(no content)").replace(/\s+/g, " ").trim();
          const snippet = content.length > 160 ? `${content.substring(0, 160)}...` : content;
          return { when, channel, author, content: snippet };
        });

        conversations.push({
          users: { a: pair.a, b: pair.b, aName, bName },
          samples: samplesFmt,
        });

        if (conversations.length >= limit) break;
      }

      if (conversations.length === 0) {
        return {
          success: true,
          summary: `No recent conversations found in the last ${hours}h`,
          data: { formatted: "No recent conversations", conversations: [], count: 0 },
        };
      }

      const formatted = conversations
        .map((c) => {
          const header = `${c.users.aName} ↔ ${c.users.bName}`;
          const lines = c.samples.map(
            (s) => `[${s.when}] #${s.channel} — ${s.author}: ${s.content}`
          );
          return `${header}\n${lines.join("\n")}`;
        })
        .join("\n\n");

      return {
        success: true,
        summary: `Found ${conversations.length} recent conversation(s) over ~${hours}h`,
        data: { formatted, conversations, count: conversations.length },
      };
    } catch (error) {
      console.error("🔸 Error in getRecentConversations:", error);
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

      // Top relationships (prefer embedded network for speed)
      let relationshipsFormatted = "No relationships tracked";
      let relationships = Array.isArray(profile?.relationship_network) ? profile.relationship_network : [];
      if (relationships.length > 0) {
        const top = relationships
          .slice()
          .sort((a: any, b: any) => (b.affinity_percentage || 0) - (a.affinity_percentage || 0))
          .slice(0, relationshipsLimit);
        relationshipsFormatted = top
          .map(
            (r: any) =>
              `  - ${r.display_name || r.username || r.user_id}: ${(r.affinity_percentage || 0).toFixed(1)}% affinity, ${r.interaction_count || 0} interactions${r.summary ? `, ${r.summary}` : ""}`
          )
          .join("\n");
        relationships = top;
      } else {
        // Fallback: query edges table for recent relationships
        const edges = await context.db.query(
          `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other_user,
                  rolling_7d, total, last_interaction
           FROM relationship_edges
           WHERE guild_id = $2 AND (user_a = $1 OR user_b = $1)
           ORDER BY rolling_7d DESC, total DESC
           LIMIT $3`,
          [userId, context.guildId, relationshipsLimit]
        );
        if (edges.success && edges.data && edges.data.length > 0) {
          const otherIds = edges.data.map((e: any) => e.other_user);
          const names = await context.db.query(
            `SELECT user_id, display_name, username FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
            [context.guildId, otherIds]
          );
          const nameMap = new Map<string, string>();
          if (names.success && names.data) {
            for (const n of names.data) {
              nameMap.set(n.user_id, n.display_name || n.username || n.user_id);
            }
          }
          relationships = edges.data.map((e: any) => ({
            user_id: e.other_user,
            display_name: nameMap.get(e.other_user) || e.other_user,
            affinity_percentage: e.rolling_7d || 0,
            interaction_count: e.total || 0,
            last_interaction: e.last_interaction,
          }));
          relationshipsFormatted = relationships
            .map(
              (r: any) =>
                `  - ${r.display_name}: ${(r.affinity_percentage || 0).toFixed(1)}% affinity, ${r.interaction_count || 0} interactions`
            )
            .join("\n");
        }
      }

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
        `SELECT cs.id, cs.channel_id, cs.start_time, cs.end_time, cs.summary, cs.features, c.name as channel_name
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

          // Extract keywords from features.terms if available
          let keywords: string[] = [];
          if (seg.features && typeof seg.features === 'object') {
            const featuresObj = seg.features as any;

            // Check for both 'keywords' (old format) and 'terms' (new format)
            if (Array.isArray(featuresObj.keywords)) {
              keywords = featuresObj.keywords.slice(0, 5);
            } else if (Array.isArray(featuresObj.terms)) {
              // Extract words from terms array
              keywords = featuresObj.terms
                .slice(0, 5)
                .map((term: any) => term.word)
                .filter(Boolean);
            }
          }

          const summary = seg.summary || (keywords.length > 0 ? keywords.join(", ") : "discussion");
          topicsLines.push(`  • #${channel} (${date}): ${summary}`);
        }

        if (topicsLines.length > 0) {
          conversationTopicsFormatted = `Recent discussion topics:\n${topicsLines.join("\n")}`;
        }
      }

      // Build conversational context (minimal stats, focus on content and relationships)
      const parts: string[] = [];
      parts.push(header.join(" \u2014 "));

      // Include user keywords/interests if available
      if (profile?.keywords && Array.isArray(profile.keywords) && profile.keywords.length > 0) {
        const topKeywords = profile.keywords.slice(0, 8).join(", ");
        parts.push(`Interests: ${topKeywords}`);
      }

      // Include top relationships as natural connections (no percentages/counts)
      if (relationshipsFormatted !== "No relationships tracked" && relationships.length > 0) {
        const topConnections = relationships.slice(0, 3).map((r: any) => r.display_name || r.username || r.user_id);
        if (topConnections.length > 0) {
          parts.push(`Close connections: ${topConnections.join(", ")}`);
        }
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
          relationships,
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
