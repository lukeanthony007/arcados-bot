/**
 * Attention inside a conversation: where each message's focus goes, and what that says about
 * the people in it. Pure; no I/O.
 *
 * Every message carries one unit of attention, split across its targets:
 *   - a reply gives REPLY_SHARE to the replied-to author, the rest to people it mentions;
 *   - a mention (≤ 3 people) splits the unit between them;
 *   - an implicit message is attributed by evidence: who spoke recently (recency), who the
 *     author was already talking to (continuation), and who the author tends to talk to at
 *     all (the affinity prior); whatever the evidence doesn't support goes to the room.
 *     In a two-person conversation it all goes to the other person.
 *
 * From the attributions, `focusMap` derives the social shape of the conversation: who gives
 * and receives attention, which bids for someone's attention were answered, and structures
 * (reciprocal pairs, pursuits, a centre, people left unattended, people talking to the room).
 */

/** Share of a reply's attention that goes to the replied-to author (rest to its mentions) */
export const REPLY_SHARE = 0.8;
/** Recent speakers considered as implicit targets */
export const RECENT_SPEAKERS = 4;
/** An implicit message only answers someone who spoke within this window */
export const ANSWER_WINDOW_MS = 5 * 60_000;
/** How much the room competes for an implicit message's attention in a group */
export const ROOM_WEIGHT = 0.45;
/** A bid is answered when the target gives the bidder ≥ this mass within the window */
export const ANSWER_MASS = 0.5;
/** …within this many later messages or this much time */
export const BID_WINDOW_MESSAGES = 8;
export const BID_WINDOW_MS = 5 * 60_000;

export interface AttentionMessage {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
	/** Participants directly mentioned (bots and self excluded, group pings dropped) */
	mentions: string[];
}

/**
 * The author's historical tendency to attend to another member (0-1, share of their explicit
 * attention). Used as evidence for implicit messages; 0 for strangers.
 */
export type AffinityPrior = (from: string, to: string) => number;

export interface MessageAttention {
	id: string;
	from: string;
	/** Attention mass per person (sums with `room` to 1) */
	to: Record<string, number>;
	room: number;
	explicit: boolean;
}

export function attributeAttention(
	messages: AttentionMessage[],
	prior: AffinityPrior,
): MessageAttention[] {
	const participants = new Set(messages.map((m) => m.author_id));
	const authorOf = new Map(messages.map((m) => [m.id, m.author_id]));
	const lastTarget = new Map<string, string>();
	const out: MessageAttention[] = [];

	for (const [index, m] of messages.entries()) {
		const to: Record<string, number> = {};
		const add = (id: string, mass: number) => {
			if (id !== m.author_id && mass > 0) to[id] = (to[id] ?? 0) + mass;
		};
		const repliedTo = m.referenced_message_id
			? authorOf.get(m.referenced_message_id)
			: undefined;
		const mentions = m.mentions.filter((id) => id !== m.author_id);

		if ((repliedTo && repliedTo !== m.author_id) || mentions.length) {
			const others = mentions.filter((id) => id !== repliedTo);
			if (repliedTo && repliedTo !== m.author_id) {
				add(repliedTo, others.length ? REPLY_SHARE : 1);
				for (const id of others) add(id, (1 - REPLY_SHARE) / others.length);
			} else {
				for (const id of mentions) add(id, 1 / mentions.length);
			}
			out.push({ id: m.id, from: m.author_id, to, room: 0, explicit: true });
		} else if (participants.size === 2) {
			const other = [...participants].find((p) => p !== m.author_id);
			if (other) add(other, 1);
			out.push({
				id: m.id,
				from: m.author_id,
				to,
				room: other ? 0 : 1,
				explicit: false,
			});
		} else {
			const scores = implicitScores(
				messages,
				index,
				lastTarget.get(m.author_id),
				prior,
			);
			const total =
				[...scores.values()].reduce((s, v) => s + v, 0) + ROOM_WEIGHT;
			for (const [id, s] of scores) add(id, s / total);
			out.push({
				id: m.id,
				from: m.author_id,
				to,
				room: ROOM_WEIGHT / total,
				explicit: false,
			});
		}

		const focus = Object.entries(to).sort((a, b) => b[1] - a[1])[0];
		if (focus && focus[1] >= 0.5) lastTarget.set(m.author_id, focus[0]);
	}
	return out;
}

/** Evidence for each candidate target of an implicit message */
function implicitScores(
	messages: AttentionMessage[],
	index: number,
	continuing: string | undefined,
	prior: AffinityPrior,
): Map<string, number> {
	const m = messages[index] as AttentionMessage;
	const at = m.created_at.getTime();
	const scores = new Map<string, number>();
	let rank = 0;
	for (let i = index - 1; i >= 0 && rank < RECENT_SPEAKERS; i--) {
		const prev = messages[i] as AttentionMessage;
		if (at - prev.created_at.getTime() > ANSWER_WINDOW_MS) break;
		if (prev.author_id === m.author_id || scores.has(prev.author_id)) continue;
		// The most recent other speaker is the strongest candidate; earlier ones fade
		const recency = 1 / 2 ** rank;
		const affinity = prior(m.author_id, prev.author_id);
		scores.set(prev.author_id, recency * (0.5 + 2 * affinity));
		rank++;
	}
	if (continuing) scores.set(continuing, (scores.get(continuing) ?? 0) + 0.6);
	return scores;
}

export interface Bid {
	message_id: string;
	from: string;
	/** A person, or null for a bid to the room (an opener nobody was addressed in) */
	to: string | null;
	at: Date;
	explicit: boolean;
	/** Who answered (the target, or for room bids whoever turned to the bidder first) */
	answered_by: string | null;
}

export type FocusStructure =
	| { kind: "pair"; a: string; b: string; mass: number; reciprocity: number }
	| {
			kind: "pursuit";
			from: string;
			to: string;
			given: number;
			returned: number;
	  }
	| { kind: "centre"; user: string; received: number; from_people: number }
	| { kind: "unattended"; user: string; bids: number; received: number }
	| { kind: "room"; user: string; room_share: number };

export interface EpisodeFocus {
	/** from → to → attention mass */
	matrix: Record<string, Record<string, number>>;
	/** Per participant: mass given to people, to the room, and received */
	people: Record<
		string,
		{ given: number; room: number; received: number; messages: number }
	>;
	bids: Bid[];
	structures: FocusStructure[];
}

/** Social shape of one conversation from its attributions (same order as the messages) */
export function focusMap(
	messages: AttentionMessage[],
	attention: MessageAttention[],
): EpisodeFocus {
	const matrix: EpisodeFocus["matrix"] = {};
	const people: EpisodeFocus["people"] = {};
	const person = (id: string) =>
		people[id] ??
		(people[id] = { given: 0, room: 0, received: 0, messages: 0 });
	for (const m of messages) person(m.author_id);

	for (const a of attention) {
		const p = person(a.from);
		p.messages++;
		p.room += a.room;
		for (const [to, mass] of Object.entries(a.to)) {
			p.given += mass;
			person(to).received += mass;
			const row = matrix[a.from] ?? (matrix[a.from] = {});
			row[to] = (row[to] ?? 0) + mass;
		}
	}

	const bids = findBids(messages, attention);
	return {
		matrix,
		people,
		bids,
		structures: findStructures(matrix, people, bids),
	};
}

function findBids(
	messages: AttentionMessage[],
	attention: MessageAttention[],
): Bid[] {
	const bids: Bid[] = [];
	for (const [i, a] of attention.entries()) {
		const m = messages[i] as AttentionMessage;
		const [target, mass] = Object.entries(a.to).sort(
			(x, y) => y[1] - x[1],
		)[0] ?? [null, 0];
		// Responding to someone who just addressed you is not a bid
		const responding =
			target !== null &&
			attention
				.slice(Math.max(0, i - 3), i)
				.some(
					(prev) =>
						prev.from === target && (prev.to[a.from] ?? 0) >= ANSWER_MASS,
				);
		const toPerson = target !== null && mass >= 0.5 && !responding;
		// A room bid opens fresh: first message, or the author's previous one is outside the window
		const previous = i > 0 ? (messages[i - 1] as AttentionMessage) : undefined;
		const toRoom =
			a.room >= 0.7 &&
			(!previous ||
				previous.author_id !== a.from ||
				m.created_at.getTime() - previous.created_at.getTime() > BID_WINDOW_MS);
		if (!toPerson && !toRoom) continue;

		let answeredBy: string | null = null;
		for (
			let j = i + 1;
			j < Math.min(attention.length, i + 1 + BID_WINDOW_MESSAGES);
			j++
		) {
			const later = attention[j] as MessageAttention;
			const laterMsg = messages[j] as AttentionMessage;
			if (
				laterMsg.created_at.getTime() - m.created_at.getTime() >
				BID_WINDOW_MS
			)
				break;
			if (later.from === a.from) continue;
			if (
				(later.to[a.from] ?? 0) >= ANSWER_MASS &&
				(!toPerson || later.from === target)
			) {
				answeredBy = later.from;
				break;
			}
		}
		bids.push({
			message_id: a.id,
			from: a.from,
			to: toPerson ? target : null,
			at: m.created_at,
			explicit: a.explicit,
			answered_by: answeredBy,
		});
	}
	return bids;
}

function findStructures(
	matrix: EpisodeFocus["matrix"],
	people: EpisodeFocus["people"],
	bids: Bid[],
): FocusStructure[] {
	const structures: FocusStructure[] = [];
	const mass = (a: string, b: string) => matrix[a]?.[b] ?? 0;
	const ids = Object.keys(people);
	const totalGiven = ids.reduce((s, id) => s + (people[id]?.given ?? 0), 0);

	for (const [i, a] of ids.entries()) {
		for (const b of ids.slice(i + 1)) {
			const ab = mass(a, b);
			const ba = mass(b, a);
			const hi = Math.max(ab, ba);
			const lo = Math.min(ab, ba);
			if (lo >= 2 && lo / hi >= 0.5) {
				structures.push({
					kind: "pair",
					a,
					b,
					mass: ab + ba,
					reciprocity: lo / hi,
				});
			} else if (hi >= 2.5 && lo <= 0.4 * hi) {
				const [from, to] = ab >= ba ? [a, b] : [b, a];
				structures.push({ kind: "pursuit", from, to, given: hi, returned: lo });
			}
		}
	}
	if (ids.length >= 3 && totalGiven > 0) {
		const [top] = [...ids].sort(
			(x, y) => (people[y]?.received ?? 0) - (people[x]?.received ?? 0),
		);
		const received = top ? (people[top]?.received ?? 0) : 0;
		const fromPeople = top ? ids.filter((id) => mass(id, top) >= 1).length : 0;
		if (top && received / totalGiven >= 0.3 && fromPeople >= 2) {
			structures.push({
				kind: "centre",
				user: top,
				received,
				from_people: fromPeople,
			});
		}
	}
	for (const id of ids) {
		const p = people[id];
		if (!p) continue;
		const own = bids.filter((b) => b.from === id);
		if (own.length >= 2 && own.every((b) => !b.answered_by) && p.received < 1) {
			structures.push({
				kind: "unattended",
				user: id,
				bids: own.length,
				received: p.received,
			});
		}
		const output = p.given + p.room;
		if (p.messages >= 3 && output > 0 && p.room / output >= 0.6) {
			structures.push({ kind: "room", user: id, room_share: p.room / output });
		}
	}
	return structures;
}
