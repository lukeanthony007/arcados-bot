import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
  formatUserInfo,
} from "../registry/DatabaseTools";
import type { MemberData } from "../../../database/PostgreSQLManager";

/**
 * Resolve a user identifier (ID or name) to a Discord user ID.
 * If the input is already a Discord ID (numeric, 17-19 digits), returns it as-is.
 * Otherwise, searches for the user by name and returns their ID.
 */
async function resolveUserId(
  identifier: string,
  guildId: string,
  db: ToolContext["db"]
): Promise<{ success: boolean; userId?: string; error?: string }> {
  // Check if it's already a Discord ID (numeric, 17-19 digits)
  const isDiscordId = /^\d{17,19}$/.test(identifier);
  if (isDiscordId) {
    return { success: true, userId: identifier };
  }

  // Search for user by name
  const searchTerm = `%${identifier.toLowerCase()}%`;
  const searchResult = await db.query(
    `SELECT user_id, display_name, username, global_name, nick
     FROM members 
     WHERE guild_id = $1 
       AND active = true
       AND (
         LOWER(display_name) LIKE $2
         OR LOWER(username) LIKE $2
         OR LOWER(COALESCE(global_name, '')) LIKE $2
         OR LOWER(COALESCE(nick, '')) LIKE $2
       )
     ORDER BY 
       CASE 
         WHEN LOWER(username) = LOWER($3) THEN 1
         WHEN LOWER(display_name) = LOWER($3) THEN 2
         WHEN LOWER(COALESCE(global_name, '')) = LOWER($3) THEN 3
         WHEN LOWER(COALESCE(nick, '')) = LOWER($3) THEN 4
         ELSE 5
       END,
       display_name
     LIMIT 1`,
    [guildId, searchTerm, identifier]
  );

  if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
    return { success: true, userId: searchResult.data[0].user_id };
  }

  // Try inactive members as fallback
  const fallbackSearch = await db.query(
    `SELECT user_id, display_name, username, global_name, nick
     FROM members 
     WHERE guild_id = $1 
       AND active = false
       AND (
         LOWER(display_name) LIKE $2
         OR LOWER(username) LIKE $2
         OR LOWER(COALESCE(global_name, '')) LIKE $2
         OR LOWER(COALESCE(nick, '')) LIKE $2
       )
     ORDER BY display_name
     LIMIT 1`,
    [guildId, searchTerm]
  );

  if (fallbackSearch.success && fallbackSearch.data && fallbackSearch.data.length > 0) {
    return { success: true, userId: fallbackSearch.data[0].user_id };
  }

  return {
    success: false,
    error: `User "${identifier}" not found in this server. Try using searchUsers to find users by name.`,
  };
}

/**
 * Get complete user profile information
 */
export const getUserInfoTool: DatabaseTool = {
  name: "getUserInfo",
  description:
    "Get comprehensive user information for natural conversation context. Returns rich narrative-focused details including: who they are, how long they've been around, what topics they're into (from keywords and recent conversations), recent conversation summaries with specific details, and who they interact with. The response includes detailed conversation context like 'Recently he's been chatting about [specific events/discussions]' and topics of interest. Focus on building a flowing, conversational understanding with specific examples rather than listing generic stats. If no userId is provided, use the requesting user (for prompts like 'who am I'). Can accept either a Discord user ID (numeric string) or a username/display name (will search automatically).",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID (numeric) or username/display name to query. If a name is provided, will search for the user first.",
      },
    },
    required: [],
  },
  execute: async (
    params: { userId?: string },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const identifier = params.userId || context.userId;
      const resolved = await resolveUserId(identifier, context.guildId, context.db);
      
      if (!resolved.success || !resolved.userId) {
        return {
          success: false,
          error: resolved.error || `User "${identifier}" not found in this server`,
        };
      }
      
      const targetUserId = resolved.userId;

      const result = await context.db.query(
        `SELECT * FROM members 
         WHERE user_id = $1 AND guild_id = $2 AND active = true
         LIMIT 1`,
        [targetUserId, context.guildId]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        // Try inactive members
        const fallbackResult = await context.db.query(
          `SELECT * FROM members 
           WHERE user_id = $1 AND guild_id = $2 AND active = false
           LIMIT 1`,
          [targetUserId, context.guildId]
        );

        if (
          fallbackResult.success &&
          fallbackResult.data &&
          fallbackResult.data.length > 0
        ) {
          const member = fallbackResult.data[0] as MemberData;
          // Get profile data for inactive member
          const profileResult = await context.db.getUserProfile(targetUserId, context.guildId);
          const summary = profileResult.success && profileResult.data ? profileResult.data.summary : undefined;
          const formatted = formatUserInfo(
            member,
            profileResult.success ? profileResult.data : null
          );
          return {
            success: true,
            summary: `${member.display_name} - ${
              summary || "Member of this server"
            }`,
            data: { formatted, member },
          };
        }

        return {
          success: false,
          error: `User ${targetUserId} not found in this server`,
        };
      }

      const member = result.data[0] as MemberData;

      // Get user profile data (AI-focused data from user_profiles)
      const profileResult = await context.db.getUserProfile(targetUserId, context.guildId);
      const profile = profileResult.success && profileResult.data ? profileResult.data : null;

      // Get role names (not just IDs)
      let roleNames: string[] = [];
      if (member.roles && member.roles.length > 0) {
        const rolesResult = await context.db.query(
          `SELECT name FROM roles 
           WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true
           ORDER BY name`,
          [member.roles, context.guildId]
        );
        if (rolesResult.success && rolesResult.data) {
          roleNames = rolesResult.data.map((r: any) => r.name);
        }
      }

      // Get message count and activity context
      const messageStatsResult = await context.db.query(
        `SELECT COUNT(*) as message_count, 
                MIN(created_at) as first_message,
                MAX(created_at) as last_message
         FROM messages 
         WHERE author_id = $1 AND guild_id = $2 AND active = true`,
        [targetUserId, context.guildId]
      );

      const messageCount =
        messageStatsResult.success && messageStatsResult.data?.[0]
          ? parseInt(messageStatsResult.data[0].message_count, 10)
          : 0;
      const firstMessage =
        messageStatsResult.success &&
        messageStatsResult.data?.[0]?.first_message
          ? new Date(messageStatsResult.data[0].first_message)
          : null;

      // Get top relationships with more context
      const network = profile?.relationship_network || [];
      const topRelationshipsRaw = network
        .sort((a: { affinity_percentage: number }, b: { affinity_percentage: number }) => b.affinity_percentage - a.affinity_percentage)
        .slice(0, 5);

      // Enrich relationships with display names if missing
      const enrichedRelationships = await Promise.all(
        topRelationshipsRaw.map(async (r: { display_name?: string; username?: string; user_id: string; affinity_percentage: number; interaction_count: number; summary?: string }) => {
          if (r.display_name || r.username) {
            return r; // Already has a name
          }

          // Fetch display name from database
          const userResult = await context.db.query(
            `SELECT display_name, username, global_name
             FROM members
             WHERE user_id = $1 AND guild_id = $2
             LIMIT 1`,
            [r.user_id, context.guildId]
          );

          if (userResult.success && userResult.data && userResult.data.length > 0) {
            const userData = userResult.data[0];
            return {
              ...r,
              display_name: userData.display_name || userData.global_name || userData.username || r.user_id,
              username: userData.username,
            };
          }

          return r; // Fallback to original
        })
      );

      const topRelationships = enrichedRelationships
        .map(
          (r) =>
            `  - ${
              r.display_name || r.username || r.user_id
            }: ${r.affinity_percentage.toFixed(1)}% affinity, ${
              r.interaction_count
            } interactions${r.summary ? `, context: ${r.summary}` : ""}`
        )
        .join("\n");

      // Also enrich the full network for context (top 10)
      const topNetworkRaw = network.slice(0, 10);
      const enrichedNetwork = await Promise.all(
        topNetworkRaw.map(async (r: { display_name?: string; username?: string; user_id: string; affinity_percentage: number; interaction_count: number }) => {
          if (r.display_name || r.username) {
            return r;
          }

          const userResult = await context.db.query(
            `SELECT display_name, username, global_name
             FROM members
             WHERE user_id = $1 AND guild_id = $2
             LIMIT 1`,
            [r.user_id, context.guildId]
          );

          if (userResult.success && userResult.data && userResult.data.length > 0) {
            const userData = userResult.data[0];
            return {
              ...r,
              display_name: userData.display_name || userData.global_name || userData.username || r.user_id,
              username: userData.username,
            };
          }

          return r;
        })
      );

      // Build rich context object
      const richContext = {
        displayName: member.display_name,
        username: member.username,
        globalName: member.global_name,
        summary: profile?.summary,
        keywords: profile?.keywords || [],
        emojis: profile?.emojis || [],
        roles: roleNames,
        roleCount: member.roles?.length || 0,
        joinedAt: new Date(member.joined_at),
        messageCount,
        firstMessageDate: firstMessage,
        active: member.active,
        relationships: topRelationships || "No relationships tracked",
        relationshipNetwork: enrichedNetwork, // Top 10 with names enriched
        notes: profile?.notes || [],
      };

      // Compute server-age-relative descriptor
      try {
        const guildResult = await context.db.query(
          `SELECT created_at FROM guilds WHERE id = $1 LIMIT 1`,
          [context.guildId]
        );
        if (guildResult.success && guildResult.data?.[0]?.created_at) {
          const guildCreatedAt = new Date(guildResult.data[0].created_at);
          const joinedAt = new Date(member.joined_at);
          const daysSinceJoin = Math.floor(
            (Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24)
          );
          const daysFromStart = Math.floor(
            (joinedAt.getTime() - guildCreatedAt.getTime()) /
              (1000 * 60 * 60 * 24)
          );

          let serverMembershipDescriptor = "";
          if (daysFromStart <= 14) {
            serverMembershipDescriptor = "here since the start";
          } else if (daysSinceJoin < 30) {
            serverMembershipDescriptor = "a new member";
          } else if (daysSinceJoin < 180) {
            const months = Math.max(1, Math.round(daysSinceJoin / 30));
            serverMembershipDescriptor = `here for a few months (about ${months} months)`;
          } else if (daysSinceJoin < 365) {
            const months = Math.round(daysSinceJoin / 30);
            serverMembershipDescriptor = `here for a while (about ${months} months)`;
          } else {
            const years = Math.floor(daysSinceJoin / 365);
            serverMembershipDescriptor = `around ${years} year${
              years > 1 ? "s" : ""
            }`;
          }

          (richContext as any).serverMembershipDescriptor =
            serverMembershipDescriptor;
        }
      } catch {
        // Non-fatal if guild date unavailable
      }

      // Build a narrative-focused summary for the LLM
      const narrativeParts: string[] = [];

      // Who they are - start with a natural introduction
      const introParts: string[] = [];
      introParts.push(`${member.display_name}`);
      if (member.username && member.username !== member.display_name) {
        introParts.push(`known as @${member.username}`);
      }

      // Server tenure (contextual, not just a date)
      const serverTenure = (richContext as any).serverMembershipDescriptor;
      if (serverTenure) {
        introParts.push(`has been ${serverTenure} in this server`);
      } else {
        introParts.push(`joined ${new Date(member.joined_at).toLocaleDateString()}`);
      }

      narrativeParts.push(introParts.join(", "));

      // Roles (if any) - include in intro if relevant
      if (roleNames.length > 0) {
        narrativeParts.push(`Roles: ${roleNames.join(", ")}`);
      }

      // Get recent conversation segments with summaries AND message_ids
      // We'll combine conversation context (summaries) with user's specific messages
      const since = new Date();
      since.setDate(since.getDate() - 60);
      
      const conversationSegmentsResult = await context.db.query(
        `SELECT cs.id, cs.channel_id, cs.start_time, cs.end_time, cs.summary, cs.message_ids, cs.features, cs.message_count, c.name as channel_name
         FROM conversation_segments cs
         LEFT JOIN channels c ON cs.channel_id = c.id AND cs.guild_id = c.guild_id
         WHERE cs.guild_id = $1
           AND $2 = ANY(cs.participants)
           AND cs.start_time >= $3
           AND cs.status = 'finalized'
           AND cs.message_count >= 2
           AND cs.message_ids IS NOT NULL
           AND array_length(cs.message_ids, 1) > 0
         ORDER BY cs.start_time DESC, cs.message_count DESC
         LIMIT 30`,
        [context.guildId, targetUserId, since]
      );

      // Build contextual summaries: conversation context + user's specific contributions
      interface ContextualSummary {
        conversationSummary: string; // What the conversation was about
        userMessages: string[]; // What the user specifically said
        segmentId: string;
      }
      
      const contextualSummaries: ContextualSummary[] = [];
      const recentTopics: Set<string> = new Set();
      const allKeywords: string[] = [];
      
      if (conversationSegmentsResult.success && conversationSegmentsResult.data && conversationSegmentsResult.data.length > 0) {
        // Process each segment to get conversation context + user's messages
        for (const seg of conversationSegmentsResult.data) {
          if (!Array.isArray(seg.message_ids) || seg.message_ids.length === 0) continue;
          
          // Get the user's messages from this specific segment
          const userMessagesResult = await context.db.query(
            `SELECT m.content, m.created_at
             FROM messages m
             WHERE m.id = ANY($1::text[])
               AND m.author_id = $2
               AND m.guild_id = $3
               AND m.active = true
               AND m.content IS NOT NULL
               AND LENGTH(TRIM(m.content)) > 0
             ORDER BY m.created_at ASC`,
            [seg.message_ids, targetUserId, context.guildId]
          );
          
          const userMessages: string[] = [];
          if (userMessagesResult.success && userMessagesResult.data) {
            userMessages.push(...userMessagesResult.data.map((m: any) => m.content).filter((c: string) => c && c.trim().length > 5));
          }
          
          // Only include segments where we have both conversation context AND user messages
          if (seg.summary && seg.summary.trim().length > 15 && userMessages.length > 0) {
            contextualSummaries.push({
              conversationSummary: seg.summary.trim(),
              userMessages: userMessages.slice(0, 10), // Limit to most relevant messages
              segmentId: seg.id,
            });
          }
          
          // Extract keywords from features for topic context
          let featuresObj: any = null;
          if (seg.features) {
            if (typeof seg.features === 'string') {
              try {
                featuresObj = JSON.parse(seg.features);
              } catch {
                featuresObj = null;
              }
            } else if (typeof seg.features === 'object') {
              featuresObj = seg.features;
            }
          }
          
          if (featuresObj) {
            let keywords: string[] = [];
            
            if (featuresObj.keywords && typeof featuresObj.keywords === 'object' && !Array.isArray(featuresObj.keywords)) {
              if (Array.isArray(featuresObj.keywords.terms)) {
                keywords = featuresObj.keywords.terms
                  .map((term: any) => {
                    if (typeof term === 'string') return term;
                    if (term && typeof term === 'object' && term.word) return term.word;
                    return null;
                  })
                  .filter(Boolean)
                  .slice(0, 15);
              }
            } else if (Array.isArray(featuresObj.keywords)) {
              keywords = featuresObj.keywords
                .map((kw: any) => {
                  if (typeof kw === 'string') return kw;
                  if (kw && typeof kw === 'object' && kw.word) return kw.word;
                  return null;
                })
                .filter(Boolean)
                .slice(0, 15);
            } else if (Array.isArray(featuresObj.terms)) {
              keywords = featuresObj.terms
                .map((term: any) => {
                  if (typeof term === 'string') return term;
                  if (term && typeof term === 'object') {
                    return term.word || term.term || term.text || null;
                  }
                  return null;
                })
                .filter(Boolean)
                .slice(0, 15);
            }
            
            keywords.forEach(kw => {
              if (kw && typeof kw === 'string' && kw.length > 2) {
                const normalized = kw.toLowerCase().trim();
                if (normalized.length > 2) {
                  recentTopics.add(normalized);
                  allKeywords.push(normalized);
                }
              }
            });
          }
        }
      }
      
      // Build rich contextual summaries that combine conversation topics with user's contributions
      const richSummaries: string[] = [];
      for (const ctx of contextualSummaries.slice(0, 5)) {
        // Extract key phrases from user's messages (remove mentions, keep substance)
        const userContributions = ctx.userMessages
          .map(msg => {
            // Remove Discord mentions but keep context
            let cleaned = msg.replace(/<@\d+>/g, '').trim();
            // Limit length
            if (cleaned.length > 150) {
              cleaned = cleaned.substring(0, 150) + '...';
            }
            return cleaned;
          })
          .filter(m => m.length > 10)
          .slice(0, 3); // Take top 3 most relevant messages
        
        if (userContributions.length > 0) {
          // Build a cautious description that keeps the *conversation* summary
          // separate from the user's own perspective. This avoids implying that
          // the user is the one experiencing everything described in the segment
          // (e.g., someone else venting about a problem).
          const userText = userContributions.join("; ");
          const summary =
            `In a conversation summarized as: "${ctx.conversationSummary}", ` +
            `${member.display_name} specifically contributed lines like: ${userText}`;
          richSummaries.push(summary);
        }
      }

      // Combine member keywords with conversation topics
      // Member keywords are already aggregated from conversations, so prioritize them
      const memberKeywords = profile?.keywords || [];
      const combinedTopics = new Set<string>();
      
      // Add member keywords first (they're already aggregated/curated)
      memberKeywords.forEach(kw => {
        if (kw && typeof kw === 'string' && kw.trim().length > 2) {
          combinedTopics.add(kw.toLowerCase().trim());
        }
      });
      
      // Add conversation topics as additional context
      recentTopics.forEach(topic => combinedTopics.add(topic));
      
      // Debug: log what we found (can remove later)
      if (conversationSegmentsResult.success && conversationSegmentsResult.data) {
        console.log(`[getUserInfo] Found ${conversationSegmentsResult.data.length} conversation segments for ${targetUserId}`);
        console.log(`[getUserInfo] Found ${contextualSummaries.length} contextual summaries, ${richSummaries.length} rich summaries, ${recentTopics.size} topics, ${memberKeywords.length} member keywords`);
      }

      // Build a flowing narrative about interests and recent activity
      const interestParts: string[] = [];
      
      // Add member summary if available (this is the AI-generated summary)
      if (profile?.summary && profile.summary.trim().length > 10) {
        interestParts.push(profile.summary.trim());
      }

      // Add topics/interests - prioritize member keywords (already aggregated)
      // Skip topic extraction from keywords since they're often fragments
      // The summaries contain the real context, topics from keywords are too noisy
      // Only include topics if we have member keywords (which are curated)
      if (memberKeywords.length > 0) {
        const topicArray = memberKeywords
          .slice(0, 10)
          .map(kw => kw.toLowerCase().trim())
          .filter(t => {
            // Filter out very common words
            const commonWords = ['the', 'and', 'or', 'but', 'for', 'with', 'about', 'this', 'that', 'has', 'have', 'was', 'were', 'are', 'is', 'been', 'from', 'can', 'will', 'would', 'could', 'should', 'not', 'you', 'your', 'they', 'them', 'their', 'there', 'these', 'those', 'only', 'one', 'see'];
            return !commonWords.includes(t) && t.length > 3; // Require longer words
          })
          .slice(0, 8);
        
        if (topicArray.length > 0) {
          // Format as "into all kinds of stuff - topic1, topic2, topic3"
          interestParts.push(`into all kinds of stuff - ${topicArray.join(", ")}`);
        }
      }

      // Add rich contextual summaries that combine conversation topics with user's contributions
      // These show both what the conversation was about AND what the user specifically said
      if (richSummaries.length > 0) {
        const topSummaries = richSummaries
          .slice(0, 3) // Take top 3 most recent contextual summaries
          .filter(s => s && s.trim().length > 30); // Require meaningful length
        
        console.log(`[getUserInfo] Filtered rich summaries: ${topSummaries.length} from ${richSummaries.length}`);
        
        if (topSummaries.length > 0) {
          // Join summaries naturally - they already include full context,
          // but emphasize that these are *conversations they participated in*,
          // not necessarily events that happened to them personally.
          const summaryText = topSummaries.join(". ");
          interestParts.push(
            `Recently ${member.display_name} has been participating in conversations where ${summaryText}`
          );
        }
      }

      // Combine all interest parts into one flowing paragraph
      // Prioritize rich contextual summaries that show both conversation context and user contributions
      if (interestParts.length > 0) {
        // Join with periods and ensure proper sentence structure
        const combinedText = interestParts.join(". ");
        narrativeParts.push(`\n${combinedText}.`);
      } else if (richSummaries.length > 0) {
        // Fallback: if interestParts is empty but we have rich summaries, use them directly
        const topSummaries = richSummaries
          .slice(0, 3)
          .filter(s => s && s.trim().length > 30);
        if (topSummaries.length > 0) {
          const summaryText = topSummaries.join(". ");
          narrativeParts.push(`\nRecently ${member.display_name}'s been involved in conversations where ${summaryText}.`);
        }
      }
      
      // ALWAYS include member keywords if available (even if we have other data)
      // Member keywords are the most reliable source as they're aggregated from all conversations
      if (memberKeywords.length > 0 && interestParts.length === 0) {
        const filteredKeywords = memberKeywords
          .filter(kw => kw && typeof kw === 'string' && kw.trim().length > 2)
          .filter(kw => {
            const commonWords = ['the', 'and', 'or', 'but', 'for', 'with', 'about', 'this', 'that', 'has', 'have', 'was', 'were', 'are', 'is', 'been'];
            return !commonWords.includes(kw.toLowerCase().trim());
          })
          .slice(0, 10);
        if (filteredKeywords.length > 0) {
          narrativeParts.push(`\nKnown for: ${filteredKeywords.join(", ")}`);
        }
      }
      
      // Also add conversation topics if we found any (as additional context)
      if (recentTopics.size > 0 && interestParts.length === 0) {
        const topicArray = Array.from(recentTopics)
          .filter(t => {
            const commonWords = ['the', 'and', 'or', 'but', 'for', 'with', 'about', 'this', 'that', 'has', 'have', 'was', 'were', 'are', 'is', 'been'];
            return !commonWords.includes(t) && t.length > 2;
          })
          .slice(0, 10);
        if (topicArray.length > 0) {
          narrativeParts.push(`\nRecently discussed: ${topicArray.join(", ")}`);
        }
      }

      // Who they interact with (relationships) - format more naturally
      if (topRelationships && topRelationships.trim()) {
        const relationshipNames = enrichedRelationships
          .slice(0, 5)
          .map(r => r.display_name || r.username || r.user_id)
          .filter(Boolean);
        
        if (relationshipNames.length > 0) {
          narrativeParts.push(`\n${member.display_name} vibes with folks like ${relationshipNames.join(", ")} - they're ${member.display_name}'s usual crew.`);
        }
      }

      // Note: Message count and stats are intentionally excluded from narrative
      // to keep responses focused on qualitative understanding, not quantitative metrics

      const narrativeSummary = narrativeParts.join("\n");
      
      // Debug: log the final narrative to verify it includes our data
      console.log(`[getUserInfo] Final narrative length: ${narrativeSummary.length} chars`);
      console.log(`[getUserInfo] Final narrative preview: ${narrativeSummary.substring(0, 200)}...`);

      return {
        success: true,
        summary: narrativeSummary, // Primary field for LLM to use
        data: {
          narrative: narrativeSummary, // Primary field for LLM to use
          richContext, // Full structured context if needed
          roleNames,
          member,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getUserInfo:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get user info",
      };
    }
  },
};

/**
 * Get AI-generated user summary metadata
 */
export const getUserSummaryTool: DatabaseTool = {
  name: "getUserSummary",
  description:
    "Get AI-generated summary, keywords, emojis, and notes for a user. If no userId is provided, use the requesting user (e.g., 'summarize me'). Can accept either a Discord user ID (numeric string) or a username/display name (will search automatically).",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID (numeric) or username/display name to query. If a name is provided, will search for the user first.",
      },
    },
    required: [],
  },
  execute: async (
    params: { userId?: string },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const identifier = params.userId || context.userId;
      const resolved = await resolveUserId(identifier, context.guildId, context.db);
      
      if (!resolved.success || !resolved.userId) {
        return {
          success: false,
          error: resolved.error || `User "${identifier}" not found in this server`,
        };
      }
      
      const targetUserId = resolved.userId;
      
      // Get display name from members table
      const memberResult = await context.db.query(
        `SELECT display_name
         FROM members 
         WHERE user_id = $1 AND guild_id = $2 AND active = true
         LIMIT 1`,
        [targetUserId, context.guildId]
      );

      if (!memberResult.success || !memberResult.data || memberResult.data.length === 0) {
        return {
          success: false,
          error: `User ${targetUserId} not found in this server`,
        };
      }

      // Get profile data from user_profiles
      const profileResult = await context.db.getUserProfile(targetUserId, context.guildId);
      const profile = profileResult.success && profileResult.data ? profileResult.data : null;
      const displayName = memberResult.data[0].display_name;

      const parts: string[] = [];

      if (displayName) {
        parts.push(`User: ${displayName}`);
      }

      if (profile?.summary) {
        parts.push(`Summary: ${profile.summary}`);
      } else {
        parts.push("Summary: No summary available");
      }

      if (profile?.keywords && profile.keywords.length > 0) {
        parts.push(`Keywords: ${profile.keywords.join(", ")}`);
      }

      if (profile?.emojis && profile.emojis.length > 0) {
        parts.push(`Emojis: ${profile.emojis.join(" ")}`);
      }

      if (profile?.notes && profile.notes.length > 0) {
        parts.push(`Notes: ${profile.notes.join(", ")}`);
      }

      return {
        success: true,
        summary: profile?.summary || "No summary available",
        data: {
          formatted: parts.join("\n"),
          summary: profile?.summary,
          keywords: profile?.keywords || [],
          emojis: profile?.emojis || [],
          notes: profile?.notes || [],
        },
      };
    } catch (error) {
      console.error("🔸 Error in getUserSummary:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get user summary",
      };
    }
  },
};

/**
 * Search users by name, username, or keyword
 */
export const searchUsersTool: DatabaseTool = {
  name: "searchUsers",
  description:
    "Search for users by display name, username, or keywords. Use this when looking for specific users or users with certain characteristics.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (name, username, or keyword)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 10)",
      },
    },
    required: ["query"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { query, limit: limitParam } = params as { query: string; limit?: number };
    try {
      const limit = limitParam || 10;
      const searchTerm = `%${query.toLowerCase()}%`;

      const result = await context.db.query(
        `SELECT user_id, display_name, username, global_name, nick, summary, keywords
         FROM members 
         WHERE guild_id = $1 
           AND active = true
           AND (
             LOWER(display_name) LIKE $2
             OR LOWER(username) LIKE $2
             OR LOWER(COALESCE(global_name, '')) LIKE $2
             OR LOWER(COALESCE(nick, '')) LIKE $2
             OR EXISTS (
               SELECT 1 FROM UNNEST(keywords) AS kw 
               WHERE LOWER(kw) LIKE $2
             )
           )
         ORDER BY display_name
         LIMIT $3`,
        [context.guildId, searchTerm, limit]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        return {
          success: true,
          summary: `No users found matching "${params.query}"`,
          data: { users: [] },
        };
      }

      const users = result.data.map((u: any) => {
        const parts: string[] = [];
        parts.push(`${u.display_name} (@${u.username})`);
        if (u.user_id) {
          parts.push(`ID: ${u.user_id}`);
        }
        if (u.summary) {
          parts.push(`Summary: ${u.summary}`);
        }
        return parts.join(" | ");
      });

      return {
        success: true,
        summary: `Found ${users.length} user(s) matching "${params.query}"`,
        data: {
          formatted: users.join("\n"),
          users: result.data,
          count: users.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in searchUsers:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to search users",
      };
    }
  },
};

/**
 * Get user activity context
 * Note: This tool is deprecated in favor of getUserInfo which provides richer narrative context.
 * Use getUserInfo for comprehensive user information including activity.
 */
export const getUserActivityTool: DatabaseTool = {
  name: "getUserActivity",
  description:
    "DEPRECATED: Use getUserInfo instead. This tool provides basic activity stats but getUserInfo gives better narrative context about the user's participation and engagement. Can accept either a Discord user ID (numeric string) or a username/display name (will search automatically).",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID (numeric) or username/display name to query. If a name is provided, will search for the user first.",
      },
    },
    required: [],
  },
  execute: async (
    params: { userId?: string },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const identifier = params.userId || context.userId;
      const resolved = await resolveUserId(identifier, context.guildId, context.db);
      
      if (!resolved.success || !resolved.userId) {
        return {
          success: false,
          error: resolved.error || `User "${identifier}" not found in this server`,
        };
      }
      
      const targetUserId = resolved.userId;
      // Get member data
      const memberResult = await context.db.query(
        `SELECT display_name, status, activities, joined_at, updated_at
         FROM members 
         WHERE user_id = $1 AND guild_id = $2 AND active = true
         LIMIT 1`,
        [targetUserId, context.guildId]
      );

      if (
        !memberResult.success ||
        !memberResult.data ||
        memberResult.data.length === 0
      ) {
        return {
          success: false,
          error: `User ${targetUserId} not found in this server`,
        };
      }

      const member = memberResult.data[0];

      // Get message count
      const messageResult = await context.db.query(
        `SELECT COUNT(*) as count, MAX(created_at) as last_message
         FROM messages 
         WHERE author_id = $1 AND guild_id = $2 AND active = true`,
        [targetUserId, context.guildId]
      );

      const messageCount =
        messageResult.success && messageResult.data?.[0]
          ? parseInt(messageResult.data[0].count, 10)
          : 0;
      const lastMessage =
        messageResult.success && messageResult.data?.[0]?.last_message
          ? new Date(messageResult.data[0].last_message)
          : null;

      const parts: string[] = [];
      parts.push(`Activity for ${member.display_name}:`);
      parts.push(`  - Total messages: ${messageCount}`);
      parts.push(
        `  - Joined: ${new Date(member.joined_at).toLocaleDateString()}`
      );

      if (lastMessage) {
        parts.push(`  - Last message: ${lastMessage.toLocaleDateString()}`);
      }

      if (member.status) {
        parts.push(`  - Status: ${member.status}`);
      }

      return {
        success: true,
        summary: `${member.display_name} has sent ${messageCount} messages`,
        data: {
          formatted: parts.join("\n"),
          messageCount,
          lastMessage,
          status: member.status,
          joinedAt: member.joined_at,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getUserActivity:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get user activity",
      };
    }
  },
};

/**
 * Get user's roles and permissions
 */
export const getUserRolesTool: DatabaseTool = {
  name: "getUserRoles",
  description:
    "Get user's Discord roles and permissions. If no userId is provided, use the requesting user. Can accept either a Discord user ID (numeric string) or a username/display name (will search automatically).",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID (numeric) or username/display name to query. If a name is provided, will search for the user first.",
      },
    },
    required: [],
  },
  execute: async (
    params: { userId?: string },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const identifier = params.userId || context.userId;
      const resolved = await resolveUserId(identifier, context.guildId, context.db);
      
      if (!resolved.success || !resolved.userId) {
        return {
          success: false,
          error: resolved.error || `User "${identifier}" not found in this server`,
        };
      }
      
      const targetUserId = resolved.userId;
      const result = await context.db.query(
        `SELECT display_name, roles, permissions
         FROM members 
         WHERE user_id = $1 AND guild_id = $2 AND active = true
         LIMIT 1`,
        [targetUserId, context.guildId]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        return {
          success: false,
          error: `User ${targetUserId} not found in this server`,
        };
      }

      const member = result.data[0];
      const roleIds = member.roles || [];

      // Get role names
      let roleNames: string[] = [];
      if (roleIds.length > 0) {
        const rolesResult = await context.db.query(
          `SELECT name FROM roles 
           WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
          [roleIds, context.guildId]
        );

        if (rolesResult.success && rolesResult.data) {
          roleNames = rolesResult.data.map((r: any) => r.name);
        }
      }

      const parts: string[] = [];
      parts.push(`Roles for ${member.display_name}:`);

      if (roleNames.length > 0) {
        parts.push(`  - ${roleNames.join(", ")}`);
      } else {
        parts.push(`  - No roles assigned`);
      }

      parts.push(`  - Total roles: ${roleIds.length}`);
      parts.push(`  - Permissions: ${member.permissions || "0"}`);

      return {
        success: true,
        summary: `${member.display_name} has ${roleIds.length} role(s)`,
        data: {
          formatted: parts.join("\n"),
          roles: roleNames,
          roleIds,
          permissions: member.permissions,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getUserRoles:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get user roles",
      };
    }
  },
};

/**
 * Export all user tools for registration
 */
export const userTools: DatabaseTool[] = [
  getUserInfoTool,
  getUserSummaryTool,
  searchUsersTool,
  getUserActivityTool,
  getUserRolesTool,
];

