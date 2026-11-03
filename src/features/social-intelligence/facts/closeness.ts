/**
 * Closeness: the one definition of how much two members interact.
 *
 * Computed on demand from `messages` and `conversation_segments` (complete history), never
 * stored, so it can't drift. An interaction is one of:
 *
 *   reply         a replied to b's message                          3 points, a → b
 *   mention       a mentioned b directly (message pings ≤ 3 people) 2 points, a → b
 *   turn          a's unaddressed messages were attended to b          1 point per unit of
 *                 (episode_attention mass minus its explicit part, which   attention, a → b
 *                 replies/mentions already count; conversations/attention.ts
 *                 infers it from recent speakers, continuations, past affinity)
 *   conversation  a and b took part in the same conversation         1 point, both directions
 *   reaction      a reacted to b's message (recorded live from now on) 1 point, a → b
 *
 * Closeness is the whole history: a friendship is what two people have built, and going quiet
 * doesn't undo it. How recent it is is reported separately (`last_interaction`, and whether
 * the other person is still in the server), never folded into the strength. For a pair:
 *
 *   strength    = points a→b + points b→a
 *   reciprocity = min(a→b, b→a) / max(a→b, b→a)   (1 = balanced, 0 = one-sided)
 *   share       = strength / Σ strength over all of a's pairs   ("x% of a's interactions")
 *
 * Group pings (> 3 mentions) and bots are excluded.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";

/** Not talking for this long is worth saying, even about a close pair */
export const QUIET_AFTER_DAYS = 90;
const MAX_MENTIONS_PER_MESSAGE = 3;
const WEIGHTS = {
	reply: 3,
	mention: 2,
	turn: 1,
	reaction: 1,
	conversation: 1,
} as const;

export interface Connection {
	user_id: string;
	name: string;
	/** Interaction points, both directions, all time */
	strength: number;
	/** Fraction of the subject's total strength (0-1) */
	share: number;
	/** 1 = balanced, 0 = entirely one-sided */
	reciprocity: number;
	/** Points subject → other and other → subject */
	outbound: number;
	inbound: number;
	/** Whether the other person is still in the server */
	present: boolean;
	/** Raw counts, all time */
	replies: number;
	mentions: number;
	/** Inferred attention mass from the subject to others' unaddressed messages (1 decimal), all time */
	inferred_attention: number;
	shared_conversations: number;
	last_interaction: Date;
}

export interface PairFacts extends Connection {
	/** Raw counts in each direction */
	a_to_b: { replies: number; mentions: number; inferred_attention: number };
	b_to_a: { replies: number; mentions: number; inferred_attention: number };
}

export interface GraphEdge {
	a: string;
	b: string;
	strength: number;
	reciprocity: number;
}

interface PairRow {
	user_id: string;
	name: string;
	strength: string;
	outbound: string;
	inbound: string;
	replies: string;
	mentions: string;
	turns: string;
	shared_conversations: string;
	out_replies: string;
	out_mentions: string;
	out_turns: string;
	in_replies: string;
	in_mentions: string;
	in_turns: string;
	last_interaction: Date;
	present: boolean | null;
}

/**
 * Directed interaction events (a, b, kind, ts) for a guild. `subjectFilter` narrows to events
 * involving one member (bound as $2) so per-member queries stay fast.
 */
function eventsCte(subjectFilter: boolean): string {
	const involves = subjectFilter ? "AND ($2 IN (e.a, e.b))" : "";
	return `
		msgs AS (
			SELECT m.id, m.author_id, m.content, m.created_at, m.referenced_message_id
			FROM messages m
			JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
			WHERE m.guild_id = $1 AND m.active = true
		),
		events AS (
			SELECT * FROM (
				SELECT m.author_id AS a, p.author_id AS b, 'reply' AS kind, m.created_at AS ts, 1 AS n
				FROM msgs m JOIN msgs p ON p.id = m.referenced_message_id
				WHERE p.author_id <> m.author_id
				UNION ALL
				SELECT m.author_id, t.target, 'mention', m.created_at, 1
				FROM msgs m
				CROSS JOIN LATERAL (
					SELECT DISTINCT (regexp_matches(m.content, '<@!?(\\d+)>', 'g'))[1] AS target
				) t
				JOIN members tm ON tm.guild_id = $1 AND tm.user_id = t.target AND tm.bot = false
				WHERE m.content LIKE '%<@%'
				AND array_length(regexp_split_to_array(m.content, '<@'), 1) <= ${MAX_MENTIONS_PER_MESSAGE + 1}
				AND t.target <> m.author_id
				UNION ALL
				SELECT x.from_user, x.to_user, 'turn', cs.start_time, x.mass - x.explicit_mass
				FROM episode_attention x
				JOIN conversation_segments cs ON cs.id = x.conversation_id
				WHERE cs.guild_id = $1 AND x.mass - x.explicit_mass > 0.001
				UNION ALL
				SELECT p1.id, p2.id, 'conversation', cs.start_time, 1
				FROM conversation_segments cs
				CROSS JOIN LATERAL unnest(cs.participants) AS p1(id)
				CROSS JOIN LATERAL unnest(cs.participants) AS p2(id)
				WHERE cs.guild_id = $1 AND p1.id <> p2.id
				UNION ALL
				SELECT r.user_id, r.author_id, 'reaction', r.created_at, 1
				FROM message_reactions r
				JOIN members rm ON rm.guild_id = r.guild_id AND rm.user_id = r.user_id AND rm.bot = false
				WHERE r.guild_id = $1 AND r.user_id <> r.author_id
			) e
			WHERE true ${involves}
		),
		weighted AS (
			SELECT a, b, kind, ts, n,
				n * CASE kind
					WHEN 'reply' THEN ${WEIGHTS.reply}
					WHEN 'mention' THEN ${WEIGHTS.mention}
					WHEN 'turn' THEN ${WEIGHTS.turn}
					WHEN 'reaction' THEN ${WEIGHTS.reaction}
					ELSE ${WEIGHTS.conversation} END AS w
			FROM events
		)`;
}

/** Per-pair aggregate from the subject's point of view ($2 = subject) */
const PAIR_SELECT = `
	SELECT o.user_id,
		COALESCE(mem.nick, mem.display_name, mem.global_name, mem.username, o.user_id) AS name,
		SUM(w.w) AS strength,
		SUM(w.w) FILTER (WHERE w.a = $2) AS outbound,
		SUM(w.w) FILTER (WHERE w.b = $2) AS inbound,
		COUNT(*) FILTER (WHERE w.kind = 'reply') AS replies,
		COUNT(*) FILTER (WHERE w.kind = 'mention') AS mentions,
		COALESCE(SUM(w.n) FILTER (WHERE w.kind = 'turn'), 0) AS turns,
		COUNT(*) FILTER (WHERE w.kind = 'conversation' AND w.a = $2) AS shared_conversations,
		COUNT(*) FILTER (WHERE w.kind = 'reply' AND w.a = $2) AS out_replies,
		COUNT(*) FILTER (WHERE w.kind = 'mention' AND w.a = $2) AS out_mentions,
		COALESCE(SUM(w.n) FILTER (WHERE w.kind = 'turn' AND w.a = $2), 0) AS out_turns,
		COUNT(*) FILTER (WHERE w.kind = 'reply' AND w.b = $2) AS in_replies,
		COUNT(*) FILTER (WHERE w.kind = 'mention' AND w.b = $2) AS in_mentions,
		COALESCE(SUM(w.n) FILTER (WHERE w.kind = 'turn' AND w.b = $2), 0) AS in_turns,
		MAX(w.ts) AS last_interaction,
		COALESCE(mem.active, false) AS present
	FROM weighted w
	CROSS JOIN LATERAL (SELECT CASE WHEN w.a = $2 THEN w.b ELSE w.a END AS user_id) o
	LEFT JOIN members mem ON mem.guild_id = $1 AND mem.user_id = o.user_id`;

function toConnection(row: PairRow, totalStrength: number): Connection {
	const outbound = Number(row.outbound ?? 0);
	const inbound = Number(row.inbound ?? 0);
	const strength = Number(row.strength);
	return {
		user_id: row.user_id,
		name: row.name,
		strength,
		share: totalStrength > 0 ? strength / totalStrength : 0,
		reciprocity: reciprocity(outbound, inbound),
		outbound,
		inbound,
		present: row.present === true,
		replies: Number(row.replies),
		mentions: Number(row.mentions),
		inferred_attention: round1(Number(row.turns)),
		shared_conversations: Number(row.shared_conversations),
		last_interaction: new Date(row.last_interaction),
	};
}

function reciprocity(outbound: number, inbound: number): number {
	const max = Math.max(outbound, inbound);
	return max > 0 ? Math.min(outbound, inbound) / max : 0;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** A member's connections, strongest first */
export async function getConnections(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
	limit = 10,
): Promise<Connection[]> {
	const result = await db.query(
		`WITH ${eventsCte(true)}, pairs AS (${PAIR_SELECT} GROUP BY o.user_id, mem.nick, mem.display_name, mem.global_name, mem.username, mem.active)
		SELECT p.*, SUM(p.strength) OVER () AS total_strength
		FROM pairs p ORDER BY p.strength DESC LIMIT $3`,
		[guildId, userId, limit],
	);
	const rows: Array<PairRow & { total_strength: string }> =
		result.success && result.data ? result.data : [];
	return rows.map((row) => toConnection(row, Number(row.total_strength)));
}

/** Everything the facts say about one pair, from `userA`'s point of view; null if they never interacted */
export async function getPairFacts(
	db: PostgreSQLManager,
	guildId: string,
	userA: string,
	userB: string,
): Promise<PairFacts | null> {
	const result = await db.query(
		`WITH ${eventsCte(true)}, pairs AS (${PAIR_SELECT} GROUP BY o.user_id, mem.nick, mem.display_name, mem.global_name, mem.username, mem.active)
		SELECT p.*, SUM(p.strength) OVER () AS total_strength FROM pairs p`,
		[guildId, userA],
	);
	const rows: Array<PairRow & { total_strength: string }> =
		result.success && result.data ? result.data : [];
	const row = rows.find((candidate) => candidate.user_id === userB);
	if (!row) return null;
	return {
		...toConnection(row, Number(row.total_strength)),
		a_to_b: {
			replies: Number(row.out_replies),
			mentions: Number(row.out_mentions),
			inferred_attention: round1(Number(row.out_turns)),
		},
		b_to_a: {
			replies: Number(row.in_replies),
			mentions: Number(row.in_mentions),
			inferred_attention: round1(Number(row.in_turns)),
		},
	};
}

/** Every pair in the guild with any interaction (undirected), strongest first */
export async function getGuildGraph(
	db: PostgreSQLManager,
	guildId: string,
): Promise<GraphEdge[]> {
	const result = await db.query(
		`WITH ${eventsCte(false)}
		SELECT LEAST(a, b) AS a, GREATEST(a, b) AS b,
			SUM(w) AS strength,
			SUM(w) FILTER (WHERE a < b) AS forward,
			SUM(w) FILTER (WHERE a > b) AS backward
		FROM weighted
		GROUP BY LEAST(a, b), GREATEST(a, b)
		ORDER BY strength DESC`,
		[guildId],
	);
	const rows: Array<{
		a: string;
		b: string;
		strength: string;
		forward: string | null;
		backward: string | null;
	}> = result.success && result.data ? result.data : [];
	return rows.map((row) => ({
		a: row.a,
		b: row.b,
		strength: Number(row.strength),
		reciprocity: reciprocity(
			Number(row.forward ?? 0),
			Number(row.backward ?? 0),
		),
	}));
}

/**
 * Plain-English strength label for prompts and tool output, with recency kept separate from
 * the bond: "very close; haven't talked since January 2026", "close; no longer in the server"
 */
export function describeStrength(
	connection: Pick<Connection, "share" | "reciprocity"> &
		Partial<Pick<Connection, "last_interaction" | "present">>,
): string {
	const level =
		connection.share >= 0.25
			? "very close"
			: connection.share >= 0.1
				? "close"
				: connection.share >= 0.04
					? "regular"
					: "occasional";
	const balance = connection.reciprocity < 0.34 ? ", mostly one-sided" : "";
	const last = connection.last_interaction
		? new Date(connection.last_interaction)
		: null;
	const recency =
		connection.present === false
			? "; no longer in the server"
			: last && Date.now() - last.getTime() > QUIET_AFTER_DAYS * 86_400_000
				? `; haven't talked since ${last.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" })}`
				: "";
	return `${level}${balance}${recency}`;
}
