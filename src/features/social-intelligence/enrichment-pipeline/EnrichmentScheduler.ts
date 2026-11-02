/**
 * EnrichmentScheduler
 *
 * Drains the in-memory enrichment queue on a short interval using node-cron.
 *
 * The queue is process-local and is lost on restart, so jobs must not sit in it for
 * hours waiting for a once-a-day tick (the previous 02:00 / Monday 03:00 / 1st-of-month
 * schedule only enriched what happened to survive in memory until then). Work is bounded
 * by EnrichmentRateLimiter ($1/day, $40/month), not by the schedule, so draining
 * frequently in small batches is cost-safe. ReconciliationSync repopulates the queue
 * from the database (pending conversations, unenriched users/relationships/guild).
 */

import cron, { type ScheduledTask } from "node-cron";
import { EnrichmentPipelineOrchestrator } from "./EnrichmentPipelineOrchestrator";

/** Jobs processed per tick */
const BATCH_SIZE = 5;

export class EnrichmentScheduler {
	private static instance: EnrichmentScheduler;
	private orchestrator: EnrichmentPipelineOrchestrator;
	private jobs: ScheduledTask[] = [];

	private constructor() {
		this.orchestrator = EnrichmentPipelineOrchestrator.getInstance();
	}

	public static getInstance(): EnrichmentScheduler {
		if (!EnrichmentScheduler.instance) {
			EnrichmentScheduler.instance = new EnrichmentScheduler();
		}
		return EnrichmentScheduler.instance;
	}

	/**
	 * Start the enrichment scheduler
	 */
	public async start() {
		if (this.jobs.length > 0) return;

		// Every 5 minutes: drain a small batch of queued enrichments
		this.jobs.push(
			cron.schedule("*/5 * * * *", async () => {
				try {
					await this.orchestrator.processPendingEnrichments(BATCH_SIZE);
				} catch (error) {
					console.error("❌ Error in scheduled enrichment drain:", error);
				}
			}),
		);
	}

	/**
	 * Stop the enrichment scheduler
	 */
	public stop() {
		for (const job of this.jobs) {
			job.stop();
		}
		this.jobs = [];
		console.log("⏸️  Enrichment scheduler stopped");
	}
}
