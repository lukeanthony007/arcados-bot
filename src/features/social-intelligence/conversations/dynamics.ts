/**
 * Directional dynamics of one conversation, as read by the summarizer from the named
 * transcript: who it was really between, who drove it, who addressed whom and in what tone.
 * Stored on `conversation_segments.dynamics` (ids) and as `conversation_exchanges` rows with
 * source 'model'. These inform dossiers and tools; closeness uses only the rule-based turns.
 */

export const TONES = [
	"joking",
	"teasing",
	"mocking",
	"venting",
	"supportive",
	"validating",
	"advising",
	"asking",
	"answering",
	"checking_in",
	"dismissing",
	"escalating",
	"arguing",
	"flirting",
	"neutral",
] as const;
export type Tone = (typeof TONES)[number];

/** What the model submits (people by display name) */
export interface WrittenDynamics {
	note: string;
	roles: { drivers: string[]; responders: string[]; ignored: string[] };
	exchanges: Array<{ from: string; to: string; tone: string; note: string }>;
	bits?: string[];
}

/** What is stored (people by user id) */
export interface ConversationDynamics {
	/** One sentence: who it was between, who drove it, who got left out */
	note: string;
	roles: { drivers: string[]; responders: string[]; ignored: string[] };
	exchanges: Array<{ from: string; to: string; tone: Tone; note: string }>;
	/** Running jokes, recurring phrases, memorable lines: "who: what" */
	bits: string[];
}

/**
 * Comparable form of a name: lowercase ASCII letters and digits ("toastᓚᘏᗢ", "Toast" and the
 * model's mangled "toastᶚᶚᶞᶟ" all become "toast"); names with no ASCII keep their letters
 */
function normalizeName(name: string): string {
	const lower = name.toLowerCase();
	const ascii = lower.replace(/[^a-z0-9]+/g, "");
	return ascii.length >= 3 ? ascii : lower.replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Map a name the model wrote to a participant id: exact, then normalized, then a unique
 * prefix of at least 3 characters (the model shortens "toastᓚᘏᗢ" to "toast", capitalizes
 * "alex", drops "Pseudoacacia").
 */
export function resolveName(
	name: string,
	idByName: Map<string, string>,
): string | undefined {
	const exact = idByName.get(name.trim());
	if (exact) return exact;
	const wanted = normalizeName(name);
	if (wanted.length < 3) return undefined;
	const candidates = [...idByName].map(
		([known, id]) => [normalizeName(known), id] as const,
	);
	const same = candidates.filter(([known]) => known === wanted);
	if (same.length === 1) return same[0]?.[1];
	const prefixed = candidates.filter(
		([known]) => known.startsWith(wanted) || wanted.startsWith(known),
	);
	return prefixed.length === 1 ? prefixed[0]?.[1] : undefined;
}

/**
 * Resolve the model's names to ids; unknown names and self-addressed exchanges are dropped,
 * unknown tones become "neutral".
 */
export function toStoredDynamics(
	written: WrittenDynamics,
	idByName: Map<string, string>,
): ConversationDynamics {
	const resolve = (names: string[]) => [
		...new Set(
			names
				.map((n) => resolveName(n, idByName))
				.filter((id): id is string => !!id),
		),
	];
	// One row per direction: a repeated pair keeps its first tone and gathers its notes
	const byPair = new Map<string, ConversationDynamics["exchanges"][number]>();
	for (const x of written.exchanges ?? []) {
		const from = resolveName(x.from ?? "", idByName);
		const to = resolveName(x.to ?? "", idByName);
		if (!from || !to || from === to) continue;
		const tone = (TONES as readonly string[]).includes(x.tone)
			? (x.tone as Tone)
			: "neutral";
		const note = (x.note ?? "").trim();
		const existing = byPair.get(`${from}>${to}`);
		if (existing) {
			if (note)
				existing.note = existing.note ? `${existing.note}; ${note}` : note;
		} else {
			byPair.set(`${from}>${to}`, { from, to, tone, note });
		}
	}
	const exchanges = [...byPair.values()];
	return {
		note: (written.note ?? "").trim(),
		bits: (written.bits ?? []).map((b) => b.trim()).filter(Boolean),
		roles: {
			drivers: resolve(written.roles?.drivers ?? []),
			responders: resolve(written.roles?.responders ?? []),
			ignored: resolve(written.roles?.ignored ?? []),
		},
		exchanges,
	};
}
