/**
 * The affinity prior for attention attribution: for each member, the share of their EXPLICIT
 * attention (replies and direct mentions, last PRIOR_WINDOW_DAYS) that went to each other
 * member. Built from explicit signals only, so inferred attention never feeds its own evidence.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import type { AffinityPrior } from "./attention";

export const PRIOR_WINDOW_DAYS = 365;

export async function loadAffinityPrior(
	db: PostgreSQLManager,
	guildId: string,
	asOf = new Date(),
): Promise<AffinityPrior> {
	const result = await db.query(
		`WITH msgs AS (
			SELECT m.id, m.author_id, m.content, m.referenced_message_id
			FROM messages m
			JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
			WHERE m.guild_id = $1 AND m.active
			  AND m.created_at BETWEEN $2::timestamptz - make_interval(days => $3) AND $2::timestamptz
		),
		acts AS (
			SELECT m.author_id AS a, p.author_id AS b
			FROM msgs m JOIN msgs p ON p.id = m.referenced_message_id
			WHERE p.author_id <> m.author_id
			UNION ALL
			SELECT m.author_id, t.target
			FROM msgs m
			CROSS JOIN LATERAL (SELECT DISTINCT (regexp_matches(m.content, '<@!?(\\d+)>', 'g'))[1] AS target) t
			JOIN members tm ON tm.guild_id = $1 AND tm.user_id = t.target AND tm.bot = false
			WHERE m.content LIKE '%<@%'
			  AND array_length(regexp_split_to_array(m.content, '<@'), 1) <= 4
			  AND t.target <> m.author_id
		)
		SELECT a, b, COUNT(*)::float / SUM(COUNT(*)) OVER (PARTITION BY a) AS share
		FROM acts GROUP BY a, b`,
		[guildId, asOf, PRIOR_WINDOW_DAYS],
	);
	if (!result.success)
		throw new Error(`Loading affinity prior failed: ${result.error}`);
	const shares = new Map<string, number>();
	for (const row of (result.data ?? []) as Array<{
		a: string;
		b: string;
		share: number;
	}>) {
		shares.set(`${row.a}>${row.b}`, Number(row.share));
	}
	return (from, to) => shares.get(`${from}>${to}`) ?? 0;
}
