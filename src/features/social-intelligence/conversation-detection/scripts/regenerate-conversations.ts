#!/usr/bin/env bun
/**
 * Regenerate Conversations
 *
 * Replays stored messages through ConversationDetector to create the conversation segments
 * the live detector missed (bot downtime, history from before detection existed). Safe to
 * re-run: messages already in a segment are skipped by the detector.
 *
 * Messages are replayed one channel at a time in time order. The detector normally closes a
 * conversation on a wall-clock inactivity timer, which never fires during a fast replay, so a
 * conversation is closed whenever the gap between messages exceeds INACTIVITY_GAP_MS.
 *
 * New segments are stored as `pending`; the running bot's enrichment sweep summarizes them.
 *
 * Usage:
 *   bun run regenerate:conversations                       # all history
 *   bun run regenerate:conversations --since 2025-07-01    # from a date
 *   bun run regenerate:conversations --since 2025-07-01 --until 2025-08-01
 */

import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { ConversationDetector } from "../ConversationDetector";
import { parseEmbedding } from "../messageUtils";

/** Matches the detector's longest live inactivity timeout (replies/mentions) */
const INACTIVITY_GAP_MS = 20 * 60 * 1000;
const LOG_CHANNEL_NAMES = [
	"vc-log",
	"vc-logs",
	"mod-logs",
	"server-logs",
	"audit-logs",
];

interface StoredMessage {
	id: string;
	author_id: string;
	content: string;
	created_at: Date;
	guild_id: string;
	channel_id: string;
	referenced_message_id: string | null;
	embedding: unknown;
}

interface ChannelRow {
	channel_id: string;
	name: string | null;
	messages: number;
}

function parseArgs(argv: string[]): { since?: Date; until?: Date } {
	const value = (flag: string) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const toDate = (flag: string) => {
		const raw = value(flag);
		if (raw === undefined) return undefined;
		const date = new Date(raw);
		if (Number.isNaN(date.getTime()))
			throw new Error(`Invalid ${flag} date: ${raw}`);
		return date;
	};
	return { since: toDate("--since"), until: toDate("--until") };
}

function mentionedUserIds(content: string, authorId: string): string[] {
	const ids = [...content.matchAll(/<@!?(\d+)>/g)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
	return [...new Set(ids)].filter((id) => id !== authorId);
}

async function countSegments(
	db: PostgreSQLManager,
	guildId: string,
): Promise<number> {
	const result = await db.query(
		"SELECT COUNT(*)::int AS count FROM conversation_segments WHERE guild_id = $1",
		[guildId],
	);
	return result.success ? (result.data?.[0]?.count ?? 0) : 0;
}

async function main() {
	const { since, until } = parseArgs(process.argv.slice(2));
	const guildId = config.guildId;
	if (!guildId) throw new Error("GUILD_ID is not configured");

	const db = new PostgreSQLManager();
	if (!(await db.connect())) throw new Error("Failed to connect to database");

	// Human-authored, non-empty messages; authors missing from `members` (people who left) are kept
	const filters = `m.guild_id = $1 AND m.active = true AND length(trim(m.content)) > 0
		AND COALESCE(mem.bot, false) = false
		AND ($2::timestamptz IS NULL OR m.created_at >= $2)
		AND ($3::timestamptz IS NULL OR m.created_at < $3)`;
	const bounds = [guildId, since ?? null, until ?? null];

	const channelsResult = await db.query(
		`SELECT m.channel_id, c.name, COUNT(*)::int AS messages
		FROM messages m
		LEFT JOIN members mem ON mem.user_id = m.author_id AND mem.guild_id = m.guild_id
		LEFT JOIN channels c ON c.id = m.channel_id
		WHERE ${filters} AND COALESCE(c.name, '') <> ALL($4::text[])
		GROUP BY m.channel_id, c.name
		ORDER BY messages DESC`,
		[...bounds, LOG_CHANNEL_NAMES],
	);
	if (!channelsResult.success)
		throw new Error(`Failed to list channels: ${channelsResult.error}`);
	const channels: ChannelRow[] = channelsResult.data ?? [];
	const total = channels.reduce((sum, channel) => sum + channel.messages, 0);

	console.log(
		`🔄 Regenerating conversations: ${total} messages in ${channels.length} channels` +
			`${since ? ` from ${since.toISOString().slice(0, 10)}` : ""}${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}`,
	);
	const segmentsBefore = await countSegments(db, guildId);
	const detector = new ConversationDetector(db);
	const started = Date.now();
	let processed = 0;

	for (const channel of channels) {
		const result = await db.query(
			`SELECT m.id, m.author_id, m.content, m.created_at, m.guild_id, m.channel_id,
				m.referenced_message_id, m.embedding
			FROM messages m
			LEFT JOIN members mem ON mem.user_id = m.author_id AND mem.guild_id = m.guild_id
			WHERE ${filters} AND m.channel_id = $4
			ORDER BY m.created_at ASC`,
			[...bounds, channel.channel_id],
		);
		if (!result.success) {
			console.error(
				`🔸 Skipping #${channel.name ?? channel.channel_id}: ${result.error}`,
			);
			continue;
		}

		const messages: StoredMessage[] = result.data ?? [];
		let lastTime: number | null = null;
		for (const message of messages) {
			const time = new Date(message.created_at).getTime();
			// Close the conversation in progress when the channel went quiet
			if (lastTime !== null && time - lastTime > INACTIVITY_GAP_MS) {
				await detector.flushInactiveBuffers(0);
			}
			lastTime = time;

			await detector.addMessageToStream({
				id: message.id,
				author_id: message.author_id,
				content: message.content,
				created_at: new Date(message.created_at),
				guild_id: message.guild_id,
				channel_id: message.channel_id,
				referenced_message_id: message.referenced_message_id ?? undefined,
				mentioned_user_ids: mentionedUserIds(
					message.content,
					message.author_id,
				),
				embedding: parseEmbedding(message.embedding),
			});
		}
		await detector.flushInactiveBuffers(0);

		processed += messages.length;
		const elapsed = Math.round((Date.now() - started) / 1000);
		console.log(
			`   #${channel.name ?? channel.channel_id}: ${messages.length} messages (${processed}/${total}, ${elapsed}s)`,
		);
	}

	const segmentsAfter = await countSegments(db, guildId);
	console.log(
		`🔹 Done: ${segmentsAfter - segmentsBefore} new conversations (${segmentsAfter} total)`,
	);
	await db.disconnect();
	// Detector inactivity timers would otherwise keep the process alive
	process.exit(0);
}

main().catch((error) => {
	console.error("❌ Regeneration failed:", error);
	process.exit(1);
});
