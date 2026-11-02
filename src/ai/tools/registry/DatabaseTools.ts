import {
  PostgreSQLManager,
  type MemberData,
  type UserProfileData,
} from "../../../database/PostgreSQLManager";
import type {
  ConversationEntry,
  RelationshipEntry,
} from "../../../features/social-intelligence/types";

/**
 * Context passed to tool execution functions
 */
export interface ToolContext {
  userId: string; // Requesting user ID
  guildId: string; // Current guild ID
  db: PostgreSQLManager; // Database connection
  // AI calls from tools go through OmpRuntime.get()
  channelId?: string; // Current channel ID (for live conversation access)
  messageId?: string; // Message that triggered the bot (for thread detection)
}

/**
 * Result format for tool execution
 */
export interface DatabaseToolResult {
  success: boolean;
  data?: any;
  summary?: string; // AI-friendly summary of the result
  formatted?: string; // Human-readable formatted output
  error?: string;
}

/**
 * DatabaseTool interface defining the structure of a tool
 */
export interface DatabaseTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description: string;
        enum?: string[];
      }
    >;
    required: string[];
  };
  execute: (
    params: Record<string, any>,
    context: ToolContext
  ) => Promise<string | DatabaseToolResult>;
}

/**
 * Format user information for AI consumption.
 * AI-generated profile fields (summary/keywords/emojis) live in user_profiles,
 * not on the members row, so they are passed in separately.
 */
export function formatUserInfo(
  member: MemberData,
  profile?: Pick<UserProfileData, "summary" | "keywords" | "emojis"> | null
): string {
  const parts: string[] = [];
  parts.push(`User: ${member.display_name} (@${member.username})`);

  if (member.global_name) {
    parts.push(`Global name: ${member.global_name}`);
  }

  if (profile?.summary) {
    parts.push(`Summary: ${profile.summary}`);
  }

  if (profile?.keywords && profile.keywords.length > 0) {
    parts.push(`Keywords: ${profile.keywords.join(", ")}`);
  }

  if (profile?.emojis && profile.emojis.length > 0) {
    parts.push(`Emojis: ${profile.emojis.join(" ")}`);
  }

  parts.push(`Joined: ${new Date(member.joined_at).toLocaleDateString()}`);
  parts.push(`Roles: ${member.roles?.length || 0}`);
  parts.push(`Active: ${member.active ? "Yes" : "No"}`);

  return parts.join("\n");
}

/**
 * Format relationship information for AI consumption
 */
export function formatRelationship(rel: RelationshipEntry): string {
  const parts: string[] = [];
  const name = rel.display_name || rel.username || rel.user_id;

  parts.push(`Relationship with ${name}:`);
  parts.push(`  - Affinity: ${rel.affinity_percentage.toFixed(1)}%`);
  parts.push(`  - Interactions: ${rel.interaction_count}`);
  parts.push(`  - Conversations: ${rel.conversations?.length || 0}`);
  parts.push(
    `  - Last interaction: ${new Date(
      rel.last_interaction
    ).toLocaleDateString()}`
  );

  if (rel.summary) {
    parts.push(`  - Summary: ${rel.summary}`);
  }

  if (rel.keywords && rel.keywords.length > 0) {
    parts.push(`  - Keywords: ${rel.keywords.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Format conversation entry for AI consumption
 */
export function formatConversation(conv: ConversationEntry): string {
  const parts: string[] = [];
  parts.push(`Conversation (${conv.conversation_id}):`);
  parts.push(`  - Start: ${new Date(conv.start_time).toLocaleString()}`);
  parts.push(`  - End: ${new Date(conv.end_time).toLocaleString()}`);
  parts.push(`  - Duration: ${conv.duration_minutes} minutes`);
  parts.push(`  - Messages: ${conv.message_count}`);
  parts.push(`  - Channel: ${conv.channel_id}`);

  if (conv.interaction_types && conv.interaction_types.length > 0) {
    parts.push(`  - Interaction types: ${conv.interaction_types.join(", ")}`);
  }

  if (conv.has_name_usage) {
    parts.push(`  - Direct name usage: Yes`);
  }

  return parts.join("\n");
}
