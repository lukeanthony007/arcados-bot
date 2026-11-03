/**
 * Directed exchanges the conversation summarizer recorded between members
 * (`conversation_exchanges` rows with source 'model'): who addressed whom, in what tone.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { TONES } from "../conversations/dynamics";

export interface ExchangeNote {
	from_user: string;
	to_user: string;
	tone: string;
	note: string;
	start_time: Date;
}

export type ToneTally = Record<string, number>;

function rows<T>(result: { success: boolean; data?: unknown }): T[] {
	return result.success && Array.isArray(result.data)
		? (result.data as T[])
		: [];
}

export function emptyTally(): ToneTally {
	return Object.fromEntries(TONES.map((t) => [t, 0]));
}

/** "teasing 6, asking 3"; "none recorded" when empty */
export function formatTally(tally: ToneTally): string {
	const parts = Object.entries(tally)
		.filter(([, n]) => n > 0)
		.sort((x, y) => y[1] - x[1])
		.map(([tone, n]) => `${tone} ${n}`);
	return parts.length ? parts.join(", ") : "none recorded";
}

/** The pair's model exchanges in both directions, newest first */
export async function getPairExchangeNotes(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
	limit: number,
): Promise<ExchangeNote[]> {
	const result = await db.query(
		`SELECT x.from_user, x.to_user, x.tone, x.note, s.start_time
		FROM conversation_exchanges x
		JOIN conversation_segments s ON s.id = x.conversation_id
		WHERE s.guild_id = $1 AND x.source = 'model'
			AND ((x.from_user = $2 AND x.to_user = $3) OR (x.from_user = $3 AND x.to_user = $2))
		ORDER BY s.start_time DESC LIMIT $4`,
		[guildId, a, b, limit],
	);
	return rows<ExchangeNote>(result).map((r) => ({
		...r,
		start_time: new Date(r.start_time),
	}));
}

/** Tone counts over all of the pair's model exchanges, per direction */
export async function getPairToneTallies(
	db: PostgreSQLManager,
	guildId: string,
	a: string,
	b: string,
): Promise<{ a_to_b: ToneTally; b_to_a: ToneTally }> {
	const result = await db.query(
		`SELECT x.from_user, x.tone, COUNT(*)::int AS n
		FROM conversation_exchanges x
		JOIN conversation_segments s ON s.id = x.conversation_id
		WHERE s.guild_id = $1 AND x.source = 'model'
			AND ((x.from_user = $2 AND x.to_user = $3) OR (x.from_user = $3 AND x.to_user = $2))
		GROUP BY x.from_user, x.tone`,
		[guildId, a, b],
	);
	const out = { a_to_b: emptyTally(), b_to_a: emptyTally() };
	for (const r of rows<{ from_user: string; tone: string; n: number }>(
		result,
	)) {
		const target = r.from_user === a ? out.a_to_b : out.b_to_a;
		target[r.tone] = (target[r.tone] ?? 0) + Number(r.n);
	}
	return out;
}
