import type { Client, Guild, Message } from "discord.js";
import type { KeywordMessage } from "../social-intelligence/semantic-analysis/types";
import { KeywordExtractor } from "../social-intelligence/semantic-analysis/KeywordExtractor";
import { EmbeddingService } from "../social-intelligence/semantic-analysis/EmbeddingService";
import { RelationshipMapper } from "../social-intelligence/relationship-mapping/RelationshipMapper";
import type { ConversationDetector } from "../social-intelligence/conversation-detection/ConversationDetector";
import { parseEmbedding } from "../social-intelligence/conversation-detection/messageUtils";
import { EnrichmentPipelineOrchestrator } from "../social-intelligence/enrichment-pipeline/EnrichmentPipelineOrchestrator";
import { EnrichmentLayer } from "../social-intelligence/enrichment-pipeline/EnrichmentQueue";
import { config } from "../../config/index.js";
import type { SyncCoordinator } from "./SyncCoordinator.js";
import type { PostgreSQLManager } from "../../database/PostgreSQLManager.js";
import { timeOperation } from "../../utils/timing.js";

type BackfilledMessage = {
  id: string;
  author_id: string;
  content: string;
  created_at: Date;
  guild_id: string;
  channel_id: string;
  referenced_message_id?: string;
  mentioned_user_ids?: string[];
  embedding?: number[];
};

/**
 * Background reconciliation and healing for Discord state
 *
 * Responsibilities:
 * - Detect and fill message gaps (bot downtime, missed events)
 * - Backfill conversation keywords
 * - Validate data consistency (channels, members, messages)
 * - Consolidate duplicate/overlapping segments
 *
 * Priority: LOW (background, non-blocking)
 * Coordination: Uses SyncCoordinator to avoid conflicts with LiveEventSync
 *
 * Key Principle: NEVER overwrite recent data managed by LiveEventSync
 */
export class ReconciliationSync {
  private client: Client;
  private db: PostgreSQLManager;
  private relationshipMapper: RelationshipMapper;
  private conversationDetector?: ConversationDetector;
  private coordinator: SyncCoordinator;
  private verbose: boolean;
  private keywordExtractor: KeywordExtractor;
  private embeddingService: EmbeddingService;

  private readonly KEYWORD_HEAL_SEGMENT_LIMIT = 200;

  // Statistics
  private stats = {
    lastRunTime: null as Date | null,
    gapsDetected: 0,
    messagesFilled: 0,
    channelsSynced: 0,
    membersSynced: 0,
    // Healing stats
    messageEmbeddingsGenerated: 0,
    conversationEmbeddingsGenerated: 0,
    usersQueued: 0,
    relationshipsQueued: 0,
    guildsQueued: 0,
  };

  constructor(
    client: Client,
    db: PostgreSQLManager,
    relationshipMapper: RelationshipMapper,
    conversationDetector: ConversationDetector | undefined,
    coordinator: SyncCoordinator,
    verbose: boolean = false
  ) {
    this.client = client;
    this.db = db;
    this.relationshipMapper = relationshipMapper;
    this.conversationDetector = conversationDetector;
    this.coordinator = coordinator;
    this.verbose = verbose;
    this.keywordExtractor = new KeywordExtractor(db);
    this.embeddingService = EmbeddingService.getInstance();
  }

  /**
   * Run full reconciliation pass
   */
  async runOnce(): Promise<void> {
    console.log("🔹 ReconciliationSync: Starting reconciliation pass...");

    try {
      if (config.guildId) {
        const targetGuild = this.client.guilds.cache.get(config.guildId);
        if (targetGuild) {
          console.log(
            `🔹 ReconciliationSync: Limiting to guild: ${targetGuild.name} (${config.guildId})`
          );
          await this.reconcileGuild(targetGuild);
        } else {
          console.log(
            `🔸 ReconciliationSync: Guild ID ${config.guildId} not found in cache`
          );
        }
      } else {
        for (const [, guild] of this.client.guilds.cache) {
          await this.reconcileGuild(guild);
        }
      }

      this.stats.lastRunTime = new Date();
      console.log("🔹 ReconciliationSync: Reconciliation pass completed");
    } catch (error) {
      console.error(
        "🔸 ReconciliationSync: Error during reconciliation:",
        error
      );
    }
  }

  /**
   * Reconcile a single guild
   */
  private async reconcileGuild(guild: Guild): Promise<void> {
    if (this.verbose) {
      console.log(`🔹 ReconciliationSync: Reconciling guild: ${guild.name}`);
    }

    const guildId = guild.id;

    // Sync guild metadata (coordinator prevents conflicts)
    const releaseLock = await this.coordinator.acquireGuildLock(guildId);
    try {
      const guildResult = await this.db.upsertGuild({
        id: guildId,
        name: guild.name,
        description: guild.description || undefined,
        icon: guild.icon || undefined,
        owner_id: guild.ownerId || "",
        member_count: guild.memberCount,
        active: true,
        created_at: guild.createdAt || new Date(),
      });

      if (!guildResult.success) {
        console.error(
          `🔸 ReconciliationSync: Failed to upsert guild ${guildId}`
        );
        return;
      }
    } finally {
      releaseLock();
    }

    // 1. Reconcile base Discord data
    await this.reconcileChannels(guild);
    await this.reconcileMembers(guild);

    // 2. Reconcile messages and embeddings
    await this.reconcileMessages(guild);
    await this.reconcileMessageEmbeddings(guild);

    // 3. Reconcile conversation data
    await this.reconcileConversationKeywords(guild);
    await this.reconcileConversationEmbeddings(guild);
    await this.reconcileConversationEnrichment(guild);

    // 4. Reconcile enrichment layers (dependency chain)
    await this.reconcileUserProfiles(guild);
    await this.reconcileRelationshipProfiles(guild);
    await this.reconcileGuildMetadata(guild);

    // 5. Reconcile voice states
    await this.reconcileVoiceStates(guild);

    if (this.verbose) {
      console.log(`🔹 ReconciliationSync: Completed for ${guild.name}`);
    }
  }

  /**
   * Reconcile channels (detect missing channels, update metadata)
   */
  private async reconcileChannels(guild: Guild): Promise<void> {
    const channels = Array.from(guild.channels.cache.values()).filter(
      (ch) => ch.isTextBased() && !ch.isDMBased()
    );

    if (this.verbose) {
      console.log(
        `   📝 ReconciliationSync: Syncing ${channels.length} channels...`
      );
    }

    for (const channel of channels) {
      const releaseLock = await this.coordinator.acquireChannelLock(channel.id);

      try {
        await this.db.upsertChannel({
          id: channel.id,
          guild_id: guild.id,
          name: channel.name || "",
          type: channel.type,
          position: (channel as any).position || 0,
          topic: (channel as any).topic || undefined,
          nsfw: (channel as any).nsfw || false,
          parent_id: (channel as any).parentId || undefined,
          active: true,
        });

        this.stats.channelsSynced++;
      } finally {
        releaseLock();
      }
    }
  }

  /**
   * Reconcile members (detect missing members, update profiles)
   */
  private async reconcileMembers(guild: Guild): Promise<void> {
    if (this.verbose) {
      console.log(`   👥 ReconciliationSync: Fetching members...`);
    }

    const members = await guild.members.fetch();
    const membersArray = Array.from(members.values());

    if (this.verbose) {
      console.log(
        `   👥 ReconciliationSync: Syncing ${membersArray.length} members...`
      );
    }

    for (const member of membersArray) {
      const releaseLock = await this.coordinator.acquireMemberLock(
        `${guild.id}_${member.user.id}`
      );

      try {
        await this.db.upsertMember({
          id: `${guild.id}_${member.user.id}`,
          guild_id: guild.id,
          user_id: member.user.id,
          username: member.user.username,
          display_name: member.displayName,
          global_name: member.user.globalName || undefined,
          avatar: member.user.avatar || undefined,
          avatar_decoration: member.user.avatarDecoration || undefined,
          banner: member.user.banner || undefined,
          accent_color: member.user.accentColor || undefined,
          discriminator: member.user.discriminator,
          bio: undefined,
          flags: member.user.flags?.bitfield || undefined,
          premium_type: undefined,
          public_flags: member.user.flags?.bitfield || undefined,
          bot: member.user.bot,
          system: member.user.system || undefined,
          nick: member.nickname || undefined,
          joined_at: member.joinedAt || new Date(),
          roles: Array.from(member.roles.cache.keys()),
          permissions: member.permissions.bitfield.toString(),
          communication_disabled_until:
            member.communicationDisabledUntil || undefined,
          pending: member.pending || undefined,
          premium_since: member.premiumSince || undefined,
          timeout: undefined,
          active: true,
          created_at: member.user.createdAt || new Date(),
          updated_at: new Date(),
        });

        this.stats.membersSynced++;
      } catch (error) {
        // Silent failure for individual members
      } finally {
        releaseLock();
      }
    }
  }

  /**
   * Reconcile messages (detect gaps, backfill missing messages)
   *
   * Key Strategy:
   * - Check watermarks to detect gaps
   * - Only backfill OLDER messages (never overwrite LiveEventSync data)
   * - Use coordinator to ensure watermarks don't regress
   */
  private async reconcileMessages(guild: Guild): Promise<void> {
    const channels = Array.from(guild.channels.cache.values()).filter(
      (ch) => ch.isTextBased() && !ch.isDMBased()
    );

    let channelsProcessed = 0;
    let channelsWithGaps = 0;
    let channelsBackfilled = 0;

    // Process channels in parallel with concurrency limit
    const concurrency = 10; // Process 10 channels simultaneously
    const results = await this.processChannelsConcurrently(
      channels,
      guild.id,
      concurrency
    );

    channelsProcessed = results.processed;
    channelsBackfilled = results.backfilled;
    channelsWithGaps = results.gapChecks;

    if (this.conversationDetector) {
      await this.conversationDetector.flushInactiveBuffers(0);
    }
  }

  /**
   * Process multiple channels concurrently with rate limiting
   */
  private async processChannelsConcurrently(
    channels: any[],
    guildId: string,
    concurrency: number
  ): Promise<{
    processed: number;
    backfilled: number;
    gapChecks: number;
  }> {
    let processed = 0;
    let backfilled = 0;
    let gapChecks = 0;

    // Process channels in batches of 'concurrency' size
    for (let i = 0; i < channels.length; i += concurrency) {
      const batch = channels.slice(i, i + concurrency);

      // Process batch concurrently
      const batchResults = await Promise.allSettled(
        batch.map(async (channel) => {
          const channelStart = performance.now();
          try {
            const watermarkResult = await this.db.getChannelWatermark(
              channel.id
            );

            if (!watermarkResult.success || !watermarkResult.data) {
              // No watermark = channel never synced, backfill all messages
              await this.backfillChannel(guildId, channel.id, null);
              return { type: "backfilled" as const };
            } else {
              const watermark = watermarkResult.data.last_message_id;

              if (!watermark) {
                // Watermark exists but NULL (messages cleared), backfill all
                await this.backfillChannel(guildId, channel.id, null);
                return { type: "backfilled" as const };
              } else {
                // Check if this channel has ever had a complete backfill
                const hasCompleteSyncResult = await this.db.query(
                  `SELECT last_full_sync FROM channels WHERE id = $1`,
                  [channel.id]
                );

                const hasCompleteSync =
                  hasCompleteSyncResult.success &&
                  hasCompleteSyncResult.data &&
                  hasCompleteSyncResult.data.length > 0 &&
                  hasCompleteSyncResult.data[0].last_full_sync !== null;

                // Only use fast-path optimization if channel has been fully synced before
                if (hasCompleteSync) {
                  // Quick check: if watermark is current, channel is likely up-to-date
                  const isUpToDate = await this.isChannelUpToDate(
                    channel,
                    watermark
                  );

                  if (isUpToDate) {
                    // Watermark is current, but do a quick sanity check (first 200 messages)
                    const hasGaps = await this.quickGapCheck(
                      guildId,
                      channel.id,
                      watermark
                    );
                    if (!hasGaps) {
                      return { type: "skip" as const };
                    }
                  }
                }

                // Either: no complete sync yet, watermark outdated, or gaps detected
                // First check for messages newer than watermark (bot downtime scenario)
                const hasNewerMessages = await this.backfillNewerMessages(
                  guildId,
                  channel.id,
                  watermark
                );
                
                // Then do full scan backwards to ensure all history is captured
                await this.detectAndFillGaps(guildId, channel.id, watermark);
                return { type: "gapCheck" as const };
              }
            }
          } catch (error: any) {
            if (error.code === 50001 || error.status === 403) {
              // Missing permissions, skip silently
              return { type: "skip" as const };
            }

            if (this.verbose) {
              console.error(
                `   🔸 ReconciliationSync: Error reconciling channel ${channel.id}:`,
                error
              );
            }
            return { type: "error" as const };
          } finally {
            const channelDuration = performance.now() - channelStart;

            // Log slow channels (> 10 seconds)
            if (channelDuration > 10000) {
              const channelName = (channel as any).name || channel.id;
              console.log(
                `      ⚠️  Slow channel: #${channelName} took ${(
                  channelDuration / 1000
                ).toFixed(1)}s`
              );
            }
          }
        })
      );

      // Count results
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          processed++;
          if (result.value.type === "backfilled") {
            backfilled++;
          } else if (result.value.type === "gapCheck") {
            gapChecks++;
          }
        }
      }
    }

    return { processed, backfilled, gapChecks };
  }

  /**
   * Quick check if channel's watermark points to the most recent message
   * Returns true if channel is up-to-date (no reconciliation needed)
   */
  private async isChannelUpToDate(
    channel: any,
    watermark: string
  ): Promise<boolean> {
    try {
      // Fetch only the most recent message from Discord
      const messages = await channel.messages.fetch({ limit: 1 });

      if (!messages || messages.size === 0) {
        // No messages in channel, up-to-date
        return true;
      }

      const latestMessage = messages.first();

      // If watermark matches latest message, no gaps possible
      return latestMessage?.id === watermark;
    } catch (error) {
      // On error, assume not up-to-date to be safe
      return false;
    }
  }

  /**
   * Quick sanity check for gaps in recent messages
   * Returns true if gaps detected, false if all recent messages present
   */
  private async quickGapCheck(
    guildId: string,
    channelId: string,
    watermark: string
  ): Promise<boolean> {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return false;

    try {
      // Check first 2 batches (200 messages) for gaps
      let lastId: string | null = watermark;
      const batchSize = 100;
      const quickScanBatches = 2;

      for (let i = 0; i < quickScanBatches; i++) {
        const options: any = { limit: batchSize, before: lastId };
        const messages = await (channel as any).messages.fetch(options);

        if (!messages || messages.size === 0) break;

        // Check if these messages exist in DB
        const messageIds = Array.from(messages.keys());
        const existingResult = await this.db.query(
          `SELECT id FROM messages WHERE id = ANY($1) AND active = true`,
          [messageIds]
        );

        const existingCount =
          existingResult.success && existingResult.data
            ? existingResult.data.length
            : 0;

        // If any messages missing, we have a gap
        if (existingCount < messageIds.length) {
          return true; // Gap detected
        }

        if (messages.size < batchSize) break; // Reached end of channel
        lastId = messages.last()?.id || null;
        if (!lastId) break;
      }

      return false; // No gaps in recent messages
    } catch (error) {
      // On error, assume gaps exist to be safe
      return true;
    }
  }

  /**
   * Backfill all messages in a channel (no watermark)
   */
  private async backfillChannel(
    guildId: string,
    channelId: string,
    watermark: string | null
  ): Promise<void> {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return;

    const channelName = `#${(channel as any).name || channelId}`;

    let lastId: string | null = null;
    let synced = 0;
    const batchSize = 100;
    const backfilledMessages: BackfilledMessage[] = [];

    while (true) {
      const options: any = { limit: batchSize };
      if (lastId) {
        options.before = lastId;
      }

      const messages = await (channel as any).messages.fetch(options);
      if (!messages || messages.size === 0) break;

      // Filter out messages that already exist in DB (avoid duplicate work)
      const messageIds = Array.from(messages.keys());
      const existingResult = await this.db.query(
        `SELECT id FROM messages WHERE id = ANY($1)`,
        [messageIds]
      );

      const existingIds = new Set<string>();
      if (existingResult.success && existingResult.data) {
        for (const row of existingResult.data) {
          existingIds.add(row.id);
        }
      }

      // Insert only missing messages
      for (const [, msg] of messages) {
        if (!existingIds.has(msg.id)) {
          // Generate embedding for message content (if it has meaningful text)
          let embedding: number[] | undefined = undefined;
          if (msg.content && msg.content.trim().length > 0) {
            try {
              embedding = await this.embeddingService.generateEmbedding(
                msg.content
              );
            } catch (error) {
              if (this.verbose) {
                console.error(
                  `🔸 ReconciliationSync: Failed to generate embedding for message ${msg.id}:`,
                  error
                );
              }
              // Continue without embedding - will be backfilled later if needed
            }
          }

          await this.db.upsertMessage({
            id: msg.id,
            guild_id: guildId,
            channel_id: channelId,
            author_id: msg.author.id,
            content: msg.content || "",
            created_at: msg.createdAt,
            edited_at: msg.editedAt || undefined,
            attachments: Array.from(msg.attachments.values()).map(
              (a: any) => a.url
            ),
            embeds: msg.embeds.map((e: any) => JSON.stringify(e.toJSON())),
            referenced_message_id: msg.reference?.messageId || undefined,
            embedding: embedding,
            active: true,
          });

          if (!msg.author.bot) {
            synced++;
            this.stats.messagesFilled++;
          }

          const conversationMessage = this.buildBackfilledMessage(
            msg,
            guildId,
            channelId,
            embedding
          );
          if (conversationMessage) {
            backfilledMessages.push(conversationMessage);
          }
        }
      }

      lastId = messages.last()?.id || null;
      if (messages.size < batchSize) break;
    }

    // Set watermark ONLY if no watermark exists (avoid regressing)
    if (synced > 0) {
      const mostRecentResult = await this.db.query(
        "SELECT id FROM messages WHERE channel_id = $1 AND guild_id = $2 ORDER BY created_at DESC LIMIT 1",
        [channelId, guildId]
      );

      if (
        mostRecentResult.success &&
        mostRecentResult.data &&
        mostRecentResult.data.length > 0
      ) {
        await this.coordinator.tryUpdateWatermarkIfMissing(
          channelId,
          mostRecentResult.data[0].id
        );
      }

      if (this.verbose) {
        console.log(
          `   🔹 ReconciliationSync: Backfilled ${synced} messages in ${channelName}`
        );
      }

      // Mark channel as having completed a full sync
      await this.db.query(
        `UPDATE channels SET last_full_sync = NOW() WHERE id = $1`,
        [channelId]
      );
    }

    await this.streamBackfilledMessages(backfilledMessages);
  }

  /**
   * Backfill messages newer than watermark (sent while bot was offline)
   * This handles the case where the bot reconnects after being offline
   */
  private async backfillNewerMessages(
    guildId: string,
    channelId: string,
    watermark: string
  ): Promise<boolean> {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return false;

    try {
      // Fetch the latest message from Discord
      const latestMessages = await (channel as any).messages.fetch({ limit: 1 });
      if (!latestMessages || latestMessages.size === 0) {
        return false; // No messages in channel
      }

      const latestMessage = latestMessages.first()!;
      const latestMessageId = latestMessage.id;

      // Compare snowflake IDs to check if there are newer messages
      const watermarkSnowflake = BigInt(watermark);
      const latestSnowflake = BigInt(latestMessageId);

      // If latest message is older or equal to watermark, no newer messages
      if (latestSnowflake <= watermarkSnowflake) {
        return false;
      }

      // There are newer messages! Backfill forward from watermark
      let synced = 0;
      let lastId: string | null = watermark;
      const batchSize = 100;
      const maxBatches = 50; // Safety limit
      const backfilledMessages: BackfilledMessage[] = [];

      // Fetch messages after the watermark
      for (let i = 0; i < maxBatches; i++) {
        const options: { limit: number; after?: string } = { limit: batchSize };
        if (lastId) {
          options.after = lastId; // Fetch messages after this ID
        }

        const messages = await channel.messages.fetch(options);
        if (!messages || messages.size === 0) break;

        // Check which messages already exist in DB
        const messageIds = Array.from(messages.keys());
        const existingResult = await this.db.query(
          `SELECT id FROM messages WHERE id = ANY($1) AND active = true`,
          [messageIds]
        );

        const existingIds = new Set<string>();
        if (existingResult.success && existingResult.data) {
          for (const row of existingResult.data) {
            existingIds.add(row.id);
          }
        }

        // Insert missing messages
        for (const [, msg] of messages) {
          if (!existingIds.has(msg.id)) {
            // Generate embedding for message content
            let embedding: number[] | undefined = undefined;
            if (msg.content && msg.content.trim().length > 0) {
              try {
                embedding = await this.embeddingService.generateEmbedding(
                  msg.content
                );
              } catch (error) {
                if (this.verbose) {
                  console.error(
                    `🔸 ReconciliationSync: Failed to generate embedding for message ${msg.id}:`,
                    error
                  );
                }
              }
            }

            await this.db.upsertMessage({
              id: msg.id,
              guild_id: guildId,
              channel_id: channelId,
              author_id: msg.author.id,
              content: msg.content || "",
              created_at: msg.createdAt,
              edited_at: msg.editedAt || undefined,
              attachments: Array.from(msg.attachments.values()).map(
                (a: any) => a.url
              ),
              embeds: msg.embeds.map((e: any) => JSON.stringify(e.toJSON())),
              referenced_message_id: msg.reference?.messageId || undefined,
              embedding: embedding,
              active: true,
            });

            // Update watermark as we go (these are newer messages)
            await this.coordinator.tryUpdateWatermark(
              channelId,
              msg.id,
              "reconciliation"
            );

            if (!msg.author.bot) {
              synced++;
              this.stats.messagesFilled++;
              this.stats.gapsDetected++;
            }

            const conversationMessage = this.buildBackfilledMessage(
              msg,
              guildId,
              channelId,
              embedding
            );
            if (conversationMessage) {
              backfilledMessages.push(conversationMessage);
            }
          }
        }

        // Stop if we've reached the latest message or end of history
        if (messages.has(latestMessageId) || messages.size < batchSize) {
          break;
        }

        // Get the newest message ID from this batch for next iteration
        const sortedMessages = Array.from(messages.values()).sort((a, b) => {
          const diff = BigInt(b.id) - BigInt(a.id);
          return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        lastId = sortedMessages[0]?.id || null;
        if (!lastId) break;
      }

      const channelName = `#${(channel as any).name || channelId}`;
      if (synced > 0) {
        console.log(
          `   🔹 ReconciliationSync: Backfilled ${synced} newer messages in ${channelName} (bot downtime recovery)`
        );
      }

      await this.streamBackfilledMessages(backfilledMessages);
      return synced > 0;
    } catch (error) {
      if (this.verbose) {
        console.error(
          `🔸 ReconciliationSync: Error backfilling newer messages in ${channelId}:`,
          error
        );
      }
      return false;
    }
  }

  /**
   * Detect and fill gaps (messages before watermark that are missing from DB)
   */
  private async detectAndFillGaps(
    guildId: string,
    channelId: string,
    watermark: string
  ): Promise<void> {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return;

    // Fetch oldest message in DB for this channel
    const oldestResult = await this.db.query(
      "SELECT id, created_at FROM messages WHERE channel_id = $1 AND active = true ORDER BY created_at ASC LIMIT 1",
      [channelId]
    );

    if (
      !oldestResult.success ||
      !oldestResult.data ||
      oldestResult.data.length === 0
    ) {
      // No messages in DB, backfill from watermark backward
      await this.backfillChannel(guildId, channelId, watermark);
      return;
    }

    const oldestInDb = oldestResult.data[0].id;

    // Scan backwards from watermark, filling all gaps until we reach oldest in DB
    let lastId: string | null = watermark;
    let synced = 0;
    const batchSize = 100;
    const maxBatches = 100; // Safety limit for thorough scanning
    let consecutiveCleanBatches = 0;
    const backfilledMessages: BackfilledMessage[] = [];

    for (let i = 0; i < maxBatches; i++) {
      const options: any = { limit: batchSize, before: lastId };
      const messages = await (channel as any).messages.fetch(options);

      if (!messages || messages.size === 0) break;

      // Check if we've reached the oldest message in DB
      let reachedOldest = false;
      for (const [, msg] of messages) {
        if (msg.id === oldestInDb) {
          reachedOldest = true;
          break;
        }
      }

      // Filter out messages that already exist
      const messageIds = Array.from(messages.keys());
      const existingResult = await this.db.query(
        `SELECT id FROM messages WHERE id = ANY($1) AND active = true`,
        [messageIds]
      );

      const existingIds = new Set<string>();
      if (existingResult.success && existingResult.data) {
        for (const row of existingResult.data) {
          existingIds.add(row.id);
        }
      }

      // Track if this batch had any gaps
      const batchHasGaps = existingIds.size < messageIds.length;

      // Insert missing messages
      for (const [, msg] of messages) {
        if (!existingIds.has(msg.id)) {
          // Generate embedding for message content (if it has meaningful text)
          let embedding: number[] | undefined = undefined;
          if (msg.content && msg.content.trim().length > 0) {
            try {
              embedding = await this.embeddingService.generateEmbedding(
                msg.content
              );
            } catch (error) {
              if (this.verbose) {
                console.error(
                  `🔸 ReconciliationSync: Failed to generate embedding for message ${msg.id}:`,
                  error
                );
              }
              // Continue without embedding - will be backfilled later if needed
            }
          }

          await this.db.upsertMessage({
            id: msg.id,
            guild_id: guildId,
            channel_id: channelId,
            author_id: msg.author.id,
            content: msg.content || "",
            created_at: msg.createdAt,
            edited_at: msg.editedAt || undefined,
            attachments: Array.from(msg.attachments.values()).map(
              (a: any) => a.url
            ),
            embeds: msg.embeds.map((e: any) => JSON.stringify(e.toJSON())),
            referenced_message_id: msg.reference?.messageId || undefined,
            embedding: embedding,
            active: true,
          });

          if (!msg.author.bot) {
            synced++;
            this.stats.messagesFilled++;
            this.stats.gapsDetected++;
          }

          const conversationMessage = this.buildBackfilledMessage(
            msg,
            guildId,
            channelId,
            embedding
          );
          if (conversationMessage) {
            backfilledMessages.push(conversationMessage);
          }
        }
      }

      // Update consecutive clean batches counter
      if (batchHasGaps) {
        consecutiveCleanBatches = 0; // Reset on gap
      } else {
        consecutiveCleanBatches++;
        // Early exit: if we've had 3+ consecutive clean batches, very likely no more gaps
        if (consecutiveCleanBatches >= 3 && !reachedOldest) {
          if (this.verbose) {
            const channelName = `#${(channel as any).name || channelId}`;
            console.log(
              `   🔹 ReconciliationSync: ${channelName} verified clean after ${
                i + 1
              } batches`
            );
          }
          break;
        }
      }

      // Stop if we reached the oldest message or end of history
      if (reachedOldest || messages.size < batchSize) break;

      lastId = messages.last()?.id || null;
      if (!lastId) break;
    }

    const channelName = `#${(channel as any).name || channelId}`;
    if (synced > 0) {
      console.log(
        `   🔹 ReconciliationSync: Filled ${synced} gap messages in ${channelName}`
      );
    } else if (this.verbose) {
      console.log(`   🔹 ReconciliationSync: No gaps found in ${channelName}`);
    }

    // Mark channel as having completed a full sync
    await this.db.query(
      `UPDATE channels SET last_full_sync = NOW() WHERE id = $1`,
      [channelId]
    );

    await this.streamBackfilledMessages(backfilledMessages);
  }

  private buildBackfilledMessage(
    msg: Message,
    guildId: string,
    channelId: string,
    embedding?: number[]
  ): BackfilledMessage | null {
    if (!this.conversationDetector) {
      return null;
    }

    if (msg.author.bot) {
      return null;
    }

    const trimmedContent = msg.content?.trim();
    if (!trimmedContent) {
      return null;
    }

    const mentionedUsers =
      msg.mentions?.users && msg.mentions.users.size > 0
        ? Array.from(msg.mentions.users.keys())
        : undefined;

    return {
      id: msg.id,
      author_id: msg.author.id,
      content: msg.content,
      created_at: msg.createdAt || new Date(),
      guild_id: guildId,
      channel_id: channelId,
      referenced_message_id: msg.reference?.messageId || undefined,
      mentioned_user_ids: mentionedUsers,
      embedding,
    };
  }

  private async streamBackfilledMessages(
    messages: BackfilledMessage[]
  ): Promise<void> {
    if (!this.conversationDetector || messages.length === 0) {
      return;
    }

    const ordered = [...messages].sort(
      (a, b) => a.created_at.getTime() - b.created_at.getTime()
    );

    for (const message of ordered) {
      try {
        await this.conversationDetector.addMessageToStream(message);
      } catch (error) {
        if (this.verbose) {
          console.error(
            `   🔸 ReconciliationSync: Failed to process backfilled message ${message.id} for conversations:`,
            error
          );
        }
      }
    }
  }

  /**
   * Reconcile message embeddings (backfill missing embeddings)
   * ENHANCED: No time limit, configurable options, progress tracking
   */
  private async reconcileMessageEmbeddings(
    guild: Guild,
    options: {
      dryRun?: boolean;
      batchSize?: number;
      maxMessages?: number;
      ageLimit?: number;
    } = {}
  ): Promise<{ scanned: number; generated: number; failed: number }> {
    const batchSize = options.batchSize || 32;
    const maxMessages = options.maxMessages || 2000;
    const dryRun = options.dryRun || false;

    try {
      // Build time filter (optional age limit)
      const ageLimitClause = options.ageLimit
        ? `AND created_at > NOW() - INTERVAL '${options.ageLimit} days'`
        : "";

      // Find messages without embeddings that have content
      const messagesResult = await this.db.query(
        `
        SELECT id, content
        FROM messages
        WHERE guild_id = $1
          AND embedding IS NULL
          AND content IS NOT NULL
          AND LENGTH(TRIM(content)) > 0
          ${ageLimitClause}
        ORDER BY created_at DESC
        LIMIT $2
        `,
        [guild.id, maxMessages]
      );

      if (
        !messagesResult.success ||
        !messagesResult.data ||
        messagesResult.data.length === 0
      ) {
        return { scanned: 0, generated: 0, failed: 0 };
      }

      const messages = messagesResult.data;
      if (this.verbose || dryRun) {
        console.log(
          `   🧠 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Backfilling embeddings for ${messages.length} messages...`
        );
      }

      // Generate embeddings in batches
      let totalGenerated = 0;
      let totalFailed = 0;

      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const texts = batch.map((m: any) => m.content);
        const ids = batch.map((m: any) => m.id);

        try {
          const embeddings = await this.embeddingService.generateBatch(texts);

          if (!dryRun) {
            // Update each message with its embedding
            for (let j = 0; j < batch.length; j++) {
              const embedding = embeddings[j];
              if (embedding && embedding.length > 0) {
                try {
                  // Format as pgvector string: '[1,2,3]'
                  const embeddingStr = `[${embedding.join(",")}]`;
                  await this.db.query(
                    `UPDATE messages SET embedding = $1::vector WHERE id = $2`,
                    [embeddingStr, ids[j]]
                  );
                  totalGenerated++;
                } catch (updateError) {
                  console.error(
                    `🔸 ReconciliationSync: Failed to update embedding for message ${ids[j]}:`,
                    updateError
                  );
                  totalFailed++;
                }
              } else {
                totalFailed++;
              }
            }
          } else {
            // Dry run: just count
            totalGenerated += embeddings.filter((e) => e && e.length > 0).length;
            totalFailed += embeddings.filter((e) => !e || e.length === 0).length;
          }

          // Progress logging every 10 batches (320 messages)
          if (this.verbose && (i / batchSize + 1) % 10 === 0) {
            console.log(
              `      Progress: ${Math.min(i + batchSize, messages.length)}/${messages.length} embeddings...`
            );
          }
        } catch (error) {
          console.error(
            `🔸 ReconciliationSync: Failed to generate embeddings for batch:`,
            error
          );
          totalFailed += batch.length;
        }
      }

      // Update stats
      if (!dryRun) {
        this.stats.messageEmbeddingsGenerated += totalGenerated;
      }

      if (this.verbose && totalGenerated > 0) {
        console.log(
          `   🔹 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Generated embeddings for ${totalGenerated} messages (${totalFailed} failed)`
        );
      }

      return {
        scanned: messages.length,
        generated: totalGenerated,
        failed: totalFailed,
      };
    } catch (error) {
      console.error(
        `🔸 ReconciliationSync: Error reconciling message embeddings:`,
        error
      );
      return { scanned: 0, generated: 0, failed: 0 };
    }
  }

  /**
   * Reconcile conversation segment embeddings (NEW)
   * Generates embeddings from conversation summaries
   */
  private async reconcileConversationEmbeddings(
    guild: Guild,
    options: { dryRun?: boolean } = {}
  ): Promise<{ scanned: number; generated: number; failed: number }> {
    const dryRun = options.dryRun || false;

    try {
      // Find segments with summaries but no embeddings
      const segmentsResult = await this.db.query(
        `
        SELECT id, summary
        FROM conversation_segments
        WHERE guild_id = $1
          AND status = 'finalized'
          AND embedding IS NULL
          AND summary IS NOT NULL
          AND LENGTH(TRIM(summary)) > 0
        ORDER BY end_time DESC
        `,
        [guild.id]
      );

      if (
        !segmentsResult.success ||
        !segmentsResult.data ||
        segmentsResult.data.length === 0
      ) {
        return { scanned: 0, generated: 0, failed: 0 };
      }

      const segments = segmentsResult.data;
      if (this.verbose || dryRun) {
        console.log(
          `   🧠 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Generating embeddings for ${segments.length} conversation summaries...`
        );
      }

      let totalGenerated = 0;
      let totalFailed = 0;

      for (const segment of segments) {
        try {
          // Generate embedding from summary
          const embedding = await this.embeddingService.generateEmbedding(
            segment.summary
          );

          if (embedding && embedding.length > 0) {
            if (!dryRun) {
              // Format as pgvector string: '[1,2,3]'
              const embeddingStr = `[${embedding.join(",")}]`;
              await this.db.query(
                `UPDATE conversation_segments SET embedding = $1::vector WHERE id = $2`,
                [embeddingStr, segment.id]
              );
            }
            totalGenerated++;
          } else {
            totalFailed++;
          }
        } catch (error) {
          console.error(
            `🔸 ReconciliationSync: Failed to generate embedding for segment ${segment.id}:`,
            error
          );
          totalFailed++;
        }
      }

      // Update stats
      if (!dryRun) {
        this.stats.conversationEmbeddingsGenerated += totalGenerated;
      }

      if (this.verbose && totalGenerated > 0) {
        console.log(
          `   🔹 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Generated embeddings for ${totalGenerated} conversation segments (${totalFailed} failed)`
        );
      }

      return {
        scanned: segments.length,
        generated: totalGenerated,
        failed: totalFailed,
      };
    } catch (error) {
      console.error(
        `🔸 ReconciliationSync: Error reconciling conversation embeddings:`,
        error
      );
      return { scanned: 0, generated: 0, failed: 0 };
    }
  }

  /**
   * Reconcile conversation keywords (backfill missing keywords)
   */
  private async reconcileConversationKeywords(guild: Guild): Promise<void> {
    try {
      const attemptedSegments = new Set<string>();
      let totalUpdated = 0;
      let batchNumber = 0;

      while (true) {
        const segmentsResult = await this.db.query(
          `
					SELECT id, message_ids, features
					FROM conversation_segments
					WHERE guild_id = $1
						AND status = 'finalized'
						AND (
							features IS NULL
							OR NOT (COALESCE(features, '{}'::jsonb) ? 'keywords')
							OR jsonb_array_length(
									COALESCE(features->'keywords'->'terms', '[]'::jsonb)
								) = 0
						)
					ORDER BY end_time DESC
					LIMIT $2
					`,
          [guild.id, this.KEYWORD_HEAL_SEGMENT_LIMIT]
        );

        if (!segmentsResult.success || !segmentsResult.data) {
          break;
        }

        const segmentsNeedingKeywords = segmentsResult.data;
        if (segmentsNeedingKeywords.length === 0) {
          break;
        }

        batchNumber++;
        if (this.verbose) {
          console.log(
            `   🧠 ReconciliationSync: [Batch ${batchNumber}] Extracting keywords for ${segmentsNeedingKeywords.length} segments...`
          );
        }

        let updatedThisBatch = 0;

        for (const segment of segmentsNeedingKeywords) {
          if (attemptedSegments.has(segment.id)) {
            continue;
          }
          attemptedSegments.add(segment.id);

          if (
            !Array.isArray(segment.message_ids) ||
            segment.message_ids.length === 0
          ) {
            continue;
          }

          const messagesResult = await this.db.query(
            `
						SELECT id, content, author_id, embedding
						FROM messages
						WHERE id = ANY($1)
							AND content IS NOT NULL
							AND LENGTH(TRIM(content)) > 0
						ORDER BY created_at ASC
						`,
            [segment.message_ids]
          );

          if (
            !messagesResult.success ||
            !messagesResult.data ||
            messagesResult.data.length === 0
          ) {
            continue;
          }

          const keywordMessages: KeywordMessage[] = messagesResult.data.map(
            (msg: {
              id: string;
              content: string;
              author_id: string;
              embedding: unknown;
            }) => ({
              id: msg.id,
              content: msg.content,
              author_id: msg.author_id,
              embedding: parseEmbedding(msg.embedding),
            })
          );

          try {
            const keywords = await this.keywordExtractor.extractKeywords(
              keywordMessages,
              guild.id,
              { topN: 10, method: "hybrid" }
            );

            const existingFeaturesRaw = segment.features ?? {};
            const existingFeatures =
              typeof existingFeaturesRaw === "string"
                ? JSON.parse(existingFeaturesRaw)
                : { ...(existingFeaturesRaw || {}) };

            existingFeatures.keywords = keywords;

            await this.db.query(
              `UPDATE conversation_segments SET features = $1 WHERE id = $2`,
              [JSON.stringify(existingFeatures), segment.id]
            );

            totalUpdated++;
            updatedThisBatch++;
          } catch (error) {
            if (this.verbose) {
              console.error(
                `   🔸 ReconciliationSync: Failed to extract keywords for segment ${segment.id}:`,
                error
              );
            }
          }
        }

        if (segmentsNeedingKeywords.length < this.KEYWORD_HEAL_SEGMENT_LIMIT) {
          break;
        }

        if (updatedThisBatch === 0) {
          break;
        }
      }
    } catch (error) {
      console.error(
        `   🔸 ReconciliationSync: Error reconciling conversation keywords for ${guild.name}:`,
        error
      );
    }
  }

  /**
   * Reconcile the conversation enrichment backlog.
   *
   * The enrichment queue is in-memory and ConversationDetector only enqueues at
   * finalization time, so every finalized conversation that was not drained before a
   * restart (or that failed) stayed `ai_processing_status = 'pending'` forever, and
   * conversations below the significance threshold were never enqueued at all.
   * The database is the source of truth, so this sweep:
   *  1. marks insignificant pending conversations 'skipped' with a reason (and
   *     re-opens skipped ones that later became significant, e.g. after a merge),
   *  2. re-enqueues the newest significant pending conversations, a bounded number per
   *     sweep. The queue dedups by id, and the rate limiter ($1/day) bounds spend.
   *
   * Significance mirrors EnrichmentPipelineOrchestrator.isConversationSignificant:
   * 3+ participants OR 10+ messages.
   */
  private async reconcileConversationEnrichment(
    guild: Guild,
    options: { dryRun?: boolean; maxQueue?: number } = {}
  ): Promise<{ queued: number; skipped: number; reopened: number }> {
    const maxQueue = options.maxQueue ?? 20;
    const dryRun = options.dryRun || false;

    try {
      let skipped = 0;
      let reopened = 0;

      if (!dryRun) {
        const skipResult = await this.db.query(
          `
          UPDATE conversation_segments
          SET ai_processing_status = 'skipped',
              ai_metadata = COALESCE(ai_metadata, '{}'::jsonb) || jsonb_build_object(
                'skip_reason', 'below significance threshold (<3 participants and <10 messages)',
                'skipped_at', NOW()
              )
          WHERE guild_id = $1
            AND status = 'finalized'
            AND ai_processing_status = 'pending'
            AND COALESCE(array_length(participants, 1), 0) < 3
            AND message_count < 10
          RETURNING id
          `,
          [guild.id]
        );
        skipped = skipResult.success ? (skipResult.data?.length ?? 0) : 0;

        const reopenResult = await this.db.query(
          `
          UPDATE conversation_segments
          SET ai_processing_status = 'pending',
              ai_metadata = ai_metadata - 'skip_reason' - 'skipped_at'
          WHERE guild_id = $1
            AND status = 'finalized'
            AND ai_processing_status = 'skipped'
            AND ai_metadata ->> 'skip_reason' LIKE 'below significance threshold%'
            AND (COALESCE(array_length(participants, 1), 0) >= 3 OR message_count >= 10)
          RETURNING id
          `,
          [guild.id]
        );
        reopened = reopenResult.success ? (reopenResult.data?.length ?? 0) : 0;
      }

      const pendingResult = await this.db.query(
        `
        SELECT id, guild_id, COALESCE(array_length(participants, 1), 0) AS participant_count
        FROM conversation_segments
        WHERE guild_id = $1
          AND status = 'finalized'
          AND ai_processing_status = 'pending'
          AND (COALESCE(array_length(participants, 1), 0) >= 3 OR message_count >= 10)
        ORDER BY end_time DESC
        LIMIT $2
        `,
        [guild.id, maxQueue + 20]
      );

      if (!pendingResult.success || !pendingResult.data) {
        return { queued: 0, skipped, reopened };
      }

      const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
      // Jobs that exhausted their retries stay out until restart or an explicit retryFailed()
      const exhausted = new Set(
        orchestrator
          .getFailedJobs()
          .filter((job) => job.layer === EnrichmentLayer.CONVERSATION && job.attempts >= 3)
          .map((job) => job.entityId)
      );

      let queued = 0;
      for (const row of pendingResult.data) {
        if (queued >= maxQueue) break;
        if (exhausted.has(row.id)) continue;
        if (!dryRun) {
          const participantCount = Number(row.participant_count);
          await orchestrator.enqueueConversation(
            row.id,
            row.guild_id,
            participantCount >= 5 ? "high" : participantCount >= 3 ? "medium" : "low"
          );
        }
        queued++;
      }

      if (this.verbose || dryRun || skipped > 0 || reopened > 0) {
        console.log(
          `   🔹 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Conversation backlog for ${guild.name}: ${queued} queued, ${skipped} marked skipped, ${reopened} reopened`
        );
      }

      return { queued, skipped, reopened };
    } catch (error) {
      console.error(
        `🔸 ReconciliationSync: Error reconciling conversation enrichment backlog:`,
        error
      );
      return { queued: 0, skipped: 0, reopened: 0 };
    }
  }

  /**
   * Run the conversation backlog sweep for every guild this bot reconciles
   */
  private async reconcileConversationEnrichmentBacklog(): Promise<void> {
    if (config.guildId) {
      const targetGuild = this.client.guilds.cache.get(config.guildId);
      if (targetGuild) {
        await this.reconcileConversationEnrichment(targetGuild);
      }
      return;
    }
    for (const [, guild] of this.client.guilds.cache) {
      await this.reconcileConversationEnrichment(guild);
    }
  }

  /**
   * Reconcile user profiles (NEW)
   * Queues unenriched users for AI enrichment via enrichment pipeline
   */
  private async reconcileUserProfiles(
    guild: Guild,
    options: {
      dryRun?: boolean;
      minConversations?: number;
      maxUsers?: number;
    } = {}
  ): Promise<{ scanned: number; queued: number; skipped: number }> {
    const minConversations = options.minConversations || 5;
    const maxUsers = options.maxUsers || 20;
    const dryRun = options.dryRun || false;

    try {
      // Find users without summaries who have participated in conversations
      const usersResult = await this.db.query(
        `
        SELECT up.user_id, up.guild_id, COUNT(DISTINCT cs.id) as conversation_count
        FROM user_profiles up
        LEFT JOIN conversation_segments cs
          ON cs.guild_id = up.guild_id
          AND up.user_id = ANY(cs.participants)
          AND cs.status = 'finalized'
          AND cs.summary IS NOT NULL
        WHERE up.guild_id = $1
          AND (up.summary IS NULL OR LENGTH(TRIM(up.summary)) = 0)
        GROUP BY up.user_id, up.guild_id
        HAVING COUNT(DISTINCT cs.id) >= $2
        ORDER BY COUNT(DISTINCT cs.id) DESC
        LIMIT $3
        `,
        [guild.id, minConversations, maxUsers]
      );

      if (
        !usersResult.success ||
        !usersResult.data ||
        usersResult.data.length === 0
      ) {
        return { scanned: 0, queued: 0, skipped: 0 };
      }

      const users = usersResult.data;
      if (this.verbose || dryRun) {
        console.log(
          `   👤 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Queuing ${users.length} users for enrichment...`
        );
      }

      // Queue users via EnrichmentPipelineOrchestrator
      const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
      const queue = orchestrator.getQueue();
      let queued = 0;

      for (const user of users) {
        if (!dryRun) {
          queue.enqueue({
            layer: EnrichmentLayer.USER,
            entityId: user.user_id,
            guildId: user.guild_id,
            priority: 7, // High priority for initial healing
          });
        }
        queued++;
      }

      // Update stats
      if (!dryRun) {
        this.stats.usersQueued += queued;
      }

      if (this.verbose || dryRun) {
        console.log(
          `   🔹 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Queued ${queued} users (avg ${Math.round(users.reduce((sum: number, u: any) => sum + Number(u.conversation_count), 0) / users.length)} conversations per user)`
        );
      }

      return {
        scanned: users.length,
        queued: queued,
        skipped: 0,
      };
    } catch (error) {
      console.error(
        `🔸 ReconciliationSync: Error reconciling user profiles:`,
        error
      );
      return { scanned: 0, queued: 0, skipped: 0 };
    }
  }

  /**
   * Reconcile relationship profiles (NEW)
   * Generates relationship profiles from relationship_edges data
   */
  private async reconcileRelationshipProfiles(
    guild: Guild,
    options: {
      dryRun?: boolean;
      minInteractions?: number;
      maxRelationships?: number;
      requireUserProfiles?: boolean;
    } = {}
  ): Promise<{ scanned: number; queued: number; skipped: number }> {
    const minInteractions = options.minInteractions || 100;
    const maxRelationships = options.maxRelationships || 30;
    const requireUserProfiles = options.requireUserProfiles !== false; // default true
    const dryRun = options.dryRun || false;

    try {
      // Build user profile join requirement
      const profileCheckJoin = requireUserProfiles
        ? `INNER JOIN user_profiles up_a ON up_a.guild_id = re.guild_id AND up_a.user_id = re.user_a AND up_a.summary IS NOT NULL
           INNER JOIN user_profiles up_b ON up_b.guild_id = re.guild_id AND up_b.user_id = re.user_b AND up_b.summary IS NOT NULL`
        : "";

      // Find significant relationships without profiles.
      // relationship_edges rows are not stored in normalized order (and a pair can exist in
      // both orders), while relationship_profiles requires user_a < user_b, so aggregate
      // both orientations into one normalized pair before joining.
      const relationshipsResult = await this.db.query(
        `
        WITH pairs AS (
          SELECT guild_id,
                 LEAST(user_a, user_b) AS user_a,
                 GREATEST(user_a, user_b) AS user_b,
                 SUM(total)::int AS total
          FROM relationship_edges
          WHERE guild_id = $1 AND user_a <> user_b
          GROUP BY guild_id, LEAST(user_a, user_b), GREATEST(user_a, user_b)
          HAVING SUM(total) >= $2
        )
        SELECT re.guild_id, re.user_a, re.user_b, re.total,
               COUNT(DISTINCT cs.id) as shared_conversations
        FROM pairs re
        ${profileCheckJoin}
        LEFT JOIN relationship_profiles rp
          ON rp.guild_id = re.guild_id AND rp.user_a = re.user_a AND rp.user_b = re.user_b
        LEFT JOIN conversation_segments cs
          ON cs.guild_id = re.guild_id
          AND re.user_a = ANY(cs.participants)
          AND re.user_b = ANY(cs.participants)
          AND cs.status = 'finalized'
          AND cs.ai_processing_status = 'completed'
          AND cs.summary IS NOT NULL
        WHERE rp.guild_id IS NULL
        GROUP BY re.guild_id, re.user_a, re.user_b, re.total
        HAVING COUNT(DISTINCT cs.id) >= 3
        ORDER BY re.total DESC
        LIMIT $3
        `,
        [guild.id, minInteractions, maxRelationships]
      );

      if (
        !relationshipsResult.success ||
        !relationshipsResult.data ||
        relationshipsResult.data.length === 0
      ) {
        return { scanned: 0, queued: 0, skipped: 0 };
      }

      const relationships = relationshipsResult.data;
      if (this.verbose || dryRun) {
        console.log(
          `   🤝 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Queuing ${relationships.length} relationships for enrichment...`
        );
      }

      // Queue via EnrichmentPipelineOrchestrator
      const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
      const queue = orchestrator.getQueue();
      let queued = 0;

      for (const rel of relationships) {
        if (!dryRun) {
          queue.enqueue({
            layer: EnrichmentLayer.RELATIONSHIP,
            entityId: `${rel.user_a}:${rel.user_b}`,
            guildId: rel.guild_id,
            priority: 6, // Medium-high priority for initial healing
          });
        }
        queued++;
      }

      // Update stats
      if (!dryRun) {
        this.stats.relationshipsQueued += queued;
      }

      if (this.verbose || dryRun) {
        console.log(
          `   🔹 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Queued ${queued} relationships (avg ${Math.round(relationships.reduce((sum: number, r: any) => sum + Number(r.total), 0) / relationships.length)} interactions per pair)`
        );
      }

      return {
        scanned: relationships.length,
        queued: queued,
        skipped: 0,
      };
    } catch (error) {
      console.error(
        `🔸 ReconciliationSync: Error reconciling relationship profiles:`,
        error
      );
      return { scanned: 0, queued: 0, skipped: 0 };
    }
  }

  /**
   * Reconcile guild metadata (NEW)
   * Initializes guild_metadata and triggers enrichment
   */
  private async reconcileGuildMetadata(
    guild: Guild,
    options: {
      dryRun?: boolean;
      minRelationships?: number;
      minConversations?: number;
    } = {}
  ): Promise<{ initialized: boolean; queued: boolean; skipped: boolean }> {
    const minRelationships = options.minRelationships || 10;
    const minConversations = options.minConversations || 20;
    const dryRun = options.dryRun || false;

    try {
      // Check if metadata row exists
      const metadataExists = await this.db.query(
        `SELECT guild_id FROM guild_metadata WHERE guild_id = $1`,
        [guild.id]
      );

      let initialized = false;
      if (
        (!metadataExists.success ||
          !metadataExists.data ||
          metadataExists.data.length === 0) &&
        !dryRun
      ) {
        // Initialize metadata row if missing
        await this.db.query(
          `INSERT INTO guild_metadata (guild_id, community_clusters, influence_rankings, top_topics, enrichment_history)
           VALUES ($1, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)
           ON CONFLICT (guild_id) DO NOTHING`,
          [guild.id]
        );
        initialized = true;

        if (this.verbose) {
          console.log(
            `   🏛️ ReconciliationSync: Initialized guild_metadata for ${guild.name}`
          );
        }
      }

      // Check if guild has enough data for enrichment
      const dataCheck = await this.db.query(
        `SELECT
           (SELECT COUNT(*) FROM relationship_profiles WHERE guild_id = $1) as rel_count,
           (SELECT COUNT(*) FROM conversation_segments WHERE guild_id = $1 AND status = 'finalized') as conv_count`,
        [guild.id]
      );

      if (
        !dataCheck.success ||
        !dataCheck.data ||
        dataCheck.data.length === 0
      ) {
        return { initialized, queued: false, skipped: true };
      }

      const { rel_count, conv_count } = dataCheck.data[0];

      if (
        Number(rel_count) < minRelationships ||
        Number(conv_count) < minConversations
      ) {
        if (this.verbose || dryRun) {
          console.log(
            `   ⏭️ ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Skipping guild enrichment (${rel_count} relationships, ${conv_count} conversations - need ${minRelationships}/${minConversations})`
          );
        }
        return { initialized, queued: false, skipped: true };
      }

      // Queue for enrichment
      let queued = false;
      if (!dryRun) {
        const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
        const queue = orchestrator.getQueue();
        queue.enqueue({
          layer: EnrichmentLayer.SERVER,
          entityId: guild.id,
          guildId: guild.id,
          priority: 5, // Medium priority
        });
        queued = true;
        this.stats.guildsQueued += 1;
      } else {
        queued = true; // Would have queued
      }

      if (this.verbose || dryRun) {
        console.log(
          `   🔹 ReconciliationSync: ${dryRun ? "[DRY RUN] " : ""}Queued guild for enrichment (${rel_count} relationships, ${conv_count} conversations)`
        );
      }

      return { initialized, queued, skipped: false };
    } catch (error) {
      console.error(
        `🔸 ReconciliationSync: Error reconciling guild metadata:`,
        error
      );
      return { initialized: false, queued: false, skipped: true };
    }
  }

  /**
   * Run periodic maintenance tasks
   */
  async runMaintenance(): Promise<void> {
    await this.compactSegments();
    await this.updateRollingWindows();
    await this.consolidateOverlappingSegments();
    await this.reconcileConversationEnrichmentBacklog();
  }

  /**
   * Compact old conversation segments (delete old, large segments)
   */
  private async compactSegments(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    const result = await this.db.query(
      `DELETE FROM conversation_segments
			 WHERE start_time < $1
			 AND (SELECT COUNT(*) FROM unnest(participants) p) > 5`,
      [cutoffDate]
    );

    if (result.success && this.verbose) {
      const deleted = (result.data as any)?.rowCount || 0;
      if (deleted > 0) {
        console.log(`🔹 ReconciliationSync: Compacted ${deleted} old segments`);
      }
    }
  }

  /**
   * Update rolling windows for relationship edges
   */
  private async updateRollingWindows(): Promise<void> {
    const cutoff7d = new Date();
    cutoff7d.setDate(cutoff7d.getDate() - 7);

    const cutoff30d = new Date();
    cutoff30d.setDate(cutoff30d.getDate() - 30);

    if (config.guildId) {
      const targetGuild = this.client.guilds.cache.get(config.guildId);
      if (targetGuild) {
        await this.db.updateEdgeRollingWindows(
          targetGuild.id,
          cutoff7d,
          cutoff30d
        );
      }
    } else {
      for (const [, guild] of this.client.guilds.cache) {
        await this.db.updateEdgeRollingWindows(guild.id, cutoff7d, cutoff30d);
      }
    }
  }

  /**
   * Consolidate overlapping segments in the same channel
   */
  private async consolidateOverlappingSegments(): Promise<void> {
    try {
      const guildsToProcess = config.guildId
        ? (() => {
            const guild = this.client.guilds.cache.get(config.guildId!);
            return guild ? [guild] : [];
          })()
        : Array.from(this.client.guilds.cache.values());

      let consolidated = 0;

      for (const guild of guildsToProcess) {
        const segmentsResult = await this.db.query(
          `SELECT id, channel_id, participants, start_time, end_time, message_ids, message_count
					 FROM conversation_segments
					 WHERE guild_id = $1
					 ORDER BY channel_id, start_time ASC`,
          [guild.id]
        );

        if (!segmentsResult.success || !segmentsResult.data) continue;

        const segments = segmentsResult.data;
        const processed = new Set<string>();
        const toDelete = new Set<string>();

        for (let i = 0; i < segments.length; i++) {
          const seg1 = segments[i];
          if (processed.has(seg1.id) || toDelete.has(seg1.id)) continue;

          const seg1Participants = Array.isArray(seg1.participants)
            ? new Set(seg1.participants)
            : new Set();

          const seg1Start = new Date(seg1.start_time).getTime();
          const seg1End = new Date(seg1.end_time).getTime();
          const mergeWindow = 30 * 60 * 1000; // 30 minutes

          const toMerge: any[] = [seg1];

          for (let j = i + 1; j < segments.length; j++) {
            const seg2 = segments[j];
            if (seg1.channel_id !== seg2.channel_id) break;

            if (processed.has(seg2.id) || toDelete.has(seg2.id)) continue;

            const seg2Start = new Date(seg2.start_time).getTime();
            const seg2End = new Date(seg2.end_time).getTime();

            const timeGap = Math.min(
              Math.abs(seg2Start - seg1End),
              Math.abs(seg2End - seg1Start)
            );

            if (timeGap > mergeWindow) continue;

            const seg2Participants = Array.isArray(seg2.participants)
              ? new Set(seg2.participants)
              : new Set();

            const hasOverlap = Array.from(seg1Participants).some((p) =>
              seg2Participants.has(p)
            );

            if (hasOverlap) {
              toMerge.push(seg2);
            }
          }

          if (toMerge.length > 1) {
            const allParticipants = new Set<string>();
            const allMessageIds = new Set<string>();
            let earliestStart = Infinity;
            let latestEnd = -Infinity;

            for (const seg of toMerge) {
              const participants = Array.isArray(seg.participants)
                ? seg.participants
                : [];
              participants.forEach((p: string) => allParticipants.add(p));

              const msgIds = Array.isArray(seg.message_ids)
                ? seg.message_ids
                : [];
              msgIds.forEach((id: string) => allMessageIds.add(id));

              const start = new Date(seg.start_time).getTime();
              const end = new Date(seg.end_time).getTime();
              earliestStart = Math.min(earliestStart, start);
              latestEnd = Math.max(latestEnd, end);
            }

            const mergedParticipants = Array.from(allParticipants).sort();
            const mergedMessageIds = Array.from(allMessageIds);
            const keepId = toMerge[0].id;

            await this.db.query(
              `UPDATE conversation_segments
							 SET participants = $1::TEXT[],
									 message_ids = $2::TEXT[],
									 message_count = $3,
									 start_time = $4,
									 end_time = $5
							 WHERE id = $6`,
              [
                mergedParticipants,
                mergedMessageIds,
                mergedMessageIds.length,
                new Date(earliestStart),
                new Date(latestEnd),
                keepId,
              ]
            );

            for (let k = 1; k < toMerge.length; k++) {
              toDelete.add(toMerge[k].id);
              processed.add(toMerge[k].id);
            }

            consolidated += toMerge.length - 1;
            processed.add(keepId);
          } else {
            processed.add(seg1.id);
          }
        }

        if (toDelete.size > 0) {
          const deleteIds = Array.from(toDelete);
          await this.db.query(
            `DELETE FROM conversation_segments WHERE id = ANY($1::TEXT[])`,
            [deleteIds]
          );
        }
      }

      if (consolidated > 0 && this.verbose) {
        console.log(
          `🔹 ReconciliationSync: Consolidated ${consolidated} overlapping segments`
        );
      }
    } catch (error) {
      // Silent failure - consolidation is optional
    }
  }

  /**
   * Reconcile voice states (detect missing/stale states, fix discrepancies)
   */
  private async reconcileVoiceStates(guild: Guild): Promise<void> {
    if (this.verbose) {
      console.log(
        `🔹 ReconciliationSync: Reconciling voice states for ${guild.name}`
      );
    }

    // Get Discord truth
    const discordStates = new Map<string, string>(); // userId → channelId
    for (const [userId, voiceState] of guild.voiceStates.cache) {
      if (voiceState.channelId) {
        discordStates.set(userId, voiceState.channelId);
      }
    }

    // Get DB states
    const dbResult = await this.db.getActiveVoiceStates(guild.id);
    if (!dbResult.success) {
      console.error(
        `🔸 ReconciliationSync: Failed to get DB voice states for ${guild.name}:`,
        dbResult.error
      );
      return;
    }

    const dbStates = new Map<string, string>();
    for (const state of dbResult.data || []) {
      if (state.channel_id) {
        dbStates.set(state.user_id, state.channel_id);
      }
    }

    let fixedCount = 0;

    // Fix: In Discord but missing/wrong in DB
    for (const [userId, channelId] of discordStates) {
      if (!dbStates.has(userId) || dbStates.get(userId) !== channelId) {
        const key = `${userId}:${guild.id}`;
        const releaseLock = await this.coordinator.acquireVoiceStateLock(key);

        try {
          // Check if recently updated (skip if LiveEventSync just handled it)
          const recentCheck = await this.db.query(
            `SELECT updated_at FROM voice_sessions
             WHERE user_id = $1 AND guild_id = $2 AND active = true
             AND updated_at > NOW() - INTERVAL '5 minutes'`,
            [userId, guild.id]
          );

          if (recentCheck.success && recentCheck.data && recentCheck.data.length > 0) {
            continue; // Recently updated by LiveEventSync
          }

          // Create missing session
          const voiceState = guild.voiceStates.cache.get(userId);
          if (voiceState) {
            await this.createMissingVoiceSession(voiceState);
            fixedCount++;
          }
        } finally {
          releaseLock();
        }
      }
    }

    // Fix: In DB but not in Discord (stale)
    for (const [userId, _] of dbStates) {
      if (!discordStates.has(userId)) {
        const key = `${userId}:${guild.id}`;
        const releaseLock = await this.coordinator.acquireVoiceStateLock(key);

        try {
          // Finalize stale session
          await this.db.query(
            `UPDATE voice_sessions
             SET left_at = NOW(), active = false,
                 duration = EXTRACT(EPOCH FROM (NOW() - joined_at))::INTEGER
             WHERE user_id = $1 AND guild_id = $2 AND active = true`,
            [userId, guild.id]
          );

          // Delete stale state
          await this.db.deleteVoiceState(`${guild.id}_${userId}`);
          fixedCount++;
        } finally {
          releaseLock();
        }
      }
    }

    if (fixedCount > 0) {
      console.log(
        `🔹 Reconciliation: Fixed ${fixedCount} voice state discrepancies in ${guild.name}`
      );
    }
  }

  /**
   * Create a missing voice session during reconciliation
   */
  private async createMissingVoiceSession(voiceState: any): Promise<void> {
    const { v4: uuidv4 } = await import("uuid");

    const sessionId = uuidv4();
    const user = voiceState.member?.user;
    if (!user) return;

    // Create voice session
    await this.db.createVoiceSession({
      id: sessionId,
      guild_id: voiceState.guild.id,
      user_id: user.id,
      channel_id: voiceState.channelId,
      joined_at: new Date(),
      duration: 0,
      time_muted: 0,
      time_deafened: 0,
      time_streaming: 0,
      active: true,
      is_grandfathered: false,
      applied_moderation: {},
    });

    // Create voice state
    await this.db.upsertVoiceState({
      id: `${voiceState.guild.id}_${user.id}`,
      guild_id: voiceState.guild.id,
      user_id: user.id,
      channel_id: voiceState.channelId,
      session_id: sessionId,
      self_mute: voiceState.selfMute || false,
      self_deaf: voiceState.selfDeaf || false,
      server_mute: voiceState.mute || false,
      server_deaf: voiceState.deaf || false,
      streaming: voiceState.streaming || false,
      self_video: voiceState.selfVideo || false,
      joined_at: new Date(),
    });
  }

  /**
   * Get statistics
   */
  getStats(): {
    lastRunTime: Date | null;
    gapsDetected: number;
    messagesFilled: number;
    messageEmbeddingsGenerated: number;
    conversationEmbeddingsGenerated: number;
    usersQueued: number;
    relationshipsQueued: number;
    guildsQueued: number;
  } {
    return {
      lastRunTime: this.stats.lastRunTime,
      gapsDetected: this.stats.gapsDetected,
      messagesFilled: this.stats.messagesFilled,
      messageEmbeddingsGenerated: this.stats.messageEmbeddingsGenerated,
      conversationEmbeddingsGenerated: this.stats.conversationEmbeddingsGenerated,
      usersQueued: this.stats.usersQueued,
      relationshipsQueued: this.stats.relationshipsQueued,
      guildsQueued: this.stats.guildsQueued,
    };
  }
}
