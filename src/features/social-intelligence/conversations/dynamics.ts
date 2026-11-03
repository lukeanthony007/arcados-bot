/**
 * Directional dynamics of one conversation, as read by the summarizer from the named
 * transcript: who it was really between, who drove it, who addressed whom and in what tone.
 * Stored on `conversation_segments.dynamics` (ids) and as `conversation_exchanges` rows with
 * source 'model'. These inform dossiers and tools; closeness uses only the rule-based turns.
 */

export const TONES = [
	"teasing",
	"supportive",
	"asking",
	"answering",
	"dismissing",
	"escalating",
	"checking_in",
	"flirting",
	"arguing",
	"neutral",
] as const;
export type Tone = (typeof TONES)[number];

/** What the model submits (people by display name) */
export interface WrittenDynamics {
	note: string;
	roles: { drivers: string[]; responders: string[]; ignored: string[] };
	exchanges: Array<{ from: string; to: string; tone: string; note: string }>;
}

/** What is stored (people by user id) */
export interface ConversationDynamics {
	/** One sentence: who it was between, who drove it, who got left out */
	note: string;
	roles: { drivers: string[]; responders: string[]; ignored: string[] };
	exchanges: Array<{ from: string; to: string; tone: Tone; note: string }>;
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
				.map((n) => idByName.get(n.trim()))
				.filter((id): id is string => !!id),
		),
	];
	// One row per direction: a repeated pair keeps its first tone and gathers its notes
	const byPair = new Map<string, ConversationDynamics["exchanges"][number]>();
	for (const x of written.exchanges ?? []) {
		const from = idByName.get(x.from?.trim() ?? "");
		const to = idByName.get(x.to?.trim() ?? "");
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
		roles: {
			drivers: resolve(written.roles?.drivers ?? []),
			responders: resolve(written.roles?.responders ?? []),
			ignored: resolve(written.roles?.ignored ?? []),
		},
		exchanges,
	};
}
