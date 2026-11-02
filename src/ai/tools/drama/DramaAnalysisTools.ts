import {
	describeStrength,
	getPairFacts,
} from "../../../features/social-intelligence/facts/closeness";
import type { DatabaseTool, ToolContext } from "../registry/DatabaseTools.js";

const NEGATIVE_KEYWORDS = [
	"hate",
	"stupid",
	"idiot",
	"dumb",
	"shut up",
	"wrong",
	"disagree",
	"annoying",
	"cringe",
	"toxic",
	"trash",
];

interface ExchangeRow {
	user_a: string;
	user_b: string;
	a_to_b: string;
	b_to_a: string;
	last_interaction: Date;
}

/**
 * Detect heated recent exchanges in the server.
 * Finds pairs with many replies to each other inside the lookback window, then checks the
 * recent replies for negative language. Long-term closeness is context, not a filter.
 */
export const detectDramaEvents: DatabaseTool = {
	name: "detectDramaEvents",
	description:
		"Detect potential drama or 'beefs': pairs of users with a lot of recent back-and-forth replies, scored by volume and negative language in their latest replies. Each pair includes how close they are over the long term (so long-time friends bantering are distinguishable from new antagonists) and sample exchanges. Intensity is a heuristic from reply volume plus negative-word hits, not a measured sentiment. Useful for queries like 'biggest beefs', 'who is fighting', 'drama summary'.",
	parameters: {
		type: "object",
		properties: {
			lookbackHours: {
				type: "number",
				description:
					"How many hours to look back for drama detection (default: 168 for 7 days, max: 720 for 30 days)",
			},
			minInteractions: {
				type: "number",
				description:
					"Minimum number of replies between the pair in the window to consider (default: 10)",
			},
			limit: {
				type: "number",
				description: "Maximum number of drama pairs to return (default: 5)",
			},
		},
		required: [],
	},
	execute: async (params: Record<string, unknown>, context: ToolContext) => {
		try {
			const lookbackHours = Math.min(Number(params.lookbackHours) || 168, 720);
			const minInteractions = Number(params.minInteractions) || 10;
			const limit = Math.min(Number(params.limit) || 5, 10);

			const lookbackTime = new Date(
				Date.now() - lookbackHours * 60 * 60 * 1000,
			);

			// Replies between each human pair inside the window, both directions merged
			const result = await context.db.query(
				`SELECT
           LEAST(m.author_id, p.author_id) AS user_a,
           GREATEST(m.author_id, p.author_id) AS user_b,
           COUNT(*) FILTER (WHERE m.author_id < p.author_id) AS a_to_b,
           COUNT(*) FILTER (WHERE m.author_id > p.author_id) AS b_to_a,
           MAX(m.created_at) AS last_interaction
         FROM messages m
         JOIN messages p ON p.id = m.referenced_message_id
         JOIN members ma ON ma.guild_id = m.guild_id AND ma.user_id = m.author_id AND ma.bot = false
         JOIN members mb ON mb.guild_id = m.guild_id AND mb.user_id = p.author_id AND mb.bot = false
         WHERE m.guild_id = $1 AND m.active = true AND m.created_at >= $2
           AND m.author_id <> p.author_id
         GROUP BY 1, 2
         HAVING COUNT(*) >= $3
         ORDER BY COUNT(*) DESC
         LIMIT $4`,
				[context.guildId, lookbackTime, minInteractions, limit],
			);

			if (!result.success || !result.data || result.data.length === 0) {
				return {
					success: true,
					summary: "No significant drama or conflicts detected",
					data: { dramaEvents: [] },
					formatted: `No drama detected with criteria: ${minInteractions}+ replies between a pair, past ${lookbackHours}h`,
				};
			}

			const exchanges: ExchangeRow[] = result.data;

			const ids = [...new Set(exchanges.flatMap((e) => [e.user_a, e.user_b]))];
			const namesResult = await context.db.query(
				`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
         FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
				[context.guildId, ids],
			);
			const names = new Map<string, string>(
				(namesResult.data ?? []).map((m: { user_id: string; name: string }) => [
					m.user_id,
					m.name,
				]),
			);

			const enriched = await Promise.all(
				exchanges.map(async (event) => {
					const userAName = names.get(event.user_a) ?? "Unknown";
					const userBName = names.get(event.user_b) ?? "Unknown";
					const repliesAToB = Number(event.a_to_b);
					const repliesBToA = Number(event.b_to_a);
					const totalReplies = repliesAToB + repliesBToA;

					const [messagesResult, facts] = await Promise.all([
						context.db.query(
							`SELECT m.content, m.created_at, m.author_id
               FROM messages m
               JOIN messages p ON p.id = m.referenced_message_id
               WHERE m.guild_id = $1 AND m.active = true AND m.created_at >= $2
                 AND ((m.author_id = $3 AND p.author_id = $4)
                   OR (m.author_id = $4 AND p.author_id = $3))
               ORDER BY m.created_at DESC
               LIMIT 5`,
							[context.guildId, lookbackTime, event.user_a, event.user_b],
						),
						getPairFacts(
							context.db,
							context.guildId,
							event.user_a,
							event.user_b,
						),
					]);

					const samples: Array<{ content: string; author_id: string }> =
						messagesResult.success && messagesResult.data
							? messagesResult.data
							: [];

					const sampleMessages = samples.map((msg) => ({
						content:
							msg.content.length > 100
								? `${msg.content.substring(0, 100)}...`
								: msg.content,
						author: msg.author_id === event.user_a ? userAName : userBName,
					}));

					const negativeCount = samples.filter((msg) => {
						const content = (msg.content || "").toLowerCase();
						return NEGATIVE_KEYWORDS.some((keyword) =>
							content.includes(keyword),
						);
					}).length;

					// Heuristic: reply volume plus negative-word hits in the latest replies
					const dramaIntensity = Math.min(
						100,
						Math.min(60, totalReplies * 2) + negativeCount * 10,
					);
					const longTermCloseness = facts
						? describeStrength(facts)
						: "never interacted before";

					return {
						userA: { id: event.user_a, name: userAName },
						userB: { id: event.user_b, name: userBName },
						metrics: {
							recentReplies: totalReplies,
							repliesAToB,
							repliesBToA,
							negativeSamples: negativeCount,
							dramaIntensity,
						},
						longTermCloseness,
						lastInteraction: new Date(event.last_interaction),
						sampleMessages,
						analysis: {
							conflictLevel:
								dramaIntensity > 70
									? "High"
									: dramaIntensity > 40
										? "Moderate"
										: "Low",
							indicators: [
								totalReplies > 50 && "Very high reply volume",
								negativeCount > 2 && "Negative language detected",
								facts &&
									facts.share >= 0.1 &&
									"Close pair, may be friendly banter",
								!facts && "No prior history together",
							].filter((i): i is string => typeof i === "string"),
						},
					};
				}),
			);

			const formatted = `Drama/Conflict Analysis (past ${lookbackHours}h):

${enriched
	.map((drama, i) => {
		const hoursAgo = Math.round(
			(Date.now() - drama.lastInteraction.getTime()) / (1000 * 60 * 60),
		);
		const timeAgo =
			hoursAgo < 1
				? "Less than 1 hour ago"
				: hoursAgo === 1
					? "1 hour ago"
					: `${hoursAgo} hours ago`;
		const exchange =
			drama.sampleMessages.length > 0
				? `\n   Recent Exchanges:\n${drama.sampleMessages
						.map((msg) => `   • ${msg.author}: "${msg.content}"`)
						.join("\n")}`
				: "";

		return `${i + 1}. ${drama.userA.name} ↔ ${drama.userB.name}
   Conflict Level: ${drama.analysis.conflictLevel} (${drama.metrics.dramaIntensity}/100)
   Recent replies: ${drama.metrics.recentReplies} (${drama.metrics.repliesAToB} / ${drama.metrics.repliesBToA}) | Long-term: ${drama.longTermCloseness}
   Last Interaction: ${timeAgo}
   Indicators: ${drama.analysis.indicators.join(", ") || "None"}${exchange}`;
	})
	.join("\n\n")}

Total Drama Pairs Found: ${enriched.length}`;

			return {
				success: true,
				summary: `Detected ${enriched.length} potential drama/conflict pairs`,
				data: {
					dramaEvents: enriched,
					lookbackHours,
					criteria: { minInteractions },
				},
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in detectDramaEvents:", error);
			return {
				success: false,
				error: "Unable to detect drama events",
			};
		}
	},
};

export const dramaAnalysisTools = [detectDramaEvents];
