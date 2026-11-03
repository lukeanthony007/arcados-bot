/**
 * Who each message in a conversation is addressed to, when it isn't said.
 *
 * Replies and direct mentions are explicit and are counted from messages by closeness
 * already. This infers the rest, in order of confidence:
 *   1. in a two-person conversation, everything is addressed to the other person;
 *   2. a message following a different speaker's message within TURN_GAP_MS answers them;
 *   3. a message continuing the author's own previous message keeps its addressee.
 * Anything else is to the room and gets no addressee. Pure; counts only inferred turns.
 */

export const TURN_GAP_MS = 3 * 60_000;

export interface AddressableMessage {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
	/** Participants directly mentioned (already resolved, bots and self excluded) */
	mentions: string[];
}

export interface InferredTurn {
	from: string;
	to: string;
	turns: number;
}

/** Messages must be one conversation's, in time order */
export function inferTurns(messages: AddressableMessage[]): InferredTurn[] {
	const participants = [...new Set(messages.map((m) => m.author_id))];
	const authorOf = new Map(messages.map((m) => [m.id, m.author_id]));
	const counts = new Map<string, number>();
	const lastTarget = new Map<string, string>();
	let previous: AddressableMessage | undefined;

	for (const message of messages) {
		let target: string | undefined;
		const explicit =
			(message.referenced_message_id &&
				authorOf.get(message.referenced_message_id)) ||
			message.mentions[0];
		if (explicit && explicit !== message.author_id) {
			// Explicit: remember it for continuations, but don't count it (closeness already does)
			lastTarget.set(message.author_id, explicit);
		} else if (participants.length === 2) {
			target = participants.find((p) => p !== message.author_id);
		} else if (previous && previous.author_id !== message.author_id) {
			if (
				message.created_at.getTime() - previous.created_at.getTime() <=
				TURN_GAP_MS
			) {
				target = previous.author_id;
			}
		} else if (previous && previous.author_id === message.author_id) {
			target = lastTarget.get(message.author_id);
		}

		if (target && target !== message.author_id) {
			lastTarget.set(message.author_id, target);
			const key = `${message.author_id}\u0000${target}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		previous = message;
	}

	return [...counts].map(([key, turns]) => {
		const [from, to] = key.split("\u0000") as [string, string];
		return { from, to, turns };
	});
}
