import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
  formatRelationship,
} from "../registry/DatabaseTools";
import type { RelationshipEntry } from "../../../features/social-intelligence/types";

/**
 * Get user's relationship network
 */
export const getUserRelationshipsTool: DatabaseTool = {
  name: "getUserRelationships",
  description:
    "Get a user's complete relationship network with affinity scores, interaction counts, and summaries. Use this to understand who a user interacts with most.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID to get relationships for",
      },
      limit: {
        type: "number",
        description: "Maximum number of relationships to return (default: 20)",
      },
      minAffinity: {
        type: "number",
        description: "Minimum affinity percentage to filter (default: 0)",
      },
    },
    required: ["userId"],
  },
  execute: async (
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    const { userId, limit, minAffinity } = params as { userId: string; limit?: number; minAffinity?: number };
    try {
      const result = await context.db.getMemberRelationshipNetwork(
        userId,
        context.guildId
      );

      if (!result.success || !result.data) {
        return {
          success: false,
          error: `Failed to get relationships for user ${userId}`,
        };
      }

      let relationships = result.data;

      // Filter by minimum affinity
      if (minAffinity !== undefined) {
        relationships = relationships.filter(
          (r) => r.affinity_percentage >= minAffinity
        );
      }

      // Sort by affinity and limit
      relationships = relationships
        .sort((a, b) => b.affinity_percentage - a.affinity_percentage)
        .slice(0, limit || 20);

      // Get display names for relationships
      const userIds = relationships.map((r) => r.user_id);
      if (userIds.length > 0) {
        const namesResult = await context.db.query(
          `SELECT user_id, display_name, username 
           FROM members 
           WHERE user_id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
          [userIds, context.guildId]
        );

        if (namesResult.success && namesResult.data) {
          const nameMap = new Map(
            namesResult.data.map((m: any) => [m.user_id, m])
          );
          relationships.forEach((rel) => {
            const member = nameMap.get(rel.user_id);
            if (member) {
              rel.display_name = member.display_name;
              rel.username = member.username;
            }
          });
        }
      }

      const formatted = relationships.map(formatRelationship).join("\n\n");

      return {
        success: true,
        summary: `Found ${relationships.length} relationship(s) for user`,
        data: {
          formatted,
          relationships,
          count: relationships.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getUserRelationships:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get relationships",
      };
    }
  },
};

/**
 * Get specific relationship between two users
 */
export const getRelationshipBetweenTool: DatabaseTool = {
  name: "getRelationshipBetween",
  description:
    "Get the specific relationship data between two users including affinity, conversations, and summaries. Use this when asked about relationships between specific people.",
  parameters: {
    type: "object",
    properties: {
      user1Id: {
        type: "string",
        description: "First user's Discord ID",
      },
      user2Id: {
        type: "string",
        description: "Second user's Discord ID",
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
      // Get user1's relationship network
      const result = await context.db.getMemberRelationshipNetwork(
        user1Id,
        context.guildId
      );

      if (!result.success || !result.data) {
        return {
          success: false,
          error: `Failed to get relationships for user ${user1Id}`,
        };
      }

      const relationship = result.data.find(
        (r) => r.user_id === user2Id
      );

      if (!relationship) {
        // Try reverse relationship
        const reverseResult = await context.db.getMemberRelationshipNetwork(
          user2Id,
          context.guildId
        );

        if (
          reverseResult.success &&
          reverseResult.data &&
          reverseResult.data.find((r) => r.user_id === user1Id)
        ) {
          return {
            success: true,
            summary:
              "Relationship exists but is tracked from the other user's perspective",
            data: {
              formatted:
                "Relationship detected but not detailed in this direction",
              relationship: null,
            },
          };
        }

        return {
          success: false,
          error: `No relationship found between ${user1Id} and ${user2Id}`,
        };
      }

      // Get display names
      const namesResult = await context.db.query(
        `SELECT user_id, display_name, username
         FROM members
         WHERE user_id IN ($1, $2) AND guild_id = $3 AND active = true`,
        [user1Id, user2Id, context.guildId]
      );

      if (namesResult.success && namesResult.data) {
        const nameMap = new Map(
          namesResult.data.map((m: any) => [m.user_id, m])
        );
        const user2Member = nameMap.get(user2Id);
        if (user2Member) {
          relationship.display_name = user2Member.display_name;
          relationship.username = user2Member.username;
        }
      }

      const formatted = formatRelationship(relationship);

      // Add conversation details
      if (relationship.conversations && relationship.conversations.length > 0) {
        const convDetails = relationship.conversations
          .slice(-3)
          .map(
            (conv) =>
              `  - ${conv.conversation_id}: ${conv.message_count} messages, ${conv.duration_minutes} min`
          )
          .join("\n");
        formatted + `\nRecent conversations:\n${convDetails}`;
      }

      return {
        success: true,
        summary: `Relationship affinity: ${relationship.affinity_percentage.toFixed(
          1
        )}%`,
        data: {
          formatted,
          relationship,
          conversationCount: relationship.conversations?.length || 0,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getRelationshipBetween:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get relationship",
      };
    }
  },
};

/**
 * Get top N relationships for a user
 */
export const getTopRelationshipsTool: DatabaseTool = {
  name: "getTopRelationships",
  description:
    "Get the top N relationships for a user sorted by affinity percentage. Use this to find a user's closest connections.",
  parameters: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description: "Discord user ID to get top relationships for",
      },
      limit: {
        type: "number",
        description: "Number of top relationships to return (default: 10)",
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
      const result = await context.db.getMemberRelationshipNetwork(
        userId,
        context.guildId
      );

      if (!result.success || !result.data) {
        return {
          success: false,
          error: `Failed to get relationships for user ${userId}`,
        };
      }

      const topRelationships = result.data
        .sort((a, b) => b.affinity_percentage - a.affinity_percentage)
        .slice(0, limit || 10);

      // Get display names
      const userIds = topRelationships.map((r) => r.user_id);
      if (userIds.length > 0) {
        const namesResult = await context.db.query(
          `SELECT user_id, display_name, username 
           FROM members 
           WHERE user_id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
          [userIds, context.guildId]
        );

        if (namesResult.success && namesResult.data) {
          const nameMap = new Map(
            namesResult.data.map((m: any) => [m.user_id, m])
          );
          topRelationships.forEach((rel) => {
            const member = nameMap.get(rel.user_id);
            if (member) {
              rel.display_name = member.display_name;
              rel.username = member.username;
            }
          });
        }
      }

      const formatted = topRelationships
        .map(
          (rel, idx) =>
            `${idx + 1}. ${
              rel.display_name || rel.user_id
            }: ${rel.affinity_percentage.toFixed(1)}% affinity (${
              rel.interaction_count
            } interactions)`
        )
        .join("\n");

      return {
        success: true,
        summary: `Top ${topRelationships.length} relationship(s) for user`,
        data: {
          formatted,
          relationships: topRelationships,
          count: topRelationships.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getTopRelationships:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get top relationships",
      };
    }
  },
};

/**
 * Get mutual connections between two users
 */
export const getMutualConnectionsTool: DatabaseTool = {
  name: "getMutualConnections",
  description:
    "Find users who have relationships with both specified users (mutual connections). Use this to find common friends or connections.",
  parameters: {
    type: "object",
    properties: {
      user1Id: {
        type: "string",
        description: "First user's Discord ID",
      },
      user2Id: {
        type: "string",
        description: "Second user's Discord ID",
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
      // Get both users' relationship networks
      const [result1, result2] = await Promise.all([
        context.db.getMemberRelationshipNetwork(
          user1Id,
          context.guildId
        ),
        context.db.getMemberRelationshipNetwork(
          user2Id,
          context.guildId
        ),
      ]);

      if (!result1.success || !result2.success) {
        return {
          success: false,
          error: "Failed to get relationship networks",
        };
      }

      const network1 = new Set(
        (result1.data || []).map((r: RelationshipEntry) => r.user_id)
      );
      const network2 = new Set(
        (result2.data || []).map((r: RelationshipEntry) => r.user_id)
      );

      // Find mutual connections
      const mutualIds = Array.from(network1).filter((id) => network2.has(id));

      if (mutualIds.length === 0) {
        return {
          success: true,
          summary: "No mutual connections found",
          data: {
            formatted: "No mutual connections between these users",
            connections: [],
            count: 0,
          },
        };
      }

      // Get details for mutual connections
      const namesResult = await context.db.query(
        `SELECT user_id, display_name, username 
         FROM members 
         WHERE user_id = ANY($1::text[]) AND guild_id = $2 AND active = true`,
        [mutualIds, context.guildId]
      );

      const connections: any[] = [];
      if (namesResult.success && namesResult.data) {
        for (const member of namesResult.data) {
          const rel1 = (result1.data || []).find(
            (r: RelationshipEntry) => r.user_id === member.user_id
          );
          const rel2 = (result2.data || []).find(
            (r: RelationshipEntry) => r.user_id === member.user_id
          );

          connections.push({
            user_id: member.user_id,
            display_name: member.display_name,
            username: member.username,
            affinity_with_user1: rel1?.affinity_percentage || 0,
            affinity_with_user2: rel2?.affinity_percentage || 0,
          });
        }
      }

      const formatted = connections
        .map(
          (conn) =>
            `${conn.display_name}: ${conn.affinity_with_user1.toFixed(
              1
            )}% with user1, ${conn.affinity_with_user2.toFixed(1)}% with user2`
        )
        .join("\n");

      return {
        success: true,
        summary: `Found ${connections.length} mutual connection(s)`,
        data: {
          formatted,
          connections,
          count: connections.length,
        },
      };
    } catch (error) {
      console.error("🔸 Error in getMutualConnections:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get mutual connections",
      };
    }
  },
};

/**
 * Analyze relationship strength and patterns
 */
export const analyzeRelationshipTool: DatabaseTool = {
  name: "analyzeRelationship",
  description:
    "Analyze the relationship between two users including strength, interaction patterns, and conversation frequency. Use this for detailed relationship insights.",
  parameters: {
    type: "object",
    properties: {
      user1Id: {
        type: "string",
        description: "First user's Discord ID",
      },
      user2Id: {
        type: "string",
        description: "Second user's Discord ID",
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
      // Get relationship
      const networkResult = await context.db.getMemberRelationshipNetwork(
        user1Id,
        context.guildId
      );

      if (!networkResult.success || !networkResult.data) {
        return {
          success: false,
          error: `Failed to get relationship data`,
        };
      }

      // relationship_network JSONB entries carry optional keywords (not in PostgreSQLManager's narrower type)
      const network: RelationshipEntry[] = networkResult.data;
      const relationship = network.find((r) => r.user_id === user2Id);

      if (!relationship) {
        return {
          success: false,
          error: `No relationship found between these users`,
        };
      }

      // Analyze conversations
      const conversations = relationship.conversations || [];
      const totalConversations = conversations.length;
      const totalMessages = conversations.reduce(
        (sum, conv) => sum + conv.message_count,
        0
      );
      const avgDuration =
        conversations.length > 0
          ? conversations.reduce(
              (sum, conv) => sum + (conv.duration_minutes || 0),
              0
            ) / conversations.length
          : 0;

      // Get recent interaction
      const recentConv =
        conversations.length > 0
          ? conversations.sort(
              (a, b) =>
                new Date(b.end_time).getTime() - new Date(a.end_time).getTime()
            )[0]
          : null;

      const parts: string[] = [];
      parts.push(`Relationship Analysis:`);
      parts.push(
        `  - Affinity Score: ${relationship.affinity_percentage.toFixed(1)}%`
      );
      parts.push(`  - Interaction Count: ${relationship.interaction_count}`);
      parts.push(`  - Total Conversations: ${totalConversations}`);
      parts.push(`  - Total Messages: ${totalMessages}`);

      if (totalConversations > 0) {
        parts.push(`  - Average Duration: ${avgDuration.toFixed(1)} minutes`);
      }

      if (relationship.summary) {
        parts.push(`  - Summary: ${relationship.summary}`);
      }

      if (relationship.keywords && relationship.keywords.length > 0) {
        parts.push(`  - Keywords: ${relationship.keywords.join(", ")}`);
      }

      if (recentConv) {
        parts.push(
          `  - Most Recent: ${new Date(
            recentConv.end_time
          ).toLocaleDateString()} (${recentConv.message_count} messages)`
        );
      }

      // Strength classification
      let strength = "Weak";
      if (relationship.affinity_percentage >= 70) {
        strength = "Very Strong";
      } else if (relationship.affinity_percentage >= 50) {
        strength = "Strong";
      } else if (relationship.affinity_percentage >= 30) {
        strength = "Moderate";
      }

      parts.push(`  - Relationship Strength: ${strength}`);

      return {
        success: true,
        summary: `${strength} relationship (${relationship.affinity_percentage.toFixed(
          1
        )}% affinity)`,
        data: {
          formatted: parts.join("\n"),
          relationship,
          analysis: {
            strength,
            totalConversations,
            totalMessages,
            avgDuration,
            recentConversation: recentConv,
          },
        },
      };
    } catch (error) {
      console.error("🔸 Error in analyzeRelationship:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to analyze relationship",
      };
    }
  },
};

/**
 * Export all relationship tools for registration
 */
export const relationshipTools: DatabaseTool[] = [
  getUserRelationshipsTool,
  getRelationshipBetweenTool,
  getTopRelationshipsTool,
  getMutualConnectionsTool,
  analyzeRelationshipTool,
];
