import type { AIEngine, AIRequestConfig } from "./AIEngine";
import type { AIContext } from "./AIContext";
import { AIContextBuilder } from "./AIContext";
import type { AIResponse } from "../providers/base/AIProvider";
import type { ToolCategory } from "../tools/registry/DynamicToolRegistry";
import type { PostgreSQLManager } from "../../database/PostgreSQLManager";

/**
 * AIRequestBuilder - Fluent API for building AI requests
 *
 * Provides a clean, discoverable interface for configuring AI requests.
 * Uses builder pattern to make code more readable and maintainable.
 *
 * Usage:
 *   const response = await ai.chat()
 *     .user(userId)
 *     .guild(guildId)
 *     .history(messages)
 *     .provider('grok')
 *     .generate('who is @alex?');
 *
 *   const stream = await ai.voice()
 *     .streaming()
 *     .withContext(ctx)
 *     .generate('play arcade fire');
 */
export class AIRequestBuilder {
	private contextBuilder: AIContextBuilder;
	private config: Partial<AIRequestConfig> = {};
	private contextOverride?: AIContext;

	constructor(private engine: AIEngine) {
		this.contextBuilder = new AIContextBuilder();
	}

	// ==================== Context Builders ====================

	/**
	 * Use a pre-built AIContext
	 */
	withContext(context: AIContext): this {
		this.contextOverride = context;
		return this;
	}

	/**
	 * Set user ID
	 */
	user(userId: string): this {
		this.contextBuilder.user(userId);
		return this;
	}

	/**
	 * Set guild ID
	 */
	guild(guildId: string): this {
		this.contextBuilder.guild(guildId);
		return this;
	}

	/**
	 * Set channel ID
	 */
	channel(channelId: string): this {
		this.contextBuilder.channel(channelId);
		return this;
	}

	/**
	 * Set message ID
	 */
	message(messageId: string): this {
		this.contextBuilder.message(messageId);
		return this;
	}

	/**
	 * Set conversation history
	 */
	history(msgs: Array<{ role: string; content: string }>): this {
		this.contextBuilder.withHistory(msgs);
		return this;
	}

	/**
	 * Set database instance
	 */
	database(db: PostgreSQLManager): this {
		this.contextBuilder.withDatabase(db);
		return this;
	}

	/**
	 * Set session ID
	 */
	session(sessionId: string): this {
		this.contextBuilder.session(sessionId);
		return this;
	}

	// ==================== Config Builders ====================

	/**
	 * Set provider (grok, openai, gemini, ollama)
	 */
	provider(name: string): this {
		this.config.provider = name;
		return this;
	}

	/**
	 * Set persona key (sophia, casual)
	 */
	persona(key: string): this {
		this.config.personaKey = key;
		return this;
	}

	/**
	 * Set communication mode (yin/yang)
	 */
	communicationMode(mode: "yin" | "yang"): this {
		this.contextBuilder.communicationMode(mode);
		return this;
	}

	/**
	 * Set conversation mode (chat, structured)
	 */
	mode(mode: "chat" | "structured"): this {
		this.config.mode = mode;
		return this;
	}

	/**
	 * Enable streaming (returns AsyncIterable<string>)
	 */
	streaming(): this {
		this.config.streaming = true;
		return this;
	}

	/**
	 * Disable streaming (returns AIResponse) - this is the default
	 */
	blocking(): this {
		this.config.streaming = false;
		return this;
	}

	/**
	 * Set custom method prompt
	 */
	methodPrompt(prompt: string): this {
		this.config.methodPrompt = prompt;
		return this;
	}

	/**
	 * Set max tokens
	 */
	maxTokens(tokens: number): this {
		this.config.maxTokens = tokens;
		return this;
	}

	/**
	 * Set temperature
	 */
	temperature(temp: number): this {
		this.config.temperature = temp;
		return this;
	}

	/**
	 * Set maximum tool iterations for the execution loop
	 */
	maxToolIterations(iterations: number): this {
		this.config.maxToolIterations = iterations;
		return this;
	}

	/**
	 * Bound aggregate UTF-8 tool-result content bytes sent to the provider.
	 * Names and call IDs are preserved outside this budget.
	 */
	maxToolContextBytes(bytes: number): this {
		this.config.maxToolContextBytes = bytes;
		return this;
	}

	/**
	 * Set maximum number of history messages to include
	 */
	maxHistoryMessages(count: number): this {
		this.config.maxHistoryMessages = count;
		return this;
	}

	/**
	 * Enable Discord formatting
	 */
	discordFormatting(enabled = true): this {
		this.config.useDiscordFormatting = enabled;
		return this;
	}

	// ==================== Tool Builders ====================

	/**
	 * Explicitly load specific tool categories
	 */
	withTools(...categories: ToolCategory[]): this {
		if (!this.config.tools) {
			this.config.tools = {};
		}
		this.config.tools.explicit = categories;
		return this;
	}

	/**
	 * Disable all tools
	 */
	withoutTools(): this {
		if (!this.config.tools) {
			this.config.tools = {};
		}
		this.config.tools.disabled = true;
		return this;
	}

	// ==================== Domain Presets ====================

	/**
	 * Configure for chat domain
	 * - Mode: chat
	 * - Persona: sophia
	 * - Tools: user, relationship, conversation (dynamic)
	 * - Formatting: disabled
	 * - Web search: opt-in only (enabled only if query contains "search", "look up", etc.)
	 */
	chat(): this {
		this.mode("chat");
		this.persona("sophia");
		this.discordFormatting(false);
		this.contextBuilder.domain("chat");
		// Web search is opt-in only - enabled only if user explicitly requests it
		return this;
	}

	/**
	 * Disable web search for this request
	 * Useful for social-intelligence queries that should use database tools only
	 */
	noWebSearch(): this {
		this.config.enableWebSearch = false;
		this.config.enableXSearch = false;
		return this;
	}

	/**
	 * Enable web search for this request (default: true)
	 * Useful when you explicitly want web search despite social query detection
	 */
	withWebSearch(): this {
		this.config.enableWebSearch = true;
		this.config.enableXSearch = true;
		return this;
	}

	/**
	 * Configure for voice domain
	 * - Mode: chat
	 * - Persona: casual
	 * - Tools: media, voice (dynamic)
	 * - Formatting: disabled
	 * - Method prompt: voice-optimized
	 */
	voice(): this {
		this.mode("chat");
		this.persona("casual");
		this.discordFormatting(false);
		this.contextBuilder.domain("voice");
		this.methodPrompt(
			`You control the built-in media player for this Discord server.

Play & queue requests:
- When the user asks to play, queue, or put on music/audio, you MUST call the playMedia tool with their query.
- Do NOT respond with bot commands like "m!p ..." or instructions to use another bot.
- Do NOT describe that you are calling tools or the media player.

Voice control:
- For pause/resume/skip/stop/volume, use the appropriate voice/media tools when available.

Response style:
- When you successfully trigger media playback or control, you should not send any spoken explanation – an empty or minimal response is ideal, because the audio itself is the response.`
		);
		return this;
	}

	/**
	 * Configure for voice streaming
	 * - Same as voice(), but with streaming enabled
	 * - Method prompt: paragraph-based
	 */
	voiceStream(): this {
		this.voice();
		this.streaming();
		this.methodPrompt("Streaming voice. Separate paragraphs with \\n.");
		return this;
	}

	// ==================== Execution ====================

	/**
	 * Generate response with the configured options
	 */
	async generate(
		prompt: string
	): Promise<AIResponse | AsyncIterable<string>> {
		// Build context (use override if provided, otherwise build from builder)
		const context = this.contextOverride || this.contextBuilder.build();

		// Ensure provider is set
		if (!this.config.provider) {
			throw new Error("Provider is required. Call .provider('grok') before .generate()");
		}

		// Build final config
		const finalConfig: AIRequestConfig = {
			provider: this.config.provider,
			personaKey: this.config.personaKey,
			mode: this.config.mode,
			streaming: this.config.streaming,
			methodPrompt: this.config.methodPrompt,
			tools: this.config.tools,
			useDiscordFormatting: this.config.useDiscordFormatting,
			maxTokens: this.config.maxTokens,
			temperature: this.config.temperature,
			maxToolIterations: this.config.maxToolIterations,
			maxToolContextBytes: this.config.maxToolContextBytes,
			maxHistoryMessages: this.config.maxHistoryMessages,
		};

		// Call engine
		return this.engine.generate(prompt, context, finalConfig);
	}
}
