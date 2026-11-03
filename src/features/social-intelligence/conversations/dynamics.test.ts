import { describe, expect, test } from "bun:test";
import { resolveName, toStoredDynamics } from "./dynamics";

const ids = new Map([
	["Terra", "1"],
	["alex", "2"],
	["Joe", "3"],
]);

describe("toStoredDynamics", () => {
	test("resolves names to ids and drops unknown or self-addressed exchanges", () => {
		const out = toStoredDynamics(
			{
				note: " Terra drove it ",
				roles: {
					drivers: ["Terra", "Nobody"],
					responders: ["alex", "alex"],
					ignored: [],
				},
				exchanges: [
					{ from: "Terra", to: "alex", tone: "teasing", note: "egged him on" },
					{ from: "alex", to: "alex", tone: "asking", note: "self" },
					{ from: "Ghost", to: "alex", tone: "asking", note: "unknown" },
				],
			},
			ids,
		);
		expect(out.note).toBe("Terra drove it");
		expect(out.roles).toEqual({
			drivers: ["1"],
			responders: ["2"],
			ignored: [],
		});
		expect(out.exchanges).toEqual([
			{ from: "1", to: "2", tone: "teasing", note: "egged him on" },
		]);
	});

	test("merges a repeated direction into one row and maps unknown tones to neutral", () => {
		const out = toStoredDynamics(
			{
				note: "",
				roles: { drivers: [], responders: [], ignored: [] },
				exchanges: [
					{
						from: "Terra",
						to: "alex",
						tone: "escalating",
						note: "cum monster bit",
					},
					{
						from: "Terra",
						to: "alex",
						tone: "neutral",
						note: "bird-raft story",
					},
					{
						from: "alex",
						to: "Joe",
						tone: "curious",
						note: "asked about his day",
					},
				],
			},
			ids,
		);
		expect(out.exchanges).toEqual([
			{
				from: "1",
				to: "2",
				tone: "escalating",
				note: "cum monster bit; bird-raft story",
			},
			{ from: "2", to: "3", tone: "neutral", note: "asked about his day" },
		]);
	});
});

describe("resolveName", () => {
	const known = new Map([
		["toastᓚᘏᗢ", "1"],
		["alex", "2"],
		["Terra Pseudoacacia", "3"],
		["Astoria", "4"],
		["AircraftMechanic", "5"],
	]);
	test("matches shortened, recased and decorated names uniquely", () => {
		expect(resolveName("toast", known)).toBe("1");
		expect(resolveName("Alex", known)).toBe("2");
		expect(resolveName("Terra", known)).toBe("3");
		expect(resolveName("terra pseudoacacia", known)).toBe("3");
	});
	test("refuses ambiguous or tiny names", () => {
		expect(resolveName("A", known)).toBeUndefined();
		expect(resolveName("Nobody", known)).toBeUndefined();
	});
});
