/**
 * Storylines: subjects or situations that continue across conversations. Two kinds:
 *   thread  someone's ongoing situation, a debate picked up again, a plan, a follow-up later
 *   bit     a running joke, phrase or persona that keeps coming back
 *
 * Built from the conversations' summaries, dynamics and bits (not messages), in two steps:
 *   1. links: the model says which later conversation continues which earlier one, and how.
 *      Run several times; each run's links form chains, and two conversations belong
 *      together when a majority of runs put them in the same chain (voting on exact links
 *      splits votes between "E8 continues E4" and "E8 continues E5"; voting on whole clusters
 *      made every run partition the day differently).
 *   2. each agreed chain is named and narrated in its own call.
 */
import {
	type JsonObjectSchema,
	OmpRuntime,
} from "../../../ai/runtime/OmpRuntime";
import { resolveName } from "./dynamics";

export interface StorylineEpisode {
	/** 1-based position in the day, shown to the model as E1, E2, … */
	index: number;
	start: Date;
	end: Date;
	participants: string[];
	topic: string;
	summary: string;
	dynamics: string;
	/** "from → to [tone]: note" lines; side remarks and jokes often survive only here */
	exchanges: string[];
	bits: string[];
}

export type StorylineKind = "thread" | "bit";

export interface StorylineLink {
	/** The later conversation */
	from: number;
	/** The earlier conversation it continues */
	to: number;
	kind: StorylineKind;
	/** Share of runs that proposed this link (0-1) */
	agreement: number;
}

export interface Storyline {
	kind: StorylineKind;
	title: string;
	episodes: number[];
	/** User id → their part */
	people: Array<{ user_id: string; part: string }>;
	arc: string;
	open: boolean;
}

const LINK_PROMPT = `You map how conversations in a Discord channel connect over a day, for the server's assistant bot. You read short records of each conversation (E1, E2, … in time order) and say which later conversations CONTINUE an earlier one.

Two kinds of continuation:
- thread: the same person's situation, debate, plan or story picked up again, including a follow-up hours later ("how did that go?");
- bit: the same running joke, phrase or persona brought back, even as a side remark.

Only link when the later conversation clearly carries on the same specific thing (same situation, same joke), not merely a similar topic or the same people. Link each later conversation to the most recent earlier conversation it continues. Many conversations continue nothing; that is normal.`;

const LINK_SCHEMA: JsonObjectSchema = {
	type: "object",
	properties: {
		links: {
			type: "array",
			items: {
				type: "object",
				properties: {
					from: {
						type: "integer",
						description: "The later conversation (E8 → 8)",
					},
					to: {
						type: "integer",
						description: "The earlier conversation it continues",
					},
					kind: { type: "string", enum: ["thread", "bit"] },
					what: {
						type: "string",
						description: "What carries over, a few words",
					},
				},
				required: ["from", "to", "kind", "what"],
			},
		},
	},
	required: ["links"],
};

const NARRATE_PROMPT = `You describe storylines that run through a day of conversations in a Discord channel, for the server's assistant bot. Each storyline is given as a list of conversations that are already known to belong together. Name it from what carries through ALL of them (a conversation's own topic label may describe only part of it, so do not just copy the first one), say what each person's part was, and describe how it developed (who started it, turning points, where it ended up). Name people by the names shown; never write user IDs.`;

const NARRATE_SCHEMA: JsonObjectSchema = {
	type: "object",
	properties: {
		storylines: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: {
						type: "integer",
						description: "The storyline number given (S1 → 1)",
					},
					title: { type: "string", description: "3-8 words naming it" },
					people: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string", description: "Name exactly as shown" },
								part: {
									type: "string",
									description:
										"Their part, e.g. 'the one venting', 'kept bringing the joke back'",
								},
							},
							required: ["name", "part"],
						},
					},
					arc: {
						type: "string",
						description: "2-3 sentences: how it started, developed, ended",
					},
					open: { type: "boolean", description: "True if left unresolved" },
				},
				required: ["id", "title", "people", "arc", "open"],
			},
		},
	},
	required: ["storylines"],
};

function describeEpisode(e: StorylineEpisode, timeZone: string): string {
	const clock = (d: Date) =>
		d.toLocaleTimeString("en-GB", {
			timeZone,
			hour: "2-digit",
			minute: "2-digit",
		});
	return [
		`E${e.index} ${clock(e.start)}–${clock(e.end)} [${e.participants.join(", ")}] ${e.topic}`,
		`   ${e.summary}`,
		`   Dynamics: ${e.dynamics}`,
		...e.exchanges.map((x) => `   - ${x}`),
		...(e.bits.length ? [`   Bits: ${e.bits.join(" | ")}`] : []),
	].join("\n");
}

/** One run of the link step: proposed links, deduplicated */
async function proposeLinks(
	episodes: StorylineEpisode[],
	timeZone: string,
): Promise<Array<Omit<StorylineLink, "agreement">> | null> {
	const [general, bits] = await Promise.all([
		OmpRuntime.get().generateStructured<{
			links: Array<{ from: number; to: number; kind: string; what: string }>;
		}>({
			systemPrompt: LINK_PROMPT,
			prompt: `The day's conversations, in order:\n\n${episodes.map((e) => describeEpisode(e, timeZone)).join("\n\n")}`,
			schema: LINK_SCHEMA,
			label: "rnd.storyline-links",
		}),
		proposeBitLinks(episodes),
	]);
	if (!general?.links) return null;
	const known = new Set(episodes.map((e) => e.index));
	const seen = new Set<string>();
	const links: Array<Omit<StorylineLink, "agreement">> = [];
	const proposed = [
		...general.links.map((l) => ({
			...l,
			kind: l.kind === "bit" ? "bit" : "thread",
		})),
		...(bits ?? []).map((l) => ({ ...l, kind: "bit" })),
	];
	for (const l of proposed) {
		const [from, to] = [Math.max(l.from, l.to), Math.min(l.from, l.to)];
		const kind: StorylineKind = l.kind === "bit" ? "bit" : "thread";
		const key = `${from}:${to}:${kind}`;
		if (from === to || !known.has(from) || !known.has(to) || seen.has(key))
			continue;
		seen.add(key);
		links.push({ from, to, kind });
	}
	return links;
}

/**
 * Running jokes get lost among the threads in the general pass (they are side remarks), so
 * they get their own look at just the conversations' bits: which ones are the same joke.
 */
async function proposeBitLinks(
	episodes: StorylineEpisode[],
): Promise<Array<{ from: number; to: number }> | null> {
	const withBits = episodes.filter((e) => e.bits.length);
	if (withBits.length < 2) return [];
	const written = await OmpRuntime.get().generateStructured<{
		links: Array<{ from: number; to: number; what: string }>;
	}>({
		systemPrompt: `You find running jokes in a Discord channel. Below are the jokes, phrases and memorable lines recorded for each conversation of one day (E numbers in time order). Link two conversations when the same joke, phrase, persona or bit comes back in the later one (same idea, not just the same person joking). Report every such pair; if nothing recurs, report none.`,
		prompt: withBits
			.map(
				(e) =>
					`E${e.index} [${e.participants.join(", ")}]: ${e.bits.join(" | ")}`,
			)
			.join("\n"),
		schema: {
			type: "object",
			properties: {
				links: {
					type: "array",
					items: {
						type: "object",
						properties: {
							from: { type: "integer", description: "The later conversation" },
							to: {
								type: "integer",
								description: "The earlier conversation where the bit appeared",
							},
							what: { type: "string", description: "The bit, a few words" },
						},
						required: ["from", "to", "what"],
					},
				},
			},
			required: ["links"],
		},
		label: "rnd.storyline-bits",
	});
	return written?.links ?? null;
}

/** How often independent runs put each pair of conversations in the same chain (0-1) */
export async function voteLinks(
	episodes: StorylineEpisode[],
	timeZone: string,
	runs = 5,
): Promise<StorylineLink[] | null> {
	const proposals = (
		await Promise.all(
			Array.from({ length: runs }, () => proposeLinks(episodes, timeZone)),
		)
	).filter((p): p is Array<Omit<StorylineLink, "agreement">> => p !== null);
	if (!proposals.length) return null;
	const votes = new Map<string, number>();
	// Each run's links → chains → "these two belong together" votes, per kind
	for (const run of proposals) {
		for (const chain of chainLinks(run.map((l) => ({ ...l, agreement: 1 })))) {
			for (const [a, i] of chain.episodes.entries()) {
				for (const j of chain.episodes.slice(a + 1)) {
					const key = `${j}:${i}:${chain.kind}`;
					votes.set(key, (votes.get(key) ?? 0) + 1);
				}
			}
		}
	}
	// Every pair any run put together, with the share of runs that did
	return [...votes].map(([key, n]) => {
		const [from, to, kind] = key.split(":") as [string, string, StorylineKind];
		return {
			from: Number(from),
			to: Number(to),
			kind,
			agreement: n / proposals.length,
		};
	});
}

/** Connected chains of links, per kind; each chain is a sorted list of episode numbers */
export function chainLinks(
	links: StorylineLink[],
): Array<{ kind: StorylineKind; episodes: number[] }> {
	const chains: Array<{ kind: StorylineKind; episodes: number[] }> = [];
	for (const kind of ["thread", "bit"] as const) {
		const parent = new Map<number, number>();
		const find = (x: number): number => {
			const p = parent.get(x) ?? x;
			if (p === x) return x;
			const root = find(p);
			parent.set(x, root);
			return root;
		};
		for (const l of links.filter((link) => link.kind === kind))
			parent.set(find(l.from), find(l.to));
		const groups = new Map<number, Set<number>>();
		for (const l of links.filter((link) => link.kind === kind)) {
			for (const e of [l.from, l.to]) {
				const root = find(e);
				const group = groups.get(root) ?? groups.set(root, new Set()).get(root);
				group?.add(e);
			}
		}
		for (const group of groups.values()) {
			chains.push({ kind, episodes: [...group].sort((a, b) => a - b) });
		}
	}
	return chains.sort((a, b) => (a.episodes[0] ?? 0) - (b.episodes[0] ?? 0));
}

/**
 * Group conversations by agreement, per kind: start from single conversations and merge the
 * two groups whose AVERAGE pairwise agreement is highest, while it stays above `threshold`
 * (pairs nobody proposed count as 0). Unlike chaining agreed pairs, one borderline pair can't
 * fuse two otherwise separate storylines.
 */
export function groupByAgreement(
	pairs: StorylineLink[],
	threshold = 0.5,
): Array<{ kind: StorylineKind; episodes: number[] }> {
	const out: Array<{ kind: StorylineKind; episodes: number[] }> = [];
	for (const kind of ["thread", "bit"] as const) {
		const agreement = new Map<string, number>();
		const members = new Set<number>();
		for (const p of pairs.filter((pair) => pair.kind === kind)) {
			agreement.set(
				`${Math.min(p.from, p.to)}:${Math.max(p.from, p.to)}`,
				p.agreement,
			);
			members.add(p.from);
			members.add(p.to);
		}
		const score = (a: number, b: number) =>
			agreement.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? 0;
		let groups = [...members].map((e) => [e]);
		for (;;) {
			let best: [number, number] | null = null;
			let bestScore = threshold;
			for (let i = 0; i < groups.length; i++) {
				for (let j = i + 1; j < groups.length; j++) {
					const a = groups[i] as number[];
					const b = groups[j] as number[];
					let total = 0;
					for (const x of a) for (const y of b) total += score(x, y);
					const average = total / (a.length * b.length);
					if (average > bestScore) {
						bestScore = average;
						best = [i, j];
					}
				}
			}
			if (!best) break;
			const [i, j] = best;
			const merged = [...(groups[i] as number[]), ...(groups[j] as number[])];
			groups = groups.filter((_, k) => k !== i && k !== j);
			groups.push(merged);
		}
		for (const g of groups)
			if (g.length >= 2) out.push({ kind, episodes: g.sort((x, y) => x - y) });
	}
	return out.sort((a, b) => (a.episodes[0] ?? 0) - (b.episodes[0] ?? 0));
}

/** Agreed links → chains → named, narrated storylines */
export async function buildStorylines(
	episodes: StorylineEpisode[],
	idByName: Map<string, string>,
	timeZone: string,
): Promise<{ storylines: Storyline[]; links: StorylineLink[] } | null> {
	const votes = await voteLinks(episodes, timeZone);
	if (!votes) return null;
	const chains = groupByAgreement(votes);
	const links = votes.filter((v) => v.agreement > 0.5);
	if (!chains.length) return { storylines: [], links };

	// One call per chain, so a narration can't be matched to the wrong chain
	const byIndex = new Map(episodes.map((e) => [e.index, e]));
	const storylines = await Promise.all(
		chains.map(async (chain) => {
			const prompt = `S1 (${chain.kind}):\n${chain.episodes
				.map((n) => byIndex.get(n))
				.filter((e): e is StorylineEpisode => !!e)
				.map((e) =>
					chain.kind === "bit"
						? `E${e.index} [${e.participants.join(", ")}] bits: ${e.bits.join(" | ") || "(none recorded)"}`
						: describeEpisode(e, timeZone),
				)
				.join("\n")}`;
			const written = await OmpRuntime.get().generateStructured<{
				storylines: Array<{
					title: string;
					people: Array<{ name: string; part: string }>;
					arc: string;
					open: boolean;
				}>;
			}>({
				systemPrompt: NARRATE_PROMPT,
				prompt,
				schema: NARRATE_SCHEMA,
				label: "rnd.storyline-narrate",
			});
			const w = written?.storylines?.[0];
			return {
				kind: chain.kind,
				episodes: chain.episodes,
				title:
					w?.title.trim() ??
					`${chain.kind} ${chain.episodes.map((n) => `E${n}`).join("-")}`,
				people: (w?.people ?? []).flatMap((p) => {
					const user_id = resolveName(p.name, idByName);
					return user_id ? [{ user_id, part: p.part.trim() }] : [];
				}),
				arc: w?.arc.trim() ?? "",
				open: Boolean(w?.open),
			};
		}),
	);
	return { storylines, links };
}
