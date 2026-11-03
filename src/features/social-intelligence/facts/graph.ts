/**
 * Graph summary: the shape of the server's social network. Pairs, member counts and isolation
 * come from the closeness graph; hubs (attention standing) and communities (reciprocal-attention
 * cliques) come from the attention network so the server tool and dossiers agree with it.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { getSocialStructure } from "./attention";
import { getGuildGraph } from "./closeness";

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
const MAX_COMMUNITY_SIZE = 12;
const MIN_COMMUNITY_SIZE = 3;

export async function summarizeGraph(
	db: PostgreSQLManager,
	guildId: string,
): Promise<GraphSummary> {
	const [edges, membersResult, structure] = await Promise.all([
		getGuildGraph(db, guildId),
		db.query(
			`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
			 FROM members
			 WHERE guild_id = $1 AND active = true AND bot = false`,
			[guildId],
		),
		getSocialStructure(db, guildId),
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
	const hubs = structure.ranking
		.filter((r) => names.has(r.user_id))
		.slice(0, MAX_HUBS)
		.map((r) => ({
			...member(r.user_id),
			strength: Math.round(r.received),
		}));
	const strongestPairs = live.slice(0, MAX_PAIRS).map((e) => ({
		a: member(e.a),
		b: member(e.b),
		strength: Math.round(e.strength),
		reciprocity: e.reciprocity,
	}));

	const communities = structure.cliques
		.map((c) =>
			c.members
				.filter((m) => names.has(m.user_id))
				.slice(0, MAX_COMMUNITY_SIZE),
		)
		.filter((members) => members.length >= MIN_COMMUNITY_SIZE);

	return {
		members: names.size,
		connectedPairs: live.length,
		isolated: [...names.keys()].filter((id) => !totals.has(id)).length,
		hubs,
		strongestPairs,
		communities,
	};
}
