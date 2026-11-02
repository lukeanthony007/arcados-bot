import type { DatabaseTool, ToolContext } from "../registry/DatabaseTools.js";

/**
 * Detect drama/conflict events in the server
 * Identifies high-conflict interactions between users with low affinity
 */
export const detectDramaEvents: DatabaseTool = {
  name: "detectDramaEvents",
  description:
    "Detect potential drama, conflicts, or 'beefs' between users in the server. Identifies pairs of users with low affinity but high interaction frequency, suggesting contentious relationships. Useful for queries like 'biggest beefs', 'who is fighting', 'drama summary'.",
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
        description: "Minimum number of interactions to consider (default: 10)",
      },
      maxAffinityPercent: {
        type: "number",
        description:
          "Maximum affinity percentage to consider as 'low affinity' (default: 30, meaning <30% affinity suggests conflict)",
      },
      limit: {
        type: "number",
        description: "Maximum number of drama pairs to return (default: 5)",
      },
    },
    required: [],
  },
  execute: async (params: any, context: ToolContext) => {
    try {
      const lookbackHours = Math.min(params.lookbackHours || 168, 720);
      const minInteractions = params.minInteractions || 10;
      const maxAffinityPercent = params.maxAffinityPercent || 30;
      const limit = Math.min(params.limit || 5, 10);

      const lookbackTime = new Date(
        Date.now() - lookbackHours * 60 * 60 * 1000
      );

      // Query relationship edges for low-affinity, high-interaction pairs.
      // Edges are directed (author → other), so both rows of a pair are merged first.
      const result = await context.db.query(
        `WITH re1 AS (
          SELECT
            LEAST(user_a, user_b) AS user_a,
            GREATEST(user_a, user_b) AS user_b,
            SUM(CASE WHEN user_a < user_b THEN msg_a_to_b ELSE msg_b_to_a END) AS msg_a_to_b,
            SUM(CASE WHEN user_a < user_b THEN msg_b_to_a ELSE msg_a_to_b END) AS msg_b_to_a,
            SUM(mentions) AS mentions,
            SUM(replies) AS replies,
            SUM(reactions) AS reactions,
            MAX(last_interaction) AS last_interaction
          FROM relationship_edges
          WHERE guild_id = $1 AND user_a <> user_b
            AND NOT EXISTS (
              SELECT 1 FROM members m
              WHERE m.guild_id = $1 AND m.user_id IN (user_a, user_b) AND m.bot
            )
          GROUP BY LEAST(user_a, user_b), GREATEST(user_a, user_b)
        )
        SELECT
          re1.user_a,
          re1.user_b,
          re1.msg_a_to_b,
          re1.msg_b_to_a,
          re1.mentions,
          re1.replies,
          re1.reactions,
          (re1.msg_a_to_b + re1.msg_b_to_a + re1.mentions + re1.replies + re1.reactions) as total_interactions,
          re1.last_interaction,
          -- Calculate affinity score (0-100 based on interaction diversity and frequency)
          CASE
            WHEN (re1.msg_a_to_b + re1.msg_b_to_a + re1.mentions + re1.replies + re1.reactions) = 0 THEN 0
            ELSE LEAST(100,
              (CASE WHEN re1.msg_a_to_b > 0 THEN 15 ELSE 0 END +
               CASE WHEN re1.msg_b_to_a > 0 THEN 15 ELSE 0 END +
               CASE WHEN re1.mentions > 0 THEN 20 ELSE 0 END +
               CASE WHEN re1.replies > 0 THEN 30 ELSE 0 END +
               CASE WHEN re1.reactions > 0 THEN 10 ELSE 0 END +
               LEAST(10, (re1.msg_a_to_b + re1.msg_b_to_a) / 2))
            )
          END as affinity_score
        FROM re1
        WHERE (re1.msg_a_to_b + re1.msg_b_to_a + re1.mentions + re1.replies + re1.reactions) >= $2
          AND re1.last_interaction >= $3
          AND CASE
            WHEN (re1.msg_a_to_b + re1.msg_b_to_a + re1.mentions + re1.replies + re1.reactions) = 0 THEN 0
            ELSE LEAST(100,
              (CASE WHEN re1.msg_a_to_b > 0 THEN 15 ELSE 0 END +
               CASE WHEN re1.msg_b_to_a > 0 THEN 15 ELSE 0 END +
               CASE WHEN re1.mentions > 0 THEN 20 ELSE 0 END +
               CASE WHEN re1.replies > 0 THEN 30 ELSE 0 END +
               CASE WHEN re1.reactions > 0 THEN 10 ELSE 0 END +
               LEAST(10, (re1.msg_a_to_b + re1.msg_b_to_a) / 2))
            )
          END <= $4
        ORDER BY total_interactions DESC, affinity_score ASC
        LIMIT $5`,
        [
          context.guildId,
          minInteractions,
          lookbackTime,
          maxAffinityPercent,
          limit,
        ]
      );

      if (!result.success || !result.data || result.data.length === 0) {
        return {
          success: true,
          summary: "No significant drama or conflicts detected",
          data: { dramaEvents: [] },
          formatted: `No drama detected with criteria: ${minInteractions}+ interactions, <${maxAffinityPercent}% affinity, past ${lookbackHours}h`,
        };
      }

      const dramaEvents = result.data;

      // Enrich with user names and message samples
      const enriched = await Promise.all(
        dramaEvents.map(async (event: any) => {
          // Get user A name
          const userAResult = await context.db.query(
            `SELECT display_name, username, global_name
             FROM members
             WHERE guild_id = $1 AND user_id = $2`,
            [context.guildId, event.user_a]
          );

          const userAName =
            userAResult.success &&
            userAResult.data &&
            userAResult.data.length > 0
              ? userAResult.data[0].display_name ||
                userAResult.data[0].global_name ||
                userAResult.data[0].username
              : "Unknown";

          // Get user B name
          const userBResult = await context.db.query(
            `SELECT display_name, username, global_name
             FROM members
             WHERE guild_id = $1 AND user_id = $2`,
            [context.guildId, event.user_b]
          );

          const userBName =
            userBResult.success &&
            userBResult.data &&
            userBResult.data.length > 0
              ? userBResult.data[0].display_name ||
                userBResult.data[0].global_name ||
                userBResult.data[0].username
              : "Unknown";

          // Get sample messages between these users (recent interactions)
          const messagesResult = await context.db.query(
            `SELECT m.content, m.created_at, m.author_id
             FROM messages m
             WHERE m.guild_id = $1
               AND m.created_at >= $2
               AND (
                 (m.author_id = $3 AND m.content LIKE '%' || $4 || '%') OR
                 (m.author_id = $4 AND m.content LIKE '%' || $3 || '%')
               )
             ORDER BY m.created_at DESC
             LIMIT 5`,
            [context.guildId, lookbackTime, event.user_a, event.user_b]
          );

          const sampleMessages =
            messagesResult.success && messagesResult.data
              ? messagesResult.data.map((msg: any) => ({
                  content:
                    msg.content.length > 100
                      ? `${msg.content.substring(0, 100)}...`
                      : msg.content,
                  timestamp: new Date(msg.created_at),
                  author:
                    msg.author_id === event.user_a ? userAName : userBName,
                }))
              : [];

          // Analyze sentiment (basic negative keyword detection)
          const negativeKeywords = [
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

          let negativeCount = 0;
          if (messagesResult.success && messagesResult.data) {
            for (const msg of messagesResult.data) {
              const content = (msg.content || "").toLowerCase();
              for (const keyword of negativeKeywords) {
                if (content.includes(keyword)) {
                  negativeCount++;
                  break;
                }
              }
            }
          }

          const sentimentScore = Math.max(
            0,
            100 - negativeCount * 15 - (100 - event.affinity_score)
          );

          // Calculate drama intensity (0-100)
          const dramaIntensity = Math.min(
            100,
            (event.total_interactions / 5 + // More interactions = more drama
              (100 - event.affinity_score) + // Lower affinity = more drama
              negativeCount * 10) / // Negative words = more drama
              2.5
          );

          return {
            userA: {
              id: event.user_a,
              name: userAName,
            },
            userB: {
              id: event.user_b,
              name: userBName,
            },
            metrics: {
              totalInteractions: event.total_interactions,
              messagesAToB: event.msg_a_to_b,
              messagesBToA: event.msg_b_to_a,
              mentions: event.mentions,
              replies: event.replies,
              reactions: event.reactions,
              affinityScore: event.affinity_score,
              sentimentScore,
              dramaIntensity: Math.round(dramaIntensity),
            },
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
                event.affinity_score < 20 && "Very low affinity",
                event.total_interactions > 50 && "High interaction frequency",
                negativeCount > 2 && "Negative language detected",
                event.replies > 10 && "Frequent back-and-forth",
              ].filter((i): i is string => typeof i === "string"),
            },
          };
        })
      );

      // Format as natural text
      const formatted = `Drama/Conflict Analysis (past ${lookbackHours}h):

${enriched
  .map(
    (
      drama: {
        lastInteraction: Date;
        userA: { name: string };
        userB: { name: string };
        analysis: { conflictLevel: string; indicators: string[] };
        metrics: {
          dramaIntensity: number;
          affinityScore: number;
          totalInteractions: number;
        };
        sampleMessages: Array<{ author: string; content: string }>;
      },
      i: number
    ) => {
      const hoursAgo = Math.round(
        (Date.now() - drama.lastInteraction.getTime()) / (1000 * 60 * 60)
      );
      const timeAgo =
        hoursAgo < 1
          ? "Less than 1 hour ago"
          : hoursAgo === 1
          ? "1 hour ago"
          : `${hoursAgo} hours ago`;

      return `${i + 1}. ${drama.userA.name} ↔ ${drama.userB.name}
   Conflict Level: ${drama.analysis.conflictLevel} (${
        drama.metrics.dramaIntensity
      }/100)
   Affinity: ${drama.metrics.affinityScore}% | Interactions: ${
        drama.metrics.totalInteractions
      }
   Last Interaction: ${timeAgo}
   Indicators: ${drama.analysis.indicators.join(", ") || "None"}
   ${
     drama.sampleMessages.length > 0
       ? `Recent Exchanges:
${drama.sampleMessages
  .map(
    (msg: { author: string; content: string }) =>
      `   • ${msg.author}: "${msg.content}"`
  )
  .join("\n")}`
       : ""
   }`;
    }
  )
  .join("\n\n")}

Total Drama Pairs Found: ${enriched.length}`;

      return {
        success: true,
        summary: `Detected ${enriched.length} potential drama/conflict pairs`,
        data: {
          dramaEvents: enriched,
          lookbackHours,
          criteria: {
            minInteractions,
            maxAffinityPercent,
          },
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
