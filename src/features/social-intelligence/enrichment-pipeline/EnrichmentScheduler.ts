/**
 * EnrichmentScheduler
 *
 * Every 5 minutes: sweep each guild for stale dossiers (members, pairs, server), then drain
 * a small batch of the in-memory enrichment queue. Work is bounded by EnrichmentRateLimiter
 * ($1/day, $40/month), not by the schedule, so draining often in small batches is cost-safe.
 * The queue is process-local; conversation jobs lost on restart are repopulated by
 * ReconciliationSync, dossier jobs by the next sweep.
 */

import cron, { type ScheduledTask } from "node-cron";
import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { EnrichmentPipelineOrchestrator } from "./EnrichmentPipelineOrchestrator";

/** Jobs processed per tick */
const BATCH_SIZE = 5;

export class EnrichmentScheduler {
	private static instance: EnrichmentScheduler;
	private readonly orchestrator = EnrichmentPipelineOrchestrator.getInstance();
	private task: ScheduledTask | null = null;

	private constructor() {}

	public static getInstance(): EnrichmentScheduler {
		EnrichmentScheduler.instance ??= new EnrichmentScheduler();
		return EnrichmentScheduler.instance;
	}

	public start(db: PostgreSQLManager): void {
		if (this.task) return;
		this.task = cron.schedule("*/5 * * * *", async () => {
			try {
				const guilds = await db.query("SELECT id FROM guilds");
				for (const guild of (guilds.data ?? []) as Array<{ id: string }>) {
					await this.orchestrator.enqueueStaleDossiers(guild.id);
				}
				await this.orchestrator.processPendingEnrichments(BATCH_SIZE);
			} catch (error) {
				console.error("❌ Error in scheduled enrichment drain:", error);
			}
		});
	}

	public stop(): void {
		this.task?.stop();
		this.task = null;
		console.log("⏸️  Enrichment scheduler stopped");
	}
}
