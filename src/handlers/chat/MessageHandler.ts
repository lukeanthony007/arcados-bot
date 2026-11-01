/**
 * MessageHandler
 *
 * Handles all Discord message events for the AI assistant feature.
 * Manages bot mentions, chat sessions, and message responses.
 */

import type { Client, Message } from "discord.js";
import { ChannelType } from "discord.js";
import type { PostgreSQLManager } from "../../database/PostgreSQLManager";
import { ChatAIManager } from "./ChatAIManager";
import { AIContextBuilder } from "../../ai/core/AIContext";
import {
  getSessionByRepliedMessageId,
  appendUserTurn,
  appendAssistantTurnAndTrackMessage,
  getSessionHistory,
  startSession,
} from "../../ai/core/ChatSessionManager";
import { resolveMentionsInText } from "../../ai/utils/MentionResolver";
import { VoiceAssistantManager } from "../voice/VoiceAssistantManager";
import { AIFactory } from "../../ai/core/AIFactory";
import type { AIEngine } from "../../ai/core/AIEngine";
import { detectModeFromMessage, stripModeKeywords } from "../../ai/personas/modes";
import { buildPersonaPrompt } from "../../features/user-personas/personaPrompt";

export class MessageHandler {
  private client: Client;
  private db: PostgreSQLManager;
  private provider: string;
  private chatAI: ChatAIManager | null = null;
  private enginePromise: Promise<AIEngine> | null = null;
  
  // Deduplication: track recently processed messages to prevent duplicate responses
  private recentMessageIds: Set<string> = new Set();
  private readonly MESSAGE_DEDUP_WINDOW = 5000; // 5 seconds

  constructor(client: Client, db: PostgreSQLManager, provider = "grok") {
    this.client = client;
    this.db = db;
    this.provider = provider;

    // Lazy initialization of AI engine to avoid segfaults in test environments
  }

  private async getChatAI(): Promise<ChatAIManager> {
    if (this.chatAI) {
      return this.chatAI;
    }
    if (!this.enginePromise) {
      this.enginePromise = AIFactory.create().then(({ engine }) => engine);
    }
    const engine = await this.enginePromise;
    this.chatAI = new ChatAIManager(engine);
    return this.chatAI;
  }

  /**
   * Handle incoming Discord messages
   */
  async handleMessage(message: Message): Promise<void> {
    try {
      // Ignore bot messages and DMs
      if (message.author.bot || !message.guildId) {
        return;
      }

      // Deduplication: prevent processing the same message twice
      if (this.recentMessageIds.has(message.id)) {
        console.log(`[MessageHandler] Skipping duplicate message ${message.id}`);
        return;
      }
      
      // Add to deduplication set
      this.recentMessageIds.add(message.id);
      
      // Clean up old message IDs periodically
      if (this.recentMessageIds.size > 1000) {
        // Keep only the most recent 500 IDs (simple cleanup)
        const ids = Array.from(this.recentMessageIds);
        this.recentMessageIds = new Set(ids.slice(-500));
      }
      
      // Remove message ID after dedup window expires
      setTimeout(() => {
        this.recentMessageIds.delete(message.id);
      }, this.MESSAGE_DEDUP_WINDOW);

      const botUserId = this.client.user?.id;
      if (!botUserId) {
        console.log("🔸 Bot user ID not available yet");
        return;
      }

      // Check if bot is mentioned (not a reply)
      const isBotMentioned = this.isBotMentioned(message, botUserId);

      if (isBotMentioned) {
        await this.handleBotMention(message, botUserId);
        return;
      }

      // Check for stream selection first (even if not a reply)
      // Only match single digits or small numbers (1-99) to avoid matching Discord IDs
      const rawContent = message.content.trim();
      const numberMatch = rawContent.match(/^\s*(\d{1,2})\s*$/);
      if (numberMatch && numberMatch[1]) {
        const selectionNumber = parseInt(numberMatch[1], 10);
        // Only process if it's a reasonable selection number (1-20)
        if (selectionNumber < 1 || selectionNumber > 20) {
          console.log(`[MessageHandler] Number ${selectionNumber} is out of range for selection, ignoring`);
        } else {
          console.log(`[MessageHandler] Detected number-only message: ${selectionNumber}`);

          try {
            const { StreamPlayerManager } = await import("../../features/stream-chrome/StreamPlayerManager");
            const streamManager = StreamPlayerManager.getInstance();
            const activeSession = streamManager.getActiveSession(message.guildId!);

            console.log(`[MessageHandler] Active session check:`, {
              hasActiveSession: !!activeSession,
              sessionState: activeSession?.state,
              hasPendingResults: !!(activeSession as any)?.pendingSearchResults,
              guildId: activeSession?.guildId,
              messageGuildId: message.guildId,
              query: activeSession?.query,
            });

            if (activeSession &&
              activeSession.state === "searching" &&
              (activeSession as any).pendingSearchResults) {
              console.log(`[MessageHandler] Processing stream selection ${selectionNumber} for guild ${message.guildId}`);
              const result = await streamManager.streamWithSelection(
                message.guildId!,
                selectionNumber
              );

              console.log(`[MessageHandler] streamWithSelection result:`, {
                success: result.success,
                message: result.message,
                error: result.error,
              });

              if (result.success) {
                await message.reply(result.message);
                return;
              } else {
                await message.reply(result.message || result.error || "Failed to process selection");
                return;
              }
            } else {
              console.log(`[MessageHandler] No active stream session waiting for selection`, {
                hasSession: !!activeSession,
                state: activeSession?.state,
                hasPending: !!(activeSession as any)?.pendingSearchResults,
              });
            }
          } catch (error) {
            console.error("[MessageHandler] Error checking stream selection:", error);
          }
        } // Close the selectionNumber range check
      }

      // Handle chat session continuation (replies to bot messages)
      const refId = message.reference?.messageId;
      if (refId) {
        await this.handleSessionContinuation(message, refId);
      }
    } catch (err) {
      // Log errors but don't send to channel to avoid spam
      console.error("🔸 Error in message handler:", err);
    }
  }

  /**
   * Check if the bot is mentioned in a message (excluding replies)
   */
  private isBotMentioned(message: Message, botUserId: string): boolean {
    // Check both mentions.users and message content for mention patterns
    const isBotMentionedInUsers = message.mentions.users.has(botUserId);
    const mentionPattern = new RegExp(`<@!?${botUserId}>`);
    const isBotMentionedInContent = mentionPattern.test(message.content);

    // Only consider it a mention if it's not a reply
    return (
      (isBotMentionedInUsers || isBotMentionedInContent) && !message.reference
    );
  }

  /**
   * Handle bot mention - start a new conversation
   */
  private async handleBotMention(
    message: Message,
    botUserId: string
  ): Promise<void> {
    // Extract message content without the mention
    let userContent = message.content
      .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
      .trim();

    // If empty after removing mention, use a default prompt
    if (!userContent) {
      userContent = "Hello!";
    }

    // Check for voice commands first (before AI processing)
    const voiceCommandHandled = await this.handleVoiceCommand(message, userContent);
    if (voiceCommandHandled) {
      return; // Voice command was handled, don't process with AI
    }

    // Detect and strip yin/yang mode keywords
    const detectedMode = detectModeFromMessage(userContent);
    userContent = stripModeKeywords(userContent);

    // Map self-referential queries to explicit self-mention
    userContent = this.mapSelfReferentialQuery(userContent, message.author.id);

    // For AI, keep the raw content (with <@id> intact) so tools can extract IDs reliably
    const rawForAI = userContent;

    // Optionally resolve mentions for display/session context only
    let resolvedContent = userContent;
    if (this.db.isConnected()) {
      try {
        resolvedContent = await resolveMentionsInText(
          userContent,
          message.guildId!,
          this.db
        );
      } catch (err) {
        console.error("🔸 Error resolving mentions:", err);
      }
    }

    // Build AIContext from message with communication mode
    const contextBuilder = new AIContextBuilder()
      .guild(message.guildId!)
      .user(message.author.id)
      .channel(message.channel.id)
      .message(message.id)
      .domain("chat")
      .withDatabase(this.db);

    if (detectedMode) {
      contextBuilder.communicationMode(detectedMode);
    }

    const context = contextBuilder.build();

    const chatAI = await this.getChatAI();
    const contentResponse = await chatAI.generateMentionResponse(
      rawForAI,
      context,
      await this.getActivePersonaPrompt(message.guildId!)
    );

    if (!contentResponse?.success || !contentResponse.content) {
      console.error(
        "🔸 Failed to generate response for bot mention:",
        contentResponse?.error
      );
      return;
    }

    // Check if stream tools were executed - if so, skip sending response
    const executedTools = contentResponse.executedTools || [];
    const streamTools = new Set([
      "streamContent",
      "selectStreamResult",
      "stopStream",
      "searchYouTube",
      "searchJellyfin",
    ]);
    if (executedTools.some((name) => streamTools.has(name))) {
      console.log(
        `[MessageHandler] Stream tools executed (${executedTools.join(
          ", "
        )}), skipping response.`
      );
      return;
    }

    // Send response using chunking (handles long responses automatically)
    const { message: reply, sentText } = await this.sendChunked(
      message,
      contentResponse.content
    );

    // Start a new chat session, storing exactly what was sent
    startSession({
      initialBotMessage: reply,
      userId: message.author.id,
      initialUserMessage: resolvedContent,
      initialAssistantMessage: sentText,
    });
  }

  /**
   * Handle continuation of existing chat session
   */
  private async handleSessionContinuation(
    message: Message,
    refId: string
  ): Promise<void> {
    console.log(`[MessageHandler] handleSessionContinuation called: refId=${refId}, content="${message.content}"`);

    const found = getSessionByRepliedMessageId(refId);
    if (!found) {
      console.log(`[MessageHandler] No session found for refId ${refId}`);
      return;
    }

    // Ignore replies with no meaningful text
    const rawReplyText = (message.content || "").trim();
    if (!rawReplyText) {
      console.log("[MessageHandler] Empty reply text");
      return;
    }

    const textWithoutUserMentions = rawReplyText.replace(/<@!?\d+>/g, "");
    if (textWithoutUserMentions.trim().length === 0) {
      console.log("[MessageHandler] Reply text empty after removing mentions");
      return;
    }

    // Detect and strip yin/yang mode keywords
    const detectedMode = detectModeFromMessage(message.content);
    let contentToProcess = stripModeKeywords(message.content);

    // Resolve mentions in user message
    let resolvedContent = contentToProcess;
    resolvedContent = this.mapSelfReferentialQuery(
      resolvedContent,
      message.author.id
    );

    const rawForAI = resolvedContent; // keep raw (with <@id>) for AI

    if (this.db.isConnected()) {
      try {
        resolvedContent = await resolveMentionsInText(
          contentToProcess,
          message.guildId!,
          this.db
        );
      } catch (err) {
        console.error("🔸 Error resolving mentions in reply:", err);
      }
    }

    // Check if this is a stream selection (user replied with just a number)
    // This is a fallback check in case the main handler didn't catch it
    // Only match single digits or small numbers (1-99) to avoid matching Discord IDs
    console.log(`[MessageHandler] handleSessionContinuation: Raw reply text: "${rawReplyText}"`);
    const numberMatch = rawReplyText.match(/^\s*(\d{1,2})\s*$/);
    if (numberMatch && numberMatch[1]) {
      const selectionNumber = parseInt(numberMatch[1], 10);
      // Only process if it's a reasonable selection number (1-20)
      if (selectionNumber < 1 || selectionNumber > 20) {
        console.log(`[MessageHandler] handleSessionContinuation: Number ${selectionNumber} is out of range, ignoring`);
        // Continue with normal AI processing
      } else {
        console.log(`[MessageHandler] handleSessionContinuation: Detected potential stream selection: ${selectionNumber}`);

        try {
          const { StreamPlayerManager } = await import("../../features/stream-chrome/StreamPlayerManager");
          const streamManager = StreamPlayerManager.getInstance();
          const activeSession = streamManager.getActiveSession(message.guildId!);

          console.log(`[MessageHandler] handleSessionContinuation: Active session check:`, {
            hasActiveSession: !!activeSession,
            sessionState: activeSession?.state,
            hasPendingResults: !!(activeSession as any)?.pendingSearchResults,
            guildId: activeSession?.guildId,
            messageGuildId: message.guildId,
            query: activeSession?.query,
          });

          if (activeSession &&
            activeSession.state === "searching" &&
            (activeSession as any).pendingSearchResults) {
            console.log(`[MessageHandler] handleSessionContinuation: Processing stream selection ${selectionNumber}`);
            const result = await streamManager.streamWithSelection(
              message.guildId!,
              selectionNumber
            );

            console.log(`[MessageHandler] handleSessionContinuation: streamWithSelection result:`, {
              success: result.success,
              message: result.message,
              error: result.error,
            });

            if (result.success) {
              await message.reply(result.message);
              return;
            } else {
              await message.reply(result.message || result.error || "Failed to process selection");
              return;
            }
          }
        } catch (error) {
          console.error("[MessageHandler] handleSessionContinuation: Error processing stream selection:", error);
        }
      } // Close the selectionNumber range check
    }

    // Get session history for context
    const history = getSessionHistory(found.sessionId);

    // Convert history format
    const historyFormatted = history.map((msg) => ({
      role: msg.role === "user" ? "user" : "assistant",
      content: msg.content,
    }));

    // Build AIContext from message with communication mode
    const contextBuilder = new AIContextBuilder()
      .guild(message.guildId!)
      .user(message.author.id)
      .channel(message.channel.id)
      .message(message.id)
      .domain("chat")
      .withDatabase(this.db)
      .withHistory(historyFormatted);

    if (detectedMode) {
      contextBuilder.communicationMode(detectedMode);
    }

    const context = contextBuilder.build();

    const chatAI = await this.getChatAI();
    const contentResponse = await chatAI.generateReplyResponse(
      rawForAI,
      context,
      historyFormatted,
      await this.getActivePersonaPrompt(message.guildId!)
    );

    if (!contentResponse?.success || !contentResponse.content) {
      return;
    }

    // Check if stream tools were executed - if so, skip sending response
    const executedTools = contentResponse.executedTools || [];
    const streamTools = new Set([
      "streamContent",
      "selectStreamResult",
      "stopStream",
      "searchYouTube",
      "searchJellyfin",
    ]);
    if (executedTools.some((name) => streamTools.has(name))) {
      console.log(
        `[MessageHandler] Stream tools executed (${executedTools.join(
          ", "
        )}), skipping response.`
      );
      // Still append user's turn to session for history
      appendUserTurn(found.sessionId, resolvedContent);
      return;
    }

    // Append user's turn to session (store resolved version)
    appendUserTurn(found.sessionId, resolvedContent);

    // Send response using chunking
    const { message: reply, sentText } = await this.sendChunked(
      message,
      contentResponse.content
    );

    // Store exactly what was sent in session history
    appendAssistantTurnAndTrackMessage(found.sessionId, reply, sentText);
  }

  /**
   * System persona for the member persona active in this guild (set via /persona change), if any
   */
  private async getActivePersonaPrompt(guildId: string): Promise<string | undefined> {
    if (!this.db.isConnected()) return undefined;
    const active = await this.db.getActivePersona(guildId);
    return active.success && active.data ? buildPersonaPrompt(active.data) : undefined;
  }

  /**
   * Map self-referential queries to explicit user mentions
   */
  private mapSelfReferentialQuery(content: string, userId: string): string {
    const selfQueryRegex =
      /(who\s+am\s+i\b|whoami\b|tell\s+me\s+about\s+me\b|what\s+do\s+you\s+know\s+about\s+me\b|who\s+is\s+me\b)/i;

    if (selfQueryRegex.test(content)) {
      return `tell me about <@${userId}>`;
    }

    return content;
  }

  /**
   * Split and send long messages safely under Discord's 2000-char limit
   */
  private async sendChunked(
    message: Message,
    text: string
  ): Promise<{ message: any; sentText: string }> {
    const limit = 1900; // leave headroom for safety
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > limit) {
      // Try to split on paragraph, sentence, or newline boundaries
      let idx = Math.max(
        remaining.lastIndexOf("\n\n", limit),
        remaining.lastIndexOf("\n", limit),
        remaining.lastIndexOf(". ", limit)
      );

      if (idx < limit * 0.6) {
        idx = limit; // fallback to hard split
      }

      chunks.push(remaining.slice(0, idx).trim());
      remaining = remaining.slice(idx).trimStart();
    }

    if (remaining.length) {
      chunks.push(remaining);
    }

    let lastMessage = message as any;
    const sentParts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;

      try {
        if (i === 0) {
          // First chunk: reply to the user's message to start the thread
          lastMessage = await lastMessage.reply({
            content: this.sanitizeEveryone(chunk),
            allowedMentions: {
              parse: ["users", "roles"],
              repliedUser: false,
            },
          });
        } else {
          // Subsequent chunks: send to channel to avoid stale message_reference errors
          lastMessage = await (message.channel as any).send({
            content: this.sanitizeEveryone(chunk),
            allowedMentions: {
              parse: ["users", "roles"],
              repliedUser: false,
            },
          });
        }
      } catch (err: any) {
        // Fallback: if replying failed, send to channel
        lastMessage = await (message.channel as any).send({
          content: this.sanitizeEveryone(chunk),
          allowedMentions: {
            parse: ["users", "roles"],
            repliedUser: false,
          },
        });
      }

      sentParts.push(
        (lastMessage as any).content || this.sanitizeEveryone(chunk)
      );
    }

    return { message: lastMessage, sentText: sentParts.join("\n\n") };
  }

  /**
   * Prevent mass-mention pings from bot output
   */
  private sanitizeEveryone(input: string | undefined | null): string {
    if (!input) return "";
    return input.replace(/@everyone/gi, "@\u200Beveryone");
  }

  /**
   * Handle voice-related commands (join/leave vc)
   * Returns true if a voice command was handled
   */
  private async handleVoiceCommand(message: Message, content: string): Promise<boolean> {
    const lowerContent = content.toLowerCase();

    // Patterns for join voice commands
    const joinPatterns = [
      /\b(join|come to|get in|hop in|enter)\s+(vc|voice|voice channel)\b/i,
      /\b(join|come)\s+(my|the)?\s*(vc|voice|voice channel)\b/i,
    ];

    // Patterns for leave voice commands
    const leavePatterns = [
      /\b(leave|disconnect|exit|quit)\s+(vc|voice|voice channel)\b/i,
      /\b(leave|disconnect|exit|quit)\s+(the)?\s*(vc|voice|voice channel)\b/i,
      /\b(go away|bye)\b/i,
    ];

    // Check for join command
    const isJoinCommand = joinPatterns.some((pattern) => pattern.test(lowerContent));
    if (isJoinCommand) {
      await this.handleJoinVoiceCommand(message);
      return true;
    }

    // Check for leave command
    const isLeaveCommand = leavePatterns.some((pattern) => pattern.test(lowerContent));
    if (isLeaveCommand) {
      await this.handleLeaveVoiceCommand(message);
      return true;
    }

    return false; // No voice command detected
  }

  /**
   * Handle join voice channel command
   */
  private async handleJoinVoiceCommand(message: Message): Promise<void> {
    try {
      const voiceAssistant = VoiceAssistantManager.getInstance();

      // Check if voice assistant is enabled
      if (!voiceAssistant.isEnabled()) {
        await message.reply(
          "Voice assistant is not configured. Please contact the bot administrator."
        );
        return;
      }

      // Check if user is in a voice channel
      const member = message.guild?.members.cache.get(message.author.id);
      if (!member?.voice.channel) {
        await message.reply("You need to be in a voice channel first!");
        return;
      }

      const voiceChannel = member.voice.channel;

      // Check if it's a voice channel (not stage)
      if (voiceChannel.type !== ChannelType.GuildVoice) {
        await message.reply("I can only join regular voice channels.");
        return;
      }

      // Check if bot has permissions
      const permissions = voiceChannel.permissionsFor(this.client.user!);
      if (!permissions?.has("Connect") || !permissions?.has("Speak")) {
        await message.reply(
          "I don't have permission to join or speak in that voice channel!"
        );
        return;
      }

      // Join the voice channel
      await voiceAssistant.joinVoiceChannel(voiceChannel, message.author.id);

      await message.reply(
        `Joined ${voiceChannel.name}! Say "Aria" followed by your question to talk to me.`
      );
    } catch (error) {
      console.error("[MessageHandler] Error joining voice:", error);
      await message.reply(
        `Failed to join voice channel: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Handle leave voice channel command
   */
  private async handleLeaveVoiceCommand(message: Message): Promise<void> {
    try {
      const voiceAssistant = VoiceAssistantManager.getInstance();

      // Check if guild exists
      if (!message.guildId) {
        await message.reply("This command can only be used in a server!");
        return;
      }

      // Check if bot is in a voice channel
      if (!voiceAssistant.isInVoiceChannel(message.guildId)) {
        await message.reply("I'm not in a voice channel!");
        return;
      }

      // Get session info for response
      const session = voiceAssistant.getSession(message.guildId);
      const channelName = session?.channel.name || "voice channel";

      // Leave the voice channel
      await voiceAssistant.leaveVoiceChannel(message.guildId);

      await message.reply(`Left ${channelName}. Thanks for chatting!`);
    } catch (error) {
      console.error("[MessageHandler] Error leaving voice:", error);
      await message.reply(
        `Failed to leave voice channel: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
}
