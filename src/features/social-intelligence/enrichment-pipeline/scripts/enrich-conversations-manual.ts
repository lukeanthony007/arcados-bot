#!/usr/bin/env tsx
/**
 * Manual Conversation Enrichment Script
 *
 * Usage:
 *   bun run enrich-conversations-manual.ts 24        # Unsummarized conversations from the last 24 hours
 *   bun run enrich-conversations-manual.ts 168       # …from the last 7 days
 *   bun run enrich-conversations-manual.ts --force   # All unsummarized conversations
 *   bun run enrich-conversations-manual.ts --from 2025-10-13 --to 2025-10-20
 *                                                    # Re-describe every significant conversation in the range
 */

import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { EnrichmentPipelineOrchestrator } from "../EnrichmentPipelineOrchestrator";

const db = new PostgreSQLManager();

async function main() {
	const args = process.argv.slice(2);
	const hoursBack =
		args.includes("--force") || args.includes("--from")
			? null
			: args[0]
				? Number.parseInt(args[0], 10)
				: 24;

	console.log("🤖 Manual Conversation Enrichment");
	console.log("=".repeat(80));
	if (hoursBack) {
		console.log(`Time window: Past ${hoursBack} hours`);
	} else {
		console.log("Mode: FORCE (all conversations)");
	}
	console.log("=".repeat(80));

	const connected = await db.connect();
	if (!connected) {
		console.error("❌ Failed to connect to database");
		process.exit(1);
	}

	const guildId = config.guildId;
	if (!guildId) {
		console.error("❌ No guild ID configured");
		await db.disconnect();
		process.exit(1);
	}

	// Initialize orchestrator
	const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
	await orchestrator.initialize(db);

	// Query conversations to enrich
	const since = hoursBack
		? new Date(Date.now() - hoursBack * 60 * 60 * 1000)
		: null;

	// --from/--to: re-describe every significant conversation in the range with the current
	// summarizer, including ones summarized before (their model exchanges are replaced)
	const rangeArg = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 && args[i + 1] ? new Date(args[i + 1] as string) : null;
	};
	const from = rangeArg("--from");
	const to = rangeArg("--to");

	const [query, params] =
		from && to
			? [
					`SELECT id, guild_id, participants, message_count
				FROM conversation_segments
				WHERE guild_id = $1 AND status = 'finalized' AND ai_processing_status <> 'skipped'
				AND start_time >= $2 AND start_time < $3
				ORDER BY start_time`,
					[guildId, from, to],
				]
			: hoursBack
				? [
						`SELECT id, guild_id, participants, message_count
				FROM conversation_segments
				WHERE guild_id = $1
				AND status = 'finalized'
				AND start_time >= $2
				AND (summary IS NULL OR summary = '' OR enrichment_version IS NULL)
				ORDER BY start_time DESC`,
						[guildId, since],
					]
				: [
						`SELECT id, guild_id, participants, message_count
				FROM conversation_segments
				WHERE guild_id = $1
				AND status = 'finalized'
				AND (summary IS NULL OR summary = '' OR enrichment_version IS NULL)
				ORDER BY start_time DESC`,
						[guildId],
					];

	const result = await db.query(query, params);

	if (!result.success || !result.data || result.data.length === 0) {
		console.log("ℹ️  No conversations found to enrich");
		await db.disconnect();
		return;
	}

	const conversations = result.data;
	console.log(`\n📋 Found ${conversations.length} conversations to enrich\n`);

	let enriched = 0;
	let failed = 0;

	for (const conv of conversations) {
		try {
			const participantCount = Array.isArray(conv.participants)
				? conv.participants.length
				: 0;
			const significance =
				participantCount >= 5
					? "high"
					: participantCount >= 3
						? "medium"
						: "low";

			await orchestrator.enqueueConversation(conv.id, guildId, significance);
			enriched++;

			if (enriched % 10 === 0) {
				console.log(`   Processed ${enriched}/${conversations.length}...`);
			}
		} catch (error) {
			console.error(`   ⚠️  Failed to enqueue conversation ${conv.id}:`, error);
			failed++;
		}
	}

	// Process queue
	console.log("\n🔄 Processing enrichment queue...\n");
	await orchestrator.processPendingEnrichments(conversations.length);

	console.log("\n🔹 Enrichment complete!");
	console.log(`   Enqueued: ${enriched}`);
	console.log(`   Failed: ${failed}`);

	await db.disconnect();
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});
