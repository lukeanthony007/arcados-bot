/**
 * EnrichmentQueue
 *
 * Simple in-memory queue for managing enrichment jobs across all 4 layers.
 * Prioritizes jobs by layer (conversations first, then users, then relationships, then server).
 *
 * No Redis required - designed for single-process operation.
 */

export enum EnrichmentLayer {
	CONVERSATION = 1,
	USER = 2,
	RELATIONSHIP = 3,
	SERVER = 4,
}

export interface EnrichmentJob {
	id: string;
	layer: EnrichmentLayer;
	entityId: string; // conversation_id, user_id, or "user_a:user_b" for relationships
	guildId: string;
	priority: number; // Higher = more urgent
	enqueuedAt: Date;
	attempts: number;
	lastError?: string;
	estimatedCost?: number;
}

export class EnrichmentQueue {
	private static instance: EnrichmentQueue;

	private queues: Map<EnrichmentLayer, EnrichmentJob[]>;
	private processing: Set<string>; // Job IDs currently being processed
	private failed: Map<string, EnrichmentJob>; // Failed jobs for retry

	private readonly MAX_ATTEMPTS = 3;

	private constructor() {
		this.queues = new Map([
			[EnrichmentLayer.CONVERSATION, []],
			[EnrichmentLayer.USER, []],
			[EnrichmentLayer.RELATIONSHIP, []],
			[EnrichmentLayer.SERVER, []],
		]);
		this.processing = new Set();
		this.failed = new Map();
	}

	public static getInstance(): EnrichmentQueue {
		if (!EnrichmentQueue.instance) {
			EnrichmentQueue.instance = new EnrichmentQueue();
		}
		return EnrichmentQueue.instance;
	}

	/**
	 * Enqueue a new enrichment job
	 */
	public enqueue(job: Omit<EnrichmentJob, "id" | "enqueuedAt" | "attempts">) {
		const jobId = this.generateJobId(job.layer, job.entityId, job.guildId);

		// Skip if already enqueued or processing
		if (this.isEnqueued(jobId) || this.processing.has(jobId)) {
			return;
		}

		const fullJob: EnrichmentJob = {
			...job,
			id: jobId,
			enqueuedAt: new Date(),
			attempts: 0,
		};

		const queue = this.queues.get(job.layer);
		if (!queue) {
			console.error(
				`❌ Invalid enrichment layer: ${job.layer}`,
			);
			return;
		}

		queue.push(fullJob);

		// Sort by priority (higher first), then by enqueue time (older first)
		queue.sort((a, b) => {
			if (a.priority !== b.priority) {
				return b.priority - a.priority;
			}
			return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
		});

		console.log(
			`📥 Enqueued ${this.layerName(job.layer)} enrichment: ${job.entityId}`,
		);
	}

	/**
	 * Dequeue next job from specified layer
	 */
	public dequeue(layer: EnrichmentLayer): EnrichmentJob | null {
		const queue = this.queues.get(layer);
		if (!queue || queue.length === 0) {
			return null;
		}

		const job = queue.shift()!;
		this.processing.add(job.id);

		console.log(
			`📤 Dequeued ${this.layerName(layer)} enrichment: ${job.entityId} (attempt ${job.attempts + 1})`,
		);

		return job;
	}

	/**
	 * Dequeue jobs from all layers in priority order
	 */
	public dequeueBatch(maxCount: number): EnrichmentJob[] {
		const jobs: EnrichmentJob[] = [];

		// Process layers in order: conversation -> user -> relationship -> server
		for (const layer of [
			EnrichmentLayer.CONVERSATION,
			EnrichmentLayer.USER,
			EnrichmentLayer.RELATIONSHIP,
			EnrichmentLayer.SERVER,
		]) {
			while (jobs.length < maxCount) {
				const job = this.dequeue(layer);
				if (!job) break;
				jobs.push(job);
			}
			if (jobs.length >= maxCount) break;
		}

		return jobs;
	}

	/**
	 * Return a dequeued-but-unprocessed job to its queue untouched (no attempt consumed)
	 */
	public requeue(job: EnrichmentJob) {
		this.processing.delete(job.id);
		this.queues.get(job.layer)?.unshift(job);
	}

	/**
	 * Mark job as completed
	 */
	public complete(jobId: string) {
		this.processing.delete(jobId);
		this.failed.delete(jobId); // Clear from failed if it was retried
		console.log(`🔹 Completed enrichment job: ${jobId}`);
	}

	/**
	 * Mark job as failed and potentially re-enqueue
	 */
	public fail(jobId: string, error: string) {
		this.processing.delete(jobId);

		// Find the original job in failed map or reconstruct from jobId
		const failedJob = this.failed.get(jobId);
		if (failedJob) {
			failedJob.attempts++;
			failedJob.lastError = error;

			if (failedJob.attempts < this.MAX_ATTEMPTS) {
				// Re-enqueue with lower priority
				this.enqueue({
					...failedJob,
					priority: Math.max(1, failedJob.priority - 1),
				});
				console.warn(
					`⚠️  Failed enrichment job ${jobId}, re-enqueueing (attempt ${failedJob.attempts}/${this.MAX_ATTEMPTS})`,
				);
			} else {
				console.error(
					`❌ Enrichment job ${jobId} failed ${this.MAX_ATTEMPTS} times, giving up: ${error}`,
				);
				// Keep in failed map for inspection
			}
		} else {
			// First failure, add to failed map
			const [layer, entityId, guildId] = this.parseJobId(jobId);
			if (layer !== null) {
				const job: EnrichmentJob = {
					id: jobId,
					layer,
					entityId,
					guildId,
					priority: 5, // Default priority
					enqueuedAt: new Date(),
					attempts: 1,
					lastError: error,
				};
				this.failed.set(jobId, job);

				// Re-enqueue
				this.enqueue({
					layer,
					entityId,
					guildId,
					priority: 4, // Lower priority for retries
				});
			}
		}
	}

	/**
	 * Get queue depths for all layers
	 */
	public getQueueDepths(): Record<string, number> {
		return {
			conversation: this.queues.get(EnrichmentLayer.CONVERSATION)?.length || 0,
			user: this.queues.get(EnrichmentLayer.USER)?.length || 0,
			relationship: this.queues.get(EnrichmentLayer.RELATIONSHIP)?.length || 0,
			server: this.queues.get(EnrichmentLayer.SERVER)?.length || 0,
			processing: this.processing.size,
			failed: this.failed.size,
		};
	}

	/**
	 * Get total pending jobs
	 */
	public getTotalPending(): number {
		let total = 0;
		for (const queue of this.queues.values()) {
			total += queue.length;
		}
		return total;
	}

	/**
	 * Check if job is already enqueued
	 */
	private isEnqueued(jobId: string): boolean {
		for (const queue of this.queues.values()) {
			if (queue.some((job) => job.id === jobId)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Generate unique job ID
	 */
	private generateJobId(
		layer: EnrichmentLayer,
		entityId: string,
		guildId: string,
	): string {
		return `${layer}:${entityId}:${guildId}`;
	}

	/**
	 * Parse job ID back to components
	 */
	private parseJobId(
		jobId: string,
	): [EnrichmentLayer | null, string, string] {
		const parts = jobId.split(":");
		if (parts.length < 3) {
			return [null, "", ""];
		}
		const layer = Number.parseInt(parts[0] ?? "", 10);
		const guildId = parts[parts.length - 1];
		if (Number.isNaN(layer) || guildId === undefined) {
			return [null, "", ""];
		}
		const entityId = parts.slice(1, -1).join(":");
		return [layer as EnrichmentLayer, entityId, guildId];
	}

	/**
	 * Get human-readable layer name
	 */
	private layerName(layer: EnrichmentLayer): string {
		switch (layer) {
			case EnrichmentLayer.CONVERSATION:
				return "conversation";
			case EnrichmentLayer.USER:
				return "user";
			case EnrichmentLayer.RELATIONSHIP:
				return "relationship";
			case EnrichmentLayer.SERVER:
				return "server";
			default:
				return "unknown";
		}
	}

	/**
	 * Clear all queues (for testing)
	 */
	public clearAll() {
		for (const queue of this.queues.values()) {
			queue.length = 0;
		}
		this.processing.clear();
		this.failed.clear();
		console.log("🗑️  All enrichment queues cleared");
	}

	/**
	 * Get failed jobs for inspection
	 */
	public getFailedJobs(): EnrichmentJob[] {
		return Array.from(this.failed.values());
	}

	/**
	 * Retry all failed jobs
	 */
	public retryFailed() {
		const failedJobs = Array.from(this.failed.values());
		this.failed.clear();

		for (const job of failedJobs) {
			this.enqueue({
				layer: job.layer,
				entityId: job.entityId,
				guildId: job.guildId,
				priority: 3, // Medium priority for retries
			});
		}

		console.log(`🔄 Retrying ${failedJobs.length} failed enrichment jobs`);
	}
}
