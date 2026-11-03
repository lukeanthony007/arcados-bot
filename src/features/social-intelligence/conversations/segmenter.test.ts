import { describe, expect, test } from "bun:test";
import {
	EPISODE_HARD_MAX,
	EPISODE_SOFT_MAX,
	GAP_MS,
	MAX_SPAN_MS,
	REPLY_STITCH_MS,
	type SegmentMessage,
	isOpen,
	isSignificant,
	segment,
	splitEpisodes,
} from "./segmenter";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;

/** `[minutesFromT0, author, replyTo?]` */
function msgs(spec: Array<[number, string, string?]>): SegmentMessage[] {
	return spec.map(([minutes, author, replyTo], i) => ({
		id: `m${i}`,
		author_id: author,
		created_at: new Date(T0 + minutes * MIN),
		referenced_message_id: replyTo ?? null,
		mentions: [],
	}));
}

describe("segment", () => {
	test("splits on a silence longer than the gap and keeps shorter ones together", () => {
		const out = segment(
			"c",
			msgs([
				[0, "a"],
				[5, "b"],
				[15, "a"],
				[15 + GAP_MS / MIN + 1, "b"],
				[40, "a"],
				[45, "b"],
			]),
		);
		expect(out.map((s) => s.messages.map((m) => m.id))).toEqual([
			["m0", "m1", "m2"],
			["m3", "m4", "m5"],
		]);
	});

	test("a reply to a message in the open conversation stitches across a silence", () => {
		const out = segment(
			"c",
			msgs([
				[0, "a"],
				[1, "b"],
				[2, "a"],
				[120, "b", "m1"],
				[121, "a"],
			]),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.messages).toHaveLength(5);
	});

	test("a reply does not stitch after the stitch limit, or to a message outside the conversation", () => {
		const late = 2 + REPLY_STITCH_MS / MIN + 1;
		const out = segment(
			"c",
			msgs([
				[0, "a"],
				[1, "b"],
				[2, "a"],
				[late, "b", "m1"],
				[late + 1, "a"],
				[late + 2, "b"],
			]),
		);
		expect(out.map((s) => s.messages.length)).toEqual([3, 3]);
		const foreign = segment(
			"c",
			msgs([
				[0, "a"],
				[1, "b"],
				[2, "a"],
				[90, "b", "nope"],
				[91, "a"],
				[92, "b"],
			]),
		);
		expect(foreign.map((s) => s.messages.length)).toEqual([3, 3]);
	});

	test("caps a conversation at the maximum span even with no silence", () => {
		const spec: Array<[number, string]> = [];
		for (let minute = 0; minute <= MAX_SPAN_MS / MIN + 30; minute += 10)
			spec.push([minute, minute % 20 ? "a" : "b"]);
		const out = segment("c", msgs(spec));
		const sessions = new Set(out.map((s) => s.session_id));
		expect(sessions.size).toBe(2);
		for (const sessionId of sessions) {
			const inSession = out.filter((s) => s.session_id === sessionId);
			const span =
				inSession[inSession.length - 1]!.end.getTime() -
				inSession[0]!.start.getTime();
			expect(span).toBeLessThanOrEqual(MAX_SPAN_MS);
		}
	});

	test("drops runs with too few messages or a single author", () => {
		const out = segment(
			"c",
			msgs([
				[0, "a"],
				[1, "a"],
				[2, "a"],
				[3, "a"],
				[60, "a"],
				[61, "b"],
				[200, "a"],
				[201, "b"],
				[202, "b"],
			]),
		);
		expect(out.map((s) => s.messages.map((m) => m.id))).toEqual([
			["m6", "m7", "m8"],
		]);
	});

	test("ids depend only on the channel and the first message, so reruns agree", () => {
		const input = msgs([
			[0, "a"],
			[1, "b"],
			[2, "a"],
		]);
		expect(segment("chan", input)[0]?.id).toBe("conv_chan_m0");
		expect(segment("chan", input)).toEqual(segment("chan", input));
		expect(segment("other", input)[0]?.id).toBe("conv_other_m0");
	});

	test("participants are listed in order of first appearance", () => {
		expect(
			segment(
				"c",
				msgs([
					[0, "b"],
					[1, "a"],
					[2, "b"],
					[3, "c"],
				]),
			)[0]?.participants,
		).toEqual(["b", "a", "c"]);
	});
});

describe("isOpen / isSignificant", () => {
	const [conv] = segment(
		"c",
		msgs([
			[0, "a"],
			[1, "b"],
			[2, "a"],
		]),
	);
	test("open while the last message is within the gap", () => {
		expect(isOpen(conv!, new Date(T0 + 2 * MIN + GAP_MS))).toBe(true);
		expect(isOpen(conv!, new Date(T0 + 2 * MIN + GAP_MS + 1))).toBe(false);
	});
	test("significant with 3+ people or 10+ messages", () => {
		expect(isSignificant(conv!)).toBe(false);
		expect(
			isSignificant(
				segment(
					"c",
					msgs([
						[0, "a"],
						[1, "b"],
						[2, "c"],
					]),
				)[0]!,
			),
		).toBe(true);
		const ten = segment(
			"c",
			msgs(Array.from({ length: 10 }, (_, i) => [i, i % 2 ? "a" : "b"])),
		);
		expect(isSignificant(ten[0]!)).toBe(true);
	});
});

describe("splitEpisodes", () => {
	const chat = (
		count: number,
		speakers: string[],
		startMinute = 0,
	): SegmentMessage[] =>
		msgs(
			Array.from({ length: count }, (_, i) => [
				startMinute + i,
				speakers[i % speakers.length]!,
			]),
		);

	test("short runs are one episode", () => {
		expect(splitEpisodes(chat(EPISODE_SOFT_MAX, ["a", "b"]))).toHaveLength(1);
	});

	test("a long run is cut where the speakers change, and the episodes share a session", () => {
		const run = [...chat(30, ["a", "b"]), ...chat(30, ["c", "d"], 30)];
		const episodes = splitEpisodes(run);
		expect(episodes.map((e) => e.length)).toEqual([30, 30]);
		const segments = segment("c", run);
		expect(segments).toHaveLength(2);
		expect(new Set(segments.map((s) => s.session_id)).size).toBe(1);
		expect(segments[0]?.session_id).toBe(segments[0]?.id);
	});

	test("a long run with the same speakers throughout is not cut below the hard cap", () => {
		expect(splitEpisodes(chat(EPISODE_HARD_MAX, ["a", "b"]))).toHaveLength(1);
		expect(
			splitEpisodes(chat(EPISODE_HARD_MAX + 30, ["a", "b"])).length,
		).toBeGreaterThan(1);
	});

	test("prefers a pause as the cut when speakers stay the same", () => {
		const run = [...chat(45, ["a", "b"]), ...chat(45, ["a", "b"], 45 + 9)];
		const episodes = splitEpisodes(run);
		expect(episodes[0]).toHaveLength(45);
	});

	test("never cuts between a reply and the message it answers", () => {
		const run = [...chat(30, ["a", "b"]), ...chat(30, ["c", "d"], 30)];
		run[30] = { ...run[30]!, referenced_message_id: run[29]!.id };
		const [first] = splitEpisodes(run);
		expect(first!.length).not.toBe(30);
	});
});
