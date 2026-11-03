#!/usr/bin/env bun
/**
 * Re-segment every channel's whole history with the current rule.
 *
 * Existing conversations that closely match a new one (≥ 80% of messages in common) keep
 * their id, summary and embedding; the rest are replaced and queued for a summary by the
 * running bot. Safe to re-run: unchanged conversations are no-ops.
 *
 *   bun run resegment:history [--channel <name>]
 */

import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { loadAffinityPrior } from "../prior";
import { resegmentChannelHistory } from "../store";

async function main() {
	const guildId = config.guildId;
	if (!guildId) throw new Error("GUILD_ID is not configured");
	const only =
		process.argv.indexOf("--channel") >= 0
			? process.argv[process.argv.indexOf("--channel") + 1]
			: undefined;

	const db = new PostgreSQLManager();
	if (!(await db.connect())) throw new Error("Failed to connect to database");

	const channels = await db.query(
		`SELECT DISTINCT m.channel_id, c.name FROM messages m LEFT JOIN channels c ON c.id = m.channel_id
		 WHERE m.guild_id = $1 AND ($2::text IS NULL OR c.name = $2)`,
		[guildId, only ?? null],
	);
	const before = await db.query(
		"SELECT COUNT(*)::int AS n, COUNT(summary)::int AS summarized FROM conversation_segments WHERE guild_id = $1",
		[guildId],
	);
	const prior = await loadAffinityPrior(db, guildId);
	const totals = { upserted: 0, deleted: 0, kept: 0, finalized: 0 };
	for (const { channel_id, name } of (channels.data ?? []) as Array<{
		channel_id: string;
		name: string | null;
	}>) {
		const result = await resegmentChannelHistory(
			db,
			guildId,
			channel_id,
			prior,
		);
		totals.upserted += result.upserted;
		totals.deleted += result.deleted;
		totals.kept += result.kept;
		totals.finalized += result.finalized.length;
		if (result.upserted || result.deleted) {
			console.log(
				`   #${name ?? channel_id}: ${result.upserted} written, ${result.deleted} removed, ${result.kept} summaries kept`,
			);
		}
	}
	const after = await db.query(
		"SELECT COUNT(*)::int AS n, COUNT(summary)::int AS summarized, COUNT(*) FILTER (WHERE ai_processing_status = 'pending')::int AS pending FROM conversation_segments WHERE guild_id = $1",
		[guildId],
	);
	console.log(
		`🔹 Conversations ${before.data?.[0]?.n} → ${after.data?.[0]?.n}; summaries ${before.data?.[0]?.summarized} → ${after.data?.[0]?.summarized} (${totals.kept} carried over); ${after.data?.[0]?.pending} pending summary`,
	);
	await db.disconnect();
	process.exit(0);
}

main().catch((error) => {
	console.error("❌ Re-segmentation failed:", error);
	process.exit(1);
});
