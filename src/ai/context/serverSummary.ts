import type { PostgreSQLManager } from "../../database/PostgreSQLManager";

/** Max characters of server summary prepended to a conversation's first turn */
const MAX_PREFACE_CHARS = 300;

/**
 * "Server <name>: <summary>" for framing the first turn of a conversation, or "" if the guild
 * has no summary. This is the only context enrichment that reached prompts in the old engine.
 */
export async function getServerSummaryPreface(
	db: PostgreSQLManager,
	guildId: string,
): Promise<string> {
	if (!db.isConnected()) return "";
	const result = await db.query(
		"SELECT name, server_summary FROM guilds WHERE id = $1",
		[guildId],
	);
	const row:
		| { name: string | null; server_summary: string | null }
		| undefined = result.success ? result.data?.[0] : undefined;
	if (!row?.server_summary) return "";

	const text = `Server ${row.name || guildId}: ${row.server_summary}`;
	return text.length > MAX_PREFACE_CHARS
		? `${text.slice(0, MAX_PREFACE_CHARS - 3)}...`
		: text;
}
