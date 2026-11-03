/**
 * Conversation segmentation: a pure function from a channel's messages to conversations.
 *
 * A conversation is a run of human messages in one channel that
 *   - never falls silent for more than GAP_MS, unless the next message replies to a message
 *     already in the conversation within REPLY_STITCH_MS of the previous one,
 *   - spans at most MAX_SPAN_MS,
 *   - has at least MIN_MESSAGES messages from at least MIN_PARTICIPANTS people.
 *
 * Ids derive from the channel and the first message, so re-running over the same messages
 * yields the same conversations: live detection, crash recovery and history backfill are the
 * same computation.
 */

export const GAP_MS = 20 * 60_000;
export const REPLY_STITCH_MS = 6 * 3_600_000;
export const MAX_SPAN_MS = 24 * 3_600_000;
export const MIN_MESSAGES = 3;
export const MIN_PARTICIPANTS = 2;

export interface SegmentMessage {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
}

export interface Segment {
	id: string;
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
	for (const candidate of runs) {
		const participants = [...new Set(candidate.map((m) => m.author_id))];
		if (
			candidate.length < MIN_MESSAGES ||
			participants.length < MIN_PARTICIPANTS
		)
			continue;
		const first = candidate[0] as SegmentMessage;
		segments.push({
			id: segmentId(channelId, first.id),
			channel_id: channelId,
			messages: candidate,
			participants,
			start: first.created_at,
			end: (candidate[candidate.length - 1] as SegmentMessage).created_at,
		});
	}
	return segments;
}

/** A conversation is still open while its last message is within GAP_MS of `now` */
export function isOpen(segment: Segment, now: Date): boolean {
	return now.getTime() - segment.end.getTime() <= GAP_MS;
}

/** Worth a model-written summary: a group chat or a sustained exchange */
export function isSignificant(segment: Segment): boolean {
	return segment.participants.length >= 3 || segment.messages.length >= 10;
}
