#!/usr/bin/env bun
/**
 * Show how the segmentation rule groups one day of one channel, without writing anything:
 * each conversation with its session, speakers, time range and first lines; loose messages
 * (not in any conversation) listed at the end.
 *
 *   bun run conversations:day 2025-10-15            # busiest channel that day
 *   bun run conversations:day 2025-10-15 chat       # a named channel
 *   bun run conversations:day 2025-10-15 chat --all # every message, with its conversation
 */

import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { FACTS_TIME_ZONE } from "../../facts/memberFacts";
import { type SegmentMessage, segment } from "../segmenter";

interface Row {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
	content: string;
	name: string;
}

async function main() {
	const [day, channelArg, ...flags] = process.argv.slice(2);
	if (!day) throw new Error("Usage: show-day <YYYY-MM-DD> [channel] [--all]");
	const guildId = config.guildId;
	if (!guildId) throw new Error("GUILD_ID is not configured");
	const db = new PostgreSQLManager();
	if (!(await db.connect())) throw new Error("Failed to connect to database");

	const channel = await db.query(
		`SELECT m.channel_id, c.name, COUNT(*)::int AS n
		 FROM messages m JOIN channels c ON c.id = m.channel_id
		 JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
		 WHERE m.guild_id = $1 AND (m.created_at AT TIME ZONE $2)::date = $3::date
		   AND ($4::text IS NULL OR c.name = $4)
		 GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`,
		[guildId, FACTS_TIME_ZONE, day, channelArg ?? null],
	);
	const target = channel.data?.[0] as
		| { channel_id: string; name: string; n: number }
		| undefined;
	if (!target) throw new Error("No messages that day");

	// The whole day plus a margin so runs crossing midnight are intact
	const rows = (
		await db.query(
			`SELECT m.id, m.author_id, m.created_at, m.referenced_message_id, m.content,
				COALESCE(x.nick, x.display_name, x.username) AS name
			 FROM messages m JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
			 WHERE m.guild_id = $1 AND m.channel_id = $2 AND m.active
			   AND m.created_at >= ($3::date::timestamp AT TIME ZONE $4) - INTERVAL '6 hours'
			   AND m.created_at < ($3::date::timestamp AT TIME ZONE $4) + INTERVAL '30 hours'
			   AND m.content !~* '^\\s*(m!|!|\\$|/)[a-z]'
			 ORDER BY m.created_at, m.id`,
			[guildId, target.channel_id, day, FACTS_TIME_ZONE],
		)
	).data as Row[];
	const names = new Map(rows.map((r) => [r.author_id, r.name]));
	const authors = new Set(rows.map((r) => r.author_id));
	const messages: SegmentMessage[] = rows.map((r) => {
		const mentioned = [...r.content.matchAll(/<@!?(\d+)>/g)].map(
			(m) => m[1] as string,
		);
		return {
			id: r.id,
			author_id: r.author_id,
			created_at: new Date(r.created_at),
			referenced_message_id: r.referenced_message_id,
			mentions:
				mentioned.length > 3
					? []
					: [...new Set(mentioned)].filter(
							(id) => id !== r.author_id && authors.has(id),
						),
		};
	});
	const text = new Map(
		rows.map((r) => [r.id, r.content.replace(/\s+/g, " ").slice(0, 72)]),
	);
	const clock = (d: Date) =>
		d.toLocaleTimeString("en-GB", {
			timeZone: FACTS_TIME_ZONE,
			hour: "2-digit",
			minute: "2-digit",
		});
	const inDay = (d: Date) =>
		d.toLocaleDateString("en-CA", { timeZone: FACTS_TIME_ZONE }) === day;

	const conversations = segment(target.channel_id, messages).filter(
		(s) => inDay(s.start) || inDay(s.end),
	);
	const covered = new Set(
		conversations.flatMap((s) => s.messages.map((m) => m.id)),
	);
	const dayMessages = messages.filter((m) => inDay(m.created_at));
	console.log(
		`#${target.name} on ${day}: ${dayMessages.length} messages, ${conversations.length} conversations in ${new Set(conversations.map((s) => s.session_id)).size} sessions, ${dayMessages.filter((m) => !covered.has(m.id)).length} loose`,
	);

	let session = "";
	for (const conv of conversations) {
		if (conv.session_id !== session) {
			session = conv.session_id;
			console.log(`\n━━ session ${clock(conv.start)}`);
		}
		const speakers = conv.participants.map((p) => names.get(p) ?? p).join(", ");
		console.log(
			`\n   ${clock(conv.start)}-${clock(conv.end)}  ${conv.messages.length} msgs  [${speakers}]`,
		);
		const shown = flags.includes("--all")
			? conv.messages
			: conv.messages.slice(0, 3);
		for (const m of shown) {
			const reply = m.referenced_message_id
				? ` ↩${names.get(rows.find((r) => r.id === m.referenced_message_id)?.author_id ?? "") ?? "?"}`
				: "";
			console.log(
				`      ${clock(m.created_at)} ${names.get(m.author_id)}${reply}: ${text.get(m.id)}`,
			);
		}
	}
	const loose = dayMessages.filter((m) => !covered.has(m.id));
	if (loose.length) {
		console.log("\n━━ loose (no conversation)");
		for (const m of loose)
			console.log(
				`      ${clock(m.created_at)} ${names.get(m.author_id)}: ${text.get(m.id)}`,
			);
	}
	await db.disconnect();
	process.exit(0);
}

main().catch((error) => {
	console.error("❌", error);
	process.exit(1);
});
