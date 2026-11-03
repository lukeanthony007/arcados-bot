/**
 * EnrichmentPipelineOrchestrator
 *
 * Runs the model-written parts of social intelligence through one budgeted queue:
 *
 *   conversation  summary + topic label for a finalized conversation (enqueued by the detector)
 *   member        dossier for a member whose activity made the old one stale
 *   pair          dossier for a close pair with new shared conversations
 *   server        dossier for the guild when enough new conversations exist
 *
 * Dossier jobs are found by `enqueueStaleDossiers`, a staleness sweep the scheduler runs
 * before each drain; nothing cascades. Facts (closeness, member facts) are computed on
 * demand and never queued.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import {
	findStaleMembers,
	writeMemberDossier,
} from "../understanding/memberDossier";
import { findStalePairs, writePairDossier } from "../understanding/pairDossier";
import {
	isServerDossierStale,
	writeServerDossier,
} from "../understanding/serverDossier";
import {
	type EnrichmentJob,
	EnrichmentLayer,
	EnrichmentQueue,
} from "./EnrichmentQueue";
import { EnrichmentRateLimiter } from "./EnrichmentRateLimiter";
import { ConversationEnrichmentPipeline } from "./layers/ConversationEnrichmentPipeline";

/** How many stale entities one sweep may enqueue per kind */
const SWEEP_LIMITS = { member: 10, pair: 10 } as const;

export class EnrichmentPipelineOrchestrator {
	private static instance: EnrichmentPipelineOrchestrator;

	private readonly queue = EnrichmentQueue.getInstance();
	private readonly rateLimiter = EnrichmentRateLimiter.getInstance();
	private db: PostgreSQLManager | null = null;
	private conversationPipeline: ConversationEnrichmentPipeline | null = null;
	private isProcessing = false;

	private constructor() {}

	public static getInstance(): EnrichmentPipelineOrchestrator {
		EnrichmentPipelineOrchestrator.instance ??=
			new EnrichmentPipelineOrchestrator();
		return EnrichmentPipelineOrchestrator.instance;
	}

	public initialize(db: PostgreSQLManager): void {
		this.db = db;
		this.conversationPipeline = new ConversationEnrichmentPipeline(db);
		console.log("🔹 Enrichment Pipeline Orchestrator initialized");
	}

	/** The queue, for reconciliation and scripts */
	public getQueue(): EnrichmentQueue {
		return this.queue;
	}

	/** Enqueue a finalized conversation for summarization (called by ConversationDetector) */
	public enqueueConversation(
		conversationId: string,
		guildId: string,
		significance: "high" | "medium" | "low" = "medium",
	): void {
		const priority =
			significance === "high" ? 10 : significance === "medium" ? 5 : 2;
		this.queue.enqueue({
			layer: EnrichmentLayer.CONVERSATION,
			entityId: conversationId,
			guildId,
			priority,
			estimatedCost:
				this.rateLimiter.estimateConversationCost(10).estimatedCost,
		});
	}

	/** Conversations worth a summary: 3+ people or 10+ messages */
	public isConversationSignificant(
		participantCount: number,
		messageCount: number,
	): boolean {
		return participantCount >= 3 || messageCount >= 10;
	}

	/**
	 * Find members, pairs and the server whose dossiers are stale and enqueue them.
	 * Idempotent: the queue dedupes by entity.
	 */
	public async enqueueStaleDossiers(guildId: string): Promise<void> {
		if (!this.db) return;
		const [members, pairs, serverStale] = await Promise.all([
			findStaleMembers(this.db, guildId, SWEEP_LIMITS.member),
			findStalePairs(this.db, guildId, SWEEP_LIMITS.pair),
			isServerDossierStale(this.db, guildId),
		]);
		for (const userId of members) {
			this.queue.enqueue({
				layer: EnrichmentLayer.MEMBER,
				entityId: userId,
				guildId,
				priority: 6,
				estimatedCost:
					this.rateLimiter.estimateDossierCost("member").estimatedCost,
			});
		}
		for (const [a, b] of pairs) {
			this.queue.enqueue({
				layer: EnrichmentLayer.PAIR,
				entityId: `${a}:${b}`,
				guildId,
				priority: 4,
				estimatedCost:
					this.rateLimiter.estimateDossierCost("pair").estimatedCost,
			});
		}
		if (serverStale) {
			this.queue.enqueue({
				layer: EnrichmentLayer.SERVER,
				entityId: guildId,
				guildId,
				priority: 3,
				estimatedCost:
					this.rateLimiter.estimateDossierCost("server").estimatedCost,
			});
		}
		if (members.length || pairs.length || serverStale) {
			console.log(
				`🔔 Stale dossiers queued: ${members.length} members, ${pairs.length} pairs${serverStale ? ", server" : ""}`,
			);
		}
	}

	/** Drain up to `maxBatch` jobs in priority order within the budget (called by the scheduler) */
	public async processPendingEnrichments(maxBatch = 10): Promise<void> {
		if (this.queue.getTotalPending() === 0 || this.isProcessing) return;
		this.isProcessing = true;

		try {
			console.log(
				`\n🔄 Processing enrichment queue: ${JSON.stringify(this.queue.getQueueDepths())}\n`,
			);
			const budget = this.rateLimiter.getRemainingBudget();
			if (budget.daily <= 0) {
				console.warn("⚠️  Daily budget exhausted, skipping enrichment");
				return;
			}
			console.log(
				`💰 Budget remaining: $${budget.daily.toFixed(4)} daily, $${budget.monthly.toFixed(2)} monthly`,
			);

			const jobs = this.queue.dequeueBatch(maxBatch);
			for (const [index, job] of jobs.entries()) {
				const estimated = job.estimatedCost || 0.01;
				const canAfford = await this.rateLimiter.canAffordEnrichment(estimated);
				if (!canAfford.canAfford) {
					console.warn(`⚠️  Stopping enrichment: ${canAfford.reason}`);
					// Not a job failure: return every unprocessed job to the queue untouched
					for (const unprocessed of jobs.slice(index)) {
						this.queue.requeue(unprocessed);
					}
					break;
				}
				try {
					const charged = await this.processJob(job);
					if (charged)
						await this.rateLimiter.trackCost(
							estimated,
							EnrichmentLayer[job.layer],
						);
					this.queue.complete(job.id);
				} catch (error) {
					console.error(`❌ Error processing enrichment job ${job.id}:`, error);
					this.queue.fail(
						job.id,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
			console.log("\n🔹 Enrichment batch processing complete\n");
		} finally {
			this.isProcessing = false;
		}
	}

	/**
	 * Run one job. Throws on failure so the queue retries it. Returns whether a model call
	 * was made (skips are free).
	 */
	private async processJob(job: EnrichmentJob): Promise<boolean> {
		if (!this.db || !this.conversationPipeline)
			throw new Error("Orchestrator not initialized");

		switch (job.layer) {
			case EnrichmentLayer.CONVERSATION: {
				const result = await this.conversationPipeline.enrichConversation(
					job.entityId,
					job.guildId,
				);
				if (result.success) return true;
				if (result.skipped) {
					console.log(
						`   ℹ️  Conversation ${job.entityId} skipped: ${result.error}`,
					);
					return false;
				}
				throw new Error(
					`Conversation enrichment failed for ${job.entityId}: ${result.error}`,
				);
			}
			case EnrichmentLayer.MEMBER: {
				const written = await writeMemberDossier(
					this.db,
					job.guildId,
					job.entityId,
				);
				if (written)
					console.log(`   📝 Member dossier written: ${written.facts.name}`);
				return written !== null;
			}
			case EnrichmentLayer.PAIR: {
				const [a, b] = job.entityId.split(":");
				if (!a || !b)
					throw new Error(`Invalid pair job entity: ${job.entityId}`);
				const written = await writePairDossier(this.db, job.guildId, a, b);
				if (written) console.log(`   📝 Pair dossier written: ${job.entityId}`);
				return written !== null;
			}
			case EnrichmentLayer.SERVER: {
				const written = await writeServerDossier(this.db, job.guildId);
				if (written) console.log("   📝 Server dossier written");
				return written !== null;
			}
			default:
				throw new Error(`Unknown enrichment layer ${job.layer}`);
		}
	}

	public getStatus() {
		return {
			queue: this.queue.getQueueDepths(),
			budget: this.rateLimiter.getRemainingBudget(),
			stats: this.rateLimiter.getStats(),
		};
	}

	public getFailedJobs() {
		return this.queue.getFailedJobs();
	}

	public retryFailed(): void {
		this.queue.retryFailed();
	}
}
