/**
 * Pair dossiers: how two members relate, written in one pass from the closeness facts, the
 * summaries of conversations they shared and a sample of the messages between them.
 * Regenerated whole when enough new shared conversations have accumulated.
 */

import {
	type JsonObjectSchema,
	OmpRuntime,
} from "../../../ai/runtime/OmpRuntime";
import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { SLUR_PATTERN } from "../../user-personas/personaPrompt";
import {
	describeStrength,
	getGuildGraph,
	getPairFacts,
} from "../facts/closeness";
import type { PairDossier } from "./types";

export const MIN_SHARED_CONVERSATIONS = 3;
export const STALE_AFTER_CONVERSATIONS = 3;

const MAX_SUMMARIES = 20;
const MAX_MESSAGES = 40;
/** Candidate rows fetched before filtering noise down to MAX_MESSAGES */
const MESSAGE_FETCH = 160;
const MESSAGE_WINDOW_DAYS = 365;
const MAX_MENTIONS_PER_MESSAGE = 3;
const MAX_MESSAGE_CHARS = 240;
const EVIDENCE_CHAR_BUDGET = 8000;
const STALE_CANDIDATES = 60;

const SYSTEM_PROMPT = `You write private reference notes about the relationship between two members of a Discord server. The notes are read only by the server's assistant bot, which uses them to talk about these people accurately.

Rules:
- Be specific and concrete. Quote real phrases from the messages. Say what they actually do together, not that they "interact" or "show interest in" things.
- Name people by display name. Never write user IDs or <@...> mentions.
- Ground every claim in the facts, conversation summaries or messages given. If the evidence for a section is thin, say so in that section instead of inventing.
- Describe the tone as it is (teasing, warm, prickly, businesslike, ...) with a quoted example where possible. No moralizing, no advice, no filler.
- Never reproduce slurs; refer to them as "a slur" if it matters.
- Never quote a message that contains "[slur]" or that uses "gay" or "retard" as an insult; paraphrase it instead.
- Write plain prose. No headings, no bullet lists.`;

const SCHEMA: JsonObjectSchema = {
	type: "object",
	properties: {
		dynamic: {
			type: "string",
			description:
				"How the two relate: what they do together, who reaches out more or drives the exchange, what the relationship is built on. 2-4 sentences, concrete.",
		},
		history: {
			type: "string",
			description:
				"Notable shared history: running jokes, projects, arguments, events. Dated where the evidence gives a date. If little is known, say so briefly.",
		},
		tone: {
			type: "string",
			description:
				"The tone between them (teasing, supportive, prickly, ...), with a short quoted phrase from the messages as evidence.",
		},
	},
	required: ["dynamic", "history", "tone"] as string[],
};

interface SharedSummary {
	start_time: Date;
	channel_name: string | null;
	topic_label: string | null;
	summary: string;
}

interface MessageRow {
	author_id: string;
	content: string;
	created_at: Date;
	channel_name: string | null;
}

function normalize(userA: string, userB: string): [string, string] {
	return userA < userB ? [userA, userB] : [userB, userA];
}

function maskSlurs(text: string): string {
	return text.replace(new RegExp(SLUR_PATTERN.source, "gi"), "[slur]");
}

function formatDate(date: Date): string {
	return new Date(date).toISOString().slice(0, 10);
}

function rows<T>(result: { success: boolean; data?: unknown }): T[] {
	return result.success && Array.isArray(result.data)
		? (result.data as T[])
		: [];
}

async function loadNames(
	db: PostgreSQLManager,
	guildId: string,
	ids: string[],
): Promise<Map<string, string>> {
	const result = await db.query(
		`SELECT user_id, COALESCE(nick, display_name, global_name, username, user_id) AS name
		FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
		[guildId, ids],
	);
	const names = new Map<string, string>();
	for (const row of rows<{ user_id: string; name: string }>(result)) {
		names.set(row.user_id, row.name);
	}
	return names;
}

async function countShared(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
): Promise<number> {
	const result = await db.query(
		`SELECT COUNT(*)::int AS n FROM conversation_segments
		WHERE guild_id = $1 AND participants @> ARRAY[$2, $3]::text[] AND summary IS NOT NULL`,
		[guildId, a, b],
	);
	return rows<{ n: number }>(result)[0]?.n ?? 0;
}

async function loadSharedSummaries(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
): Promise<SharedSummary[]> {
	const result = await db.query(
		`SELECT s.start_time, s.topic_label, s.summary, c.name AS channel_name
		FROM conversation_segments s
		LEFT JOIN channels c ON c.id = s.channel_id
		WHERE s.guild_id = $1 AND s.participants @> ARRAY[$2, $3]::text[] AND s.summary IS NOT NULL
		ORDER BY s.start_time DESC LIMIT $4`,
		[guildId, a, b, MAX_SUMMARIES],
	);
	return rows<SharedSummary>(result);
}

/** Messages by either that reply to or @mention the other, newest first before filtering */
async function loadMessages(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
): Promise<MessageRow[]> {
	const result = await db.query(
		`SELECT m.author_id, m.content, m.created_at, c.name AS channel_name
		FROM messages m
		LEFT JOIN messages r ON r.id = m.referenced_message_id
		LEFT JOIN channels c ON c.id = m.channel_id
		WHERE m.guild_id = $1
			AND m.author_id IN ($2, $3)
			AND COALESCE(m.active, TRUE)
			AND m.created_at > NOW() - make_interval(days => $4)
			AND m.content IS NOT NULL AND m.content <> ''
			AND (
				r.author_id = CASE WHEN m.author_id = $2 THEN $3 ELSE $2 END
				OR (
					m.content LIKE '%<@' || CASE WHEN m.author_id = $2 THEN $3 ELSE $2 END || '>%'
					OR m.content LIKE '%<@!' || CASE WHEN m.author_id = $2 THEN $3 ELSE $2 END || '>%'
				)
			)
			AND cardinality(regexp_split_to_array(m.content, '<@!?[0-9]+>')) - 1 <= $5
		ORDER BY m.created_at DESC LIMIT $6`,
		[
			guildId,
			a,
			b,
			MESSAGE_WINDOW_DAYS,
			MAX_MENTIONS_PER_MESSAGE,
			MESSAGE_FETCH,
		],
	);
	return rows<MessageRow>(result);
}

const COMMAND_PATTERN = /^[m!.$/-]\w/;

function isUsable(content: string): boolean {
	const text = content.trim();
	if (!text || COMMAND_PATTERN.test(text)) return false;
	const withoutLinks = text.replace(/https?:\/\/\S+/g, "").trim();
	return withoutLinks.length > 0;
}

function resolveMentions(text: string, names: Map<string, string>): string {
	return text.replace(
		/<@!?(\d+)>/g,
		(_, id: string) => `@${names.get(id) ?? "someone"}`,
	);
}

function formatMessage(row: MessageRow, names: Map<string, string>): string {
	const content = maskSlurs(
		resolveMentions(row.content.replace(/\s+/g, " ").trim(), names),
	);
	const clipped =
		content.length > MAX_MESSAGE_CHARS
			? `${content.slice(0, MAX_MESSAGE_CHARS)}…`
			: content;
	const author = names.get(row.author_id) ?? "someone";
	return `${formatDate(row.created_at)} #${row.channel_name ?? "unknown"} ${author}: ${clipped}`;
}

export async function writePairDossier(
	db: PostgreSQLManager,
	guildId: string,
	userA: string,
	userB: string,
): Promise<PairDossier | null> {
	const [a, b] = normalize(userA, userB);
	if (a === b) return null;

	const facts = await getPairFacts(db, guildId, a, b);
	if (!facts) return null;

	const shared = await countShared(db, guildId, a, b);
	if (shared < MIN_SHARED_CONVERSATIONS) return null;

	const [summaries, candidates] = await Promise.all([
		loadSharedSummaries(db, guildId, a, b),
		loadMessages(db, guildId, a, b),
	]);

	// Names for the pair plus anyone @mentioned in the sampled messages
	const mentioned = new Set<string>([a, b]);
	for (const row of candidates) {
		for (const match of row.content.matchAll(/<@!?(\d+)>/g))
			if (match[1]) mentioned.add(match[1]);
	}
	const names = await loadNames(db, guildId, [...mentioned]);
	const nameA = names.get(a) ?? "Member A";
	const nameB = names.get(b) ?? facts.name;

	const sample = candidates
		.filter((row) => isUsable(row.content))
		.slice(0, MAX_MESSAGES);
	sample.reverse();

	const summaryLines = summaries.map((s) => {
		const topic = s.topic_label ? `[${s.topic_label}] ` : "";
		return `${formatDate(s.start_time)} #${s.channel_name ?? "unknown"} ${topic}${maskSlurs(s.summary)}`;
	});
	const messageLines = sample.map((row) => formatMessage(row, names));

	// Keep the evidence near the budget: trim oldest messages first, then oldest summaries
	let summaryBlock = summaryLines.join("\n");
	let messageBlock = messageLines.join("\n");
	while (
		summaryBlock.length + messageBlock.length > EVIDENCE_CHAR_BUDGET &&
		messageLines.length > 10
	) {
		messageLines.shift();
		messageBlock = messageLines.join("\n");
	}
	while (
		summaryBlock.length + messageBlock.length > EVIDENCE_CHAR_BUDGET &&
		summaryLines.length > 5
	) {
		summaryLines.pop();
		summaryBlock = summaryLines.join("\n");
	}

	const factLines = [
		`${describeStrength(facts)}`,
		`${nameA} → ${nameB}: ${facts.a_to_b.replies} replies, ${facts.a_to_b.mentions} mentions`,
		`${nameB} → ${nameA}: ${facts.b_to_a.replies} replies, ${facts.b_to_a.mentions} mentions`,
		`${shared} summarized shared conversations; last interaction ${formatDate(facts.last_interaction)}`,
	];

	const prompt = `Write the notes on the relationship between ${nameA} and ${nameB}.

Measured facts:
${factLines.map((line) => `- ${line}`).join("\n")}

Shared conversation summaries (${shared} in total, newest ${summaryLines.length} shown):
${summaryBlock || "(none)"}

Messages between them, oldest first (${messageLines.length} sampled):
${messageBlock || "(none sampled)"}`;

	const sections = await OmpRuntime.get().generateStructured<{
		dynamic: string;
		history: string;
		tone: string;
	}>({
		systemPrompt: SYSTEM_PROMPT,
		prompt,
		schema: SCHEMA,
		label: "understanding.pair",
	});
	if (!sections) {
		throw new Error(
			`Pair dossier model call failed for ${a}/${b} in guild ${guildId}`,
		);
	}

	const dossier: PairDossier = {
		dynamic: sections.dynamic.trim(),
		history: sections.history.trim(),
		tone: sections.tone.trim(),
		facts,
		evidence: {
			shared_conversations: shared,
			sampled_messages: messageLines.length,
		},
		written_at: new Date().toISOString(),
	};

	const stored = await db.query(
		`INSERT INTO pair_dossiers (guild_id, user_a, user_b, dossier, summary, written_at, shared_conversation_count)
		VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), $6)
		ON CONFLICT (guild_id, user_a, user_b) DO UPDATE SET
			dossier = EXCLUDED.dossier,
			summary = EXCLUDED.summary,
			written_at = NOW(),
			shared_conversation_count = EXCLUDED.shared_conversation_count`,
		[
			guildId,
			a,
			b,
			JSON.stringify(dossier),
			renderPairDossier(dossier, nameA, nameB),
			shared,
		],
	);
	if (!stored.success) {
		throw new Error(`Failed to store pair dossier: ${stored.error}`);
	}
	return dossier;
}

export function renderPairDossier(
	d: PairDossier,
	nameA: string,
	nameB: string,
): string {
	const balance = d.facts.reciprocity >= 0.67 ? ", both reach out" : "";
	return [
		`${nameA} & ${nameB}: ${describeStrength(d.facts)}${balance}`,
		`Dynamic: ${d.dynamic}`,
		`History: ${d.history}`,
		`Tone: ${d.tone}`,
	].join("\n");
}

/** Closest pairs whose dossier is missing or has fallen behind their shared conversations */
export async function findStalePairs(
	db: PostgreSQLManager,
	guildId: string,
	limit = 20,
): Promise<Array<[string, string]>> {
	const [graph, memberResult] = await Promise.all([
		getGuildGraph(db, guildId),
		db.query(
			"SELECT user_id FROM members WHERE guild_id = $1 AND active IS NOT FALSE AND bot IS NOT TRUE",
			[guildId],
		),
	]);
	const eligible = new Set(
		rows<{ user_id: string }>(memberResult).map((row) => row.user_id),
	);
	const candidates = graph
		.filter((edge) => eligible.has(edge.a) && eligible.has(edge.b))
		.slice(0, STALE_CANDIDATES);
	if (!candidates.length) return [];

	const result = await db.query(
		`SELECT p.a, p.b, p.ord,
			(SELECT COUNT(*) FROM conversation_segments s
				WHERE s.guild_id = $1 AND s.summary IS NOT NULL AND s.participants @> ARRAY[p.a, p.b]::text[]
			)::int AS shared,
			d.shared_conversation_count AS written_count
		FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS p(a, b, ord)
		LEFT JOIN pair_dossiers d ON d.guild_id = $1 AND d.user_a = p.a AND d.user_b = p.b
		ORDER BY p.ord`,
		[
			guildId,
			candidates.map((edge) => edge.a),
			candidates.map((edge) => edge.b),
		],
	);

	const stale: Array<[string, string]> = [];
	for (const row of rows<{
		a: string;
		b: string;
		shared: number;
		written_count: number | null;
	}>(result)) {
		if (row.shared < MIN_SHARED_CONVERSATIONS) continue;
		if (
			row.written_count === null ||
			row.shared - row.written_count >= STALE_AFTER_CONVERSATIONS
		) {
			stale.push([row.a, row.b]);
			if (stale.length >= limit) break;
		}
	}
	return stale;
}

export async function getPairDossier(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
): Promise<{ dossier: PairDossier; summary: string } | null> {
	const [userA, userB] = normalize(a, b);
	const result = await db.query(
		`SELECT dossier, summary FROM pair_dossiers
		WHERE guild_id = $1 AND user_a = $2 AND user_b = $3 AND dossier IS NOT NULL AND summary IS NOT NULL`,
		[guildId, userA, userB],
	);
	const row = rows<{ dossier: PairDossier; summary: string }>(result)[0];
	return row ? { dossier: row.dossier, summary: row.summary } : null;
}
