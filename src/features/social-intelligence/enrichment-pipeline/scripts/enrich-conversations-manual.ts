#!/usr/bin/env tsx
/**
 * Manual Conversation Enrichment Script
 *
 * Usage:
 *   npx tsx enrich-conversations-manual.ts 24        # Enrich conversations from last 24 hours
 *   npx tsx enrich-conversations-manual.ts 168       # Enrich conversations from last 7 days
 *   npx tsx enrich-conversations-manual.ts --force    # Force enrich all conversations
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { EnrichmentPipelineOrchestrator } from "../EnrichmentPipelineOrchestrator";
import { config } from "../../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
	const args = process.argv.slice(2);
	const hoursBack = args.includes("--force")
		? null
		: args[0]
			? parseInt(args[0], 10)
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

	const query = hoursBack
		? `
			SELECT id, guild_id, participants, message_count
			FROM conversation_segments
			WHERE guild_id = $1
			AND status = 'finalized'
			AND start_time >= $2
			AND (summary IS NULL OR summary = '' OR enrichment_version IS NULL)
			ORDER BY start_time DESC
		`
		: `
			SELECT id, guild_id, participants, message_count
			FROM conversation_segments
			WHERE guild_id = $1
			AND status = 'finalized'
			AND (summary IS NULL OR summary = '' OR enrichment_version IS NULL)
			ORDER BY start_time DESC
		`;

	const result = await db.query(query, hoursBack ? [guildId, since] : [guildId]);

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
	console.log(`\n🔄 Processing enrichment queue...\n`);
	await orchestrator.processPendingEnrichments(conversations.length);

	console.log(`\n🔹 Enrichment complete!`);
	console.log(`   Enqueued: ${enriched}`);
	console.log(`   Failed: ${failed}`);

	await db.disconnect();
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});

