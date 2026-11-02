/**
 * Real history between an active member persona and the people in the current turn
 * (the speaker, @mentioned members, members named in the message), so the persona's
 * feelings about someone come from what that member actually said, not a one-line summary.
 */

import type {
	PostgreSQLManager,
	UserPersonaData,
} from "../../database/PostgreSQLManager";
import { SLUR_PATTERN } from "./personaPrompt";

/** People to add history for per turn */
const MAX_PEOPLE = 3;
const MAX_CONVERSATIONS = 5;
const MAX_OWN_MESSAGES = 10;
const MAX_THEIR_MESSAGES = 5;
/** Messages pinging more people than this are group VC summons, not about the person */
const MAX_MENTIONS_PER_MESSAGE = 3;

interface MemberName {
	user_id: string;
	name: string;
	aliases: string[];
}

interface EdgeRow {
	from_persona: boolean;
	messages: number;
	mentions: number;
	replies: number;
	last_interaction: Date | null;
}

interface ConversationRow {
	start_time: Date;
	topic_label: string | null;
	summary: string;
}

interface MessageRow {
	content: string;
	created_at: Date;
}

export async function buildPersonaContext(
	db: PostgreSQLManager,
	guildId: string,
	persona: UserPersonaData,
	turn: { speakerId: string; content: string },
): Promise<string> {
	if (!db.isConnected()) return "";

	const members = await loadMemberNames(db, guildId);
	const byId = new Map(members.map((member) => [member.user_id, member]));
	const people = findPeople(members, persona.user_id, turn).slice(
		0,
		MAX_PEOPLE,
	);
	if (people.length === 0) return "";

	const sections = await Promise.all(
		people.map((personId) =>
			describeHistory(db, guildId, persona, personId, byId),
		),
	);
	return sections.filter(Boolean).join("\n\n");
}

async function loadMemberNames(
	db: PostgreSQLManager,
	guildId: string,
): Promise<MemberName[]> {
	const result = await db.query(
		`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name,
			ARRAY_REMOVE(ARRAY[nick, display_name, global_name, username], NULL) AS aliases
		FROM members WHERE guild_id = $1 AND bot = false`,
		[guildId],
	);
	return result.success && result.data ? result.data : [];
}

/** Speaker first, then @mentions, then members named in the text (whole-word, case-insensitive) */
function findPeople(
	members: MemberName[],
	personaId: string,
	turn: { speakerId: string; content: string },
): string[] {
	const found: string[] = [];
	const add = (id: string) => {
		if (id !== personaId && !found.includes(id)) found.push(id);
	};

	add(turn.speakerId);
	for (const match of turn.content.matchAll(/<@!?(\d+)>/g)) {
		if (match[1]) add(match[1]);
	}
	const text = turn.content.toLowerCase();
	for (const member of members) {
		const named = member.aliases.some((alias) => {
			const word = alias.toLowerCase();
			return (
				word.length >= 3 &&
				new RegExp(
					`(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}($|[^\\p{L}\\p{N}])`,
					"u",
				).test(text)
			);
		});
		if (named) add(member.user_id);
	}
	return found;
}

async function describeHistory(
	db: PostgreSQLManager,
	guildId: string,
	persona: UserPersonaData,
	personId: string,
	byId: Map<string, MemberName>,
): Promise<string> {
	const self = persona.display_name;
	const other = byId.get(personId);
	if (!other) return "";

	const [edges, profile, conversations, own, theirs] = await Promise.all([
		db.query(
			`SELECT user_a = $2 AS from_persona, msg_a_to_b AS messages, mentions, replies, last_interaction
			FROM relationship_edges
			WHERE guild_id = $1 AND ((user_a = $2 AND user_b = $3) OR (user_a = $3 AND user_b = $2))`,
			[guildId, persona.user_id, personId],
		),
		db.query(
			`SELECT summary FROM relationship_profiles
			WHERE guild_id = $1 AND user_a = LEAST($2, $3) AND user_b = GREATEST($2, $3) AND summary IS NOT NULL`,
			[guildId, persona.user_id, personId],
		),
		db.query(
			`SELECT start_time, topic_label, summary FROM conversation_segments
			WHERE guild_id = $1 AND $2 = ANY(participants) AND $3 = ANY(participants) AND summary IS NOT NULL
			ORDER BY start_time DESC LIMIT $4`,
			[guildId, persona.user_id, personId, MAX_CONVERSATIONS],
		),
		messagesAbout(db, guildId, persona.user_id, other, MAX_OWN_MESSAGES),
		messagesAbout(
			db,
			guildId,
			personId,
			byId.get(persona.user_id) ?? {
				user_id: persona.user_id,
				name: self,
				aliases: [self],
			},
			MAX_THEIR_MESSAGES,
		),
	]);

	const lines: string[] = [
		`What you (${self}) actually have with ${other.name} (<@${personId}>):`,
	];

	const edgeRows: EdgeRow[] = edges.success && edges.data ? edges.data : [];
	const outbound = edgeRows.find((row) => row.from_persona);
	const inbound = edgeRows.find((row) => !row.from_persona);
	if (outbound || inbound) {
		const last = edgeRows
			.map((row) => row.last_interaction)
			.filter((date): date is Date => date !== null)
			.sort((a, b) => b.getTime() - a.getTime())[0];
		lines.push(
			`- Interactions: you → them ${count(outbound)}; them → you ${count(inbound)}${last ? `; last ${formatDate(last)}` : ""}`,
		);
	}

	const profileRows: Array<{ summary: string }> =
		profile.success && profile.data ? profile.data : [];
	if (profileRows[0])
		lines.push(`- Relationship summary: ${maskSlurs(profileRows[0].summary)}`);

	const conversationRows: ConversationRow[] =
		conversations.success && conversations.data ? conversations.data : [];
	if (conversationRows.length) {
		lines.push("- Recent conversations together:");
		for (const row of conversationRows) {
			const topic = row.topic_label ? `[${row.topic_label}] ` : "";
			lines.push(
				`  - ${formatDate(row.start_time)} ${topic}${maskSlurs(row.summary)}`,
			);
		}
	}

	if (own.length) {
		lines.push(
			`- Things you said to or about ${other.name} (verbatim; your real take, don't repeat them):`,
		);
		lines.push(
			...own.map((message) => `  - ${resolveMentions(message, byId)}`),
		);
	}
	if (theirs.length) {
		lines.push(`- Things ${other.name} said to or about you:`);
		lines.push(
			...theirs.map((message) => `  - ${resolveMentions(message, byId)}`),
		);
	}

	return lines.length > 1 ? lines.join("\n") : "";
}

/** Recent messages by `authorId` that name, mention or reply to `subject` (no group pings, no slurs) */
async function messagesAbout(
	db: PostgreSQLManager,
	guildId: string,
	authorId: string,
	subject: MemberName,
	limit: number,
): Promise<string[]> {
	const namePatterns = subject.aliases
		.filter((alias) => alias.length >= 3)
		.map((alias) => `%${alias}%`);
	const result = await db.query(
		`SELECT m.content, m.created_at FROM messages m
		WHERE m.guild_id = $1 AND m.author_id = $2 AND length(trim(m.content)) >= 8
		AND (
			m.content LIKE '%<@' || $3 || '>%'
			OR m.content ILIKE ANY($4::text[])
			OR m.referenced_message_id IN (SELECT id FROM messages WHERE author_id = $3)
		)
		ORDER BY m.created_at DESC LIMIT $5`,
		[guildId, authorId, subject.user_id, namePatterns, limit * 4],
	);
	const rows: MessageRow[] = result.success && result.data ? result.data : [];
	return rows
		.filter(
			(row) =>
				(row.content.match(/<@!?\d+>/g)?.length ?? 0) <=
					MAX_MENTIONS_PER_MESSAGE &&
				!SLUR_PATTERN.test(row.content) &&
				hasWords(row.content),
		)
		.slice(0, limit)
		.reverse()
		.map(
			(row) =>
				`${formatDate(row.created_at)}: ${row.content.replace(/\s+/g, " ").slice(0, 200)}`,
		);
}

function count(row: EdgeRow | undefined): string {
	if (!row) return "none";
	return `${row.messages} messages, ${row.mentions} mentions, ${row.replies} replies`;
}

/** At least a few real words once mentions and links are removed (skips bare pings and link drops) */
function hasWords(text: string): boolean {
	const words = text
		.replace(/<[@#][!&]?\d+>/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.split(/\s+/)
		.filter((word) => /\p{L}{2}/u.test(word));
	return words.length >= 3;
}

/** Keep summaries' meaning without handing the model slur vocabulary */
function maskSlurs(text: string): string {
	return text.replace(new RegExp(SLUR_PATTERN.source, "gi"), "[slur]");
}

function resolveMentions(text: string, byId: Map<string, MemberName>): string {
	return text.replace(
		/<@!?(\d+)>/g,
		(_, id: string) => `@${byId.get(id)?.name ?? "someone"}`,
	);
}

function formatDate(date: Date): string {
	return new Date(date).toISOString().slice(0, 10);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
