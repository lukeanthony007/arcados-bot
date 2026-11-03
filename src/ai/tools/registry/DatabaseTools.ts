import {
  PostgreSQLManager,
  type MemberData,
  type UserProfileData,
} from "../../../database/PostgreSQLManager";
import {
  type Connection,
  describeStrength,
} from "../../../features/social-intelligence/facts/closeness";

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
 * The AI-generated summary lives in user_profiles, not on the members row,
 * so it is passed in separately.
 */
export function formatUserInfo(
  member: MemberData,
  profile?: Pick<UserProfileData, "summary"> | null
): string {
  const parts: string[] = [];
  parts.push(`User: ${member.display_name} (@${member.username})`);

  if (member.global_name) {
    parts.push(`Global name: ${member.global_name}`);
  }

  if (profile?.summary) {
    parts.push(`Summary: ${profile.summary}`);
  }

  parts.push(`Joined: ${new Date(member.joined_at).toLocaleDateString()}`);
  parts.push(`Roles: ${member.roles?.length || 0}`);
  parts.push(`Active: ${member.active ? "Yes" : "No"}`);

  return parts.join("\n");
}

/**
 * Format one connection for AI consumption. `share` is the fraction of the subject's
 * interactions that go to this person; reciprocity 1 = balanced, 0 = one-sided.
 */
export function formatConnection(conn: Connection): string {
  const lastSeen = new Date(conn.last_interaction).toLocaleDateString();
  return `${conn.name}: ${describeStrength(conn)} (${(conn.share * 100).toFixed(0)}% of their interactions, ${(conn.reciprocity * 100).toFixed(0)}% reciprocal; ${conn.replies} replies, ${conn.mentions} mentions, ${conn.turns} inferred addressed turns, ${conn.shared_conversations} shared conversations; last ${lastSeen})`;
}

/**
 * Resolve a user identifier (ID or name) to a Discord user ID.
 * If the input is already a Discord ID (numeric, 17-19 digits), returns it as-is.
 * Otherwise, searches for the user by name and returns their ID.
 */
export async function resolveUserId(
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

  // Fuzzy fallback for nicknames and misspellings ("kelz" → "Kelsszz & Tip"), using the
  // best trigram word similarity across every name the member has had
  const fuzzy = await db.query(
    `SELECT m.user_id, m.display_name, m.active,
       GREATEST(
         word_similarity($2, LOWER(m.display_name)),
         word_similarity($2, LOWER(m.username)),
         word_similarity($2, LOWER(COALESCE(m.global_name, ''))),
         word_similarity($2, LOWER(COALESCE(m.nick, ''))),
         COALESCE((SELECT MAX(word_similarity($2, LOWER(a))) FROM unnest(p.aliases) a), 0)
       ) AS score
     FROM members m
     LEFT JOIN user_profiles p ON p.guild_id = m.guild_id AND p.user_id = m.user_id
     WHERE m.guild_id = $1 AND m.bot = false
     ORDER BY score DESC, m.active DESC
     LIMIT 2`,
    [guildId, identifier.toLowerCase()]
  );
  const candidates: Array<{ user_id: string; display_name: string; score: number }> =
    fuzzy.success && fuzzy.data ? fuzzy.data : [];
  const [best, next] = candidates;
  if (best && best.score >= 0.5) {
    if (next && next.score >= best.score - 0.1) {
      return {
        success: false,
        error: `"${identifier}" is ambiguous: could be ${best.display_name} or ${next.display_name}. Use the exact name or ID.`,
      };
    }
    return { success: true, userId: best.user_id };
  }

  return {
    success: false,
    error: `User "${identifier}" not found in this server. Try using searchUsers to find users by name.`,
  };
}
