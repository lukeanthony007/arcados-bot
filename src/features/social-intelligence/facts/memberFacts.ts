/**
 * Member facts: deterministic, cheap, always current. Computed from `messages` on demand.
 *
 * Everything here is a measurement, not a judgement: how much someone posts, when, how they
 * write, how they respond. Dossiers and tools quote these; nothing stores them.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";

/** Hours are reported in this zone (the server's members are overwhelmingly US-based) */
export const FACTS_TIME_ZONE = "America/New_York";

export interface MemberFacts {
	user_id: string;
	name: string;
	activity: {
		messages: number;
		messages_30d: number;
		/** ISO timestamps (facts are stored inside dossiers as JSON) */
		first_seen: string;
		last_seen: string;
		/** Distinct days with at least one message, as a share of days since first_seen (0-1) */
		active_day_share: number;
		/** Channels with ≥ 5% of their messages, busiest first */
		channels: Array<{ name: string; share: number }>;
	};
	style: {
		avg_length: number;
		/** Share of messages that are a single word or emoji */
		one_liner_share: number;
		lowercase_share: number;
		/** Share of messages with ALL CAPS words or repeated !/? */
		shouty_share: number;
		question_share: number;
		link_share: number;
		attachment_share: number;
		/** Share of messages containing lol/lmao/haha/💀/😭 */
		laugh_share: number;
		emoji_per_message: number;
		top_emojis: string[];
		/** Most-used custom server emoji, as `:name:` */
		top_custom_emojis: string[];
	};
	timing: {
		/** Share of messages per local hour, index 0-23 */
		hour_shares: number[];
		/** Local hours that together hold ~half of their messages, in order of use */
		peak_hours: number[];
		/** Share of messages between midnight and 5am local */
		night_share: number;
		/** Share of messages on Saturday/Sunday local */
		weekend_share: number;
	};
	responsiveness: {
		reply_share: number;
		replies_given: number;
		replies_received: number;
		/** Median minutes to reply to someone else's message (replies within 24h), null if none */
		median_reply_minutes: number | null;
		/** Share of their messages that start a run after ≥ 20 min of channel silence */
		conversation_starter_share: number;
	};
}

interface FactsRow {
	name: string;
	messages: string;
	messages_30d: string;
	first_seen: Date;
	last_seen: Date;
	active_days: string;
	avg_length: string;
	one_liner: string;
	lowercase: string;
	shouty: string;
	question: string;
	link: string;
	attachment: string;
	laugh: string;
	emoji_count: string;
	reply_share: string;
	night: string;
	weekend: string;
	replies_given: string;
	replies_received: string;
	median_reply_minutes: string | null;
	starters: string;
}

const EMOJI_PATTERN = "[\\U0001F300-\\U0001FAFF\\u2600-\\u27BF]";

export async function getMemberFacts(
	db: PostgreSQLManager,
	guildId: string,
	userId: string,
): Promise<MemberFacts | null> {
	const base = await db.query(
		`WITH msgs AS (
			SELECT m.id, m.channel_id, m.content, m.created_at, m.referenced_message_id,
				m.created_at AT TIME ZONE $3 AS local_at,
				COALESCE(cardinality(m.attachments), 0) > 0 AS has_attachment
			FROM messages m
			WHERE m.guild_id = $1 AND m.author_id = $2 AND m.active = true
		),
		replies_in AS (
			SELECT COUNT(*) AS n FROM messages r
			JOIN msgs ON msgs.id = r.referenced_message_id
			WHERE r.guild_id = $1 AND r.author_id <> $2
		),
		reply_latency AS (
			SELECT percentile_cont(0.5) WITHIN GROUP (
				ORDER BY EXTRACT(EPOCH FROM (msgs.created_at - p.created_at)) / 60
			) AS median_minutes
			FROM msgs JOIN messages p ON p.id = msgs.referenced_message_id
			WHERE p.author_id <> $2 AND msgs.created_at - p.created_at BETWEEN INTERVAL '0' AND INTERVAL '24 hours'
		),
		starters AS (
			SELECT COUNT(*) AS n FROM msgs
			WHERE NOT EXISTS (
				SELECT 1 FROM messages o
				WHERE o.guild_id = $1 AND o.channel_id = msgs.channel_id AND o.id <> msgs.id
				AND o.created_at BETWEEN msgs.created_at - INTERVAL '20 minutes' AND msgs.created_at
			)
		)
		SELECT
			COALESCE(mem.nick, mem.display_name, mem.global_name, mem.username, $2) AS name,
			COUNT(*) AS messages,
			COUNT(*) FILTER (WHERE msgs.created_at > NOW() - INTERVAL '30 days') AS messages_30d,
			MIN(msgs.created_at) AS first_seen,
			MAX(msgs.created_at) AS last_seen,
			COUNT(DISTINCT local_at::date) AS active_days,
			AVG(length(content)) FILTER (WHERE length(trim(content)) > 0) AS avg_length,
			AVG((content !~ '\\s' AND length(trim(content)) > 0)::int) AS one_liner,
			AVG((content ~ '^[a-z]' AND content !~ '[A-Z]')::int) FILTER (WHERE content ~ '[A-Za-z]') AS lowercase,
			AVG((content ~ '[!?]{2,}|\\m[A-Z]{4,}\\M')::int) AS shouty,
			AVG((content ~ '\\?')::int) AS question,
			AVG((content ~ 'https?://')::int) AS link,
			AVG(has_attachment::int) AS attachment,
			AVG((content ~* '\\m(lol|lmao|lmfao|haha|rofl)|💀|😭')::int) AS laugh,
			SUM((SELECT COUNT(*) FROM regexp_matches(content, '${EMOJI_PATTERN}|<a?:\\w+:\\d+>', 'g'))) AS emoji_count,
			AVG((referenced_message_id IS NOT NULL)::int) AS reply_share,
			AVG((EXTRACT(HOUR FROM local_at) < 5)::int) AS night,
			AVG((EXTRACT(ISODOW FROM local_at) >= 6)::int) AS weekend,
			COUNT(*) FILTER (WHERE referenced_message_id IS NOT NULL) AS replies_given,
			(SELECT n FROM replies_in) AS replies_received,
			(SELECT median_minutes FROM reply_latency) AS median_reply_minutes,
			(SELECT n FROM starters) AS starters
		FROM msgs
		LEFT JOIN members mem ON mem.guild_id = $1 AND mem.user_id = $2
		GROUP BY mem.nick, mem.display_name, mem.global_name, mem.username`,
		[guildId, userId, FACTS_TIME_ZONE],
	);
	const row: FactsRow | undefined = base.success ? base.data?.[0] : undefined;
	if (!row || Number(row.messages) === 0) return null;
	const messages = Number(row.messages);

	const [hours, channels, emojis, customEmojis] = await Promise.all([
		db.query(
			`SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $3)::int AS hour, COUNT(*)::float / $4 AS share
			FROM messages WHERE guild_id = $1 AND author_id = $2 AND active = true GROUP BY 1`,
			[guildId, userId, FACTS_TIME_ZONE, messages],
		),
		db.query(
			`SELECT COALESCE(c.name, m.channel_id) AS name, COUNT(*)::float / $3 AS share
			FROM messages m LEFT JOIN channels c ON c.id = m.channel_id
			WHERE m.guild_id = $1 AND m.author_id = $2 AND m.active = true
			GROUP BY 1 HAVING COUNT(*)::float / $3 >= 0.05 ORDER BY 2 DESC`,
			[guildId, userId, messages],
		),
		db.query(
			`SELECT e[1] AS emoji, COUNT(*) AS n FROM messages m,
				regexp_matches(m.content, '(${EMOJI_PATTERN})', 'g') AS e
			WHERE m.guild_id = $1 AND m.author_id = $2 AND m.active = true
			GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
			[guildId, userId],
		),
		db.query(
			`SELECT ':' || e[1] || ':' AS emoji, COUNT(*) AS n FROM messages m,
				regexp_matches(m.content, '<a?:(\\w+):\\d+>', 'g') AS e
			WHERE m.guild_id = $1 AND m.author_id = $2 AND m.active = true
			GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
			[guildId, userId],
		),
	]);

	const hourShares = new Array<number>(24).fill(0);
	for (const h of (hours.data ?? []) as Array<{
		hour: number;
		share: string;
	}>) {
		hourShares[h.hour] = Number(h.share);
	}
	const peakHours: number[] = [];
	let covered = 0;
	for (const [hour] of hourShares
		.map((share, hour) => [hour, share] as const)
		.sort((a, b) => b[1] - a[1])) {
		if (covered >= 0.5) break;
		peakHours.push(hour);
		covered += hourShares[hour] ?? 0;
	}

	const daysSinceFirst = Math.max(
		1,
		(Date.now() - new Date(row.first_seen).getTime()) / 86_400_000,
	);
	const num = (value: string | null | undefined) => Number(value ?? 0);
	return {
		user_id: userId,
		name: row.name,
		activity: {
			messages,
			messages_30d: num(row.messages_30d),
			first_seen: new Date(row.first_seen).toISOString(),
			last_seen: new Date(row.last_seen).toISOString(),
			active_day_share: Math.min(1, num(row.active_days) / daysSinceFirst),
			channels: (
				(channels.data ?? []) as Array<{ name: string; share: string }>
			).map((c) => ({
				name: c.name,
				share: Number(c.share),
			})),
		},
		style: {
			avg_length: Math.round(num(row.avg_length)),
			one_liner_share: num(row.one_liner),
			lowercase_share: num(row.lowercase),
			shouty_share: num(row.shouty),
			question_share: num(row.question),
			link_share: num(row.link),
			attachment_share: num(row.attachment),
			laugh_share: num(row.laugh),
			emoji_per_message: num(row.emoji_count) / messages,
			top_emojis: ((emojis.data ?? []) as Array<{ emoji: string }>).map(
				(e) => e.emoji,
			),
			top_custom_emojis: (
				(customEmojis.data ?? []) as Array<{ emoji: string }>
			).map((e) => e.emoji),
		},
		timing: {
			hour_shares: hourShares,
			peak_hours: peakHours,
			night_share: num(row.night),
			weekend_share: num(row.weekend),
		},
		responsiveness: {
			reply_share: num(row.reply_share),
			replies_given: num(row.replies_given),
			replies_received: num(row.replies_received),
			median_reply_minutes:
				row.median_reply_minutes === null
					? null
					: Math.round(Number(row.median_reply_minutes)),
			conversation_starter_share: num(row.starters) / messages,
		},
	};
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const hour = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

/** Facts as short prose lines for prompts and tool output */
export function describeMemberFacts(facts: MemberFacts): string[] {
	const { activity, style, timing, responsiveness } = facts;
	const lines = [
		`${activity.messages} messages since ${activity.first_seen.slice(0, 10)} (${activity.messages_30d} in the last 30 days, last seen ${activity.last_seen.slice(0, 10)}); posts on ${pct(activity.active_day_share)} of days`,
	];
	if (activity.channels.length) {
		lines.push(
			`Mostly in ${activity.channels.map((c) => `#${c.name} (${pct(c.share)})`).join(", ")}`,
		);
	}
	const styleBits = [
		`avg ${style.avg_length} chars`,
		`${pct(style.one_liner_share)} one-worders`,
		`${pct(style.lowercase_share)} all-lowercase`,
		style.shouty_share >= 0.05
			? `${pct(style.shouty_share)} shouty (caps/!!/??)`
			: null,
		`${pct(style.question_share)} questions`,
		`${pct(style.laugh_share)} with lol/lmao/haha/💀/😭`,
		style.link_share >= 0.05 ? `${pct(style.link_share)} links` : null,
		style.attachment_share >= 0.05
			? `${pct(style.attachment_share)} attachments`
			: null,
		`${style.emoji_per_message.toFixed(2)} emoji per message`,
	].filter((bit): bit is string => bit !== null);
	lines.push(`Writing: ${styleBits.join(", ")}`);
	const emojis = [...style.top_emojis, ...style.top_custom_emojis];
	if (emojis.length) lines.push(`Favourite emoji: ${emojis.join(" ")}`);
	lines.push(
		`Timing (${FACTS_TIME_ZONE}): peak hours ${timing.peak_hours.map(hour).join(", ")}; ${pct(timing.night_share)} between midnight and 5am; ${pct(timing.weekend_share)} on weekends`,
	);
	const latency =
		responsiveness.median_reply_minutes === null
			? "never replies with the reply feature"
			: `median ${responsiveness.median_reply_minutes} min to reply`;
	lines.push(
		`Responsiveness: ${pct(responsiveness.reply_share)} of messages are replies (${responsiveness.replies_given} given, ${responsiveness.replies_received} received), ${latency}; starts ${pct(responsiveness.conversation_starter_share)} of their messages after 20+ min of channel silence`,
	);
	return lines;
}
