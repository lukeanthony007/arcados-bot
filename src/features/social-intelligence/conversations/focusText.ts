/**
 * Plain-language rendering of an episode's focus map, shared by the summarizer (as measured
 * hints), tools and the R&D report so they all describe attention the same way.
 *
 * By default it speaks in words (who was talking to whom, who turned to whom without return,
 * whose bids went unanswered): implicit attention is inferred, so exact figures would claim
 * more precision than the measurement has. `precise` adds the numbers, for R&D reading.
 */

import type { EpisodeFocus, FocusStructure } from "./attention";

export interface FocusTextOptions {
	precise?: boolean;
}

const one = (n: number) => n.toFixed(1);

export function describeStructure(
	s: FocusStructure,
	nameOf: (id: string) => string,
	{ precise = false }: FocusTextOptions = {},
): string {
	switch (s.kind) {
		case "pair":
			return precise
				? `${nameOf(s.a)} and ${nameOf(s.b)} were talking to each other (${one(s.mass)} attention, ${Math.round(s.reciprocity * 100)}% balanced)`
				: `${nameOf(s.a)} and ${nameOf(s.b)} were talking to each other${s.reciprocity >= 0.85 ? ", evenly" : ""}`;
		case "pursuit":
			return precise
				? `${nameOf(s.from)} kept turning to ${nameOf(s.to)} (${one(s.given)}), who gave back little (${one(s.returned)})`
				: `${nameOf(s.from)} kept turning to ${nameOf(s.to)}, who gave back little`;
		case "centre":
			return `${nameOf(s.user)} was the centre of attention (from ${s.from_people} people)`;
		case "unattended":
			return `${nameOf(s.user)} reached out ${s.bids} times and got no answer`;
		case "room":
			return precise
				? `${nameOf(s.user)} mostly talked to the room (${Math.round(s.room_share * 100)}%)`
				: `${nameOf(s.user)} mostly talked to the room`;
	}
}

/** Structures, then the strongest directed flows and whose bids went unanswered, one line each */
export function describeFocus(
	focus: EpisodeFocus,
	nameOf: (id: string) => string,
	options: FocusTextOptions = {},
): string[] {
	const lines = focus.structures.map((s) =>
		describeStructure(s, nameOf, options),
	);
	const flows = Object.entries(focus.matrix)
		.flatMap(([from, row]) =>
			Object.entries(row).map(([to, mass]) => ({ from, to, mass })),
		)
		.filter((f) => f.mass >= 1)
		.sort((a, b) => b.mass - a.mass)
		.slice(0, 6);
	if (flows.length) {
		lines.push(
			options.precise
				? `Attention flows: ${flows.map((f) => `${nameOf(f.from)}→${nameOf(f.to)} ${one(f.mass)}`).join(", ")}`
				: `Most attention went: ${flows.map((f) => `${nameOf(f.from)}→${nameOf(f.to)}`).join(", ")}`,
		);
	}
	const personBids = focus.bids.filter((b) => b.to);
	const roomBids = focus.bids.filter((b) => !b.to);
	const ignored = personBids.filter((b) => !b.answered_by);
	const unanswered = [
		...new Set(ignored.map((b) => `${nameOf(b.from)}→${nameOf(b.to ?? "")}`)),
	].join(", ");
	if (options.precise && (personBids.length || roomBids.length)) {
		const parts = [
			`${personBids.length - ignored.length}/${personBids.length} bids to a person answered`,
			roomBids.length
				? `${roomBids.filter((b) => b.answered_by).length}/${roomBids.length} openers to the room taken up`
				: "",
			unanswered ? `unanswered: ${unanswered}` : "",
		].filter(Boolean);
		lines.push(`Bids: ${parts.join("; ")}`);
	} else if (unanswered) {
		lines.push(`Reached out without an answer: ${unanswered}`);
	}
	return lines;
}
