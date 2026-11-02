import type {
	DatabaseResult,
	PostgreSQLManager,
} from "../../../database/PostgreSQLManager";

/**
 * Records live interaction events into `relationship_edges` (directed per-pair counters).
 *
 * The edges are a fast cache for conversation grouping and enrichment scheduling only.
 * Closeness between members is defined once, from message history, in `facts/closeness.ts`.
 */
export class RelationshipMapper {
	constructor(private readonly db: PostgreSQLManager) {}

	/** Record a single interaction event (O(1) update) */
	async recordInteraction(
		guildId: string,
		authorId: string,
		otherId: string,
		kind: "message" | "mention" | "reply" | "reaction",
		direction: "a_to_b" | "b_to_a",
		_timestamp: Date,
	): Promise<DatabaseResult<void>> {
		if (authorId === otherId) return { success: true };

		const delta: Parameters<PostgreSQLManager["upsertEdgeCounters"]>[3] = {
			total: 1,
		};
		if (kind === "message") {
			delta[direction === "a_to_b" ? "msg_a_to_b" : "msg_b_to_a"] = 1;
		} else {
			delta[
				kind === "reply"
					? "replies"
					: kind === "mention"
						? "mentions"
						: "reactions"
			] = 1;
		}

		const result = await this.db.upsertEdgeCounters(
			guildId,
			authorId,
			otherId,
			delta,
		);
		return result.success
			? { success: true }
			: { success: false, error: result.error };
	}
}
