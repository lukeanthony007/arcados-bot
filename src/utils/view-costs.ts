#!/usr/bin/env bun
/**
 * View API Cost Breakdown (Simplified)
 * 
 * Usage:
 *   bun view-costs [provider]
 * 
 * Examples:
 *   bun view-costs              # Show summary
 *   bun view-costs grok         # Show grok costs
 *   bun view-costs all          # Show all providers
 */

import * as fs from "fs/promises";
import * as path from "path";
import { APICostTracker } from "./APICostTracker";
import { getCostTrackingConfig } from "./APICostConfig";

const provider = process.argv[2] || "summary";

async function main() {
  // Flush any pending data first
  const tracker = APICostTracker.getInstance();
  await tracker.writeStats();

  const config = getCostTrackingConfig();
  const baseDir = config.baseDirectory;

  if (provider === "summary" || provider === "all") {
    // Show overall summary
    const summaryPath = path.join(baseDir, "summary.json");
    try {
      const data = await fs.readFile(summaryPath, "utf-8");
      const summary = JSON.parse(data);
      
      console.log("\n📊 API Cost Summary\n");
      console.log(JSON.stringify(summary, null, 2));
    } catch (error) {
      console.log("No summary data available yet.");
    }

    if (provider === "all") {
      // Show all providers
      const providers = ["grok", "gemini", "openai", "ollama", "cartesia", "google-tts", "cursor"];
      for (const prov of providers) {
        await showProvider(prov, baseDir);
      }
    }
  } else {
    // Show specific provider
    await showProvider(provider, baseDir);
  }
}

async function showProvider(providerName: string, baseDir: string) {
  const filepath = path.join(baseDir, `${providerName}.json`);
  
  try {
    const data = await fs.readFile(filepath, "utf-8");
    const stats = JSON.parse(data);
    
    console.log(`\n📊 ${providerName.toUpperCase()} Costs\n`);
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    console.log(`\n${providerName}: No data available yet.`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
