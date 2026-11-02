#!/usr/bin/env bun
/**
 * Generate Summaries Script
 *
 * Generates LLM summaries for all conversations in the past 24 hours
 * that don't have summaries yet.
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { EnhancementOrchestrator } from "../EnhancementOrchestrator";
import { config } from "../../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
  console.log("🤖 Generating Summaries for Conversations");
  console.log("=".repeat(80));

  const args = process.argv.slice(2);
  const hoursBack = args[0] ? Number.parseInt(args[0], 10) : 24;
  const dryRun = args.includes("--dry-run");
  const regenerate = args.includes("--regenerate") || args.includes("-r");

  console.log(`Time window: Past ${hoursBack} hours`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will generate summaries)"}`);
  if (regenerate) {
    console.log(`Regenerate: YES (will regenerate all summaries, even existing ones)`);
  }
  console.log("=".repeat(80));

  const connected = await db.connect();
  if (!connected) {
    console.error("❌ Failed to connect to database");
    console.error("💡 Make sure POSTGRES_URL is set in your .env file");
    process.exit(1);
  }

  const guildId = config.guildId;
  if (!guildId) {
    console.error("❌ No guild ID configured");
    console.error("💡 Set GUILD_ID in your .env file");
    await db.disconnect();
    process.exit(1);
  }

  // Initialize enhancement orchestrator
  const orchestrator = new EnhancementOrchestrator(db, {
    lookbackHours: hoursBack,
    enableSummaries: true,
    enableOrphans: false,
    enableSplitting: false,
    dryRun: dryRun,
    regenerateSummaries: regenerate,
    batchSize: 10,
    sleepBetweenBatches: 4000, // 4 seconds between batches (15 RPM for Gemini)
  });

  try {
    console.log("\n🚀 Starting summary generation...\n");
    const stats = await orchestrator.enhance(guildId);

    console.log("\n" + "=".repeat(80));
    console.log("🔹 Summary generation complete!");
    console.log("=".repeat(80));
    console.log(`   Summaries Generated: ${stats.summariesGenerated}`);
    console.log(`   Segments Processed: ${stats.segmentsProcessed}`);
    console.log(`   API Calls Made: ${stats.apiCallsMade}`);
    console.log(`   Errors: ${stats.errors}`);
    if (stats.endTime) {
      const duration = (stats.endTime.getTime() - stats.startTime.getTime()) / 1000;
      console.log(`   Duration: ${duration.toFixed(1)}s`);
    }
  } catch (error) {
    console.error("\n❌ Summary generation failed:", error);
    process.exit(1);
  } finally {
    await db.disconnect();
    console.log("\n🔹 Disconnected from PostgreSQL");
  }
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});

