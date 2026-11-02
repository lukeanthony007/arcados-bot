#!/usr/bin/env tsx
/**
 * Manual Guild Summary Enrichment Script
 *
 * Usage:
 *   npx tsx enrich-guild-manual.ts           # Enrich guild summary
 *   npx tsx enrich-guild-manual.ts --full   # Full enrichment (regenerate from scratch)
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { EnrichmentPipelineOrchestrator } from "../EnrichmentPipelineOrchestrator";
import { EnrichmentQueue, EnrichmentLayer } from "../EnrichmentQueue";
import { config } from "../../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
	const args = process.argv.slice(2);
	const fullEnrichment = args.includes("--full");

	console.log("🤖 Manual Guild Summary Enrichment");
	console.log("=".repeat(80));
	if (fullEnrichment) {
		console.log("Mode: FULL (regenerate from scratch)");
	} else {
		console.log("Mode: INCREMENTAL (update based on recent activity)");
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

	// Enqueue guild
	const queue = EnrichmentQueue.getInstance();
	queue.enqueue({
		layer: EnrichmentLayer.SERVER,
		entityId: guildId,
		guildId,
		priority: 3,
	});

	// Process queue
	console.log(`\n🔄 Processing enrichment queue...\n`);
	await orchestrator.processPendingEnrichments(1);

	console.log(`\n🔹 Enrichment complete!`);

	await db.disconnect();
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});

