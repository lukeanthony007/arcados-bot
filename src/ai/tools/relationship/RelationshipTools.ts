import {
	type Connection,
	describeStrength,
	getConnections,
	getPairFacts,
} from "../../../features/social-intelligence/facts/closeness";
import {
	type DatabaseTool,
	type DatabaseToolResult,
	type ToolContext,
	formatConnection,
	resolveUserId,
} from "../registry/DatabaseTools";

const MEANING =
	"share = fraction of the person's own interactions that go to this connection; reciprocity = how balanced it is (1 = both sides engage equally, 0 = one-sided).";

function pct(value: number): string {
	return `${(value * 100).toFixed(0)}%`;
}

function failure(label: string, error: unknown): DatabaseToolResult {
	console.error(`🔸 Error in ${label}:`, error);
	return {
		success: false,
		error: error instanceof Error ? error.message : `Failed in ${label}`,
	};
}

async function memberName(
	context: ToolContext,
	userId: string,
): Promise<string> {
	const result = await context.db.query(
		`SELECT COALESCE(nick, display_name, global_name, username) AS name
		 FROM members WHERE guild_id = $1 AND user_id = $2`,
		[context.guildId, userId],
	);
	return (result.data?.[0]?.name as string | undefined) ?? userId;
}

async function resolvePair(
	first: string,
	second: string,
	context: ToolContext,
): Promise<{ a: string; b: string } | { error: string }> {
	const [a, b] = await Promise.all([
		resolveUserId(first, context.guildId, context.db),
		resolveUserId(second, context.guildId, context.db),
	]);
	if (!a.success || !a.userId)
		return { error: a.error ?? `Unknown user "${first}"` };
	if (!b.success || !b.userId)
		return { error: b.error ?? `Unknown user "${second}"` };
	return { a: a.userId, b: b.userId };
}

/**
 * A member's strongest connections
 */
export const getUserConnectionsTool: DatabaseTool = {
	name: "getUserConnections",
	description: `Get who a user interacts with most, strongest first. Closeness is computed from real replies, direct mentions and shared conversations (recent activity counts more). Each connection reports a plain label (very close / close / regular / occasional), the share of the user's interactions it represents, reciprocity, raw counts and last interaction. ${MEANING}`,
	parameters: {
		type: "object",
		properties: {
			userId: {
				type: "string",
				description:
					"Discord user ID or name of the person to get connections for",
			},
			limit: {
				type: "number",
				description: "Maximum number of connections to return (default: 10)",
			},
		},
		required: ["userId"],
	},
	execute: async (
		params: Record<string, unknown>,
		context: ToolContext,
	): Promise<string | DatabaseToolResult> => {
		const { userId, limit } = params as { userId: string; limit?: number };
		try {
			const resolved = await resolveUserId(userId, context.guildId, context.db);
			if (!resolved.success || !resolved.userId) {
				return {
					success: false,
					error: resolved.error ?? `Unknown user "${userId}"`,
				};
			}
			const subject = await memberName(context, resolved.userId);
			const connections = await getConnections(
				context.db,
				context.guildId,
				resolved.userId,
				limit || 10,
			);
			if (connections.length === 0) {
				return {
					success: true,
					summary: `No recorded interactions for ${subject}`,
					data: { user: subject, connections: [], count: 0 },
					formatted: `${subject} has no recorded interactions.`,
				};
			}
			return {
				success: true,
				summary: `Found ${connections.length} connection(s) for ${subject}`,
				data: { user: subject, connections, count: connections.length },
				formatted: `${subject}'s connections:\n${connections.map(formatConnection).join("\n")}`,
			};
		} catch (error) {
			return failure("getUserConnections", error);
		}
	},
};

/**
 * The relationship between two specific users
 */
export const getRelationshipTool: DatabaseTool = {
	name: "getRelationship",
	description: `Get the facts about how two specific users interact: closeness label, replies and mentions in each direction, shared conversations, reciprocity and last interaction. Says so plainly if they have never interacted. ${MEANING}`,
	parameters: {
		type: "object",
		properties: {
			user1Id: {
				type: "string",
				description: "First user: Discord user ID or name",
			},
			user2Id: {
				type: "string",
				description: "Second user: Discord user ID or name",
			},
		},
		required: ["user1Id", "user2Id"],
	},
	execute: async (
		params: Record<string, unknown>,
		context: ToolContext,
	): Promise<string | DatabaseToolResult> => {
		const { user1Id, user2Id } = params as { user1Id: string; user2Id: string };
		try {
			const pair = await resolvePair(user1Id, user2Id, context);
			if ("error" in pair) return { success: false, error: pair.error };
			const facts = await getPairFacts(
				context.db,
				context.guildId,
				pair.a,
				pair.b,
			);
			if (!facts) {
				return {
					success: true,
					summary: "These two users have never interacted",
					data: { interacted: false },
					formatted:
						"These two users have never interacted (no replies, direct mentions or shared conversations).",
				};
			}

			const a = facts.name;
			const subject = await memberName(context, pair.a);
			const { a_to_b: out, b_to_a: back } = facts;

			const lines = [
				`${subject} and ${a}: ${describeStrength(facts)} (${pct(facts.share)} of ${subject}'s interactions, ${pct(facts.reciprocity)} reciprocal)`,
				`${subject} → ${a}: ${out.replies} replies, ${out.mentions} mentions`,
				`${a} → ${subject}: ${back.replies} replies, ${back.mentions} mentions`,
				`Shared conversations: ${facts.shared_conversations}`,
				`Last interaction: ${new Date(facts.last_interaction).toLocaleDateString()}`,
			];
			const outTotal = out.replies + out.mentions;
			const backTotal = back.replies + back.mentions;
			if (outTotal > backTotal * 2 && outTotal > 0) {
				lines.push(
					`${subject} reaches out to ${a} much more than the reverse.`,
				);
			} else if (backTotal > outTotal * 2 && backTotal > 0) {
				lines.push(
					`${a} reaches out to ${subject} much more than the reverse.`,
				);
			}

			return {
				success: true,
				summary: `${describeStrength(facts)} relationship`,
				data: { interacted: true, facts },
				formatted: lines.join("\n"),
			};
		} catch (error) {
			return failure("getRelationship", error);
		}
	},
};

/**
 * People both users interact with
 */
export const getMutualConnectionsTool: DatabaseTool = {
	name: "getMutualConnections",
	description: `Find the people two users both interact with (within each one's 25 strongest connections), ordered by combined closeness. ${MEANING}`,
	parameters: {
		type: "object",
		properties: {
			user1Id: {
				type: "string",
				description: "First user: Discord user ID or name",
			},
			user2Id: {
				type: "string",
				description: "Second user: Discord user ID or name",
			},
		},
		required: ["user1Id", "user2Id"],
	},
	execute: async (
		params: Record<string, unknown>,
		context: ToolContext,
	): Promise<string | DatabaseToolResult> => {
		const { user1Id, user2Id } = params as { user1Id: string; user2Id: string };
		try {
			const pair = await resolvePair(user1Id, user2Id, context);
			if ("error" in pair) return { success: false, error: pair.error };
			const [first, second] = await Promise.all([
				getConnections(context.db, context.guildId, pair.a, 25),
				getConnections(context.db, context.guildId, pair.b, 25),
			]);
			const secondById = new Map<string, Connection>(
				second.map((c) => [c.user_id, c]),
			);
			const mutual = first
				.filter((c) => c.user_id !== pair.b && secondById.has(c.user_id))
				.map((c) => {
					const other = secondById.get(c.user_id) as Connection;
					return {
						name: c.name,
						user_id: c.user_id,
						with_user1: c,
						with_user2: other,
					};
				})
				.sort(
					(x, y) =>
						y.with_user1.share +
						y.with_user2.share -
						(x.with_user1.share + x.with_user2.share),
				);

			if (mutual.length === 0) {
				return {
					success: true,
					summary: "No mutual connections",
					data: { mutual: [], count: 0 },
					formatted:
						"These two users have no mutual connections among their top 25.",
				};
			}
			const formatted = mutual
				.map(
					(m) =>
						`${m.name}: ${describeStrength(m.with_user1)} with user 1 (${pct(m.with_user1.share)} of their interactions), ${describeStrength(m.with_user2)} with user 2 (${pct(m.with_user2.share)})`,
				)
				.join("\n");
			return {
				success: true,
				summary: `Found ${mutual.length} mutual connection(s)`,
				data: { mutual, count: mutual.length },
				formatted,
			};
		} catch (error) {
			return failure("getMutualConnections", error);
		}
	},
};

export const relationshipTools: DatabaseTool[] = [
	getUserConnectionsTool,
	getRelationshipTool,
	getMutualConnectionsTool,
];
