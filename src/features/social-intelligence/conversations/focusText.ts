/**
 * Plain-language rendering of an episode's focus map, shared by the summarizer (as measured
 * hints), the R&D report and tools so they all describe attention the same way.
 */

import type { EpisodeFocus, FocusStructure } from "./attention";

const one = (n: number) => n.toFixed(1);

export function describeStructure(
	s: FocusStructure,
	nameOf: (id: string) => string,
): string {
	switch (s.kind) {
		case "pair":
			return `${nameOf(s.a)} and ${nameOf(s.b)} were talking to each other (${one(s.mass)} attention, ${Math.round(s.reciprocity * 100)}% balanced)`;
		case "pursuit":
			return `${nameOf(s.from)} kept turning to ${nameOf(s.to)} (${one(s.given)}), who gave back little (${one(s.returned)})`;
		case "centre":
			return `${nameOf(s.user)} was the centre of attention (from ${s.from_people} people)`;
		case "unattended":
			return `${nameOf(s.user)} made ${s.bids} bids for attention and got none`;
		case "room":
			return `${nameOf(s.user)} mostly talked to the room (${Math.round(s.room_share * 100)}%)`;
	}
}

/** Structures, then the strongest directed flows and bid uptake, one line each */
export function describeFocus(
	focus: EpisodeFocus,
	nameOf: (id: string) => string,
): string[] {
	const lines = focus.structures.map((s) => describeStructure(s, nameOf));
	const flows = Object.entries(focus.matrix)
		.flatMap(([from, row]) =>
			Object.entries(row).map(([to, mass]) => ({ from, to, mass })),
		)
		.filter((f) => f.mass >= 1)
		.sort((a, b) => b.mass - a.mass)
		.slice(0, 6);
	if (flows.length) {
		lines.push(
			`Attention flows: ${flows.map((f) => `${nameOf(f.from)}→${nameOf(f.to)} ${one(f.mass)}`).join(", ")}`,
		);
	}
	const personBids = focus.bids.filter((b) => b.to);
	const roomBids = focus.bids.filter((b) => !b.to);
	if (personBids.length || roomBids.length) {
		const ignored = personBids.filter((b) => !b.answered_by);
		const parts = [
			`${personBids.length - ignored.length}/${personBids.length} bids to a person answered`,
			roomBids.length
				? `${roomBids.filter((b) => b.answered_by).length}/${roomBids.length} openers to the room taken up`
				: "",
			ignored.length
				? `unanswered: ${[...new Set(ignored.map((b) => `${nameOf(b.from)}→${nameOf(b.to ?? "")}`))].join(", ")}`
				: "",
		].filter(Boolean);
		lines.push(`Bids: ${parts.join("; ")}`);
	}
	return lines;
}
