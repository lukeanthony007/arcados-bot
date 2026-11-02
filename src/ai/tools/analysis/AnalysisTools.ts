import {
  type DatabaseTool,
  type ToolContext,
  type DatabaseToolResult,
} from "../registry/DatabaseTools";

function scoreNiceness(text: string): number {
  const content = (text || "").toLowerCase();
  // Simple lexicon; extend over time. Values roughly in [-2, +2]
  const positive = [
    "thanks",
    "thank you",
    "please",
    "welcome",
    "appreciate",
    "nice",
    "good",
    "great",
    "love",
    "awesome",
    ":)",
    "<3",
  ];
  const negative = [
    "hate",
    "stupid",
    "idiot",
    "dumb",
    "trash",
    "shit",
    "fuck",
    "asshole",
    "bitch",
    "loser",
    ":(",
  ];

  let score = 0;
  for (const p of positive) if (content.includes(p)) score += 1;
  for (const n of negative) if (content.includes(n)) score -= 1;
  // Normalize: clamp to [-2, 2]
  if (score > 2) score = 2;
  if (score < -2) score = -2;
  return score;
}

export const rankUsersByNicenessTool: DatabaseTool = {
  name: "rankUsersByNiceness",
  description:
    "Rank users by 'niceness' of their recent messages in the guild using a lightweight sentiment heuristic.",
  parameters: {
    type: "object",
    properties: {
      lookbackHours: {
        type: "number",
        description: "Hours to look back (default: 72)",
      },
      lookbackDays: {
        type: "number",
        description: "Days to look back (alternative to hours)",
      },
      minMessages: {
        type: "number",
        description: "Minimum messages required to include a user (default: 10)",
      },
      limitUsers: {
        type: "number",
        description: "Max users to include in the ranking (default: 20)",
      },
      channelId: {
        type: "string",
        description: "Optional channel scope",
      },
    },
    required: [],
  },
  execute: async (
    params: {
      lookbackHours?: number;
      lookbackDays?: number;
      minMessages?: number;
      limitUsers?: number;
      channelId?: string;
    },
    context: ToolContext
  ): Promise<string | DatabaseToolResult> => {
    try {
      const hours = params.lookbackDays
        ? params.lookbackDays * 24
        : params.lookbackHours || 72;
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      const minMessages = Math.max(1, params.minMessages || 10);
      const limitUsers = Math.max(1, Math.min(params.limitUsers || 20, 50));

      // Fetch recent messages; we aggregate per author in memory for simple scoring
      let query = `SELECT m.author_id, m.channel_id, m.content, m.created_at,
                          mem.display_name, mem.username
                   FROM messages m
                   JOIN members mem ON mem.user_id = m.author_id AND mem.guild_id = m.guild_id
                   WHERE m.guild_id = $1 AND m.active = true AND m.created_at >= $2`;
      const args: any[] = [context.guildId, since];
      if (params.channelId) {
        query += ` AND m.channel_id = $3`;
        args.push(params.channelId);
      }
      // Reasonable cap for analysis window
      query += ` ORDER BY m.created_at DESC LIMIT ${params.channelId ? 3000 : 6000}`;

      const result = await context.db.query(query, args);
      if (!result.success || !result.data) {
        return { success: false, error: "Failed to fetch messages for analysis" };
      }

      const byUser = new Map<string, {
        name: string;
        messages: string[];
        scores: number[];
      }>();

      for (const row of result.data) {
        const uid: string = row.author_id;
        const name: string = row.display_name || row.username || uid;
        if (!byUser.has(uid)) byUser.set(uid, { name, messages: [], scores: [] });
        const entry = byUser.get(uid)!;
        const content = row.content || "";
        entry.messages.push(content);
        entry.scores.push(scoreNiceness(content));
      }

      // Compute averages and filter by activity threshold
      const ranked = Array.from(byUser.entries())
        .map(([userId, data]) => {
          const count = data.scores.length;
          const avg = count > 0 ? data.scores.reduce((a, b) => a + b, 0) / count : 0;
          return { userId, name: data.name, count, avg };
        })
        .filter((r) => r.count >= minMessages)
        // Primary: niceness avg desc; Secondary: message count desc
        .sort((a, b) => (b.avg - a.avg) || (b.count - a.count))
        .slice(0, limitUsers);

      if (ranked.length === 0) {
        return {
          success: true,
          summary: `No users met the activity threshold in the last ${hours}h`,
          data: { formatted: "No ranking available", ranking: [], count: 0 },
        };
      }

      // Map avg in [-2,2] => rating 1..10
      const toTen = (avg: number) => {
        const scaled = Math.round(((avg + 2) / 4) * 9) + 1; // 1..10
        return Math.max(1, Math.min(10, scaled));
      };

      const formatted = ranked
        .map((r, idx) => {
          const rating = toTen(r.avg);
          const position = 10 - idx >= 1 ? rating : rating; // keep rating as computed
          return `${rating} - ${r.name} (avg: ${r.avg.toFixed(2)}, msgs: ${r.count})`;
        })
        .join("\n");

      return {
        success: true,
        summary: `Ranked ${ranked.length} user(s) by niceness over ~${hours}h`,
        data: { formatted, ranking: ranked, count: ranked.length },
      };
    } catch (error) {
      console.error("🔸 Error in rankUsersByNiceness:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to rank users by niceness",
      };
    }
  },
};

export const compareUsersTool: DatabaseTool = {
	name: "compareUsers",
	description:
		"Compare two users across multiple metrics including activity (message count), relationships (affinity score, friend count), and niceness (sentiment). Useful for queries like 'who is more active, X or Y?', 'who has more friends?', 'who is nicer?'",
	parameters: {
		type: "object",
		properties: {
			user1Id: {
				type: "string",
				description: "First user ID to compare",
			},
			user2Id: {
				type: "string",
				description: "Second user ID to compare",
			},
			metric: {
				type: "string",
				description:
					"Metric to compare (activity, relationships, niceness, or all)",
				enum: ["activity", "relationships", "niceness", "all"],
			},
			lookbackDays: {
				type: "number",
				description:
					"Days to look back for activity and niceness metrics (default: 30)",
			},
		},
		required: ["user1Id", "user2Id", "metric"],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const { user1Id, user2Id, metric } = params;
			const lookbackDays = params.lookbackDays || 30;
			const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

			// Get user info for both users
			const user1Result = await context.db.query(
				`SELECT display_name, username, global_name FROM members WHERE guild_id = $1 AND user_id = $2`,
				[context.guildId, user1Id]
			);

			const user2Result = await context.db.query(
				`SELECT display_name, username, global_name FROM members WHERE guild_id = $1 AND user_id = $2`,
				[context.guildId, user2Id]
			);

			if (
				!user1Result.success ||
				!user1Result.data ||
				user1Result.data.length === 0
			) {
				return {
					success: false,
					error: `User 1 (${user1Id}) not found in guild`,
				};
			}

			if (
				!user2Result.success ||
				!user2Result.data ||
				user2Result.data.length === 0
			) {
				return {
					success: false,
					error: `User 2 (${user2Id}) not found in guild`,
				};
			}

			const user1Name =
				user1Result.data[0].display_name ||
				user1Result.data[0].global_name ||
				user1Result.data[0].username;
			const user2Name =
				user2Result.data[0].display_name ||
				user2Result.data[0].global_name ||
				user2Result.data[0].username;

			const comparison: any = {
				user1: { id: user1Id, name: user1Name },
				user2: { id: user2Id, name: user2Name },
				metrics: {},
				winner: {},
			};

			// Activity comparison
			if (metric === "activity" || metric === "all") {
				const user1MessagesResult = await context.db.query(
					`SELECT COUNT(*) as count FROM messages WHERE guild_id = $1 AND author_id = $2 AND created_at >= $3`,
					[context.guildId, user1Id, since]
				);

				const user2MessagesResult = await context.db.query(
					`SELECT COUNT(*) as count FROM messages WHERE guild_id = $1 AND author_id = $2 AND created_at >= $3`,
					[context.guildId, user2Id, since]
				);

				const user1Count = user1MessagesResult.data?.[0]?.count || 0;
				const user2Count = user2MessagesResult.data?.[0]?.count || 0;

				comparison.metrics.activity = {
					user1Messages: user1Count,
					user2Messages: user2Count,
					difference: Math.abs(user1Count - user2Count),
					percentageDifference:
						user1Count > 0 || user2Count > 0
							? (Math.abs(user1Count - user2Count) /
									Math.max(user1Count, user2Count)) *
								100
							: 0,
				};

				comparison.winner.activity =
					user1Count > user2Count
						? user1Name
						: user2Count > user1Count
							? user2Name
							: "Tie";
			}

			// Relationships comparison
			if (metric === "relationships" || metric === "all") {
				// Edges are directed (author → other); aggregate both rows of each pair the user is in
				const relationshipStatsQuery = `
					WITH pairs AS (
						SELECT
							SUM(CASE WHEN user_a = $2 THEN msg_a_to_b ELSE msg_b_to_a END) AS sent,
							SUM(CASE WHEN user_a = $2 THEN msg_b_to_a ELSE msg_a_to_b END) AS received,
							SUM(mentions) AS mentions,
							SUM(replies) AS replies,
							SUM(reactions) AS reactions
						FROM relationship_edges
						WHERE guild_id = $1 AND $2 IN (user_a, user_b) AND user_a <> user_b
							AND NOT EXISTS (
								SELECT 1 FROM members m
								WHERE m.guild_id = $1 AND m.user_id IN (user_a, user_b) AND m.bot
							)
						GROUP BY LEAST(user_a, user_b), GREATEST(user_a, user_b)
					)
					SELECT COUNT(*) AS friend_count,
						AVG(LEAST(100,
							CASE WHEN sent > 0 THEN 15 ELSE 0 END +
							CASE WHEN received > 0 THEN 15 ELSE 0 END +
							CASE WHEN mentions > 0 THEN 20 ELSE 0 END +
							CASE WHEN replies > 0 THEN 30 ELSE 0 END +
							CASE WHEN reactions > 0 THEN 10 ELSE 0 END +
							LEAST(10, (sent + received) / 2)
						)) AS avg_affinity
					FROM pairs
					WHERE sent + received + mentions + replies + reactions >= 5`;
				const user1RelResult = await context.db.query(relationshipStatsQuery, [
					context.guildId,
					user1Id,
				]);
				const user2RelResult = await context.db.query(relationshipStatsQuery, [
					context.guildId,
					user2Id,
				]);

				const user1FriendCount = Number.parseInt(
					user1RelResult.data?.[0]?.friend_count || "0"
				);
				const user2FriendCount = Number.parseInt(
					user2RelResult.data?.[0]?.friend_count || "0"
				);
				const user1Affinity = Number.parseFloat(
					user1RelResult.data?.[0]?.avg_affinity || "0"
				);
				const user2Affinity = Number.parseFloat(
					user2RelResult.data?.[0]?.avg_affinity || "0"
				);

				comparison.metrics.relationships = {
					user1: {
						friendCount: user1FriendCount,
						avgAffinity: user1Affinity.toFixed(1),
					},
					user2: {
						friendCount: user2FriendCount,
						avgAffinity: user2Affinity.toFixed(1),
					},
					friendCountDifference: Math.abs(user1FriendCount - user2FriendCount),
					affinityDifference: Math.abs(user1Affinity - user2Affinity).toFixed(1),
				};

				comparison.winner.relationships =
					user1FriendCount > user2FriendCount
						? user1Name
						: user2FriendCount > user1FriendCount
							? user2Name
							: user1Affinity > user2Affinity
								? user1Name
								: user2Affinity > user1Affinity
									? user2Name
									: "Tie";
			}

			// Niceness comparison
			if (metric === "niceness" || metric === "all") {
				const user1MsgsResult = await context.db.query(
					`SELECT content FROM messages WHERE guild_id = $1 AND author_id = $2 AND created_at >= $3 ORDER BY created_at DESC LIMIT 100`,
					[context.guildId, user1Id, since]
				);

				const user2MsgsResult = await context.db.query(
					`SELECT content FROM messages WHERE guild_id = $1 AND author_id = $2 AND created_at >= $3 ORDER BY created_at DESC LIMIT 100`,
					[context.guildId, user2Id, since]
				);

				const user1Scores =
					user1MsgsResult.data?.map((row: any) =>
						scoreNiceness(row.content || "")
					) || [];
				const user2Scores =
					user2MsgsResult.data?.map((row: any) =>
						scoreNiceness(row.content || "")
					) || [];

				const user1Avg =
					user1Scores.length > 0
						? user1Scores.reduce((a, b) => a + b, 0) / user1Scores.length
						: 0;
				const user2Avg =
					user2Scores.length > 0
						? user2Scores.reduce((a, b) => a + b, 0) / user2Scores.length
						: 0;

				// Map to 1-10 scale
				const toTen = (avg: number) => {
					const scaled = Math.round(((avg + 2) / 4) * 9) + 1;
					return Math.max(1, Math.min(10, scaled));
				};

				comparison.metrics.niceness = {
					user1Score: user1Avg.toFixed(2),
					user2Score: user2Avg.toFixed(2),
					user1Rating: toTen(user1Avg),
					user2Rating: toTen(user2Avg),
					difference: Math.abs(user1Avg - user2Avg).toFixed(2),
				};

				comparison.winner.niceness =
					user1Avg > user2Avg
						? user1Name
						: user2Avg > user1Avg
							? user2Name
							: "Tie";
			}

			// Generate formatted summary
			let formatted = `Comparison: ${user1Name} vs ${user2Name}\n\n`;

			if (comparison.metrics.activity) {
				formatted += `📊 ACTIVITY (past ${lookbackDays} days):\n`;
				formatted += `   ${user1Name}: ${comparison.metrics.activity.user1Messages} messages\n`;
				formatted += `   ${user2Name}: ${comparison.metrics.activity.user2Messages} messages\n`;
				formatted += `   Winner: ${comparison.winner.activity}\n\n`;
			}

			if (comparison.metrics.relationships) {
				formatted += `🤝 RELATIONSHIPS:\n`;
				formatted += `   ${user1Name}: ${comparison.metrics.relationships.user1.friendCount} connections (avg ${comparison.metrics.relationships.user1.avgAffinity}% affinity)\n`;
				formatted += `   ${user2Name}: ${comparison.metrics.relationships.user2.friendCount} connections (avg ${comparison.metrics.relationships.user2.avgAffinity}% affinity)\n`;
				formatted += `   Winner: ${comparison.winner.relationships}\n\n`;
			}

			if (comparison.metrics.niceness) {
				formatted += `😊 NICENESS (past ${lookbackDays} days):\n`;
				formatted += `   ${user1Name}: ${comparison.metrics.niceness.user1Rating}/10 (score: ${comparison.metrics.niceness.user1Score})\n`;
				formatted += `   ${user2Name}: ${comparison.metrics.niceness.user2Rating}/10 (score: ${comparison.metrics.niceness.user2Score})\n`;
				formatted += `   Winner: ${comparison.winner.niceness}\n\n`;
			}

			// Overall winner
			const winners = Object.values(comparison.winner).filter(
				(w) => w !== "Tie"
			);
			const user1Wins = winners.filter((w) => w === user1Name).length;
			const user2Wins = winners.filter((w) => w === user2Name).length;

			formatted += `🏆 OVERALL: `;
			if (user1Wins > user2Wins) {
				formatted += `${user1Name} wins (${user1Wins}/${winners.length} metrics)`;
			} else if (user2Wins > user1Wins) {
				formatted += `${user2Name} wins (${user2Wins}/${winners.length} metrics)`;
			} else {
				formatted += `Tie`;
			}

			return {
				success: true,
				summary: `Compared ${user1Name} and ${user2Name} across ${metric} metric(s)`,
				data: { comparison, formatted },
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in compareUsers:", error);
			return {
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to compare users",
			};
		}
	},
};

export const analysisTools: DatabaseTool[] = [
	rankUsersByNicenessTool,
	compareUsersTool,
];


