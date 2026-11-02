#!/usr/bin/env tsx
/**
 * Manual User Profile Enrichment Script
 *
 * Usage:
 *   npx tsx enrich-users-manual.ts 24        # Enrich users with conversations from last 24 hours
 *   npx tsx enrich-users-manual.ts 168       # Enrich users with conversations from last 7 days
 *   npx tsx enrich-users-manual.ts --stale   # Enrich stale user profiles
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { AIFactory } from "../../../../ai/core/AIFactory";
import { EnrichmentPipelineOrchestrator } from "../EnrichmentPipelineOrchestrator";
import { EnrichmentQueue, EnrichmentLayer } from "../EnrichmentQueue";
import { config } from "../../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
	const args = process.argv.slice(2);
	const staleOnly = args.includes("--stale");
	const hoursBack = args[0] && !staleOnly ? parseInt(args[0], 10) : 24;

	console.log("🤖 Manual User Profile Enrichment");
	console.log("=".repeat(80));
	if (staleOnly) {
		console.log("Mode: STALE (users with 5+ new conversations since last enrichment)");
	} else if (hoursBack) {
		console.log(`Time window: Users with conversations from past ${hoursBack} hours`);
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

	// Initialize AI engine
	const { engine } = await AIFactory.create();

	// Initialize orchestrator
	const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
	await orchestrator.initialize(db, engine);

	// Query users to enrich
	let query: string;
	let params: any[];

	// Start from members so users without a profile row yet are included; bots never are
	if (staleOnly) {
		query = `
			SELECT m.user_id
			FROM members m
			LEFT JOIN user_profiles up ON up.guild_id = m.guild_id AND up.user_id = m.user_id
			WHERE m.guild_id = $1 AND m.bot = false
			AND (
				SELECT COUNT(DISTINCT cs.id)
				FROM conversation_segments cs
				WHERE cs.guild_id = $1
				AND m.user_id = ANY(cs.participants)
				AND cs.status = 'finalized'
				AND cs.ai_processing_status = 'completed'
			) - COALESCE(up.last_enriched_conversation_count, 0) >= 5
		`;
		params = [guildId];
	} else {
		const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
		query = `
			SELECT DISTINCT m.user_id
			FROM members m
			INNER JOIN conversation_segments cs ON (
				cs.guild_id = $1
				AND m.user_id = ANY(cs.participants)
				AND cs.status = 'finalized'
				AND cs.start_time >= $2
			)
			WHERE m.guild_id = $1 AND m.bot = false
		`;
		params = [guildId, since];
	}

	const result = await db.query(query, params);

	if (!result.success || !result.data || result.data.length === 0) {
		console.log("ℹ️  No users found to enrich");
		await db.disconnect();
		return;
	}

	const userIds = result.data.map((row: any) => row.user_id);
	console.log(`\n📋 Found ${userIds.length} users to enrich\n`);

	// Enqueue users
	const queue = EnrichmentQueue.getInstance();
	for (const userId of userIds) {
		queue.enqueue({
			layer: EnrichmentLayer.USER,
			entityId: userId,
			guildId,
			priority: 6,
		});
	}

	// Process queue
	console.log(`🔄 Processing enrichment queue...\n`);
	await orchestrator.processPendingEnrichments(userIds.length);

	console.log(`\n🔹 Enrichment complete!`);
	console.log(`   Users processed: ${userIds.length}`);

	await db.disconnect();
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});

