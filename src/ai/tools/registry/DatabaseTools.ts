import {
  PostgreSQLManager,
  type MemberData,
  type UserProfileData,
} from "../../../database/PostgreSQLManager";
import type {
  ConversationEntry,
  RelationshipEntry,
} from "../../../features/social-intelligence/types";
import type { AIEngine } from "../../core/AIEngine";

/**
 * Context passed to tool execution functions
 */
export interface ToolContext {
  userId: string; // Requesting user ID
  guildId: string; // Current guild ID
  db: PostgreSQLManager; // Database connection
  aiEngine?: AIEngine; // AI engine (for tools that need to make AI calls)
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
 * Registry for database tools available to AI
 */
export class DatabaseTools {
  private tools: Map<string, DatabaseTool> = new Map();

  /**
   * Register a tool in the registry
   */
  registerTool(tool: DatabaseTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once
   */
  registerTools(tools: DatabaseTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): DatabaseTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): DatabaseTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Execute a tool with given parameters and context
   */
  async executeTool(
    name: string,
    params: Record<string, any>,
    context: ToolContext
  ): Promise<string | DatabaseToolResult> {
    const tool = this.getTool(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found`,
      };
    }

    try {
      // Validate required parameters
      for (const requiredParam of tool.parameters.required) {
        if (
          params[requiredParam] === undefined ||
          params[requiredParam] === null
        ) {
          return {
            success: false,
            error: `Missing required parameter: ${requiredParam}`,
          };
        }
      }

      // Security: Validate guild access
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required for database tools",
        };
      }

      if (!context.db.isConnected()) {
        return {
          success: false,
          error: "Database not connected",
        };
      }

      // Security: Sanitize string inputs to prevent injection
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === "string" && value.length > 1000) {
          return {
            success: false,
            error: `Parameter ${key} exceeds maximum length`,
          };
        }
        // Additional sanitization could be added here if needed
      }

      const result = await tool.execute(params, context);

      // Ensure error messages are AI-friendly and don't leak sensitive data
      if (typeof result === "object" && "error" in result && result.error) {
        // Sanitize error messages
        const errorMsg = result.error.toLowerCase();
        if (
          errorMsg.includes("sql") ||
          errorMsg.includes("database") ||
          errorMsg.includes("connection")
        ) {
          return {
            success: false,
            error:
              "Unable to retrieve information from the database. The requested data may not be available.",
          };
        }
      }

      return result;
    } catch (error) {
      console.error(`🔸 Error executing tool ${name}:`, error);
      return {
        success: false,
        error:
          "An error occurred while processing your request. Please try again later.",
      };
    }
  }

  /**
   * Convert tools to OpenAI function calling format
   */
  toOpenAIFunctions(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: any;
    };
  }> {
    return this.getAllTools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Convert tools to Grok function calling format
   */
  toGrokFunctions(): Array<{
    name: string;
    description: string;
    parameters: any;
  }> {
    return this.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Convert tools to Gemini function calling format
   */
  toGeminiFunctions(): Array<{
    name: string;
    description: string;
    parameters: any;
  }> {
    return this.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
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
