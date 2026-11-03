import { describe, expect, test } from "bun:test";
import { type AddressableMessage, TURN_GAP_MS, inferTurns } from "./addressing";

const T0 = Date.UTC(2026, 0, 1);

/** `[secondsFromT0, author, { replyTo?, mentions? }?]` */
function msgs(
	spec: Array<[number, string, { replyTo?: string; mentions?: string[] }?]>,
): AddressableMessage[] {
	return spec.map(([seconds, author, extra], i) => ({
		id: `m${i}`,
		author_id: author,
		created_at: new Date(T0 + seconds * 1000),
		referenced_message_id: extra?.replyTo ?? null,
		mentions: extra?.mentions ?? [],
	}));
}

const byPair = (turns: ReturnType<typeof inferTurns>) =>
	Object.fromEntries(turns.map((t) => [`${t.from}>${t.to}`, t.turns]));

describe("inferTurns", () => {
	test("in a two-person conversation every implicit message goes to the other person", () => {
		const out = inferTurns(
			msgs([
				[0, "a"],
				[5, "a"],
				[600, "b"],
				[1200, "a"],
			]),
		);
		expect(byPair(out)).toEqual({ "a>b": 3, "b>a": 1 });
	});

	test("explicit replies and mentions are not counted (closeness counts them from messages)", () => {
		const out = inferTurns(
			msgs([
				[0, "a"],
				[5, "b", { replyTo: "m0" }],
				[10, "c", { mentions: ["a"] }],
			]),
		);
		expect(byPair(out)).toEqual({});
	});

	test("in a group, answering whoever just spoke counts within the turn gap only", () => {
		const late = TURN_GAP_MS / 1000 + 1;
		const out = inferTurns(
			msgs([
				[0, "a"],
				[10, "b"],
				[20, "c"],
				[20 + late, "a"],
			]),
		);
		expect(byPair(out)).toEqual({ "b>a": 1, "c>b": 1 });
	});

	test("a continuation keeps the author's previous addressee, explicit or inferred", () => {
		const out = inferTurns(
			msgs([
				[0, "a"],
				[5, "b"],
				[8, "b"],
				[12, "c", { replyTo: "m0" }],
				[15, "c"],
				[400, "d"],
			]),
		);
		expect(byPair(out)).toEqual({ "b>a": 2, "c>a": 1 });
	});

	test("a continuation with no known addressee is to the room", () => {
		expect(
			inferTurns(
				msgs([
					[0, "a"],
					[5, "a"],
					[10, "b"],
					[15, "c"],
				]),
			),
		).toEqual([
			{ from: "b", to: "a", turns: 1 },
			{ from: "c", to: "b", turns: 1 },
		]);
	});
});
