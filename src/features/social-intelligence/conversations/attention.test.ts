import { describe, expect, test } from "bun:test";
import {
	type AffinityPrior,
	type AttentionMessage,
	REPLY_SHARE,
	attributeAttention,
	focusMap,
} from "./attention";

const T0 = Date.UTC(2026, 0, 1);
const none: AffinityPrior = () => 0;

/** `[secondsFromT0, author, { replyTo?, mentions? }?]` */
function msgs(
	spec: Array<[number, string, { replyTo?: string; mentions?: string[] }?]>,
): AttentionMessage[] {
	return spec.map(([s, author, extra], i) => ({
		id: `m${i}`,
		author_id: author,
		created_at: new Date(T0 + s * 1000),
		referenced_message_id: extra?.replyTo ?? null,
		mentions: extra?.mentions ?? [],
	}));
}

const sum = (a: { to: Record<string, number>; room: number }) =>
	Object.values(a.to).reduce((s, v) => s + v, 0) + a.room;

describe("attributeAttention", () => {
	test("every message carries exactly one unit of attention", () => {
		const out = attributeAttention(
			msgs([
				[0, "a"],
				[5, "b"],
				[9, "c"],
				[12, "a", { replyTo: "m1", mentions: ["c"] }],
				[20, "d"],
			]),
			none,
		);
		for (const a of out) expect(sum(a)).toBeCloseTo(1, 6);
	});

	test("a reply goes mostly to the replied-to author, the rest to its mentions", () => {
		const [, , reply] = attributeAttention(
			msgs([
				[0, "a"],
				[5, "b"],
				[9, "c", { replyTo: "m0", mentions: ["b"] }],
			]),
			none,
		);
		expect(reply?.to).toEqual({ a: REPLY_SHARE, b: 1 - REPLY_SHARE });
		expect(reply?.explicit).toBe(true);
	});

	test("in a two-person conversation implicit messages go entirely to the other person", () => {
		const out = attributeAttention(
			msgs([
				[0, "a"],
				[600, "a"],
				[700, "b"],
			]),
			none,
		);
		expect(out.map((a) => a.to)).toEqual([{ b: 1 }, { b: 1 }, { a: 1 }]);
	});

	test("in a group, the previous speaker gets the most and the room keeps a share", () => {
		const out = attributeAttention(
			msgs([
				[0, "a"],
				[5, "b"],
				[9, "c"],
			]),
			none,
		);
		const last = out[2]!;
		expect(last.to.b).toBeGreaterThan(last.to.a ?? 0);
		expect(last.room).toBeGreaterThan(0);
	});

	test("the affinity prior pulls an ambiguous message toward the author's usual person", () => {
		// d usually only talks to a; a spoke two turns ago, c just spoke
		const prior: AffinityPrior = (from, to) =>
			from === "d" && to === "a" ? 1 : 0;
		const spec: Array<[number, string]> = [
			[0, "a"],
			[5, "b"],
			[9, "c"],
			[12, "d"],
		];
		const without = attributeAttention(msgs(spec), none)[3]!;
		const withPrior = attributeAttention(msgs(spec), prior)[3]!;
		expect(without.to.c).toBeGreaterThan(without.to.a ?? 0);
		expect(withPrior.to.a).toBeGreaterThan(withPrior.to.c ?? 0);
	});

	test("an opener after a long silence goes to the room", () => {
		const [opener] = attributeAttention(
			msgs([
				[0, "a"],
				[10, "b"],
				[12, "c"],
			]),
			none,
		);
		expect(opener?.room).toBe(1);
		expect(opener?.to).toEqual({});
	});
});

describe("focusMap", () => {
	test("finds a reciprocal pair, a pursuit, an unattended bidder and a centre", () => {
		// a and b talk; c keeps addressing a, a never answers c; e opens twice, nobody answers
		const spec: Array<
			[number, string, { replyTo?: string; mentions?: string[] }?]
		> = [];
		let t = 0;
		for (let i = 0; i < 4; i++) {
			spec.push([(t += 5), "a", { mentions: ["b"] }]);
			spec.push([(t += 5), "b", { mentions: ["a"] }]);
			spec.push([(t += 5), "c", { mentions: ["a"] }]);
		}
		spec.push([(t += 400), "e"]);
		spec.push([(t += 400), "e"]);
		const m = msgs(spec);
		const focus = focusMap(m, attributeAttention(m, none));
		const kinds = focus.structures.map((s) => s.kind);
		expect(focus.structures).toContainEqual(
			expect.objectContaining({ kind: "pair", a: "a", b: "b" }),
		);
		expect(focus.structures).toContainEqual(
			expect.objectContaining({ kind: "pursuit", from: "c", to: "a" }),
		);
		expect(focus.structures).toContainEqual(
			expect.objectContaining({ kind: "centre", user: "a" }),
		);
		expect(focus.structures).toContainEqual(
			expect.objectContaining({ kind: "unattended", user: "e" }),
		);
		expect(kinds).not.toContain("room");
	});

	test("a bid is answered only when the target turns back to the bidder in time", () => {
		const m = msgs([
			[0, "a", { mentions: ["b"] }],
			[30, "b", { mentions: ["a"] }],
			[60, "c", { mentions: ["b"] }],
			[70, "a"],
			[80, "a"],
		]);
		const bids = focusMap(m, attributeAttention(m, none)).bids;
		expect(bids.find((b) => b.message_id === "m0")?.answered_by).toBe("b");
		expect(bids.find((b) => b.message_id === "m2")?.answered_by).toBeNull();
	});
});
