/**
 * Member dossier: written in one pass from facts, conversation summaries and real messages,
 * stored as JSON sections plus the rendered text (user_profiles.summary), regenerated whole
 * when stale. MBTI is derived from the Big Five relative to the server, never asked of the model.
 */

import { OmpRuntime } from "../../../ai/runtime/OmpRuntime";
import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { SLUR_PATTERN } from "../../user-personas/personaPrompt";
import { describeProfile, getAttentionProfile } from "../facts/attention";
import {
	type Connection,
	describeStrength,
	getConnections,
} from "../facts/closeness";
import { describeMemberFacts, getMemberFacts } from "../facts/memberFacts";
import {
	BIG_FIVE_TRAITS,
	type BigFiveTrait,
	type MbtiEstimate,
	type MemberDossier,
	type TraitEstimate,
} from "./types";

export const MIN_MESSAGES = 30;
export const STALE_AFTER_MESSAGES = 25;

const CONNECTION_LIMIT = 8;
const SUMMARY_LIMIT = 20;
const RECENT_MESSAGES = 40;
const POPULAR_MESSAGES = 20;
const POPULAR_WINDOW_DAYS = 180;
const MESSAGE_CHARS = 240;
const EVIDENCE_BUDGET = 8000;
const MIN_COMPARISON_MEMBERS = 5;
const Z_THRESHOLD = 0.3;

const SLURS = new RegExp(SLUR_PATTERN.source, "gi");
const scrub = (text: string): string => text.replace(SLURS, "[slur]");

export interface TraitStats {
	mean: number;
	sd: number;
	n: number;
}
export type GuildTraitStats = Record<BigFiveTrait, TraitStats>;

const SYSTEM_PROMPT = `You write private reference notes about one member of a Discord server, for the server's assistant bot to consult before it talks to or about them. Nobody else reads these notes.

Rules:
- Be specific and concrete. Quote real phrases from their messages. Name people by display name, never by user ID.
- No filler ("shows interest in...", "seems to enjoy..."), no moralizing, no flattery.
- State only what the evidence supports. If evidence is thin for a section, say so in that section instead of inventing.
- Never reproduce slurs; paraphrase or omit them.
- Dates are rough ("in October", "last week"), taken from the evidence.
- The measured facts are given to you for context and are stored alongside your notes; write what the facts can't say (meaning, character, specifics), don't recite them.`;

const TRAIT_PROPERTY = {
	type: "object",
	properties: {
		score: {
			type: "number",
			description:
				"0 to 1. Use the full range, relative to a typical Discord user (0.5 = typical); do not cluster near 0.5.",
		},
		confidence: {
			type: "number",
			description:
				"0 to 1. How well the messages support the score; lower it when messages are few, short or one-note.",
		},
		evidence: {
			type: "string",
			description:
				"One sentence citing what in their messages supports the score.",
		},
	},
	required: ["score", "confidence", "evidence"],
};

const SCHEMA = {
	type: "object" as const,
	properties: {
		identity: {
			type: "string",
			description:
				"Who they are in this community, 2-4 sentences: role, reputation, what they're known for, how they came across. Prose, no statistics (the measured facts are stored separately).",
		},
		voice: {
			type: "string",
			description:
				"How they write and talk as a reader would notice it: register, humour, catchphrases, how they address people, with 3-5 short quoted examples. Do not restate the measured percentages.",
		},
		interests: {
			type: "array",
			items: { type: "string" },
			description:
				"Specific things they care about, each a short concrete phrase (not 'gaming').",
		},
		people: {
			type: "string",
			description:
				"Who they are close to and how they relate to each, grounded in the connection list and conversations.",
		},
		recent: {
			type: "string",
			description:
				"What they have been up to lately, with rough dates: events in their life, things they did or said here. Prose, not a list of quotes.",
		},
		social_position: {
			type: "string",
			description:
				"Their place in the server's attention network, 3-5 sentences: who their attention goes to and who seeks them out, who they keep turning to without much return and who does that to them, whether their bids for attention get taken up, how they behave in groups (start and carry, respond, get left out), and whether what they give and receive is warm or cold. Concrete, name people; say so if the evidence is thin.",
		},
		personality: {
			type: "object",
			description: "Big Five estimates from their messages.",
			properties: Object.fromEntries(
				BIG_FIVE_TRAITS.map((trait) => [trait, TRAIT_PROPERTY]),
			),
			required: [...BIG_FIVE_TRAITS],
		},
	},
	required: [
		"identity",
		"voice",
		"interests",
		"people",
		"recent",
		"social_position",
		"personality",
	],
};

interface WrittenSections {
	identity: string;
	voice: string;
	interests: string[];
	people: string;
	recent: string;
	social_position?: string;
	personality: Record<BigFiveTrait, TraitEstimate>;
}

interface SummaryRow {
	summary: string;
	start_time: Date;
	channel: string | null;
}

interface MessageRow {
	id: string;
	content: string;
	created_at: Date;
	channel: string | null;
	replies: string;
}

const date = (value: Date): string =>
	new Date(value).toISOString().slice(0, 10);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

async function getNameMap(
	db: PostgreSQLManager,
	guildId: string,
): Promise<Map<string, string>> {
	const result = await db.query(
		`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
		FROM members WHERE guild_id = $1`,
		[guildId],
	);
	const rows: Array<{ user_id: string; name: string | null }> =
		result.success && result.data ? result.data : [];
	return new Map(rows.map((row) => [row.user_id, row.name ?? "someone"]));
}

async function getSummaries(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
): Promise<{ rows: SummaryRow[]; total: number }> {
	const [recent, total] = await Promise.all([
		db.query(
			`SELECT cs.summary, cs.start_time, c.name AS channel
			FROM conversation_segments cs LEFT JOIN channels c ON c.id = cs.channel_id
			WHERE cs.guild_id = $1 AND $2 = ANY(cs.participants) AND cs.summary IS NOT NULL
			ORDER BY cs.start_time DESC LIMIT $3`,
			[guildId, userId, SUMMARY_LIMIT],
		),
		db.query(
			`SELECT COUNT(*) AS n FROM conversation_segments
			WHERE guild_id = $1 AND $2 = ANY(participants) AND summary IS NOT NULL`,
			[guildId, userId],
		),
	]);
	const rows: SummaryRow[] = recent.success && recent.data ? recent.data : [];
	const count = total.success && total.data ? Number(total.data[0]?.n ?? 0) : 0;
	return { rows, total: count };
}

interface GroupEvidence {
	roles: { driver: number; responder: number; ignored: number };
	lines: string[];
}

const GROUP_NOTE_LIMIT = 10;
const GROUP_TONES_SHOWN = 3;
const GROUP_COUNTERPARTS = 3;

/** Role counts, tones given/received and recent conversation notes from stored dynamics */
async function getGroupEvidence(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
	names: Map<string, string>,
): Promise<GroupEvidence> {
	const [rolesResult, exchangesResult, notesResult] = await Promise.all([
		db.query(
			`SELECT COUNT(*)::int AS total,
				COUNT(*) FILTER (WHERE dynamics->'roles'->'drivers' @> to_jsonb($2::text))::int AS driver,
				COUNT(*) FILTER (WHERE dynamics->'roles'->'responders' @> to_jsonb($2::text))::int AS responder,
				COUNT(*) FILTER (WHERE dynamics->'roles'->'ignored' @> to_jsonb($2::text))::int AS ignored
			FROM conversation_segments
			WHERE guild_id = $1 AND dynamics IS NOT NULL AND $2 = ANY(participants)`,
			[guildId, userId],
		),
		db.query(
			`SELECT x.from_user, x.to_user, x.tone, COUNT(*)::int AS n
			FROM conversation_exchanges x
			JOIN conversation_segments s ON s.id = x.conversation_id
			WHERE s.guild_id = $1 AND x.source = 'model' AND (x.from_user = $2 OR x.to_user = $2)
			GROUP BY x.from_user, x.to_user, x.tone`,
			[guildId, userId],
		),
		db.query(
			`SELECT start_time, dynamics->>'note' AS note
			FROM conversation_segments
			WHERE guild_id = $1 AND dynamics IS NOT NULL AND $2 = ANY(participants)
				AND COALESCE(dynamics->>'note', '') <> ''
			ORDER BY start_time DESC LIMIT $3`,
			[guildId, userId, GROUP_NOTE_LIMIT],
		),
	]);

	const roleRow:
		| { total: number; driver: number; responder: number; ignored: number }
		| undefined =
		rolesResult.success && rolesResult.data ? rolesResult.data[0] : undefined;
	const roles = {
		driver: Number(roleRow?.driver ?? 0),
		responder: Number(roleRow?.responder ?? 0),
		ignored: Number(roleRow?.ignored ?? 0),
	};
	const total = Number(roleRow?.total ?? 0);

	const exchangeRows: Array<{
		from_user: string;
		to_user: string;
		tone: string;
		n: number;
	}> =
		exchangesResult.success && exchangesResult.data ? exchangesResult.data : [];
	const describeDirection = (given: boolean): string => {
		const tones = new Map<string, number>();
		const others = new Map<string, number>();
		for (const r of exchangeRows) {
			if ((r.from_user === userId) !== given) continue;
			const other = given ? r.to_user : r.from_user;
			tones.set(r.tone, (tones.get(r.tone) ?? 0) + r.n);
			others.set(other, (others.get(other) ?? 0) + r.n);
		}
		if (!tones.size) return "none recorded";
		const top = (
			m: Map<string, number>,
			k: number,
			label: (key: string) => string,
		) =>
			[...m.entries()]
				.sort((x, y) => y[1] - x[1])
				.slice(0, k)
				.map(([key, n]) => `${label(key)} ${n}`)
				.join(", ");
		const counterparts = top(
			others,
			GROUP_COUNTERPARTS,
			(id) => names.get(id) ?? "someone",
		);
		return `${top(tones, GROUP_TONES_SHOWN, (t) => t)}; ${given ? "mostly to" : "mostly from"}: ${counterparts}`;
	};

	const noteRows: Array<{ start_time: Date; note: string }> =
		notesResult.success && notesResult.data ? notesResult.data : [];
	const lines = [
		total
			? `Roles over ${total} summarized conversations: driver ${roles.driver}, responder ${roles.responder}, ignored ${roles.ignored}`
			: "Roles: no conversations with recorded dynamics yet",
		`Tones they give: ${describeDirection(true)}`,
		`Tones they receive: ${describeDirection(false)}`,
		noteRows.length
			? `Notes on their ${noteRows.length} most recent conversations:\n${noteRows
					.map((r) => `- ${date(r.start_time)} ${scrub(r.note)}`)
					.join("\n")}`
			: "Conversation notes: none yet",
	];
	return { roles, lines };
}

const SUBSTANTIVE = `length(trim(m.content)) > 0
	AND m.content !~ '^(m!|[!.$/-])\\w'
	AND m.content !~ '^<?https?://\\S+>?$'`;

/** 40 most recent substantive messages + 20 most replied-to of the last 180 days, chronological */
async function getMessageSample(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
	names: Map<string, string>,
): Promise<string[]> {
	const columns = `m.id, m.content, m.created_at, c.name AS channel,
		(SELECT COUNT(*) FROM messages r WHERE r.referenced_message_id = m.id AND r.guild_id = $1) AS replies`;
	const base = `FROM messages m LEFT JOIN channels c ON c.id = m.channel_id
		WHERE m.guild_id = $1 AND m.author_id = $2 AND m.active = true AND ${SUBSTANTIVE}`;
	const [recent, popular] = await Promise.all([
		db.query(`SELECT ${columns} ${base} ORDER BY m.created_at DESC LIMIT $3`, [
			guildId,
			userId,
			RECENT_MESSAGES,
		]),
		db.query(
			`SELECT * FROM (SELECT ${columns} ${base}
				AND m.created_at > NOW() - make_interval(days => $4)) t
			WHERE replies > 0 ORDER BY replies DESC, created_at DESC LIMIT $3`,
			[guildId, userId, POPULAR_MESSAGES, POPULAR_WINDOW_DAYS],
		),
	]);
	const byId = new Map<string, MessageRow>();
	for (const result of [recent, popular]) {
		const rows: MessageRow[] = result.success && result.data ? result.data : [];
		for (const row of rows) byId.set(row.id, row);
	}

	const lines: string[] = [];
	let budget = EVIDENCE_BUDGET;
	const ordered = [...byId.values()].sort(
		(a, b) =>
			new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
	);
	// Keep the newest messages when the budget runs out
	for (const row of ordered.reverse()) {
		const content = row.content
			.replace(
				/<@!?(\d+)>/g,
				(_, id: string) => `@${names.get(id) ?? "someone"}`,
			)
			.replace(/<a?:(\w+):\d+>/g, ":$1:")
			.replace(/\s+/g, " ")
			.trim();
		if (!content || SLUR_PATTERN.test(content)) continue;
		const clipped =
			content.length > MESSAGE_CHARS
				? `${content.slice(0, MESSAGE_CHARS)}…`
				: content;
		const line = `${date(row.created_at)} #${row.channel ?? "unknown"}: ${clipped}`;
		budget -= line.length + 1;
		if (budget < 0) break;
		lines.push(line);
	}
	return lines.reverse();
}

function describeConnections(connections: Connection[]): string[] {
	return connections.map(
		(connection) =>
			`- ${connection.name}: ${describeStrength(connection)}; they reach out to this member ${Math.round(connection.inbound)}, this member reaches out ${Math.round(connection.outbound)} (all time); ${connection.shared_conversations} shared conversations`,
	);
}

function buildPrompt(
	name: string,
	factLines: string[],
	connections: Connection[],
	summaries: SummaryRow[],
	sample: string[],
	groupLines: string[],
	attentionLines: string[],
): string {
	const sections = [
		`Write the dossier for ${name}.`,
		`MEASURED FACTS:\n${factLines.map((line) => `- ${line}`).join("\n")}`,
		connections.length
			? `CONNECTIONS (strongest first):\n${describeConnections(connections).join("\n")}`
			: "CONNECTIONS: none recorded.",
		summaries.length
			? `RECENT CONVERSATIONS THEY TOOK PART IN (newest first):\n${summaries
					.map(
						(row) =>
							`- ${date(row.start_time)} #${row.channel ?? "unknown"}: ${row.summary}`,
					)
					.join("\n")}`
			: "RECENT CONVERSATIONS: none summarized yet.",
		`MEASURED ATTENTION (who their attention goes to and comes from, who they pursue and who pursues them, how their bids land, warmth given and received; base "social_position" on this, and say so if the evidence is thin):\n${attentionLines.map((l) => `- ${l}`).join("\n") || "none measured yet"}`,
		`HOW THEY BEHAVE IN GROUP CONVERSATIONS (from conversation notes; use for their role in groups):\n${groupLines.join("\n")}`,
		`THEIR MESSAGES (oldest to newest; includes their most replied-to):\n${sample.join("\n")}`,
	];
	return sections.join("\n\n");
}

function normalizeTrait(raw: TraitEstimate | undefined): TraitEstimate {
	return {
		score: clamp01(Number(raw?.score ?? 0.5)),
		confidence: clamp01(Number(raw?.confidence ?? 0)),
		evidence: scrub(String(raw?.evidence ?? "").trim()),
	};
}

/** Server-relative MBTI from Big Five: z-scores against other members' stored scores */
export function deriveMbti(
	bigFive: Record<BigFiveTrait, TraitEstimate>,
	guildStats: GuildTraitStats,
): MbtiEstimate | null {
	const z = {} as Record<BigFiveTrait, number>;
	for (const trait of BIG_FIVE_TRAITS) {
		const stats = guildStats[trait];
		if (!stats || stats.n < MIN_COMPARISON_MEMBERS) return null;
		z[trait] = (bigFive[trait].score - stats.mean) / Math.max(stats.sd, 0.05);
	}
	const letter = (value: number, high: string, low: string): string =>
		Math.abs(value) < Z_THRESHOLD ? "X" : value > 0 ? high : low;
	const type =
		letter(z.extraversion, "E", "I") +
		letter(z.openness, "N", "S") +
		letter(z.agreeableness, "F", "T") +
		letter(z.conscientiousness, "J", "P");

	const used: BigFiveTrait[] = [
		"extraversion",
		"openness",
		"agreeableness",
		"conscientiousness",
	];
	const meanConfidence =
		used.reduce((sum, t) => sum + bigFive[t].confidence, 0) / used.length;
	const meanAbsZ =
		used.reduce((sum, t) => sum + Math.abs(z[t]), 0) / used.length;
	return {
		type,
		confidence: clamp01(meanConfidence * Math.min(1, meanAbsZ)),
		z_scores: z,
	};
}

/** Mean/sd/n of each Big Five score across other members' stored dossiers */
async function getGuildTraitStats(
	db: PostgreSQLManager,
	guildId: string,
	excludeUserId: string,
): Promise<GuildTraitStats> {
	const selects = BIG_FIVE_TRAITS.map(
		(
			trait,
		) => `AVG(s_${trait}) AS ${trait}_mean, COALESCE(STDDEV_POP(s_${trait}), 0) AS ${trait}_sd,
			COUNT(s_${trait}) AS ${trait}_n`,
	).join(",\n");
	const columns = BIG_FIVE_TRAITS.map(
		(trait) =>
			`(dossier->'personality'->'big_five'->'${trait}'->>'score')::float AS s_${trait}`,
	).join(", ");
	const result = await db.query(
		`SELECT ${selects} FROM (
			SELECT ${columns} FROM user_profiles
			WHERE guild_id = $1 AND user_id <> $2 AND dossier IS NOT NULL
		) t`,
		[guildId, excludeUserId],
	);
	const row: Record<string, string | null> =
		(result.success && result.data?.[0]) || {};
	const stats = {} as GuildTraitStats;
	for (const trait of BIG_FIVE_TRAITS) {
		stats[trait] = {
			mean: Number(row[`${trait}_mean`] ?? 0.5),
			sd: Number(row[`${trait}_sd`] ?? 0),
			n: Number(row[`${trait}_n`] ?? 0),
		};
	}
	return stats;
}

/** Rendered dossier text: what user_profiles.summary stores and tools show */
export function renderMemberDossier(d: MemberDossier): string {
	const traitLabel = (trait: BigFiveTrait): string =>
		trait.charAt(0).toUpperCase() + trait.slice(1);
	const traits = BIG_FIVE_TRAITS.map((trait) => {
		const t = d.personality.big_five[trait];
		return `${traitLabel(trait)} ${t.score.toFixed(1)} (confidence ${t.confidence.toFixed(1)}): ${t.evidence}`;
	});
	const mbti = d.personality.mbti
		? `MBTI: ${d.personality.mbti.type} (confidence ${d.personality.mbti.confidence.toFixed(1)})`
		: "MBTI: not enough comparison data";

	return [
		`Identity\n${d.identity}`,
		`Voice\n${d.voice}`,
		`Interests\n${d.interests.map((interest) => `- ${interest}`).join("\n")}`,
		`People\n${d.people}`,
		`Recent\n${d.recent}`,
		`Social position\n${d.social_position}`,
		`Personality\n${[...traits, mbti].join("\n")}`,
		`Facts\n${describeMemberFacts(d.facts)
			.map((line) => `- ${line}`)
			.join("\n")}`,
	].join("\n\n");
}

/**
 * Write (or rewrite) a member's dossier. Returns null when there isn't enough evidence;
 * throws when the model fails so the queue retries.
 */
export async function writeMemberDossier(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
	options: { store?: boolean } = {},
): Promise<MemberDossier | null> {
	const facts = await getMemberFacts(db, guildId, userId);
	if (!facts || facts.activity.messages < MIN_MESSAGES) return null;

	const [connections, summaries, names] = await Promise.all([
		getConnections(db, guildId, userId, CONNECTION_LIMIT),
		getSummaries(db, guildId, userId),
		getNameMap(db, guildId),
	]);
	const sample = await getMessageSample(db, guildId, userId, names);

	const groups = await getGroupEvidence(db, guildId, userId, names);
	const attention = await getAttentionProfile(db, guildId, userId);
	const prompt = buildPrompt(
		facts.name,
		describeMemberFacts(facts),
		connections,
		summaries.rows.map((row) => ({ ...row, summary: scrub(row.summary) })),
		sample,
		groups.lines,
		attention ? describeProfile(attention) : [],
	);
	const written = await OmpRuntime.get().generateStructured<WrittenSections>({
		systemPrompt: SYSTEM_PROMPT,
		prompt,
		schema: SCHEMA,
		label: "understanding.member",
	});
	if (!written)
		throw new Error(`Member dossier generation failed for ${facts.name}`);

	const bigFive = {} as Record<BigFiveTrait, TraitEstimate>;
	for (const trait of BIG_FIVE_TRAITS)
		bigFive[trait] = normalizeTrait(written.personality?.[trait]);
	const stats = await getGuildTraitStats(db, guildId, userId);

	const dossier: MemberDossier = {
		identity: scrub(String(written.identity).trim()),
		voice: scrub(String(written.voice).trim()),
		interests: (written.interests ?? [])
			.map((i) => scrub(String(i).trim()))
			.filter(Boolean),
		people: scrub(String(written.people).trim()),
		recent: scrub(String(written.recent).trim()),
		social_position: scrub(String(written.social_position ?? "").trim()),
		personality: { big_five: bigFive, mbti: deriveMbti(bigFive, stats) },
		facts,
		evidence: {
			messages: facts.activity.messages,
			conversations: summaries.total,
			sampled_messages: sample.length,
			roles: groups.roles,
			attention,
		},
		written_at: new Date().toISOString(),
	};
	if (options.store === false) return dossier;

	const stored = await db.query(
		`INSERT INTO user_profiles
			(guild_id, user_id, summary, dossier, dossier_written_at, dossier_message_count, dossier_conversation_count)
		VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
		ON CONFLICT (guild_id, user_id) DO UPDATE SET
			summary = EXCLUDED.summary,
			dossier = EXCLUDED.dossier,
			dossier_written_at = EXCLUDED.dossier_written_at,
			dossier_message_count = EXCLUDED.dossier_message_count,
			dossier_conversation_count = EXCLUDED.dossier_conversation_count,
			updated_at = NOW()`,
		[
			guildId,
			userId,
			renderMemberDossier(dossier),
			JSON.stringify(dossier),
			dossier.written_at,
			dossier.evidence.messages,
			dossier.evidence.conversations,
		],
	);
	if (!stored.success)
		throw new Error(`Failed to store dossier: ${stored.error}`);
	return dossier;
}

const STALE_SELECT = `
	WITH msg AS (
		SELECT author_id AS user_id, COUNT(*) AS n FROM messages
		WHERE guild_id = $1 AND active = true GROUP BY author_id
	),
	conv AS (
		SELECT p AS user_id, COUNT(*) AS n FROM conversation_segments cs, unnest(cs.participants) p
		WHERE cs.guild_id = $1 AND cs.summary IS NOT NULL GROUP BY p
	)
	SELECT mem.user_id,
		msg.n - COALESCE(up.dossier_message_count, 0) AS new_messages,
		COALESCE(conv.n, 0) - COALESCE(up.dossier_conversation_count, 0) AS new_conversations
	FROM members mem
	JOIN msg ON msg.user_id = mem.user_id
	LEFT JOIN conv ON conv.user_id = mem.user_id
	LEFT JOIN user_profiles up ON up.guild_id = $1 AND up.user_id = mem.user_id
	WHERE mem.guild_id = $1 AND mem.bot = false AND mem.active = true AND msg.n >= $2
		AND (up.dossier IS NULL
			OR msg.n - COALESCE(up.dossier_message_count, 0) >= $3
			OR COALESCE(conv.n, 0) > COALESCE(up.dossier_conversation_count, 0))`;

/** Members with enough messages whose dossier is missing or out of date, most new activity first */
export async function findStaleMembers(
	db: PostgreSQLManager,
	guildId: string,
	limit = 20,
): Promise<string[]> {
	const result = await db.query(
		`${STALE_SELECT} ORDER BY new_messages DESC, new_conversations DESC LIMIT $4`,
		[guildId, MIN_MESSAGES, STALE_AFTER_MESSAGES, limit],
	);
	const rows: Array<{ user_id: string }> =
		result.success && result.data ? result.data : [];
	return rows.map((row) => row.user_id);
}

/** True when the member qualifies for a dossier and has none, or theirs is out of date */
export async function isMemberStale(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
): Promise<boolean> {
	const result = await db.query(
		`SELECT * FROM (${STALE_SELECT}) s WHERE user_id = $4`,
		[guildId, MIN_MESSAGES, STALE_AFTER_MESSAGES, userId],
	);
	return Boolean(result.success && result.data && result.data.length > 0);
}
