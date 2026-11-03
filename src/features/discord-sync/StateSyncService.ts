import type { Client, Guild, Message, Channel, GuildMember } from "discord.js";
import type { RelationshipMapper } from "../social-intelligence/relationship-mapping/RelationshipMapper";
import type { ConversationDetector } from "../social-intelligence/conversation-detection/ConversationDetector";
import { LiveEventSync } from "./LiveEventSync";
import { ReconciliationSync } from "./ReconciliationSync";
import { SyncCoordinator } from "./SyncCoordinator";
import { PostgreSQLManager } from "../../database/PostgreSQLManager";
import { timeOperation } from "../../utils/timing";

/**
 * Unified state synchronization service that manages both real-time event sync
 * and background reconciliation without race conditions.
 *
 * Architecture:
 * - LiveEventSync: Handles Discord events in real-time (messageCreate, memberUpdate, etc.)
 * - ReconciliationSync: Background healing, gap detection, watermark validation
 * - SyncCoordinator: Prevents conflicts via locking and priority management
 *
 * Key Design Principles:
 * 1. Single Source of Truth: LiveEventSync owns real-time state
 * 2. Non-Destructive Healing: ReconciliationSync only fills gaps, never overwrites recent data
 * 3. Watermark Protection: Only LiveEventSync can advance watermarks forward
 * 4. Graceful Degradation: System continues working if either component fails
 */
export class StateSyncService {
  private client: Client;
  private db: PostgreSQLManager;
  private relationshipMapper: RelationshipMapper;
  private conversationDetector: ConversationDetector;

  private liveEventSync: LiveEventSync;
  private reconciliationSync: ReconciliationSync;
  private coordinator: SyncCoordinator;

  private maintenanceTimer?: NodeJS.Timeout;
  private verbose: boolean;

  constructor(
    client: Client,
    db: PostgreSQLManager,
    relationshipMapper: RelationshipMapper,
    conversationDetector: ConversationDetector,
    verbose: boolean = false
  ) {
    this.client = client;
    this.db = db;
    this.relationshipMapper = relationshipMapper;
    this.conversationDetector = conversationDetector;
    this.verbose = verbose;

    // Initialize coordinator first (shared state manager)
    this.coordinator = new SyncCoordinator(db, verbose);

    // Initialize sync components
    this.liveEventSync = new LiveEventSync(
      client,
      db,
      relationshipMapper,
      conversationDetector,
      this.coordinator,
      verbose
    );

    this.reconciliationSync = new ReconciliationSync(
      client,
      db,
      relationshipMapper,
      conversationDetector,
      this.coordinator,
      verbose
    );
  }

  /**
   * Start the sync service
   */
  async start(): Promise<void> {
    console.log("🔹 StateSyncService: Starting unified sync...");

    // Start live event sync first (higher priority)
    this.liveEventSync.start();

    // Run initial reconciliation pass (after live sync is active)
    await this.runInitialReconciliation();

    // Start periodic maintenance
    this.startMaintenance();

    console.log("🔹 StateSyncService: Unified sync started");
  }

  /**
   * Run initial reconciliation pass on boot
   */
  private async runInitialReconciliation(): Promise<void> {
    console.log("🔹 StateSyncService: Running initial reconciliation...");

    try {
      await this.reconciliationSync.runOnce();
    } catch (error) {
      console.error(
        "🔸 StateSyncService: Error during initial reconciliation:",
        error
      );
    }
  }

  /**
   * Start periodic maintenance (every 10 minutes)
   */
  private startMaintenance(): void {
    this.maintenanceTimer = setInterval(async () => {
      await this.runMaintenance();
    }, 10 * 60 * 1000);

    if (this.verbose) {
      console.log(
        "🔹 StateSyncService: Periodic maintenance started (every 10 minutes)"
      );
    }
  }

  /**
   * Run periodic maintenance tasks
   */
  private async runMaintenance(): Promise<void> {
    try {
      if (this.verbose) {
        console.log("🔹 StateSyncService: Running periodic maintenance...");
      }

      // Run reconciliation tasks
      await this.reconciliationSync.runMaintenance();

      if (this.verbose) {
        console.log("🔹 StateSyncService: Periodic maintenance completed");
      }
    } catch (error) {
      console.error("🔸 StateSyncService: Error during maintenance:", error);
    }
  }

  /**
   * Stop the sync service
   */
  async stop(): Promise<void> {
    console.log("🔹 StateSyncService: Stopping unified sync...");

    // Stop maintenance timer
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
    }

    // Stop live event sync
    await this.liveEventSync.stop();

    // Final reconciliation pass (optional, can be skipped for fast shutdown)
    // await this.reconciliationSync.runOnce();

    console.log("🔹 StateSyncService: Unified sync stopped");
  }

  /**
   * Get sync statistics for monitoring
   */
  getStats(): {
    liveEvents: {
      messagesProcessed: number;
      reactionsSynced: number;
      membersSynced: number;
    };
    reconciliation: {
      lastRunTime: Date | null;
      gapsDetected: number;
      messagesFilled: number;
      messageEmbeddingsGenerated: number;
      conversationEmbeddingsGenerated: number;
    };
    coordinator: {
      activeLocks: number;
      totalConflicts: number;
    };
  } {
    const reconciliationStats = this.reconciliationSync.getStats();
    return {
      liveEvents: this.liveEventSync.getStats(),
      reconciliation: {
        lastRunTime: reconciliationStats.lastRunTime,
        gapsDetected: reconciliationStats.gapsDetected,
        messagesFilled: reconciliationStats.messagesFilled,
        messageEmbeddingsGenerated: reconciliationStats.messageEmbeddingsGenerated || 0,
        conversationEmbeddingsGenerated: reconciliationStats.conversationEmbeddingsGenerated || 0,
      },
      coordinator: this.coordinator.getStats(),
    };
  }
}
