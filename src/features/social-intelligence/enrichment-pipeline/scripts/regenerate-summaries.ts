#!/usr/bin/env bun
/**
 * Regenerate Summaries Script
 *
 * Regenerates AI summaries for all conversations using the improved prompt
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { EnhancementOrchestrator } from "../EnhancementOrchestrator";
import { config } from "../../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
  console.log("🔄 Regenerating conversation summaries with improved prompt\n");

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

  // Create orchestrator with regenerate flag
  const orchestrator = new EnhancementOrchestrator(db, {
    lookbackHours: 24,
    batchSize: 5, // Smaller batches to avoid rate limits
    sleepBetweenBatches: 5000, // 5 seconds between batches
    enableSummaries: true,
    enableOrphans: false,
    enableSplitting: false,
    regenerateSummaries: true, // Force regenerate all summaries
  });

  // Run enhancement
  const stats = await orchestrator.enhance(guildId);

  console.log("\n🔹 Summary regeneration complete!");
  console.log(`   Generated: ${stats.summariesGenerated}`);
  console.log(`   Errors: ${stats.errors}`);

  await db.disconnect();
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
