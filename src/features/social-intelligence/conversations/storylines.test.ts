import { describe, expect, test } from "bun:test";
import { type StorylineLink, chainLinks, groupByAgreement } from "./storylines";

const pair = (
	to: number,
	from: number,
	agreement: number,
	kind: "thread" | "bit" = "bit",
): StorylineLink => ({
	from,
	to,
	kind,
	agreement,
});

describe("groupByAgreement", () => {
	test("a single borderline pair does not fuse two strong groups", () => {
		const groups = groupByAgreement([
			pair(4, 8, 0.8),
			pair(13, 16, 0.8),
			pair(8, 13, 0.6),
		]);
		expect(groups.map((g) => g.episodes)).toEqual([
			[4, 8],
			[13, 16],
		]);
	});

	test("merges when the group as a whole agrees", () => {
		const groups = groupByAgreement(
			[pair(2, 3, 1), pair(3, 4, 1), pair(2, 4, 0.8)],
			0.5,
		);
		expect(groups.map((g) => g.episodes)).toEqual([[2, 3, 4]]);
	});

	test("pairs at or below the threshold are dropped and kinds stay apart", () => {
		const groups = groupByAgreement([
			pair(1, 2, 0.4),
			pair(5, 6, 1, "thread"),
			pair(5, 6, 1, "bit"),
		]);
		expect(groups).toEqual([
			{ kind: "thread", episodes: [5, 6] },
			{ kind: "bit", episodes: [5, 6] },
		]);
	});
});

describe("chainLinks", () => {
	test("connects links transitively per kind", () => {
		const chains = chainLinks([
			pair(1, 2, 1, "thread"),
			pair(2, 5, 1, "thread"),
			pair(3, 4, 1),
		]);
		expect(chains).toEqual([
			{ kind: "thread", episodes: [1, 2, 5] },
			{ kind: "bit", episodes: [3, 4] },
		]);
	});
});
