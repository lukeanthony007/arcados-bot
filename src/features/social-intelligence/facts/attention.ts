/**
 * The attention network: who focuses on whom inside conversations, whether bids for attention
 * are answered, whether the attention is affirming, and the hierarchy and cliques that result.
 *
 * Computed on demand from `episode_attention` (one row per directed pair per episode, written
 * by the segmentation pass), `conversation_segments.focus` (each episode's structures and
 * bids) and `conversation_exchanges` model rows (tone and valence). Each episode counts with a
 * 180-day half-life from its start (like closeness), bounded by a window.
 *
 * Nothing is stored: the pure math (decay, concentration, PageRank, communities, pursuit) is
 * exported and tested; the DB functions assemble it.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import type { EpisodeFocus, FocusStructure } from "../conversations/attention";
import { HALF_LIFE_DAYS } from "./closeness";

// ---------------------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------------------

export interface PersonFlow {
	user_id: string;
	name: string;
	mass: number;
	share: number;
	returned: number;
}

type Valence = "warm" | "neutral" | "cold";
type StructureKey =
	| "pair"
	| "pursuit_giver"
	| "pursuit_target"
	| "centre"
	| "unattended"
	| "room";

export interface AttentionProfile {
	user_id: string;
	name: string;
	/** End of the window: their last conversation unless asked otherwise */
	as_of: Date;
	episodes: number;
	given: number;
	received: number;
	room: number;
	concentration: number;
	top_out: PersonFlow[];
	top_in: PersonFlow[];
	pursues: PersonFlow[];
	pursued_by: PersonFlow[];
	bids: { made: number; answered: number; uptake: number };
	bids_to_them: { count: number; answered: number; answer_rate: number };
	room_bids: { made: number; taken_up: number };
	structures: Record<StructureKey, number>;
	situations: { one_on_one: number; small_group: number; large_group: number };
	warmth: { given: Record<Valence, number>; received: Record<Valence, number> };
}

export interface AttentionEdge {
	a: string;
	b: string;
	a_name: string;
	b_name: string;
	/** End of the window: their last shared conversation unless asked otherwise */
	as_of: Date;
	a_to_b: number;
	b_to_a: number;
	reciprocity: number;
	episodes_together: number;
	bids_a_to_b: { made: number; answered: number };
	bids_b_to_a: { made: number; answered: number };
	situations: { one_on_one: number; group: number };
	channels: Array<{ name: string; episodes: number }>;
	tones_a_to_b: Record<string, number>;
	tones_b_to_a: Record<string, number>;
	valence_a_to_b: Record<Valence, number>;
	valence_b_to_a: Record<Valence, number>;
	recent_notes: Array<{
		date: string;
		from_name: string;
		to_name: string;
		tone: string;
		valence: string | null;
		note: string;
	}>;
}

/**
 * How a member spends attention, from ratios rather than volume:
 * - draws: receives more attention than they give, from many people
 * - engine: gives a lot and collects less than they give; keeps conversations going
 * - balanced: neither
 * Where their attention comes from is separate (`anchors`: one or two people most of it
 * comes from, when that's clearly more than an even spread).
 */
export type SocialShape = "draws" | "engine" | "balanced";

export interface SocialStructure {
	/** Active members by standing (average percentile of draw, reach, uptake, opener pickup) */
	ranking: Array<{
		user_id: string;
		name: string;
		standing: number;
		shape: SocialShape;
		/** received ÷ given */
		draw: number;
		reach: number;
		uptake: number;
		/** Share of their openers to the room someone picked up */
		pickup: number;
		received: number;
		given: number;
		/** PageRank on directed attention: whose attention counts, not how much they get */
		influence: number;
		/** For anchored members: the one or two people most of their attention comes from */
		anchors: string[];
	}>;
	cliques: Array<{
		members: Array<{ user_id: string; name: string }>;
		internal_reciprocity: number;
		tone: Record<string, number>;
	}>;
	/** Reaching out without much return and without a back-and-forth partner anywhere */
	periphery: Array<{
		user_id: string;
		name: string;
		bids: number;
		uptake: number;
		openers: number;
		pickup: number;
		unattended_episodes: number;
	}>;
}

// ---------------------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------------------

export const PURSUIT_MIN_MASS = 3;
export const PURSUIT_RETURN_RATIO = 0.4;
const DAY_MS = 86_400_000;
const MAX_FLOWS = 8;
const MAX_RANKING = 25;
const MAX_CLIQUES = 8;
const MIN_CLIQUE_SIZE = 3;
const MAX_PERIPHERY = 10;
const CLIQUE_EDGE_FLOOR = 1;
/** Modularity resolution: higher splits into smaller groups */
const RESOLUTION = 1.5;
/** Members are ranked once they've given this much decayed attention (participants, not just addressees) */
export const ACTIVE_MIN_GIVEN = 10;
const MAX_NOTES = 5;

/** Weight of an episode `ageDays` old: halves every `halfLifeDays` */
export function decayWeight(
	ageDays: number,
	halfLifeDays = HALF_LIFE_DAYS,
): number {
	return 0.5 ** (Math.max(0, ageDays) / halfLifeDays);
}

/** Decay weight of something that happened at `at`, seen at `now` */
export function decayAt(at: Date, now: Date): number {
	return decayWeight((now.getTime() - at.getTime()) / DAY_MS);
}

/** Herfindahl index of masses: Σ share². 1 = all on one person; → 0 as it spreads out */
export function herfindahl(masses: number[]): number {
	const total = masses.reduce((s, m) => s + Math.max(0, m), 0);
	if (total <= 0) return 0;
	return masses.reduce((s, m) => s + (Math.max(0, m) / total) ** 2, 0);
}

/** A flow is a pursuit when it is substantial and the other side gives back little */
export function isPursuit(mass: number, returned: number): boolean {
	return mass >= PURSUIT_MIN_MASS && returned < PURSUIT_RETURN_RATIO * mass;
}

export interface RawFlow {
	id: string;
	mass: number;
	share: number;
	returned: number;
}

/** Flows out of one person: `mass` per target, `back` = what each target gave back */
export function rankFlows(
	mass: Map<string, number>,
	back: Map<string, number>,
): RawFlow[] {
	let total = 0;
	for (const m of mass.values()) total += m;
	return [...mass.entries()]
		.filter(([, m]) => m > 0)
		.map(([id, m]) => ({
			id,
			mass: m,
			share: total > 0 ? m / total : 0,
			returned: back.get(id) ?? 0,
		}))
		.sort((x, y) => y.mass - x.mass || (x.id < y.id ? -1 : 1));
}

export interface WeightedEdge {
	from: string;
	to: string;
	weight: number;
}

/**
 * PageRank on a directed weighted graph: attention flows toward standing. Damping 0.85,
 * 50 iterations, dangling nodes spread uniformly; result sums to 1.
 */
export function pagerank(
	edges: WeightedEdge[],
	damping = 0.85,
	iterations = 50,
): Map<string, number> {
	const outgoing = new Map<string, Map<string, number>>();
	const nodes = new Set<string>();
	for (const e of edges) {
		if (e.from === e.to || !(e.weight > 0)) continue;
		nodes.add(e.from);
		nodes.add(e.to);
		let row = outgoing.get(e.from);
		if (!row) {
			row = new Map();
			outgoing.set(e.from, row);
		}
		row.set(e.to, (row.get(e.to) ?? 0) + e.weight);
	}
	const ids = [...nodes].sort();
	const n = ids.length;
	const result = new Map<string, number>();
	if (n === 0) return result;
	const outTotal = new Map<string, number>();
	for (const [from, row] of outgoing) {
		let sum = 0;
		for (const w of row.values()) sum += w;
		outTotal.set(from, sum);
	}
	let rank = new Map(ids.map((id) => [id, 1 / n]));
	for (let i = 0; i < iterations; i++) {
		const next = new Map(ids.map((id) => [id, 0]));
		let dangling = 0;
		for (const id of ids) {
			const r = rank.get(id) ?? 0;
			const row = outgoing.get(id);
			const total = outTotal.get(id) ?? 0;
			if (!row || total <= 0) {
				dangling += r;
				continue;
			}
			for (const [to, w] of row)
				next.set(to, (next.get(to) ?? 0) + (r * w) / total);
		}
		const base = (1 - damping) / n + (damping * dangling) / n;
		for (const id of ids) next.set(id, base + damping * (next.get(id) ?? 0));
		rank = next;
	}
	let sum = 0;
	for (const r of rank.values()) sum += r;
	for (const id of ids) result.set(id, (rank.get(id) ?? 0) / (sum || 1));
	return result;
}

export interface UndirectedEdge {
	a: string;
	b: string;
	weight: number;
}

/**
 * Communities by deterministic modularity optimisation (Louvain's local-moving phase): every
 * node starts alone and moves to the neighbouring community with the best modularity gain, in
 * sorted order, until nothing moves. Returns groups of ≥ `minSize`, largest first, members by
 * weighted degree.
 */
export function findCommunities(
	edges: UndirectedEdge[],
	minSize = MIN_CLIQUE_SIZE,
	maxCommunities = MAX_CLIQUES,
): string[][] {
	const neighbours = new Map<string, Map<string, number>>();
	const link = (x: string, y: string, w: number) => {
		let row = neighbours.get(x);
		if (!row) {
			row = new Map();
			neighbours.set(x, row);
		}
		row.set(y, (row.get(y) ?? 0) + w);
	};
	for (const e of edges) {
		if (e.a === e.b || !(e.weight > 0)) continue;
		link(e.a, e.b, e.weight);
		link(e.b, e.a, e.weight);
	}
	const nodes = [...neighbours.keys()].sort();
	const strength = new Map<string, number>();
	let twoM = 0;
	for (const node of nodes) {
		let d = 0;
		for (const w of neighbours.get(node)?.values() ?? []) d += w;
		strength.set(node, d);
		twoM += d;
	}
	const label = new Map(nodes.map((n) => [n, n]));
	const total = new Map(nodes.map((n) => [n, strength.get(n) ?? 0]));
	for (let pass = 0; pass < 30; pass++) {
		let moved = false;
		for (const node of nodes) {
			const k = strength.get(node) ?? 0;
			const current = label.get(node) as string;
			total.set(current, (total.get(current) ?? 0) - k);
			const toCommunity = new Map<string, number>();
			for (const [other, w] of neighbours.get(node) ?? []) {
				const l = label.get(other) as string;
				toCommunity.set(l, (toCommunity.get(l) ?? 0) + w);
			}
			const gain = (l: string) =>
				(toCommunity.get(l) ?? 0) -
				(RESOLUTION * k * (total.get(l) ?? 0)) / twoM;
			let best = current;
			let bestGain = gain(current);
			for (const l of [...toCommunity.keys()].sort()) {
				const g = gain(l);
				if (g > bestGain + 1e-12) {
					best = l;
					bestGain = g;
				}
			}
			total.set(best, (total.get(best) ?? 0) + k);
			if (best !== current) {
				label.set(node, best);
				moved = true;
			}
		}
		if (!moved) break;
	}
	const degree = (id: string) => strength.get(id) ?? 0;
	const groups = new Map<string, string[]>();
	for (const [id, l] of label) {
		const g = groups.get(l);
		if (g) g.push(id);
		else groups.set(l, [id]);
	}
	return [...groups.values()]
		.filter((g) => g.length >= minSize)
		.map((g) => g.sort((x, y) => degree(y) - degree(x) || (x < y ? -1 : 1)))
		.sort(
			(x, y) => y.length - x.length || (x[0] ?? "").localeCompare(y[0] ?? ""),
		)
		.slice(0, maxCommunities);
}

/** Episode size bucket by participant count */
export function sizeBucket(
	participants: number,
): "one_on_one" | "small_group" | "large_group" | null {
	if (participants < 2) return null;
	if (participants === 2) return "one_on_one";
	return participants <= 4 ? "small_group" : "large_group";
}

/** How many of an episode's structures involve `userId`, by role (each counted once) */
export function countStructures(
	structures: FocusStructure[],
	userId: string,
): Record<StructureKey, number> {
	const out: Record<StructureKey, number> = {
		pair: 0,
		pursuit_giver: 0,
		pursuit_target: 0,
		centre: 0,
		unattended: 0,
		room: 0,
	};
	for (const s of structures) {
		switch (s.kind) {
			case "pair":
				if (s.a === userId || s.b === userId) out.pair++;
				break;
			case "pursuit":
				if (s.from === userId) out.pursuit_giver++;
				if (s.to === userId) out.pursuit_target++;
				break;
			case "centre":
				if (s.user === userId) out.centre++;
				break;
			case "unattended":
				if (s.user === userId) out.unattended++;
				break;
			case "room":
				if (s.user === userId) out.room++;
				break;
		}
	}
	return out;
}

/** What the structure is computed from, per active member (decayed masses, raw bid counts) */
export interface MemberSignals {
	id: string;
	given: number;
	received: number;
	/** Distinct people who gave them ≥ 1 attention */
	reach: number;
	bids: number;
	bidsAnswered: number;
	openers: number;
	openersTakenUp: number;
	/** Share of the attention they receive that comes from their top two givers */
	topTwoInShare: number;
	/** Their strongest back-and-forth: max over others of min(a→b, b→a) */
	partner: number;
}

/** Percentile (0-1) of each value among all of them; ties share their average rank */
export function percentiles(values: number[]): number[] {
	if (values.length <= 1) return values.map(() => 0.5);
	const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
	const out = new Array<number>(values.length);
	for (let start = 0; start < order.length; ) {
		let end = start;
		while (end + 1 < order.length && order[end + 1]?.v === order[start]?.v)
			end++;
		const rank = (start + end) / 2 / (values.length - 1);
		for (const entry of order.slice(start, end + 1)) out[entry.i] = rank;
		start = end + 1;
	}
	return out;
}

/** Server-wide rates that small samples are shrunk toward */
export interface Baselines {
	uptake: number;
	pickup: number;
}

/**
 * Pseudo-observations at the server baseline added to every member's rates, so a handful of
 * bids can't make someone look like they're always (or never) answered
 */
export const SMOOTHING = 8;

export function baselinesOf(members: MemberSignals[]): Baselines {
	const sum = (f: (m: MemberSignals) => number) =>
		members.reduce((s, m) => s + f(m), 0);
	return {
		uptake: ratio(
			sum((m) => m.bidsAnswered),
			sum((m) => m.bids),
		),
		pickup: ratio(
			sum((m) => m.openersTakenUp),
			sum((m) => m.openers),
		),
	};
}

/** Attention received per attention given, shrunk toward even */
export const drawOf = (m: MemberSignals) =>
	(m.received + SMOOTHING) / (m.given + SMOOTHING);
export const uptakeOf = (m: MemberSignals, b: Baselines) =>
	(m.bidsAnswered + SMOOTHING * b.uptake) / (m.bids + SMOOTHING);
export const pickupOf = (m: MemberSignals, b: Baselines) =>
	(m.openersTakenUp + SMOOTHING * b.pickup) / (m.openers + SMOOTHING);

/**
 * Standing: the average percentile of four signals that volume alone can't buy: draw (attention
 * received per attention given), reach, how often their bids land, and how often their openers
 * to the room are picked up. Rates are shrunk toward the server baseline.
 */
export function standingScores(
	members: MemberSignals[],
	baselines: Baselines,
): Map<string, number> {
	const signals = [
		percentiles(members.map(drawOf)),
		percentiles(members.map((m) => m.reach)),
		percentiles(members.map((m) => uptakeOf(m, baselines))),
		percentiles(members.map((m) => pickupOf(m, baselines))),
	];
	return new Map(
		members.map((m, i) => [
			m.id,
			signals.reduce((s, p) => s + (p[i] ?? 0), 0) / signals.length,
		]),
	);
}

export const ANCHORED_TOP_TWO_SHARE = 0.6;

/**
 * Most of the attention they receive comes from one or two people, clearly more than an even
 * spread over the people who attend to them would give (with three givers, two of them always
 * hold two thirds, so that alone says nothing)
 */
export function isAnchored(m: MemberSignals): boolean {
	if (m.reach === 0) return false;
	const even = Math.min(1, 2 / m.reach);
	return (
		m.topTwoInShare >= ANCHORED_TOP_TWO_SHARE && m.topTwoInShare >= 1.5 * even
	);
}

/** How they spend attention; anchoring (where theirs comes from) is reported separately */
export function classifyShape(
	m: MemberSignals,
	reachP75: number,
	givenP75: number,
): SocialShape {
	const draw = drawOf(m);
	if (draw >= 1 && m.reach >= reachP75) return "draws";
	if (m.given >= givenP75 && draw < 0.95) return "engine";
	return "balanced";
}

/**
 * A back-and-forth partner is someone they trade at least this share of their own attention
 * with (min of both directions); relative, because in a busy stretch a single decent chat
 * would clear any absolute floor
 */
export const PARTNER_SHARE = 0.25;
/** …and never less than this much attention, so near-silent members aren't judged on noise */
export const PARTNER_FLOOR = 3;
const PERIPHERY_MIN_ATTEMPTS = 3;
const PERIPHERY_RETURN_RATIO = 0.75;

/**
 * Reaching out without much return: their bids or openers land clearly less often than the
 * server's (rates shrunk toward the baseline), and nobody trades a real share of attention
 * with them. Someone whose bids often fail but who has a close partner is not peripheral;
 * they just talk past the room sometimes. (Attention received isn't used: the conversations
 * that do happen are mostly one-on-one, where attention is symmetric.)
 */
export function isPeripheral(m: MemberSignals, b: Baselines): boolean {
	const lowBids =
		m.bids >= PERIPHERY_MIN_ATTEMPTS &&
		uptakeOf(m, b) < PERIPHERY_RETURN_RATIO * b.uptake;
	const lowOpeners =
		m.openers >= PERIPHERY_MIN_ATTEMPTS &&
		pickupOf(m, b) < PERIPHERY_RETURN_RATIO * b.pickup;
	const hasPartner =
		m.partner >= PARTNER_SHARE * Math.max(m.given, PARTNER_FLOOR);
	return (lowBids || lowOpeners) && !hasPartner;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
const round = (n: number, digits = 1) => Number(n.toFixed(digits));

// ---------------------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------------------

async function select<T>(
	db: PostgreSQLManager,
	sql: string,
	params: unknown[],
): Promise<T[]> {
	const result = await db.query(sql, params);
	if (!result.success)
		throw new Error(result.error ?? "attention query failed");
	return (result.data ?? []) as T[];
}

interface MemberInfo {
	name: string;
	bot: boolean;
}

async function loadMembers(
	db: PostgreSQLManager,
	guildId: string,
): Promise<Map<string, MemberInfo>> {
	const rows = await select<{
		user_id: string;
		name: string | null;
		bot: boolean | null;
	}>(
		db,
		`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name, bot
		 FROM members WHERE guild_id = $1`,
		[guildId],
	);
	return new Map(
		rows.map((r) => [
			r.user_id,
			{ name: r.name ?? r.user_id, bot: r.bot === true },
		]),
	);
}

const nameIn = (members: Map<string, MemberInfo>, id: string) =>
	members.get(id)?.name ?? id;
const isHuman = (members: Map<string, MemberInfo>, id: string) =>
	members.get(id)?.bot !== true;

export interface WindowOptions {
	sinceDays?: number;
	/**
	 * End of the window. Defaults to the subject's last conversation, so someone who has been
	 * away is described as they were when they were around, not as an empty profile
	 */
	asOf?: Date;
}

/** When the given members were last in a conversation together (or `now` if never) */
async function lastTogether(
	db: PostgreSQLManager,
	guildId: string,
	userIds: string[],
): Promise<Date> {
	const [row] = await select<{ last: Date | null }>(
		db,
		`SELECT MAX(start_time) AS last FROM conversation_segments
		 WHERE guild_id = $1 AND participants @> $2::text[]`,
		[guildId, userIds],
	);
	return row?.last ? new Date(row.last) : new Date();
}

interface AttentionRow {
	conversation_id: string;
	from_user: string;
	to_user: string;
	mass: number;
	explicit_mass: number;
	bids: number;
	bids_answered: number;
	start_time: Date;
	channel_id: string;
	size: number | null;
}

const ATTENTION_SELECT = `
	SELECT ea.conversation_id, ea.from_user, ea.to_user, ea.mass, ea.explicit_mass,
		ea.bids, ea.bids_answered, cs.start_time, cs.channel_id,
		array_length(cs.participants, 1) AS size
	FROM episode_attention ea
	JOIN conversation_segments cs ON cs.id = ea.conversation_id`;

const emptyValence = (): Record<Valence, number> => ({
	warm: 0,
	neutral: 0,
	cold: 0,
});

// ---------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------

export async function getAttentionProfile(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
	{ sinceDays = 365, asOf }: WindowOptions = {},
): Promise<AttentionProfile | null> {
	const now = asOf ?? (await lastTogether(db, guildId, [userId]));
	const since = new Date(now.getTime() - sinceDays * DAY_MS);
	const [members, rows, episodes, valenceRows] = await Promise.all([
		loadMembers(db, guildId),
		select<AttentionRow>(
			db,
			`${ATTENTION_SELECT}
			 WHERE cs.guild_id = $1 AND cs.start_time >= $3 AND cs.start_time <= $4
				AND (ea.from_user = $2 OR ea.to_user = $2)`,
			[guildId, userId, since, now],
		),
		select<{
			size: number | null;
			focus: EpisodeFocus | null;
			start_time: Date;
		}>(
			db,
			`SELECT array_length(participants, 1) AS size, focus, start_time
			 FROM conversation_segments
			 WHERE guild_id = $1 AND $2 = ANY(participants) AND start_time >= $3 AND start_time <= $4`,
			[guildId, userId, since, now],
		),
		select<{ dir: "given" | "received"; valence: string | null; n: number }>(
			db,
			`SELECT CASE WHEN x.from_user = $2 THEN 'given' ELSE 'received' END AS dir,
				x.valence, COUNT(*)::int AS n
			 FROM conversation_exchanges x
			 JOIN conversation_segments cs ON cs.id = x.conversation_id
			 WHERE cs.guild_id = $1 AND x.source = 'model' AND cs.start_time >= $3 AND cs.start_time <= $4
				AND (x.from_user = $2 OR x.to_user = $2)
			 GROUP BY 1, 2`,
			[guildId, userId, since, now],
		),
	]);
	if (rows.length === 0 && episodes.length === 0) return null;

	const out = new Map<string, number>();
	const inn = new Map<string, number>();
	const bids = { made: 0, answered: 0 };
	const toThem = { count: 0, answered: 0 };
	for (const r of rows) {
		const other = r.from_user === userId ? r.to_user : r.from_user;
		if (other === userId || !isHuman(members, other)) continue;
		const w = decayAt(new Date(r.start_time), now);
		if (r.from_user === userId) {
			out.set(other, (out.get(other) ?? 0) + r.mass * w);
			bids.made += r.bids;
			bids.answered += r.bids_answered;
		} else {
			inn.set(other, (inn.get(other) ?? 0) + r.mass * w);
			toThem.count += r.bids;
			toThem.answered += r.bids_answered;
		}
	}

	const structures: Record<StructureKey, number> = {
		pair: 0,
		pursuit_giver: 0,
		pursuit_target: 0,
		centre: 0,
		unattended: 0,
		room: 0,
	};
	const situations = { one_on_one: 0, small_group: 0, large_group: 0 };
	const roomBids = { made: 0, taken_up: 0 };
	let room = 0;
	for (const e of episodes) {
		const bucket = sizeBucket(e.size ?? 0);
		if (bucket) situations[bucket]++;
		const focus = e.focus;
		if (!focus) continue;
		room +=
			(focus.people?.[userId]?.room ?? 0) *
			decayAt(new Date(e.start_time), now);
		const counts = countStructures(focus.structures ?? [], userId);
		for (const key of Object.keys(structures) as StructureKey[])
			structures[key] += counts[key];
		for (const b of focus.bids ?? []) {
			if (b.from === userId && !b.to) {
				roomBids.made++;
				if (b.answered_by) roomBids.taken_up++;
			}
		}
	}

	const sum = (m: Map<string, number>) =>
		[...m.values()].reduce((s, v) => s + v, 0);
	const flow = (f: RawFlow): PersonFlow => ({
		user_id: f.id,
		name: nameIn(members, f.id),
		mass: round(f.mass),
		share: round(f.share, 2),
		returned: round(f.returned),
	});
	const outFlows = rankFlows(out, inn);
	const inFlows = rankFlows(inn, out);
	const warmth = { given: emptyValence(), received: emptyValence() };
	for (const v of valenceRows) {
		if (
			v.valence === "warm" ||
			v.valence === "neutral" ||
			v.valence === "cold"
		) {
			warmth[v.dir][v.valence] += Number(v.n);
		}
	}

	return {
		user_id: userId,
		name: nameIn(members, userId),
		as_of: now,
		episodes: episodes.length,
		given: round(sum(out)),
		received: round(sum(inn)),
		room: round(room),
		concentration: round(herfindahl([...out.values()]), 2),
		top_out: outFlows.slice(0, MAX_FLOWS).map(flow),
		top_in: inFlows.slice(0, MAX_FLOWS).map(flow),
		pursues: outFlows
			.filter((f) => isPursuit(f.mass, f.returned))
			.slice(0, MAX_FLOWS)
			.map(flow),
		pursued_by: inFlows
			.filter((f) => isPursuit(f.mass, f.returned))
			.slice(0, MAX_FLOWS)
			.map(flow),
		bids: { ...bids, uptake: round(ratio(bids.answered, bids.made), 2) },
		bids_to_them: {
			...toThem,
			answer_rate: round(ratio(toThem.answered, toThem.count), 2),
		},
		room_bids: roomBids,
		structures,
		situations,
		warmth,
	};
}

// ---------------------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------------------

export async function getAttentionEdge(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
	{ sinceDays = 365, asOf }: WindowOptions = {},
): Promise<AttentionEdge | null> {
	const now = asOf ?? (await lastTogether(db, guildId, [a, b]));
	const since = new Date(now.getTime() - sinceDays * DAY_MS);
	const [members, rows, exchanges] = await Promise.all([
		loadMembers(db, guildId),
		select<AttentionRow & { channel_name: string | null }>(
			db,
			`SELECT ea.conversation_id, ea.from_user, ea.to_user, ea.mass, ea.explicit_mass,
				ea.bids, ea.bids_answered, cs.start_time, cs.channel_id,
				array_length(cs.participants, 1) AS size, ch.name AS channel_name
			 FROM episode_attention ea
			 JOIN conversation_segments cs ON cs.id = ea.conversation_id
			 LEFT JOIN channels ch ON ch.id = cs.channel_id AND ch.guild_id = cs.guild_id
			 WHERE cs.guild_id = $1 AND cs.start_time >= $4 AND cs.start_time <= $5
				AND ((ea.from_user = $2 AND ea.to_user = $3) OR (ea.from_user = $3 AND ea.to_user = $2))`,
			[guildId, a, b, since, now],
		),
		select<{
			from_user: string;
			to_user: string;
			tone: string | null;
			valence: string | null;
			note: string | null;
			start_time: Date;
		}>(
			db,
			`SELECT x.from_user, x.to_user, x.tone, x.valence, x.note, cs.start_time
			 FROM conversation_exchanges x
			 JOIN conversation_segments cs ON cs.id = x.conversation_id
			 WHERE cs.guild_id = $1 AND x.source = 'model' AND cs.start_time >= $4 AND cs.start_time <= $5
				AND ((x.from_user = $2 AND x.to_user = $3) OR (x.from_user = $3 AND x.to_user = $2))
			 ORDER BY cs.start_time DESC`,
			[guildId, a, b, since, now],
		),
	]);
	if (rows.length === 0 && exchanges.length === 0) return null;

	let aToB = 0;
	let bToA = 0;
	const bidsAB = { made: 0, answered: 0 };
	const bidsBA = { made: 0, answered: 0 };
	const episodes = new Map<string, { size: number; channel: string }>();
	for (const r of rows) {
		const w = decayAt(new Date(r.start_time), now);
		episodes.set(r.conversation_id, {
			size: r.size ?? 0,
			channel: r.channel_name ?? r.channel_id,
		});
		if (r.from_user === a) {
			aToB += r.mass * w;
			bidsAB.made += r.bids;
			bidsAB.answered += r.bids_answered;
		} else {
			bToA += r.mass * w;
			bidsBA.made += r.bids;
			bidsBA.answered += r.bids_answered;
		}
	}
	const situations = { one_on_one: 0, group: 0 };
	const channels = new Map<string, number>();
	for (const e of episodes.values()) {
		if (e.size === 2) situations.one_on_one++;
		else situations.group++;
		channels.set(e.channel, (channels.get(e.channel) ?? 0) + 1);
	}

	const tonesAB: Record<string, number> = {};
	const tonesBA: Record<string, number> = {};
	const valenceAB = emptyValence();
	const valenceBA = emptyValence();
	for (const x of exchanges) {
		const forward = x.from_user === a;
		if (x.tone) {
			const t = forward ? tonesAB : tonesBA;
			t[x.tone] = (t[x.tone] ?? 0) + 1;
		}
		if (
			x.valence === "warm" ||
			x.valence === "neutral" ||
			x.valence === "cold"
		) {
			(forward ? valenceAB : valenceBA)[x.valence]++;
		}
	}

	return {
		a,
		b,
		a_name: nameIn(members, a),
		b_name: nameIn(members, b),
		as_of: now,
		a_to_b: round(aToB),
		b_to_a: round(bToA),
		reciprocity: round(ratio(Math.min(aToB, bToA), Math.max(aToB, bToA)), 2),
		episodes_together: episodes.size,
		bids_a_to_b: bidsAB,
		bids_b_to_a: bidsBA,
		situations,
		channels: [...channels.entries()]
			.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
			.slice(0, 5)
			.map(([name, count]) => ({ name, episodes: count })),
		tones_a_to_b: tonesAB,
		tones_b_to_a: tonesBA,
		valence_a_to_b: valenceAB,
		valence_b_to_a: valenceBA,
		recent_notes: exchanges
			.filter((x) => x.note)
			.slice(0, MAX_NOTES)
			.map((x) => ({
				date: new Date(x.start_time).toISOString().slice(0, 10),
				from_name: nameIn(members, x.from_user),
				to_name: nameIn(members, x.to_user),
				tone: x.tone ?? "",
				valence: x.valence,
				note: x.note ?? "",
			})),
	};
}

// ---------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------

export async function getSocialStructure(
	db: PostgreSQLManager,
	guildId: string,
	sinceDays = 180,
	/** Read the structure as it was at this moment (window and decay end here) */
	asOf = new Date(),
): Promise<SocialStructure> {
	const since = new Date(asOf.getTime() - sinceDays * DAY_MS);
	const window = "cs.start_time >= $2 AND cs.start_time <= $3";
	const [members, rows, toneRows, unattendedRows, openerRows] =
		await Promise.all([
			loadMembers(db, guildId),
			select<AttentionRow>(
				db,
				`${ATTENTION_SELECT} WHERE cs.guild_id = $1 AND ${window}`,
				[guildId, since, asOf],
			),
			select<{ from_user: string; to_user: string; tone: string; n: number }>(
				db,
				`SELECT x.from_user, x.to_user, x.tone, COUNT(*)::int AS n
			 FROM conversation_exchanges x
			 JOIN conversation_segments cs ON cs.id = x.conversation_id
			 WHERE cs.guild_id = $1 AND x.source = 'model' AND ${window} AND x.tone IS NOT NULL
			 GROUP BY 1, 2, 3`,
				[guildId, since, asOf],
			),
			select<{ user_id: string; n: number }>(
				db,
				`SELECT s->>'user' AS user_id, COUNT(*)::int AS n
			 FROM conversation_segments cs, jsonb_array_elements(cs.focus->'structures') s
			 WHERE cs.guild_id = $1 AND ${window} AND cs.focus IS NOT NULL
				AND s->>'kind' = 'unattended'
			 GROUP BY 1`,
				[guildId, since, asOf],
			),
			// Openers to the room (bids with no person target) and whether anyone picked them up
			select<{ user_id: string; made: number; taken: number }>(
				db,
				`SELECT b->>'from' AS user_id, COUNT(*)::int AS made,
				COUNT(*) FILTER (WHERE b->>'answered_by' IS NOT NULL)::int AS taken
			 FROM conversation_segments cs, jsonb_array_elements(cs.focus->'bids') b
			 WHERE cs.guild_id = $1 AND ${window} AND cs.focus IS NOT NULL
				AND b->>'to' IS NULL
			 GROUP BY 1`,
				[guildId, since, asOf],
			),
		]);

	const directed = new Map<string, number>();
	const given = new Map<string, number>();
	const received = new Map<string, number>();
	const givers = new Map<string, Set<string>>();
	const bids = new Map<string, { made: number; answered: number }>();
	for (const r of rows) {
		if (r.from_user === r.to_user) continue;
		if (!isHuman(members, r.from_user) || !isHuman(members, r.to_user))
			continue;
		const w = decayAt(new Date(r.start_time), asOf);
		const mass = r.mass * w;
		const key = `${r.from_user}|${r.to_user}`;
		directed.set(key, (directed.get(key) ?? 0) + mass);
		given.set(r.from_user, (given.get(r.from_user) ?? 0) + mass);
		received.set(r.to_user, (received.get(r.to_user) ?? 0) + mass);
		const b = bids.get(r.from_user) ?? { made: 0, answered: 0 };
		b.made += r.bids;
		b.answered += r.bids_answered;
		bids.set(r.from_user, b);
	}
	const edges: WeightedEdge[] = [];
	for (const [key, weight] of directed) {
		const [from, to] = key.split("|") as [string, string];
		edges.push({ from, to, weight });
		if (weight >= 1) {
			const set = givers.get(to) ?? new Set<string>();
			set.add(from);
			givers.set(to, set);
		}
	}

	const person = (id: string) => ({ user_id: id, name: nameIn(members, id) });

	const reciprocal: UndirectedEdge[] = [];
	for (const [key, ab] of directed) {
		const [x, y] = key.split("|") as [string, string];
		if (x >= y) continue;
		const ba = directed.get(`${y}|${x}`) ?? 0;
		const weight = Math.min(ab, ba);
		if (weight >= CLIQUE_EDGE_FLOOR) reciprocal.push({ a: x, b: y, weight });
	}
	const cliques = findCommunities(reciprocal).map((ids) => {
		const inside = new Set(ids);
		let lo = 0;
		let hi = 0;
		for (let i = 0; i < ids.length; i++) {
			for (let j = i + 1; j < ids.length; j++) {
				const ab = directed.get(`${ids[i]}|${ids[j]}`) ?? 0;
				const ba = directed.get(`${ids[j]}|${ids[i]}`) ?? 0;
				lo += Math.min(ab, ba);
				hi += Math.max(ab, ba);
			}
		}
		const tone: Record<string, number> = {};
		for (const t of toneRows) {
			if (inside.has(t.from_user) && inside.has(t.to_user)) {
				tone[t.tone] = (tone[t.tone] ?? 0) + Number(t.n);
			}
		}
		return {
			members: ids.map(person),
			internal_reciprocity: round(ratio(lo, hi), 2),
			tone,
		};
	});

	const unattended = new Map(
		unattendedRows.map((r) => [r.user_id, Number(r.n)]),
	);
	const openers = new Map(
		openerRows.map((r) => [
			r.user_id,
			{ made: Number(r.made), taken: Number(r.taken) },
		]),
	);

	const signals: MemberSignals[] = [];
	// Every member with attention in the window; the ranking keeps the active ones, the
	// periphery looks at everyone (people reaching out without return are often low-volume)
	for (const id of new Set([...given.keys(), ...received.keys()])) {
		const g = given.get(id) ?? 0;
		const r = received.get(id) ?? 0;
		const inFlows: number[] = [];
		let partner = 0;
		for (const [key, mass] of directed) {
			const [from, to] = key.split("|");
			if (to === id && from) inFlows.push(mass);
			if (from === id && to)
				partner = Math.max(
					partner,
					Math.min(mass, directed.get(`${to}|${id}`) ?? 0),
				);
		}
		inFlows.sort((x, y) => y - x);
		const b = bids.get(id) ?? { made: 0, answered: 0 };
		const o = openers.get(id) ?? { made: 0, taken: 0 };
		signals.push({
			id,
			given: g,
			received: r,
			reach: givers.get(id)?.size ?? 0,
			bids: b.made,
			bidsAnswered: b.answered,
			openers: o.made,
			openersTakenUp: o.taken,
			topTwoInShare: ratio((inFlows[0] ?? 0) + (inFlows[1] ?? 0), r),
			partner,
		});
	}

	const baselines = baselinesOf(signals);
	const active = signals.filter((m) => m.given >= ACTIVE_MIN_GIVEN);
	const standing = standingScores(active, baselines);
	const influence = pagerank(edges);
	const quartile = (values: number[]) =>
		[...values].sort((x, y) => x - y)[Math.floor(values.length * 0.75)] ?? 0;
	const reachP75 = quartile(active.map((m) => m.reach));
	const givenP75 = quartile(active.map((m) => m.given));
	const topGivers = (id: string) =>
		[...directed.entries()]
			.filter(([key]) => key.endsWith(`|${id}`))
			.sort((x, y) => y[1] - x[1])
			.slice(0, 2)
			.map(([key]) => nameIn(members, key.split("|")[0] ?? ""));

	const ranking = active
		.map((m) => ({
			...person(m.id),
			standing: round(standing.get(m.id) ?? 0, 3),
			shape: classifyShape(m, reachP75, givenP75),
			draw: round(drawOf(m), 2),
			reach: m.reach,
			uptake: round(uptakeOf(m, baselines), 2),
			pickup: round(pickupOf(m, baselines), 2),
			received: round(m.received),
			given: round(m.given),
			influence: round(influence.get(m.id) ?? 0, 3),
			anchors: isAnchored(m) ? topGivers(m.id) : [],
		}))
		.sort((x, y) => y.standing - x.standing || (x.user_id < y.user_id ? -1 : 1))
		.slice(0, MAX_RANKING);

	const periphery = signals
		.filter((m) => isPeripheral(m, baselines))
		.map((m) => ({
			...person(m.id),
			bids: m.bids,
			uptake: round(uptakeOf(m, baselines), 2),
			openers: m.openers,
			pickup: round(pickupOf(m, baselines), 2),
			unattended_episodes: unattended.get(m.id) ?? 0,
		}))
		.sort(
			(x, y) =>
				y.unattended_episodes - x.unattended_episodes ||
				x.uptake - y.uptake ||
				(x.user_id < y.user_id ? -1 : 1),
		)
		.slice(0, MAX_PERIPHERY);

	return { ranking, cliques, periphery };
}

// ---------------------------------------------------------------------------------------
// Plain language
// ---------------------------------------------------------------------------------------

// Rates and shares are rendered as bands: implicit attention is inferred, so exact percentages
// would claim more precision than the measurement has. Exact figures stay in the data objects.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How much of someone's attention a share is */
export function shareBand(share: number): string {
	if (share >= 0.5) return "most";
	if (share >= 0.25) return "a large share";
	if (share >= 0.1) return "some";
	return "a little";
}

/** How much of the attention given comes back */
export function returnBand(returned: number, given: number): string {
	const r = given > 0 ? returned / given : 0;
	if (r >= 0.8) return "returned in kind";
	if (r >= 0.4) return "partly returned";
	return "little returned";
}

/** How often something happens */
export function rateBand(rate: number): string {
	if (rate >= 0.7) return "usually";
	if (rate >= 0.45) return "often";
	if (rate >= 0.25) return "sometimes";
	return "rarely";
}

function balanceBand(reciprocity: number): string {
	if (reciprocity >= 0.85) return "evenly";
	if (reciprocity >= 0.6) return "fairly evenly";
	return "unevenly";
}

/** Warm/cold read from the summarizer's exchanges; nothing from fewer than 3 */
function warmthText(v: Record<Valence, number>): string {
	const total = v.warm + v.neutral + v.cold;
	if (total < 3) return "";
	const warm = v.warm / total;
	const cold = v.cold / total;
	if (cold >= 0.3) return warm >= 0.3 ? "mixed, warm and cold" : "often cold";
	if (warm >= 0.5)
		return cold >= 0.15 ? "mostly warm, sometimes cold" : "mostly warm";
	if (warm >= 0.3)
		return cold >= 0.15 ? "often warm, sometimes cold" : "often warm";
	return cold >= 0.15 ? "mostly neutral, sometimes cold" : "mostly neutral";
}

function tonesText(tones: Record<string, number>): string {
	return Object.entries(tones)
		.filter(([t]) => t !== "neutral")
		.sort((x, y) => y[1] - x[1])
		.slice(0, 3)
		.map(([t]) => t)
		.join(", ");
}

const names = (list: string[]) =>
	list.length <= 2
		? list.join(" and ")
		: `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/** A window ending this long ago describes the past, and the text says so */
const STALE_MS = 30 * DAY_MS;
const monthYear = (d: Date) =>
	d.toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "America/New_York",
	});

export function describeProfile(p: AttentionProfile): string[] {
	const lines: string[] = [
		`${p.name}: ${plural(p.episodes, "conversation")} in the year up to ${p.as_of.getTime() < Date.now() - STALE_MS ? `${monthYear(p.as_of)}, when they were last active` : "now"}.`,
	];
	const draw = (p.received + SMOOTHING) / (p.given + SMOOTHING);
	if (draw >= 1.15) lines.push("Receives more attention than they give.");
	else if (draw <= 0.85) lines.push("Gives more attention than they get back.");
	else lines.push("Gives and receives attention about equally.");
	if (p.room > 0 && p.room / (p.given + p.room) >= 0.3) {
		lines.push("Often talks to the room rather than to anyone in particular.");
	}

	const [first, ...rest] = p.top_out;
	if (first) {
		const more = rest
			.slice(0, 2)
			.map((f) => `${f.name} (${returnBand(f.returned, f.mass)})`);
		lines.push(
			`Gives ${shareBand(first.share)} of their attention to ${first.name} (${returnBand(first.returned, first.mass)})${more.length ? `, then ${more.join(", ")}` : ""}.`,
		);
		if (p.concentration >= 0.35)
			lines.push("Their attention is concentrated on a few people.");
		else if (p.concentration <= 0.15 && p.top_out.length >= 4) {
			lines.push("Spreads their attention across many people.");
		}
	}
	const topTwoIn = (p.top_in[0]?.share ?? 0) + (p.top_in[1]?.share ?? 0);
	if (p.top_in.length >= 4 && topTwoIn >= ANCHORED_TOP_TWO_SHARE) {
		lines.push(
			`Most of the attention they get comes from ${names(p.top_in.slice(0, 2).map((f) => f.name))}.`,
		);
	} else if (p.top_in.length) {
		lines.push(
			`Attention comes to them from ${p.top_in.length >= 4 ? "many people" : names(p.top_in.map((f) => f.name))}${p.top_in.length >= 4 ? `, most from ${names(p.top_in.slice(0, 3).map((f) => f.name))}` : ""}.`,
		);
	}
	for (const f of p.pursues.slice(0, 3)) {
		lines.push(`Keeps turning to ${f.name}, who gives little back.`);
	}
	for (const f of p.pursued_by.slice(0, 3)) {
		lines.push(`${f.name} keeps turning to ${p.name}, who gives little back.`);
	}
	if (p.bids.made >= 3) {
		lines.push(
			`When ${p.name} reaches for someone's attention, they ${rateBand(p.bids.uptake)} get an answer.`,
		);
	}
	if (p.bids_to_them.count >= 3) {
		lines.push(
			`When others reach for ${p.name}'s attention, ${p.name} ${rateBand(p.bids_to_them.answer_rate)} answers.`,
		);
	}
	if (p.room_bids.made >= 3) {
		lines.push(
			`What they open to the whole room is ${rateBand(p.room_bids.taken_up / p.room_bids.made)} picked up.`,
		);
	}
	const s = p.structures;
	const groups: string[] = [];
	if (s.centre)
		groups.push(
			`the centre of attention in ${plural(s.centre, "conversation")}`,
		);
	if (s.unattended) groups.push(`left unanswered in ${s.unattended}`);
	if (s.room) groups.push(`mostly talking to the room in ${s.room}`);
	if (groups.length) lines.push(`In groups: ${groups.join(", ")}.`);
	if (s.pair)
		lines.push(
			`In a back-and-forth with one person in ${plural(s.pair, "conversation")}.`,
		);
	const sit = p.situations;
	const total = sit.one_on_one + sit.small_group + sit.large_group;
	if (total > 0) {
		const mostly =
			sit.one_on_one / total >= 0.5
				? "mostly one-on-one"
				: sit.large_group / total >= 0.4
					? "often in big groups (5+)"
					: "mostly in small groups (3-4)";
		lines.push(`Talks ${mostly}.`);
	}
	const given = warmthText(p.warmth.given);
	const received = warmthText(p.warmth.received);
	if (given) lines.push(`The attention they give is ${given}.`);
	if (received) lines.push(`The attention they get is ${received}.`);
	return lines;
}

export function describeEdge(e: AttentionEdge): string[] {
	const lines: string[] = [
		`${e.a_name} and ${e.b_name}: attention flows ${balanceBand(e.reciprocity)} between them across ${plural(e.episodes_together, "conversation")}${e.as_of.getTime() < Date.now() - STALE_MS ? `, up to ${monthYear(e.as_of)} when they last talked` : ""}.`,
	];
	const big = Math.max(e.a_to_b, e.b_to_a);
	if (big >= PURSUIT_MIN_MASS && e.reciprocity < PURSUIT_RETURN_RATIO) {
		const [from, to] =
			e.a_to_b >= e.b_to_a ? [e.a_name, e.b_name] : [e.b_name, e.a_name];
		lines.push(`${from} turns to ${to} far more than ${to} gives back.`);
	} else if (e.reciprocity < 0.85 && big > 0) {
		const [from, to] =
			e.a_to_b >= e.b_to_a ? [e.a_name, e.b_name] : [e.b_name, e.a_name];
		lines.push(
			`${from} gives ${e.reciprocity < 0.6 ? "clearly" : "a bit"} more than ${to} returns.`,
		);
	}
	for (const [from, to, bids] of [
		[e.a_name, e.b_name, e.bids_a_to_b],
		[e.b_name, e.a_name, e.bids_b_to_a],
	] as const) {
		if (bids.made >= 3) {
			lines.push(
				`When ${from} reaches for ${to}, ${to} ${rateBand(bids.answered / bids.made)} answers.`,
			);
		}
	}
	const { one_on_one: duo, group } = e.situations;
	if (duo + group > 0)
		lines.push(`Together: ${duo} one-on-one, ${group} in groups.`);
	if (e.channels.length) {
		lines.push(`Mostly in ${e.channels.map((c) => `#${c.name}`).join(", ")}.`);
	}
	for (const [from, to, tones, valence] of [
		[e.a_name, e.b_name, e.tones_a_to_b, e.valence_a_to_b],
		[e.b_name, e.a_name, e.tones_b_to_a, e.valence_b_to_a],
	] as const) {
		const t = tonesText(tones);
		const v = warmthText(valence);
		if (t || v)
			lines.push(`${from} toward ${to}: ${[t, v].filter(Boolean).join("; ")}.`);
	}
	return lines;
}

export function describeStructureOverview(s: SocialStructure): string[] {
	const lines: string[] = [];
	const top = s.ranking.slice(0, 8);
	const byShape = (shape: SocialShape) =>
		top.filter((r) => r.shape === shape).map((r) => r.name);
	const draws = byShape("draws");
	const engines = byShape("engine");
	if (draws.length) {
		lines.push(
			`People turn to ${names(draws)} from many directions; they get more attention than they give.`,
		);
	}
	if (engines.length) {
		lines.push(
			`${names(engines)} keep${engines.length === 1 ? "s" : ""} conversations going: they give out more attention than they collect.`,
		);
	}
	const others = top.filter((r) => r.shape === "balanced").map((r) => r.name);
	if (others.length) lines.push(`Also well placed: ${names(others)}.`);
	for (const r of top.filter((r) => r.anchors.length)) {
		lines.push(`Most of ${r.name}'s attention comes from ${names(r.anchors)}.`);
	}
	for (const c of s.cliques) {
		const tone = tonesText(c.tone);
		const mutual =
			c.internal_reciprocity >= 0.75
				? "mostly mutual"
				: c.internal_reciprocity >= 0.5
					? "partly mutual"
					: "one-sided";
		lines.push(
			`Circle: ${names(c.members.map((m) => m.name))} (attention ${mutual}${tone ? `; ${tone}` : ""}).`,
		);
	}
	if (s.periphery.length) {
		lines.push(
			`Often reaching out without much return, and without anyone they regularly trade attention with: ${names(s.periphery.map((p) => p.name))}.`,
		);
	}
	return lines;
}
