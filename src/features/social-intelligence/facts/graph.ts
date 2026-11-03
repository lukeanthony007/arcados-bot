/**
 * Graph summary: the shape of the server's social network (hubs, strongest pairs,
 * communities), computed from the closeness graph restricted to active, non-bot members.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { type GraphEdge, getGuildGraph } from "./closeness";

export interface GraphMember {
	user_id: string;
	name: string;
}

export interface GraphSummary {
	members: number;
	connectedPairs: number;
	isolated: number;
	hubs: Array<{ user_id: string; name: string; strength: number }>;
	strongestPairs: Array<{
		a: GraphMember;
		b: GraphMember;
		strength: number;
		reciprocity: number;
	}>;
	communities: GraphMember[][];
}

const MAX_HUBS = 10;
const MAX_PAIRS = 10;
const MAX_COMMUNITIES = 6;
const MAX_COMMUNITY_SIZE = 12;
const MIN_COMMUNITY_SIZE = 3;
const COMMUNITY_EDGE_FLOOR = 0.1;

/**
 * Deterministic label propagation: every node starts in its own community and repeatedly
 * adopts the label with the most edge weight among its neighbours (ties → smallest label),
 * in sorted node order.
 */
function findCommunities(edges: GraphEdge[]): Map<string, string> {
	const neighbours = new Map<string, Array<[string, number]>>();
	for (const e of edges) {
		if (!neighbours.has(e.a)) neighbours.set(e.a, []);
		if (!neighbours.has(e.b)) neighbours.set(e.b, []);
		neighbours.get(e.a)?.push([e.b, e.strength]);
		neighbours.get(e.b)?.push([e.a, e.strength]);
	}
	const nodes = [...neighbours.keys()].sort();
	const label = new Map(nodes.map((n) => [n, n]));
	for (let pass = 0; pass < 15; pass++) {
		let changed = false;
		for (const node of nodes) {
			const weight = new Map<string, number>();
			for (const [other, w] of neighbours.get(node) ?? []) {
				const l = label.get(other) as string;
				weight.set(l, (weight.get(l) ?? 0) + w);
			}
			let best = label.get(node) as string;
			let bestWeight = weight.get(best) ?? 0;
			for (const [l, w] of weight) {
				if (w > bestWeight || (w === bestWeight && l < best)) {
					best = l;
					bestWeight = w;
				}
			}
			if (best !== label.get(node)) {
				label.set(node, best);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return label;
}

export async function summarizeGraph(
	db: PostgreSQLManager,
	guildId: string,
): Promise<GraphSummary> {
	const [edges, membersResult] = await Promise.all([
		getGuildGraph(db, guildId),
		db.query(
			`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
			 FROM members
			 WHERE guild_id = $1 AND active = true AND bot = false`,
			[guildId],
		),
	]);
	if (!membersResult.success || !membersResult.data) {
		throw new Error(
			`Failed to load members: ${membersResult.error ?? "unknown error"}`,
		);
	}
	const names = new Map<string, string>(
		(membersResult.data as Array<{ user_id: string; name: string | null }>).map(
			(m) => [m.user_id, m.name ?? m.user_id],
		),
	);
	const member = (id: string): GraphMember => ({
		user_id: id,
		name: names.get(id) ?? id,
	});
	const live = edges
		.filter((e) => names.has(e.a) && names.has(e.b))
		.sort((x, y) => y.strength - x.strength);

	const totals = new Map<string, number>();
	for (const e of live) {
		totals.set(e.a, (totals.get(e.a) ?? 0) + e.strength);
		totals.set(e.b, (totals.get(e.b) ?? 0) + e.strength);
	}
	const hubs = [...totals.entries()]
		.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
		.slice(0, MAX_HUBS)
		.map(([id, strength]) => ({
			...member(id),
			strength: Math.round(strength),
		}));
	const strongestPairs = live.slice(0, MAX_PAIRS).map((e) => ({
		a: member(e.a),
		b: member(e.b),
		strength: Math.round(e.strength),
		reciprocity: e.reciprocity,
	}));

	const maxStrength = live[0]?.strength ?? 0;
	const labels = findCommunities(
		live.filter((e) => e.strength >= maxStrength * COMMUNITY_EDGE_FLOOR),
	);
	const groups = new Map<string, string[]>();
	for (const [id, l] of labels) {
		if (!groups.has(l)) groups.set(l, []);
		groups.get(l)?.push(id);
	}
	const communities = [...groups.values()]
		.filter((ids) => ids.length >= MIN_COMMUNITY_SIZE)
		.sort(
			(x, y) => y.length - x.length || (x[0] ?? "").localeCompare(y[0] ?? ""),
		)
		.slice(0, MAX_COMMUNITIES)
		.map((ids) =>
			ids
				.sort((x, y) => (totals.get(y) ?? 0) - (totals.get(x) ?? 0))
				.slice(0, MAX_COMMUNITY_SIZE)
				.map(member),
		);

	return {
		members: names.size,
		connectedPairs: live.length,
		isolated: [...names.keys()].filter((id) => !totals.has(id)).length,
		hubs,
		strongestPairs,
		communities,
	};
}
