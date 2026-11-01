/**
 * EnrichmentPipelineOrchestrator
 *
 * Master coordinator for the 4-layer autonomous enrichment pipeline.
 *
 * Architecture:
 * Layer 1: Conversation Enrichment (conversations → summaries, embeddings)
 * Layer 2: User Profile Enrichment (new conversations → user profile updates)
 * Layer 3: Relationship Enrichment (user profile changes → relationship updates)
 * Layer 4: Server Summary Enrichment (relationship changes → guild summary)
 *
 * Context-driven approach: Only enrich when new underlying context exists.
 */

import { EnrichmentQueue, EnrichmentLayer } from "./EnrichmentQueue";
import { EnrichmentRateLimiter } from "./EnrichmentRateLimiter";
import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";

export class EnrichmentPipelineOrchestrator {
	private static instance: EnrichmentPipelineOrchestrator;

	private queue: EnrichmentQueue;
	private rateLimiter: EnrichmentRateLimiter;
	private postgresManager: PostgreSQLManager | null = null;

	// Pipeline references (will be set after pipelines are created)
	private conversationPipeline: any = null;
	private userPipeline: any = null;
	private relationshipPipeline: any = null;
	private serverPipeline: any = null;

	private constructor() {
		this.queue = EnrichmentQueue.getInstance();
		this.rateLimiter = EnrichmentRateLimiter.getInstance();
	}

	public static getInstance(): EnrichmentPipelineOrchestrator {
		if (!EnrichmentPipelineOrchestrator.instance) {
			EnrichmentPipelineOrchestrator.instance =
				new EnrichmentPipelineOrchestrator();
		}
		return EnrichmentPipelineOrchestrator.instance;
	}

	/**
	 * Initialize with PostgreSQL manager and AI engine
	 */
	public async initialize(postgresManager: PostgreSQLManager, aiEngine?: any) {
		this.postgresManager = postgresManager;

		// Initialize pipelines if AI engine provided
		if (aiEngine) {
			const { ConversationEnrichmentPipeline } = await import(
				"./layers/ConversationEnrichmentPipeline"
			);
			const { UserProfileEnrichmentPipeline } = await import(
				"./layers/UserProfileEnrichmentPipeline"
			);
			const { RelationshipEnrichmentPipeline } = await import(
				"./layers/RelationshipEnrichmentPipeline"
			);
			const { ServerEnrichmentPipeline } = await import(
				"./layers/ServerEnrichmentPipeline"
			);

			this.conversationPipeline = new ConversationEnrichmentPipeline(
				postgresManager,
				aiEngine,
			);
			this.userPipeline = new UserProfileEnrichmentPipeline(
				postgresManager,
				aiEngine,
			);
			this.relationshipPipeline = new RelationshipEnrichmentPipeline(
				postgresManager,
				aiEngine,
			);
			this.serverPipeline = new ServerEnrichmentPipeline(
				postgresManager,
				aiEngine,
			);
		}

		console.log("🔹 Enrichment Pipeline Orchestrator initialized");
	}

	/**
	 * Set pipeline references (alternative to auto-initialization)
	 */
	public setPipelines(pipelines: {
		conversation?: any;
		user?: any;
		relationship?: any;
		server?: any;
	}) {
		if (pipelines.conversation) this.conversationPipeline = pipelines.conversation;
		if (pipelines.user) this.userPipeline = pipelines.user;
		if (pipelines.relationship) this.relationshipPipeline = pipelines.relationship;
		if (pipelines.server) this.serverPipeline = pipelines.server;
	}

	/**
	 * Get the enrichment queue (for direct access by healing/reconciliation systems)
	 */
	public getQueue(): EnrichmentQueue {
		return this.queue;
	}

	// ============================================================================
	// Layer 1: Conversation Enrichment Entry Points
	// ============================================================================

	/**
	 * Enqueue conversation for enrichment after finalization
	 * Called by ConversationDetector after a conversation is finalized
	 */
	public async enqueueConversation(
		conversationId: string,
		guildId: string,
		significance: "high" | "medium" | "low" = "medium",
	) {
		// Map significance to priority
		const priority = significance === "high" ? 10 : significance === "medium" ? 5 : 2;

		// Estimate cost
		const estimate = this.rateLimiter.estimateConversationCost(10); // Assume avg 10 messages

		this.queue.enqueue({
			layer: EnrichmentLayer.CONVERSATION,
			entityId: conversationId,
			guildId,
			priority,
			estimatedCost: estimate.estimatedCost,
		});
	}

	/**
	 * Check significance of conversation to determine if it should be enriched
	 */
	public async isConversationSignificant(
		participantCount: number,
		messageCount: number,
		keywords?: string[],
	): Promise<boolean> {
		// Significance criteria:
		// - 3+ participants OR
		// - 10+ messages OR
		// - Contains important keywords (from guild vocabulary)

		if (participantCount >= 3) return true;
		if (messageCount >= 10) return true;

		// TODO: Check keywords against guild vocabulary for important topics
		// if (keywords && keywords.some(k => this.isImportantKeyword(k))) return true;

		return false;
	}

	// ============================================================================
	// Layer 2: User Profile Enrichment Entry Points
	// ============================================================================

	/**
	 * Handle message burst (50th message threshold)
	 * Called by LiveEventSync when user hits 50-message mark
	 */
	public async handleMessageBurst(userId: string, guildId: string) {
		// Enqueue user for profile enrichment
		this.queue.enqueue({
			layer: EnrichmentLayer.USER,
			entityId: userId,
			guildId,
			priority: 7, // High priority for message bursts
		});

		console.log(
			`🔔 User ${userId} hit message threshold, queued for enrichment`,
		);
	}

	/**
	 * Handle new conversation participation
	 * Called after a conversation is enriched
	 */
	public async handleNewConversationParticipation(
		userId: string,
		guildId: string,
		conversationId: string,
	) {
		if (!this.postgresManager) return;

		// Check if user needs enrichment based on conversation count.
		// Starts from members so users without a profile row yet still qualify; bots never do.
		const result = await this.postgresManager.query(
			`
			SELECT
				COALESCE(p.last_enriched_conversation_count, 0) AS last_enriched_conversation_count,
				(
					SELECT COUNT(DISTINCT cs.id)
					FROM conversation_segments cs
					WHERE cs.guild_id = $1
					AND $2 = ANY(cs.participants)
					AND cs.status = 'finalized'
					AND cs.ai_processing_status = 'completed'
				) AS current_conversation_count
			FROM members m
			LEFT JOIN user_profiles p ON p.guild_id = m.guild_id AND p.user_id = m.user_id
			WHERE m.guild_id = $1 AND m.user_id = $2 AND m.bot = false
		`,
			[guildId, userId],
		);

		if (result.success && result.data && result.data.length > 0) {
			const lastCount = Number(result.data[0].last_enriched_conversation_count);
			const currentCount = Number(result.data[0].current_conversation_count);
			const newConversations = currentCount - lastCount;

			// Trigger if 5+ new conversations since last enrichment
			if (newConversations >= 5) {
				this.queue.enqueue({
					layer: EnrichmentLayer.USER,
					entityId: userId,
					guildId,
					priority: 6, // Medium-high priority
				});

				console.log(
					`🔔 User ${userId} has ${newConversations} new conversations, queued for enrichment`,
				);
			}
		}
	}

	// ============================================================================
	// Layer 3: Relationship Enrichment Entry Points
	// ============================================================================

	/**
	 * Handle user profile update
	 * Called after user profile is enriched
	 */
	public async handleUserProfileUpdate(
		userId: string,
		guildId: string,
		newProfileVersion: number,
	) {
		if (!this.postgresManager) return;

		// Find significant relationships (100+ interactions) where user is a participant
		const result = await this.postgresManager.query(
			`
			SELECT
				CASE
					WHEN user_a = $2 THEN user_b
					ELSE user_a
				END as other_user,
				total
			FROM relationship_edges
			WHERE guild_id = $1
			AND (user_a = $2 OR user_b = $2)
			AND total >= 100
			ORDER BY total DESC
			LIMIT 50
		`,
			[guildId, userId],
		);

		if (result.success && result.data) {
			for (const row of result.data) {
				const otherUser = row.other_user;

				// Normalize user pair (ensure user_a < user_b)
				const [userA, userB] =
					userId < otherUser ? [userId, otherUser] : [otherUser, userId];

				// Check if relationship profile needs update
				const needsUpdate = await this.checkRelationshipNeedsUpdate(
					guildId,
					userA,
					userB,
					newProfileVersion,
				);

				if (needsUpdate) {
					this.queue.enqueue({
						layer: EnrichmentLayer.RELATIONSHIP,
						entityId: `${userA}:${userB}`,
						guildId,
						priority: 5, // Medium priority
					});
				}
			}
		}
	}

	/**
	 * Check if relationship needs update based on user profile versions
	 */
	private async checkRelationshipNeedsUpdate(
		guildId: string,
		userA: string,
		userB: string,
		updatedUserVersion: number,
	): Promise<boolean> {
		if (!this.postgresManager) return false;

		const result = await this.postgresManager.query(
			`
			SELECT
				user_a_profile_version,
				user_b_profile_version,
				last_enriched_conversation_count,
				(
					SELECT COUNT(DISTINCT cs.id)
					FROM conversation_segments cs
					WHERE cs.guild_id = $1
					AND $2 = ANY(cs.participants)
					AND $3 = ANY(cs.participants)
					AND cs.status = 'finalized'
					AND cs.ai_processing_status = 'completed'
				) as current_shared_conversations
			FROM relationship_profiles
			WHERE guild_id = $1 AND user_a = $2 AND user_b = $3
		`,
			[guildId, userA, userB],
		);

		if (result.success && result.data && result.data.length > 0) {
			const row = result.data[0];

			// Check if profile versions differ AND there are 3+ new shared conversations
			const versionsDiffer =
				row.user_a_profile_version !== updatedUserVersion ||
				row.user_b_profile_version !== updatedUserVersion;
			const newSharedConversations =
				row.current_shared_conversations -
				(row.last_enriched_conversation_count || 0);

			return versionsDiffer && newSharedConversations >= 3;
		}

		// If no profile exists yet, create one if there are shared conversations
		return true;
	}

	// ============================================================================
	// Layer 4: Server Summary Enrichment Entry Points
	// ============================================================================

	/**
	 * Handle relationship update
	 * Called after relationship profile is enriched
	 */
	public async handleRelationshipUpdate(guildId: string) {
		if (!this.postgresManager) return;

		// Check if guild needs summary update based on relationship count
		const result = await this.postgresManager.query(
			`
			SELECT
				last_enriched_relationship_count,
				(
					SELECT COUNT(*)
					FROM relationship_profiles
					WHERE guild_id = $1
					AND last_enriched_at IS NOT NULL
				) as current_relationship_count
			FROM guild_metadata
			WHERE guild_id = $1
		`,
			[guildId],
		);

		if (result.success && result.data && result.data.length > 0) {
			const { last_enriched_relationship_count, current_relationship_count } =
				result.data[0];

			// Trigger if 10+ new relationship enrichments
			if (
				current_relationship_count - (last_enriched_relationship_count || 0) >= 10
			) {
				this.queue.enqueue({
					layer: EnrichmentLayer.SERVER,
					entityId: guildId,
					guildId,
					priority: 3, // Lower priority
				});

				console.log(
					`🔔 Guild ${guildId} has ${current_relationship_count - last_enriched_relationship_count} new relationship updates, queued for enrichment`,
				);
			}
		}
	}

	// ============================================================================
	// Batch Processing
	// ============================================================================

	/**
	 * Process pending enrichments (called by scheduler)
	 */
	public async processPendingEnrichments(maxBatch: number = 10) {
		// Get queue depths for logging
		const depths = this.queue.getQueueDepths();
		if (this.queue.getTotalPending() === 0) {
			return; // Nothing to process
		}

		console.log(`\n🔄 Processing enrichment queue: ${JSON.stringify(depths)}\n`);

		// Check remaining budget
		const budget = this.rateLimiter.getRemainingBudget();
		if (budget.daily <= 0) {
			console.warn("⚠️  Daily budget exhausted, skipping enrichment");
			return;
		}

		console.log(
			`💰 Budget remaining: $${budget.daily.toFixed(4)} daily, $${budget.monthly.toFixed(2)} monthly`,
		);

		// Dequeue batch of jobs in priority order
		const jobs = this.queue.dequeueBatch(maxBatch);

		for (const job of jobs) {
			try {
				// Check budget before each enrichment
				const canAfford = await this.rateLimiter.canAffordEnrichment(
					job.estimatedCost || 0.01,
				);

				if (!canAfford.canAfford) {
					console.warn(
						`⚠️  Stopping enrichment: ${canAfford.reason}`,
					);
					this.queue.fail(job.id, canAfford.reason || "Budget exceeded");
					break; // Stop processing batch
				}

				// Process job based on layer
				await this.processJob(job);

				this.queue.complete(job.id);
			} catch (error) {
				console.error(
					`❌ Error processing enrichment job ${job.id}:`,
					error,
				);
				this.queue.fail(
					job.id,
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		console.log("\n🔹 Enrichment batch processing complete\n");
	}

	/**
	 * Process individual enrichment job
	 */
	private async processJob(job: any) {
		switch (job.layer) {
			case EnrichmentLayer.CONVERSATION:
				if (this.conversationPipeline) {
					await this.conversationPipeline.enrichConversation(
						job.entityId,
						job.guildId,
					);
					// Trigger cascade: check participants for user enrichment
					await this.cascadeConversationEnrichment(job.entityId, job.guildId);
				}
				break;

			case EnrichmentLayer.USER:
				if (this.userPipeline) {
					const profileVersion = await this.userPipeline.enrichUser(
						job.entityId,
						job.guildId,
					);
					// Trigger cascade: update relationships
					if (profileVersion) {
						await this.handleUserProfileUpdate(
							job.entityId,
							job.guildId,
							profileVersion,
						);
					}
				}
				break;

			case EnrichmentLayer.RELATIONSHIP:
				if (this.relationshipPipeline) {
					const [userA, userB] = job.entityId.split(":");
					await this.relationshipPipeline.enrichRelationship(
						userA,
						userB,
						job.guildId,
					);
					// Trigger cascade: check if guild summary needs update
					await this.handleRelationshipUpdate(job.guildId);
				}
				break;

			case EnrichmentLayer.SERVER:
				if (this.serverPipeline) {
					await this.serverPipeline.enrichGuild(job.guildId);
				}
				break;
		}
	}

	/**
	 * Cascade conversation enrichment to participants
	 */
	private async cascadeConversationEnrichment(
		conversationId: string,
		guildId: string,
	) {
		if (!this.postgresManager) return;

		// Get conversation participants
		const result = await this.postgresManager.query(
			`
			SELECT participants
			FROM conversation_segments
			WHERE id = $1 AND guild_id = $2
		`,
			[conversationId, guildId],
		);

		if (result.success && result.data && result.data.length > 0) {
			const participants = result.data[0].participants;
			for (const userId of participants) {
				await this.handleNewConversationParticipation(
					userId,
					guildId,
					conversationId,
				);
			}
		}
	}

	// ============================================================================
	// Status & Metrics
	// ============================================================================

	/**
	 * Get enrichment status
	 */
	public getStatus() {
		return {
			queue: this.queue.getQueueDepths(),
			budget: this.rateLimiter.getRemainingBudget(),
			stats: this.rateLimiter.getStats(),
		};
	}

	/**
	 * Get failed jobs
	 */
	public getFailedJobs() {
		return this.queue.getFailedJobs();
	}

	/**
	 * Retry failed jobs
	 */
	public retryFailed() {
		this.queue.retryFailed();
	}
}
