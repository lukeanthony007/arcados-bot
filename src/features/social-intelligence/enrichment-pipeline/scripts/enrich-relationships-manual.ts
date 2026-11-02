#!/usr/bin/env tsx
/**
 * Manual Relationship Enrichment Script
 *
 * Usage:
 *   npx tsx enrich-relationships-manual.ts 24        # Enrich relationships from last 24 hours
 *   npx tsx enrich-relationships-manual.ts --significant  # Enrich significant relationships (100+ interactions)
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { AIFactory } from "../../../../ai/core/AIFactory";
import { EnrichmentPipelineOrchestrator } from "../EnrichmentPipelineOrchestrator";
import { EnrichmentQueue, EnrichmentLayer } from "../EnrichmentQueue";
import { config } from "../../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
	const args = process.argv.slice(2);
	const significantOnly = args.includes("--significant");
	const hoursBack = args[0] && !significantOnly ? parseInt(args[0], 10) : 24;

	console.log("🤖 Manual Relationship Enrichment");
	console.log("=".repeat(80));
	if (significantOnly) {
		console.log("Mode: SIGNIFICANT (relationships with 100+ interactions)");
	} else if (hoursBack) {
		console.log(`Time window: Relationships with shared conversations from past ${hoursBack} hours`);
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

	// Query relationships to enrich
	let query: string;
	let params: any[];

	if (significantOnly) {
		query = `
			SELECT
				LEAST(user_a, user_b) as user_a,
				GREATEST(user_a, user_b) as user_b
			FROM relationship_edges
			WHERE guild_id = $1
			GROUP BY LEAST(user_a, user_b), GREATEST(user_a, user_b)
			HAVING SUM(total) >= 100
			ORDER BY SUM(total) DESC
		`;
		params = [guildId];
	} else {
		const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
		query = `
			SELECT DISTINCT
				LEAST(re.user_a, re.user_b) as user_a,
				GREATEST(re.user_a, re.user_b) as user_b
			FROM relationship_edges re
			INNER JOIN conversation_segments cs ON (
				cs.guild_id = $1
				AND re.user_a = ANY(cs.participants)
				AND re.user_b = ANY(cs.participants)
				AND cs.status = 'finalized'
				AND cs.start_time >= $2
			)
			WHERE re.guild_id = $1
		`;
		params = [guildId, since];
	}

	const result = await db.query(query, params);

	if (!result.success || !result.data || result.data.length === 0) {
		console.log("ℹ️  No relationships found to enrich");
		await db.disconnect();
		return;
	}

	const relationships = result.data;
	console.log(`\n📋 Found ${relationships.length} relationships to enrich\n`);

	// Enqueue relationships
	const queue = EnrichmentQueue.getInstance();
	for (const rel of relationships) {
		const entityId = `${rel.user_a}:${rel.user_b}`;
		queue.enqueue({
			layer: EnrichmentLayer.RELATIONSHIP,
			entityId,
			guildId,
			priority: 5,
		});
	}

	// Process queue
	console.log(`🔄 Processing enrichment queue...\n`);
	await orchestrator.processPendingEnrichments(relationships.length);

	console.log(`\n🔹 Enrichment complete!`);
	console.log(`   Relationships processed: ${relationships.length}`);

	await db.disconnect();
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});

