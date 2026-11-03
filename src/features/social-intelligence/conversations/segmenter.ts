/**
 * Conversation segmentation: a pure function from a channel's messages to conversations.
 *
 * A session is a run of human messages in one channel that
 *   - never falls silent for more than GAP_MS, unless the next message replies to a message
 *     already in the run within REPLY_STITCH_MS of the previous one,
 *   - spans at most MAX_SPAN_MS.
 * A long session is split into episodes where the active speakers change or the chat
 * pauses (see splitEpisodes). An episode is a conversation if it has at least MIN_MESSAGES
 * messages from at least MIN_PARTICIPANTS people.
 *
 * Ids derive from the channel and the first message, so re-running over the same messages
 * yields the same conversations: live detection, crash recovery and history backfill are the
 * same computation.
 */

export const GAP_MS = 20 * 60_000;
export const REPLY_STITCH_MS = 2 * 3_600_000;
export const MAX_SPAN_MS = 24 * 3_600_000;
export const MIN_MESSAGES = 3;
export const MIN_PARTICIPANTS = 2;
/** Episodes: runs longer than this prefer a cut at a clear seam… */
export const EPISODE_SOFT_MAX = 40;
/** …and longer than this are cut at the best seam available */
export const EPISODE_HARD_MAX = 80;
/** Speakers compared on each side of a candidate cut: at least this many messages… */
const SEAM_WINDOW = 10;
/** …and at least this much time */
const SEAM_WINDOW_MS = 3 * 60_000;
/** Speaker overlap at or below this is a clear seam */
const SEAM_THRESHOLD = 0.45;
/** A pause this long counts fully in favour of a cut */
const EPISODE_PAUSE_MS = 8 * 60_000;
/** Never cut closer than this to either end of a run */
const SEAM_MARGIN = 15;

export interface SegmentMessage {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
	/** Members directly mentioned (bots and self excluded, group pings dropped) */
	mentions: string[];
}

export interface Segment {
	id: string;
	/** The continuous run (session) this episode belongs to; equals `id` for its first episode */
	session_id: string;
	channel_id: string;
	messages: SegmentMessage[];
	/** Distinct authors in order of first appearance */
	participants: string[];
	start: Date;
	end: Date;
}

export function segmentId(channelId: string, firstMessageId: string): string {
	return `conv_${channelId}_${firstMessageId}`;
}

/** Messages must be one channel's, sorted by created_at ascending */
export function segment(
	channelId: string,
	messages: SegmentMessage[],
): Segment[] {
	const runs: SegmentMessage[][] = [];
	let run: SegmentMessage[] = [];
	let runIds = new Set<string>();

	for (const message of messages) {
		const last = run[run.length - 1];
		if (last) {
			const gap = message.created_at.getTime() - last.created_at.getTime();
			const span =
				message.created_at.getTime() -
				(run[0] as SegmentMessage).created_at.getTime();
			const stitched =
				message.referenced_message_id !== null &&
				runIds.has(message.referenced_message_id) &&
				gap <= REPLY_STITCH_MS;
			if (span > MAX_SPAN_MS || (gap > GAP_MS && !stitched)) {
				runs.push(run);
				run = [];
				runIds = new Set();
			}
		}
		run.push(message);
		runIds.add(message.id);
	}
	if (run.length) runs.push(run);

	const segments: Segment[] = [];
	for (const run of runs) {
		const sessionId = segmentId(channelId, (run[0] as SegmentMessage).id);
		for (const candidate of splitEpisodes(run)) {
			const participants = [...new Set(candidate.map((m) => m.author_id))];
			if (
				candidate.length < MIN_MESSAGES ||
				participants.length < MIN_PARTICIPANTS
			)
				continue;
			const first = candidate[0] as SegmentMessage;
			segments.push({
				id: segmentId(channelId, first.id),
				session_id: sessionId,
				channel_id: channelId,
				messages: candidate,
				participants,
				start: first.created_at,
				end: (candidate[candidate.length - 1] as SegmentMessage).created_at,
			});
		}
	}
	return segments;
}

/**
 * Overlap (Jaccard) between the speakers just before and just after index `i`. Each side
 * covers at least SEAM_WINDOW messages and at least SEAM_WINDOW_MS, so a fast chat among the
 * same people doesn't look like a change of speakers.
 */
function speakerSeam(messages: SegmentMessage[], i: number): number {
	const at = (messages[i] as SegmentMessage).created_at.getTime();
	let lo = Math.max(0, i - SEAM_WINDOW);
	while (
		lo > 0 &&
		at - (messages[lo - 1] as SegmentMessage).created_at.getTime() <=
			SEAM_WINDOW_MS
	)
		lo--;
	let hi = Math.min(messages.length, i + SEAM_WINDOW);
	while (
		hi < messages.length &&
		(messages[hi] as SegmentMessage).created_at.getTime() - at <= SEAM_WINDOW_MS
	)
		hi++;
	const before = new Set(messages.slice(lo, i).map((m) => m.author_id));
	const after = new Set(messages.slice(i, hi).map((m) => m.author_id));
	const shared = [...before].filter((author) => after.has(author)).length;
	return shared / new Set([...before, ...after]).size;
}

/**
 * Split a continuous run into episodes at the best seam: where the active speakers change
 * or the chat pauses, never between a reply and the message it answers. Runs over
 * EPISODE_SOFT_MAX are cut when a clear seam exists; over EPISODE_HARD_MAX at the best seam
 * available. Exported for examination scripts.
 */
export function splitEpisodes(run: SegmentMessage[]): SegmentMessage[][] {
	if (run.length <= EPISODE_SOFT_MAX) return [run];
	let best = -1;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let i = SEAM_MARGIN; i <= run.length - SEAM_MARGIN; i++) {
		const message = run[i] as SegmentMessage;
		const previous = run[i - 1] as SegmentMessage;
		const answersJustBefore =
			message.referenced_message_id !== null &&
			run
				.slice(Math.max(0, i - 5), i)
				.some((m) => m.id === message.referenced_message_id);
		if (answersJustBefore) continue;
		const pause = Math.min(
			(message.created_at.getTime() - previous.created_at.getTime()) /
				EPISODE_PAUSE_MS,
			1,
		);
		const score = speakerSeam(run, i) - pause;
		if (score < bestScore) {
			bestScore = score;
			best = i;
		}
	}
	if (
		best < 0 ||
		(bestScore > SEAM_THRESHOLD && run.length <= EPISODE_HARD_MAX)
	)
		return [run];
	return [
		...splitEpisodes(run.slice(0, best)),
		...splitEpisodes(run.slice(best)),
	];
}

/** A conversation is still open while its last message is within GAP_MS of `now` */
export function isOpen(segment: Segment, now: Date): boolean {
	return now.getTime() - segment.end.getTime() <= GAP_MS;
}

/** Worth a model-written summary: a group chat or a sustained exchange */
export function isSignificant(segment: Segment): boolean {
	return segment.participants.length >= 3 || segment.messages.length >= 10;
}
