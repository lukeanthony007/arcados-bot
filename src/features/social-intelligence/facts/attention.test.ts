import { describe, expect, test } from "bun:test";
import {
	countStructures,
	decayWeight,
	findCommunities,
	herfindahl,
	isPeripheral,
	isPursuit,
	pagerank,
	rankFlows,
	sizeBucket,
} from "./attention";

describe("decayWeight", () => {
	test("halves every half-life", () => {
		expect(decayWeight(0)).toBe(1);
		expect(decayWeight(180)).toBeCloseTo(0.5);
		expect(decayWeight(360)).toBeCloseTo(0.25);
		expect(decayWeight(-5)).toBe(1);
	});
});

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

	test("periphery: bids, below-baseline uptake, standing at or under the median", () => {
		expect(isPeripheral(5, 0.1, 0.3, 0.01, 0.02)).toBe(true);
		expect(isPeripheral(2, 0, 0.3, 0.01, 0.02)).toBe(false);
		expect(isPeripheral(5, 0.3, 0.3, 0.01, 0.02)).toBe(false);
		expect(isPeripheral(5, 0.1, 0.3, 0.2, 0.02)).toBe(false);
	});
});
