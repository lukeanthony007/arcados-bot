/**
 * Applies the segmenter to a channel and reconciles the result with `conversation_segments`.
 *
 * `segmentChannelTail` re-segments the recent window of a channel (everything that could
 * still change: open conversations and anything a late reply could stitch to) and upserts
 * the result. Ids are deterministic, so unchanged conversations are no-ops, a changed one is
 * updated in place (and re-summarized), and ids that no longer occur are deleted.
 *
 * `resegmentChannelHistory` does the same over the whole channel, keeping the id and summary
 * of any existing conversation that matches a new one closely (used once to migrate).
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { type AffinityPrior, attributeAttention, focusMap } from "./attention";
import {
	GAP_MS,
	MAX_SPAN_MS,
	REPLY_STITCH_MS,
	type Segment,
	type SegmentMessage,
	isOpen,
	isSignificant,
	segment,
} from "./segmenter";

/** Messages that are commands to other bots are not conversation */
const BOT_COMMAND = /^\s*(m!|!|\$|\/)[a-z]/i;
const MENTION = /<@!?(\d+)>/g;
/** A message pinging more people than this is a group ping, not an address */
const MAX_MENTIONS = 3;

/** Jaccard overlap above which a re-segmented conversation keeps an old one's id and summary */
const KEEP_SUMMARY_OVERLAP = 0.8;

export interface SegmentationResult {
	/** Conversations that became finalized in this pass and want a summary */
	finalized: Segment[];
	/** Conversations stored as still open */
	open: Segment[];
	upserted: number;
	deleted: number;
}

interface StoredSegment {
	id: string;
	message_ids: string[];
	status: string;
	summary: string | null;
	session_id: string | null;
	/** The stored episode has no focus yet */
	focus_missing: boolean;
}

interface MessageRow {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
	content: string;
}

async function loadMessages(
	db: PostgreSQLManager,
	guildId: string,
	channelId: string,
	since: Date | null,
): Promise<SegmentMessage[]> {
	const result = await db.query(
		`SELECT m.id, m.author_id, m.created_at, m.referenced_message_id, m.content
		 FROM messages m
		 JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
		 WHERE m.guild_id = $1 AND m.channel_id = $2 AND m.active = true
		   AND ($3::timestamptz IS NULL OR m.created_at >= $3)
		 ORDER BY m.created_at ASC, m.id ASC`,
		[guildId, channelId, since],
	);
	if (!result.success)
		throw new Error(`Loading messages failed: ${result.error}`);
	const rows = (result.data ?? []) as MessageRow[];
	const authors = new Set(rows.map((row) => row.author_id));
	return rows
		.filter((row) => !BOT_COMMAND.test(row.content))
		.map((row) => {
			const mentioned = [...row.content.matchAll(MENTION)].map(
				(m) => m[1] as string,
			);
			return {
				id: row.id,
				author_id: row.author_id,
				created_at: new Date(row.created_at),
				referenced_message_id: row.referenced_message_id,
				mentions:
					mentioned.length > MAX_MENTIONS
						? []
						: [...new Set(mentioned)].filter(
								(id) => id !== row.author_id && authors.has(id),
							),
			};
		});
}

async function loadStored(
	db: PostgreSQLManager,
	guildId: string,
	channelId: string,
	since: Date | null,
): Promise<StoredSegment[]> {
	const result = await db.query(
		`SELECT id, message_ids, status, summary, session_id, focus IS NULL AS focus_missing
		 FROM conversation_segments
		 WHERE guild_id = $1 AND channel_id = $2 AND ($3::timestamptz IS NULL OR start_time >= $3)`,
		[guildId, channelId, since],
	);
	if (!result.success)
		throw new Error(`Loading segments failed: ${result.error}`);
	return (result.data ?? []) as StoredSegment[];
}

function sameIds(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Compute an episode's attention and replace its per-pair rows and stored focus */
async function writeAttention(
	db: PostgreSQLManager,
	conversationId: string,
	seg: Segment,
	prior: AffinityPrior,
): Promise<void> {
	const attention = attributeAttention(seg.messages, prior);
	const focus = focusMap(seg.messages, attention);

	const pairs = new Map<
		string,
		{
			from: string;
			to: string;
			mass: number;
			explicit: number;
			bids: number;
			answered: number;
		}
	>();
	const pair = (from: string, to: string) => {
		const key = `${from}>${to}`;
		let p = pairs.get(key);
		if (!p) {
			p = { from, to, mass: 0, explicit: 0, bids: 0, answered: 0 };
			pairs.set(key, p);
		}
		return p;
	};
	for (const a of attention)
		for (const [to, mass] of Object.entries(a.to)) {
			const p = pair(a.from, to);
			p.mass += mass;
			if (a.explicit) p.explicit += mass;
		}
	for (const bid of focus.bids) {
		if (!bid.to) continue;
		const p = pair(bid.from, bid.to);
		p.bids++;
		if (bid.answered_by) p.answered++;
	}
	const rows = [...pairs.values()];

	const del = await db.query(
		"DELETE FROM episode_attention WHERE conversation_id = $1",
		[conversationId],
	);
	if (!del.success)
		throw new Error(
			`Clearing attention for ${conversationId} failed: ${del.error}`,
		);
	if (rows.length) {
		const ins = await db.query(
			`INSERT INTO episode_attention
				(conversation_id, from_user, to_user, mass, explicit_mass, bids, bids_answered)
			 SELECT $1, f, t, m, e, b, a
			 FROM unnest($2::text[], $3::text[], $4::real[], $5::real[], $6::int[], $7::int[])
				AS x(f, t, m, e, b, a)`,
			[
				conversationId,
				rows.map((r) => r.from),
				rows.map((r) => r.to),
				rows.map((r) => r.mass),
				rows.map((r) => r.explicit),
				rows.map((r) => r.bids),
				rows.map((r) => r.answered),
			],
		);
		if (!ins.success)
			throw new Error(
				`Writing attention for ${conversationId} failed: ${ins.error}`,
			);
	}
	const set = await db.query(
		"UPDATE conversation_segments SET focus = $2::jsonb WHERE id = $1",
		[conversationId, JSON.stringify(focus)],
	);
	if (!set.success)
		throw new Error(`Storing focus for ${conversationId} failed: ${set.error}`);
}

/**
 * Write the computed conversations for one channel window and remove stale ones.
 * `stored` must cover every existing segment in the window. A finalized conversation whose
 * messages changed loses its summary (so it gets rewritten) unless `keepSummaries`.
 */
async function reconcile(
	db: PostgreSQLManager,
	guildId: string,
	prior: AffinityPrior,
	computed: Array<{
		segment: Segment;
		id: string;
		status: "active" | "finalized";
	}>,
	stored: StoredSegment[],
	keepSummaries = false,
): Promise<SegmentationResult> {
	const storedById = new Map(stored.map((s) => [s.id, s]));
	const keep = new Set<string>();
	const result: SegmentationResult = {
		finalized: [],
		open: [],
		upserted: 0,
		deleted: 0,
	};

	for (const { segment: seg, id, status } of computed) {
		keep.add(id);
		const previous = storedById.get(id);
		const messageIds = seg.messages.map((m) => m.id);
		const unchanged =
			previous !== undefined &&
			sameIds(previous.message_ids, messageIds) &&
			previous.status === status &&
			previous.session_id === seg.session_id;
		if (unchanged) {
			if (previous.focus_missing) await writeAttention(db, id, seg, prior);
			if (status === "active") result.open.push(seg);
			continue;
		}

		// A finalized conversation whose messages changed needs its summary redone
		const summaryStale =
			!keepSummaries &&
			previous !== undefined &&
			previous.summary !== null &&
			!sameIds(previous.message_ids, messageIds);
		const processing =
			status === "active"
				? "pending"
				: isSignificant(seg)
					? "pending"
					: "skipped";
		const upsert = await db.query(
			`INSERT INTO conversation_segments
				(id, guild_id, channel_id, participants, start_time, end_time, message_ids, message_count,
				 status, last_activity_at, ai_processing_status, session_id)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6, $10, $12)
			 ON CONFLICT (id) DO UPDATE SET
				participants = EXCLUDED.participants, start_time = EXCLUDED.start_time,
				end_time = EXCLUDED.end_time, message_ids = EXCLUDED.message_ids,
				message_count = EXCLUDED.message_count, status = EXCLUDED.status,
				last_activity_at = EXCLUDED.last_activity_at, session_id = EXCLUDED.session_id,
				ai_processing_status = CASE WHEN $11 THEN 'pending' ELSE conversation_segments.ai_processing_status END,
				summary = CASE WHEN $11 THEN NULL ELSE conversation_segments.summary END,
				embedding = CASE WHEN $11 THEN NULL ELSE conversation_segments.embedding END,
				topic_label = CASE WHEN $11 THEN NULL ELSE conversation_segments.topic_label END,
				dynamics = CASE WHEN $11 THEN NULL ELSE conversation_segments.dynamics END`,
			[
				id,
				guildId,
				seg.channel_id,
				seg.participants,
				seg.start,
				seg.end,
				messageIds,
				messageIds.length,
				status,
				processing,
				summaryStale,
				seg.session_id,
			],
		);
		if (!upsert.success)
			throw new Error(`Storing conversation ${id} failed: ${upsert.error}`);
		result.upserted++;
		await writeAttention(db, id, seg, prior);
		if (status === "active") result.open.push(seg);
		else if (previous?.status !== "finalized" || summaryStale)
			result.finalized.push(seg);
	}

	const stale = stored.filter((s) => !keep.has(s.id)).map((s) => s.id);
	if (stale.length) {
		const del = await db.query(
			"DELETE FROM conversation_segments WHERE guild_id = $1 AND id = ANY($2)",
			[guildId, stale],
		);
		if (!del.success)
			throw new Error(`Deleting stale conversations failed: ${del.error}`);
		result.deleted = stale.length;
	}
	return result;
}

/** Re-segment everything in a channel that could still change and store the result */
export async function segmentChannelTail(
	db: PostgreSQLManager,
	guildId: string,
	channelId: string,
	prior: AffinityPrior,
	now = new Date(),
): Promise<SegmentationResult> {
	// Anything ending in the last stitch window could still change; include such conversations
	// whole, plus a full span before them so runs that straddle the boundary are intact
	const cutoff = new Date(now.getTime() - REPLY_STITCH_MS - MAX_SPAN_MS);
	const earliest = await db.query(
		`SELECT MIN(start_time) AS start FROM conversation_segments
		 WHERE guild_id = $1 AND channel_id = $2 AND end_time >= $3`,
		[guildId, channelId, cutoff],
	);
	const earliestStart = earliest.data?.[0]?.start
		? new Date(earliest.data[0].start)
		: null;
	const since =
		earliestStart && earliestStart < cutoff ? earliestStart : cutoff;

	const [messages, stored] = await Promise.all([
		loadMessages(db, guildId, channelId, since),
		loadStored(db, guildId, channelId, since),
	]);
	// Conversations written before deterministic ids keep theirs when the first message matches
	const legacyIdByFirstMessage = new Map(
		stored.map((s) => [s.message_ids[0], s.id]),
	);
	const computed = segment(channelId, messages).map((seg) => ({
		segment: seg,
		id: legacyIdByFirstMessage.get(seg.messages[0]?.id ?? "") ?? seg.id,
		status: isOpen(seg, now) ? ("active" as const) : ("finalized" as const),
	}));
	return reconcile(db, guildId, prior, computed, stored);
}

/**
 * Re-segment a channel's whole history. Existing conversations that overlap a new one by at
 * least KEEP_SUMMARY_OVERLAP keep their id, summary and embedding; everything else is replaced.
 */
export async function resegmentChannelHistory(
	db: PostgreSQLManager,
	guildId: string,
	channelId: string,
	prior: AffinityPrior,
	now = new Date(),
): Promise<SegmentationResult & { kept: number }> {
	const [messages, stored] = await Promise.all([
		loadMessages(db, guildId, channelId, null),
		loadStored(db, guildId, channelId, null),
	]);
	const storedByMessage = new Map<string, StoredSegment>();
	for (const s of stored)
		for (const id of s.message_ids) storedByMessage.set(id, s);

	let kept = 0;
	const claimed = new Set<string>();
	const computed = segment(channelId, messages).map((seg) => {
		const overlap = new Map<StoredSegment, number>();
		for (const m of seg.messages) {
			const s = storedByMessage.get(m.id);
			if (s) overlap.set(s, (overlap.get(s) ?? 0) + 1);
		}
		let id = seg.id;
		for (const [s, shared] of overlap) {
			const jaccard =
				shared / (seg.messages.length + s.message_ids.length - shared);
			if (jaccard >= KEEP_SUMMARY_OVERLAP && !claimed.has(s.id)) {
				id = s.id;
				claimed.add(s.id);
				if (s.summary) kept++;
				break;
			}
		}
		return {
			segment: seg,
			id,
			status: isOpen(seg, now) ? ("active" as const) : ("finalized" as const),
		};
	});
	return {
		...(await reconcile(db, guildId, prior, computed, stored, true)),
		kept,
	};
}

/** Channels with messages newer than `since`, or with a conversation still marked open */
export async function channelsToSegment(
	db: PostgreSQLManager,
	guildId: string,
	since: Date,
): Promise<string[]> {
	const result = await db.query(
		`SELECT channel_id FROM messages WHERE guild_id = $1 AND created_at > $2
		 UNION
		 SELECT channel_id FROM conversation_segments WHERE guild_id = $1 AND status = 'active'`,
		[guildId, new Date(since.getTime() - GAP_MS)],
	);
	if (!result.success)
		throw new Error(`Listing channels failed: ${result.error}`);
	return ((result.data ?? []) as Array<{ channel_id: string }>).map(
		(row) => row.channel_id,
	);
}
