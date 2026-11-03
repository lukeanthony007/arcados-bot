import { describe, expect, test } from "bun:test";
import {
	type MemberSignals,
	classifyShape,
	countStructures,
	findCommunities,
	herfindahl,
	isAnchored,
	isPeripheral,
	isPursuit,
	pagerank,
	percentiles,
	rankFlows,
	sizeBucket,
	standingScores,
	uptakeOf,
} from "./attention";

describe("herfindahl", () => {
	test("one target is 1, even split is 1/n", () => {
		expect(herfindahl([5])).toBe(1);
		expect(herfindahl([1, 1, 1, 1])).toBeCloseTo(0.25);
		expect(herfindahl([])).toBe(0);
		expect(herfindahl([0, 0])).toBe(0);
	});
});

describe("isPursuit", () => {
	test("needs mass ≥ 3 and returned < 40% of it", () => {
		expect(isPursuit(5, 1)).toBe(true);
		expect(isPursuit(5, 2)).toBe(false);
		expect(isPursuit(2.9, 0)).toBe(false);
	});
});

describe("rankFlows", () => {
	test("shares of the total, sorted, with what came back", () => {
		const flows = rankFlows(
			new Map([
				["a", 6],
				["b", 2],
			]),
			new Map([["a", 5]]),
		);
		expect(flows.map((f) => f.id)).toEqual(["a", "b"]);
		expect(flows[0]?.share).toBeCloseTo(0.75);
		expect(flows[0]?.returned).toBe(5);
		expect(flows[1]?.returned).toBe(0);
	});
});

describe("pagerank", () => {
	test("sums to 1 and favours the node attention flows toward", () => {
		const ranks = pagerank([
			{ from: "a", to: "c", weight: 3 },
			{ from: "b", to: "c", weight: 3 },
			{ from: "c", to: "a", weight: 1 },
		]);
		const total = [...ranks.values()].reduce((s, v) => s + v, 0);
		expect(total).toBeCloseTo(1);
		expect(ranks.get("c") ?? 0).toBeGreaterThan(ranks.get("a") ?? 1);
		expect(ranks.get("a") ?? 0).toBeGreaterThan(ranks.get("b") ?? 1);
	});

	test("empty graph and dangling nodes are fine", () => {
		expect(pagerank([]).size).toBe(0);
		const ranks = pagerank([{ from: "a", to: "b", weight: 1 }]);
		expect([...ranks.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1);
		expect(ranks.get("b") ?? 0).toBeGreaterThan(ranks.get("a") ?? 1);
	});
});

describe("findCommunities", () => {
	const clique = (ids: string[], weight: number) =>
		ids.flatMap((x, i) =>
			ids.slice(i + 1).map((y) => ({ a: x, b: y, weight })),
		);

	test("splits two groups joined by a weak bridge, drops pairs", () => {
		const edges = [
			...clique(["a", "b", "c", "d"], 5),
			...clique(["w", "x", "y"], 4),
			{ a: "d", b: "w", weight: 0.5 },
			{ a: "p", b: "q", weight: 9 },
		];
		const groups = findCommunities(edges);
		expect(groups.length).toBe(2);
		expect([...(groups[0] ?? [])].sort()).toEqual(["a", "b", "c", "d"]);
		expect([...(groups[1] ?? [])].sort()).toEqual(["w", "x", "y"]);
	});

	test("deterministic", () => {
		const edges = clique(["a", "b", "c", "d", "e"], 2);
		expect(findCommunities(edges)).toEqual(
			findCommunities([...edges].reverse()),
		);
	});
});

describe("situations and structures", () => {
	test("size buckets", () => {
		expect(sizeBucket(1)).toBeNull();
		expect(sizeBucket(2)).toBe("one_on_one");
		expect(sizeBucket(4)).toBe("small_group");
		expect(sizeBucket(5)).toBe("large_group");
	});

	test("countStructures by role", () => {
		const counts = countStructures(
			[
				{ kind: "pair", a: "u", b: "x", mass: 3, reciprocity: 0.8 },
				{ kind: "pursuit", from: "u", to: "x", given: 4, returned: 1 },
				{ kind: "pursuit", from: "x", to: "u", given: 4, returned: 1 },
				{ kind: "centre", user: "u", received: 5, from_people: 3 },
				{ kind: "unattended", user: "x", bids: 3, received: 0 },
			],
			"u",
		);
		expect(counts).toEqual({
			pair: 1,
			pursuit_giver: 1,
			pursuit_target: 1,
			centre: 1,
			unattended: 0,
			room: 0,
		});
	});
});

const member = (
	over: Partial<MemberSignals> & { id: string },
): MemberSignals => ({
	given: 50,
	received: 50,
	reach: 5,
	bids: 20,
	bidsAnswered: 10,
	openers: 10,
	openersTakenUp: 5,
	topTwoInShare: 0.4,
	partner: 10,
	...over,
});

describe("social structure", () => {
	test("standing rewards draw, reach and uptake, not volume", () => {
		// The engine talks five times as much; the draw is answered more and reaches further
		const engine = member({
			id: "engine",
			given: 500,
			received: 400,
			reach: 6,
			bidsAnswered: 6,
		});
		const draw = member({
			id: "draw",
			given: 60,
			received: 80,
			reach: 9,
			bidsAnswered: 14,
		});
		const quiet = member({
			id: "quiet",
			given: 20,
			received: 15,
			reach: 2,
			bidsAnswered: 4,
		});
		const s = standingScores([engine, draw, quiet], {
			uptake: 0.4,
			pickup: 0.5,
		});
		expect(s.get("draw")).toBeGreaterThan(s.get("engine") ?? 0);
		expect(s.get("engine")).toBeGreaterThan(s.get("quiet") ?? 0);
	});

	test("a handful of answered bids is shrunk toward the server baseline", () => {
		const lucky = member({ id: "l", bids: 2, bidsAnswered: 2 });
		const steady = member({ id: "s", bids: 60, bidsAnswered: 42 });
		const base = { uptake: 0.3, pickup: 0.5 };
		expect(uptakeOf(lucky, base)).toBeCloseTo(0.44, 2);
		expect(uptakeOf(steady, base)).toBeGreaterThan(uptakeOf(lucky, base));
	});

	test("percentiles share ranks on ties", () => {
		expect(percentiles([3, 1, 3, 2])).toEqual([5 / 6, 0, 5 / 6, 1 / 3]);
	});

	test("shape: draws widely, engine, balanced", () => {
		expect(
			classifyShape(member({ id: "b", received: 70, reach: 9 }), 8, 100),
		).toBe("draws");
		expect(
			classifyShape(member({ id: "c", given: 200, received: 150 }), 8, 100),
		).toBe("engine");
		expect(classifyShape(member({ id: "d" }), 8, 100)).toBe("balanced");
	});

	test("anchored means clearly more concentrated than an even spread", () => {
		expect(isAnchored(member({ id: "j", reach: 9, topTwoInShare: 0.76 }))).toBe(
			true,
		);
		// Three givers: the top two hold two thirds anyway
		expect(isAnchored(member({ id: "k", reach: 3, topTwoInShare: 0.8 }))).toBe(
			false,
		);
		expect(isAnchored(member({ id: "m", reach: 9, topTwoInShare: 0.4 }))).toBe(
			false,
		);
	});

	test("periphery needs low return, no back-and-forth partner and low draw", () => {
		const reaching = member({
			id: "r",
			given: 30,
			received: 10,
			bidsAnswered: 2,
			openersTakenUp: 1,
			partner: 1,
		});
		const base = { uptake: 0.5, pickup: 0.5 };
		expect(isPeripheral(reaching, base)).toBe(true);
		// Same pattern, but with someone they really talk to: not peripheral
		expect(isPeripheral({ ...reaching, partner: 8 }, base)).toBe(false);
		// Answered as often as everyone else
		expect(
			isPeripheral({ ...reaching, bidsAnswered: 10, openersTakenUp: 5 }, base),
		).toBe(false);
	});
});
