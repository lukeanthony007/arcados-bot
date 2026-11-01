/**
 * Bot
 *
 * Main bot coordinator that initializes features and manages lifecycle.
 * Delegates feature-specific logic to appropriate handlers.
 */

import { PostgreSQLManager } from "./database/PostgreSQLManager";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import type { Interaction, VoiceState, VoiceChannel } from "discord.js";
import { config } from "./config";
import type { Command } from "./types";
import { CommandDeployer } from "./utils/CommandDeployer";
import { ConversationWorkflowManager } from "./features/social-intelligence";
import { MessageHandler } from "./handlers/chat";
import { VoiceAssistantManager } from "./handlers/voice/VoiceAssistantManager";
import { MediaPlayerManager } from "./features/media-player/MediaPlayerManager";
import { VoiceConnectionManager } from "./handlers/voice/tts/services/VoiceConnectionManager";
import { APICostTracker } from "./utils/APICostTracker";
import { VoiceStateCoordinator } from "./features/voice-state/VoiceStateCoordinator";
import { SyncCoordinator } from "./features/discord-sync/SyncCoordinator";
import { DeletedMessageLogger } from "./utils/DeletedMessageLogger";
import { UserPersonaService } from "./features/user-personas/UserPersonaService";

export class Bot {
  public client: Client;
  public commands = new Collection<string, Command>();
  private db: PostgreSQLManager;

  // Feature coordinators
  private conversationWorkflow?: ConversationWorkflowManager;
  private messageHandler?: MessageHandler;
  private commandDeployer?: CommandDeployer;
  private voiceAssistant?: VoiceAssistantManager;
  public voiceStateCoordinator?: VoiceStateCoordinator; // Public for slash commands
  private syncCoordinator?: SyncCoordinator;

  // Track if event handlers are already set up
  private eventHandlersSetup = false;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.db = new PostgreSQLManager();
  }

  /**
   * Initialize the bot and all features
   */
  async init(): Promise<void> {

    // Initialize API cost tracker (must be done early)
    const costTracker = APICostTracker.getInstance();

    // Connect to database
    const dbConnected = await this.db.connect();
    if (dbConnected) {

      // Initialize enrichment pipeline
      try {
        const { EnrichmentPipelineOrchestrator } = await import(
          "./features/social-intelligence/enrichment-pipeline/EnrichmentPipelineOrchestrator"
        );
        const { EnrichmentScheduler } = await import(
          "./features/social-intelligence/enrichment-pipeline/EnrichmentScheduler"
        );
        const { AIFactory } = await import("./ai/core/AIFactory");

        const { engine } = await AIFactory.create();
        const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
        await orchestrator.initialize(this.db, engine);

        // Start scheduler
        const scheduler = EnrichmentScheduler.getInstance();
        await scheduler.start();

      } catch (error) {
        console.error("🔸 Error initializing enrichment pipeline:", error);
      }
    } else {
      console.error("❌ Failed to connect to database");
    }

    // Set up event handlers
    this.setupEventHandlers();

    // Login to Discord
    await this.client.login(config.botToken);

    // Deploy commands (with retry)
    await this.deployCommands();
  }

  /**
   * Set up Discord event handlers
   */
  private setupEventHandlers(): void {
    // Prevent duplicate event handler registration
    if (this.eventHandlersSetup) {
      console.log("🔸 Event handlers already set up, skipping");
      return;
    }

    // Ready event - initialize all features
    this.client.once("ready", async () => {
      await this.initializeFeatures();
    });

    // Slash command interactions
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      // Handle button interactions for media player
      if (interaction.isButton() && interaction.customId.startsWith("media_")) {
        await this.handleMediaButton(interaction);
        return;
      }

      await this.handleInteraction(interaction);
    });

    // Message events (for AI assistant)
    this.client.on("messageCreate", async (message) => {
      await this.messageHandler?.handleMessage(message);
    });

    // Message deletion tracking
    this.client.on("messageDelete", async (message) => {
      // Only log messages with content (ignore system messages, embeds, etc.)
      if (!message.content && message.attachments.size === 0) {
        return;
      }

      const deletedLogger = DeletedMessageLogger.getInstance();
      deletedLogger.logDeletedMessage({
        messageId: message.id,
        content: message.content || "",
        sender: {
          id: message.author?.id || "unknown",
          username: message.author?.username || "unknown",
          displayName: message.author?.displayName || message.author?.username || "unknown",
        },
        channel: {
          id: message.channel.id,
          name: "name" in message.channel ? (message.channel.name || "unknown") : "DM",
        },
        timestamp: message.createdAt.toISOString(),
        deletedAt: new Date().toISOString(),
        attachments: Array.from(message.attachments.values()).map((att) => ({
          url: att.url,
          filename: att.name || "unknown",
          size: att.size,
          contentType: att.contentType || undefined,
        })),
      });
    });

    // Voice state updates
    this.client.on(
      "voiceStateUpdate",
      async (oldState: VoiceState, newState: VoiceState) => {
        // Delegate to VoiceStateCoordinator first (spawn channels, session tracking)
        if (this.voiceStateCoordinator) {
          try {
            await this.voiceStateCoordinator.handleStateUpdate(oldState, newState);
          } catch (error) {
            console.error("🔸 VoiceStateCoordinator error:", error);
          }
        }

        // Then handle bot auto-disconnect
        await this.handleVoiceStateUpdate(oldState, newState);
      }
    );

    // Channel updates (sync Discord UI changes to preferences)
    this.client.on(
      "channelUpdate",
      async (oldChannel, newChannel) => {
        if (this.voiceStateCoordinator && oldChannel.isVoiceBased() && newChannel.isVoiceBased()) {
          try {
            await this.voiceStateCoordinator.handleChannelUpdate(
              oldChannel as VoiceChannel,
              newChannel as VoiceChannel
            );
          } catch (error) {
            console.error("🔸 Channel update handling error:", error);
          }
        }
      }
    );

    this.eventHandlersSetup = true;
  }

  /**
   * Initialize all feature services
   */
  private async initializeFeatures(): Promise<void> {
    // Initialize conversation detection workflow
    this.conversationWorkflow = new ConversationWorkflowManager(
      this.client,
      this.db,
      {
        guildId: config.guildId,
        verbose: false,
      }
    );
    await this.conversationWorkflow.start();

    // Initialize message handler
    this.messageHandler = new MessageHandler(this.client, this.db);

    // Member personas (/persona init|change|clear); commands reach it through the client
    Object.assign(this.client, {
      userPersonas: new UserPersonaService(
        this.db,
        this.conversationWorkflow.getRelationshipMapper()!
      ),
    });

    // Initialize voice assistant
    this.voiceAssistant = VoiceAssistantManager.getInstance();
    await this.voiceAssistant.initialize(this.client, this.db);

    // Initialize voice state coordinator
    if (config.spawnChannelId) {
      this.syncCoordinator = new SyncCoordinator(this.db, false);
      this.voiceStateCoordinator = new VoiceStateCoordinator(
        this.client,
        this.db,
        this.syncCoordinator,
        config.spawnChannelId,
        config.botOwnerId
      );
      (this.client as any).voiceStateCoordinator = this.voiceStateCoordinator;
    }

    // Initialize media player
    const mediaPlayer = MediaPlayerManager.getInstance();
    mediaPlayer.initialize(this.client);

  }

  /**
   * Handle media player button interactions
   */
  private async handleMediaButton(interaction: any): Promise<void> {
    if (!interaction.guildId || !interaction.channel) {
      return;
    }

    try {
      const mediaPlayer = MediaPlayerManager.getInstance();

      // For queue button, we need to reply ephemerally, so don't defer
      if (interaction.customId === "media_queue") {
        await mediaPlayer.handleButtonInteraction(
          interaction.guildId,
          interaction.customId,
          interaction.channel,
          interaction
        );
        return; // Don't defer update for queue button
      }

      await mediaPlayer.handleButtonInteraction(
        interaction.guildId,
        interaction.customId,
        interaction.channel,
        interaction
      );

      // Acknowledge interaction
      await interaction.deferUpdate().catch(() => {
        // Ignore if already acknowledged
      });
    } catch (error) {
      console.error("[Bot] Error handling media button:", error);
      try {
        await interaction.reply({
          content: "An error occurred while handling that action.",
          ephemeral: true,
        });
      } catch {
        // Ignore if interaction already handled
      }
    }
  }

  /**
   * Handle slash command interactions
   */
  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = this.commands.get(interaction.commandName);
    if (!command) {
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(
        `🔸 Error executing command ${interaction.commandName}:`,
        error
      );

      const errorMessage = "There was an error while executing this command!";

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: errorMessage,
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: errorMessage,
            ephemeral: true,
          });
        }
      } catch (err) {
        // If sending the error message fails, just log it
        console.error("🔸 Failed to send error message to interaction:", err);
      }
    }
  }

  /**
   * Deploy commands to Discord
   */
  private async deployCommands(): Promise<void> {
    const appId = this.client.application?.id;
    if (!appId) {
      throw new Error(
        "Application ID is missing. Make sure the client is fully logged in."
      );
    }

    this.commandDeployer = new CommandDeployer(config.botToken, this.commands);
    await this.commandDeployer.deploy(appId, config.guildId);
  }

  /**
   * Handle voice state updates - disconnect if everyone leaves
   */
  private async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState
  ): Promise<void> {
    // Only check when someone leaves a channel (not when they join or switch)
    if (!oldState.channelId) {
      return; // User wasn't in a channel before
    }

    // Check if bot is connected to this channel
    const connectionManager = VoiceConnectionManager.getInstance();
    const session = connectionManager.getSession(oldState.guild.id);

    if (!session || session.channelId !== oldState.channelId) {
      return; // Bot is not connected to this channel
    }

    // Fetch the channel to get current member count
    const channel = await oldState.guild.channels.fetch(oldState.channelId);
    if (!channel || !channel.isVoiceBased()) {
      return;
    }

    // Count members in the channel (excluding the bot)
    const botId = this.client.user?.id;
    const memberCount = channel.members.filter(
      (member) => member.id !== botId
    ).size;

    // If no other members remain, disconnect
    if (memberCount === 0) {
      console.log(
        `🔹 Everyone left voice channel ${channel.name} in ${oldState.guild.name}, disconnecting bot`
      );

      // Disconnect voice assistant
      if (this.voiceAssistant?.isInVoiceChannel(oldState.guild.id)) {
        try {
          await this.voiceAssistant.leaveVoiceChannel(oldState.guild.id);
        } catch (error) {
          console.error(`🔸 Error disconnecting voice assistant:`, error);
        }
      }

      // Stop and disconnect media player
      const mediaPlayer = MediaPlayerManager.getInstance();
      try {
        await mediaPlayer.stop(oldState.guild.id);
        // Also disconnect the connection if media player was using it
        if (connectionManager.isConnected(oldState.guild.id)) {
          await connectionManager.leaveChannel(oldState.guild.id);
        }
      } catch (error) {
        console.error(`🔸 Error stopping media player:`, error);
      }
    }
  }

  /**
   * Gracefully shutdown the bot and all features
   */
  async shutdown(): Promise<void> {
    // Flush API cost tracking data
    try {
      const costTracker = APICostTracker.getInstance();
      await costTracker.shutdown();
    } catch (error) {
      console.error("🔸 Error flushing cost tracking:", error);
    }

    // Stop conversation workflow (handles conversation finalization + cleanup)
    if (this.conversationWorkflow) {
      await this.conversationWorkflow.stop();
    }

    // Shutdown stream player
    // const streamPlayer = StreamPlayerManager.getInstance();
    // await streamPlayer.shutdown();

    // Cleanup voice assistant (stops Whisper server)
    if (this.voiceAssistant) {
      await this.voiceAssistant.cleanup();
    }

    // Destroy Discord client
    this.client.destroy();

    // Disconnect from database
    if (this.db.isConnected()) {
      await this.db.disconnect();
    }

    console.log("🔹 Bot shutdown complete");
  }
}
