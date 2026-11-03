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

export interface SocialStructure {
	ranking: Array<{
		user_id: string;
		name: string;
		standing: number;
		received: number;
		given: number;
		uptake: number;
		reach: number;
	}>;
	cliques: Array<{
		members: Array<{ user_id: string; name: string }>;
		internal_reciprocity: number;
		tone: Record<string, number>;
	}>;
	periphery: Array<{
		user_id: string;
		name: string;
		bids: number;
		uptake: number;
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
const PERIPHERY_MIN_BIDS = 3;
const PERIPHERY_UPTAKE_RATIO = 0.75;
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

/**
 * Whether a member sits at the edge: bids often, gets answered clearly less than the server
 * does overall (below 75% of `baselineUptake`), and attention does not flow toward them
 * (standing at or under the median).
 */
export function isPeripheral(
	bids: number,
	uptake: number,
	baselineUptake: number,
	standing: number,
	medianStanding: number,
): boolean {
	return (
		bids >= PERIPHERY_MIN_BIDS &&
		uptake < PERIPHERY_UPTAKE_RATIO * baselineUptake &&
		standing <= medianStanding
	);
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

function windowStart(sinceDays: number): Date {
	return new Date(Date.now() - sinceDays * DAY_MS);
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
	sinceDays = 365,
): Promise<AttentionProfile | null> {
	const since = windowStart(sinceDays);
	const now = new Date();
	const [members, rows, episodes, valenceRows] = await Promise.all([
		loadMembers(db, guildId),
		select<AttentionRow>(
			db,
			`${ATTENTION_SELECT}
			 WHERE cs.guild_id = $1 AND cs.start_time >= $3
				AND (ea.from_user = $2 OR ea.to_user = $2)`,
			[guildId, userId, since],
		),
		select<{
			size: number | null;
			focus: EpisodeFocus | null;
			start_time: Date;
		}>(
			db,
			`SELECT array_length(participants, 1) AS size, focus, start_time
			 FROM conversation_segments
			 WHERE guild_id = $1 AND $2 = ANY(participants) AND start_time >= $3`,
			[guildId, userId, since],
		),
		select<{ dir: "given" | "received"; valence: string | null; n: number }>(
			db,
			`SELECT CASE WHEN x.from_user = $2 THEN 'given' ELSE 'received' END AS dir,
				x.valence, COUNT(*)::int AS n
			 FROM conversation_exchanges x
			 JOIN conversation_segments cs ON cs.id = x.conversation_id
			 WHERE cs.guild_id = $1 AND x.source = 'model' AND cs.start_time >= $3
				AND (x.from_user = $2 OR x.to_user = $2)
			 GROUP BY 1, 2`,
			[guildId, userId, since],
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
	sinceDays = 365,
): Promise<AttentionEdge | null> {
	const since = windowStart(sinceDays);
	const now = new Date();
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
			 WHERE cs.guild_id = $1 AND cs.start_time >= $4
				AND ((ea.from_user = $2 AND ea.to_user = $3) OR (ea.from_user = $3 AND ea.to_user = $2))`,
			[guildId, a, b, since],
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
			 WHERE cs.guild_id = $1 AND x.source = 'model' AND cs.start_time >= $4
				AND ((x.from_user = $2 AND x.to_user = $3) OR (x.from_user = $3 AND x.to_user = $2))
			 ORDER BY cs.start_time DESC`,
			[guildId, a, b, since],
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
): Promise<SocialStructure> {
	const since = windowStart(sinceDays);
	const now = new Date();
	const [members, rows, toneRows, unattendedRows] = await Promise.all([
		loadMembers(db, guildId),
		select<AttentionRow>(
			db,
			`${ATTENTION_SELECT} WHERE cs.guild_id = $1 AND cs.start_time >= $2`,
			[guildId, since],
		),
		select<{ from_user: string; to_user: string; tone: string; n: number }>(
			db,
			`SELECT x.from_user, x.to_user, x.tone, COUNT(*)::int AS n
			 FROM conversation_exchanges x
			 JOIN conversation_segments cs ON cs.id = x.conversation_id
			 WHERE cs.guild_id = $1 AND x.source = 'model' AND cs.start_time >= $2 AND x.tone IS NOT NULL
			 GROUP BY 1, 2, 3`,
			[guildId, since],
		),
		select<{ user_id: string; n: number }>(
			db,
			`SELECT s->>'user' AS user_id, COUNT(*)::int AS n
			 FROM conversation_segments cs, jsonb_array_elements(cs.focus->'structures') s
			 WHERE cs.guild_id = $1 AND cs.start_time >= $2 AND cs.focus IS NOT NULL
				AND s->>'kind' = 'unattended'
			 GROUP BY 1`,
			[guildId, since],
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
		const w = decayAt(new Date(r.start_time), now);
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

	const standing = pagerank(edges);
	const person = (id: string) => ({ user_id: id, name: nameIn(members, id) });
	const ranking = [...standing.entries()]
		.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
		.slice(0, MAX_RANKING)
		.map(([id, s]) => {
			const b = bids.get(id) ?? { made: 0, answered: 0 };
			return {
				...person(id),
				standing: round(s, 3),
				received: round(received.get(id) ?? 0),
				given: round(given.get(id) ?? 0),
				uptake: round(ratio(b.answered, b.made), 2),
				reach: givers.get(id)?.size ?? 0,
			};
		});

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
	let allMade = 0;
	let allAnswered = 0;
	for (const b of bids.values()) {
		allMade += b.made;
		allAnswered += b.answered;
	}
	const baseline = ratio(allAnswered, allMade);
	const sortedStanding = [...standing.values()].sort((x, y) => x - y);
	const median = sortedStanding[Math.floor(sortedStanding.length / 2)] ?? 0;
	const periphery = [...bids.entries()]
		.map(([id, b]) => ({ id, made: b.made, uptake: ratio(b.answered, b.made) }))
		.filter((p) =>
			isPeripheral(p.made, p.uptake, baseline, standing.get(p.id) ?? 0, median),
		)
		.map((p) => ({
			...person(p.id),
			bids: p.made,
			uptake: round(p.uptake, 2),
			unattended_episodes: unattended.get(p.id) ?? 0,
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

const pct = (n: number) => `${Math.round(n * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function flowList(
	flows: PersonFlow[],
	limit: number,
	showReturned: boolean,
): string {
	return flows
		.slice(0, limit)
		.map((f) =>
			showReturned
				? `${f.name} (${pct(f.share)}, returned ${pct(f.mass > 0 ? f.returned / f.mass : 0)})`
				: `${f.name} (${pct(f.share)})`,
		)
		.join(", ");
}

export function describeProfile(p: AttentionProfile): string[] {
	const lines: string[] = [];
	lines.push(
		`${p.name}: ${plural(p.episodes, "conversation")} in the window; gives ${p.given} attention to people and ${p.room} to the room, receives ${p.received}.`,
	);
	if (p.top_out.length) {
		lines.push(`Gives most attention to ${flowList(p.top_out, 3, true)}.`);
		if (p.concentration >= 0.35)
			lines.push("Attention is concentrated on a few people.");
		else if (p.concentration <= 0.15 && p.top_out.length >= 4) {
			lines.push("Spreads attention widely across many people.");
		}
	}
	if (p.top_in.length)
		lines.push(`Gets most attention from ${flowList(p.top_in, 3, false)}.`);
	for (const f of p.pursues.slice(0, 3)) {
		lines.push(
			`Turns to ${f.name} often; ${f.name} gives back little (${pct(f.mass > 0 ? f.returned / f.mass : 0)}).`,
		);
	}
	for (const f of p.pursued_by.slice(0, 3)) {
		lines.push(`${f.name} keeps turning to ${p.name}, who gives back little.`);
	}
	if (p.bids.made > 0) {
		lines.push(
			`When ${p.name} reaches for someone's attention, that person answers ${pct(p.bids.uptake)} of the time (${p.bids.answered} of ${p.bids.made}).`,
		);
	}
	if (p.bids_to_them.count > 0) {
		lines.push(
			`When others reach for ${p.name}'s attention, ${p.name} answers ${pct(p.bids_to_them.answer_rate)} of the time (${p.bids_to_them.answered} of ${p.bids_to_them.count}).`,
		);
	}
	if (p.room_bids.made > 0) {
		lines.push(
			`Messages ${p.name} opens to the whole room: ${p.room_bids.taken_up} of ${p.room_bids.made} picked up by someone.`,
		);
	}
	const s = p.structures;
	const groups: string[] = [];
	if (s.centre)
		groups.push(`centre of attention in ${plural(s.centre, "episode")}`);
	if (s.unattended) groups.push(`unattended in ${s.unattended}`);
	if (s.room) groups.push(`mostly talking to the room in ${s.room}`);
	if (groups.length) lines.push(`In groups: ${groups.join(", ")}.`);
	if (s.pair)
		lines.push(`In a back-and-forth pair in ${plural(s.pair, "episode")}.`);
	const sit = p.situations;
	const total = sit.one_on_one + sit.small_group + sit.large_group;
	if (total > 0) {
		lines.push(
			`Takes part in ${sit.one_on_one} one-on-one, ${sit.small_group} small-group (3-4) and ${sit.large_group} large-group (5+) conversations.`,
		);
	}
	const w = p.warmth;
	const gv = w.given.warm + w.given.neutral + w.given.cold;
	const rc = w.received.warm + w.received.neutral + w.received.cold;
	if (gv > 0) {
		lines.push(
			`Attention given is warm ${pct(w.given.warm / gv)}, cold ${pct(w.given.cold / gv)} of the time.`,
		);
	}
	if (rc > 0) {
		lines.push(
			`Attention received is warm ${pct(w.received.warm / rc)}, cold ${pct(w.received.cold / rc)} of the time.`,
		);
	}
	return lines;
}

function tonesText(tones: Record<string, number>): string {
	return Object.entries(tones)
		.sort((x, y) => y[1] - x[1])
		.slice(0, 3)
		.map(([t, n]) => `${t} ${n}`)
		.join(", ");
}

function valenceText(v: Record<Valence, number>): string {
	const total = v.warm + v.neutral + v.cold;
	return total > 0
		? `${pct(v.warm / total)} warm, ${pct(v.cold / total)} cold`
		: "";
}

export function describeEdge(e: AttentionEdge): string[] {
	const lines: string[] = [];
	lines.push(
		`${e.a_name} → ${e.b_name}: ${e.a_to_b} attention; ${e.b_name} → ${e.a_name}: ${e.b_to_a} (${pct(e.reciprocity)} balanced) across ${plural(e.episodes_together, "conversation")}.`,
	);
	const big = Math.max(e.a_to_b, e.b_to_a);
	if (big >= PURSUIT_MIN_MASS && e.reciprocity < PURSUIT_RETURN_RATIO) {
		const [from, to] =
			e.a_to_b >= e.b_to_a ? [e.a_name, e.b_name] : [e.b_name, e.a_name];
		lines.push(`${from} turns to ${to} far more than ${to} gives back.`);
	}
	for (const [from, to, bids] of [
		[e.a_name, e.b_name, e.bids_a_to_b],
		[e.b_name, e.a_name, e.bids_b_to_a],
	] as const) {
		if (bids.made > 0) {
			lines.push(
				`${from}'s bids to ${to} answered ${pct(bids.answered / bids.made)} of the time (${bids.answered} of ${bids.made}).`,
			);
		}
	}
	const { one_on_one: duo, group } = e.situations;
	if (duo + group > 0) {
		lines.push(`Together: ${duo} one-on-one, ${group} in groups.`);
	}
	if (e.channels.length) {
		lines.push(
			`Mostly in ${e.channels.map((c) => `#${c.name} (${c.episodes})`).join(", ")}.`,
		);
	}
	for (const [from, to, tones, valence] of [
		[e.a_name, e.b_name, e.tones_a_to_b, e.valence_a_to_b],
		[e.b_name, e.a_name, e.tones_b_to_a, e.valence_b_to_a],
	] as const) {
		const t = tonesText(tones);
		const v = valenceText(valence);
		if (t || v)
			lines.push(`${from} → ${to}: ${[t, v].filter(Boolean).join("; ")}.`);
	}
	return lines;
}

export function describeStructureOverview(s: SocialStructure): string[] {
	const lines: string[] = [];
	if (s.ranking.length) {
		const top = s.ranking.slice(0, 5);
		lines.push(
			`Attention flows toward: ${top.map((r) => `${r.name} (standing ${pct(r.standing)}, ${r.reach === 1 ? "1 person gives" : `${r.reach} people give`} them attention, bids answered ${pct(r.uptake)})`).join("; ")}.`,
		);
	}
	for (const c of s.cliques) {
		const tone = tonesText(c.tone);
		lines.push(
			`Group: ${c.members.map((m) => m.name).join(", ")} (${pct(c.internal_reciprocity)} reciprocal${tone ? `, ${tone}` : ""}).`,
		);
	}
	for (const p of s.periphery) {
		lines.push(
			`${p.name} makes bids but rarely gets answered (${p.bids} bids, ${pct(p.uptake)} answered${p.unattended_episodes ? `, unattended in ${plural(p.unattended_episodes, "conversation")}` : ""}).`,
		);
	}
	return lines;
}
