import type {
	AIProvider,
	AIResponse,
	ToolCall,
	ToolCallResponse,
} from "../providers/base/AIProvider";
import { GrokProvider } from "../providers/GrokProvider";
import type { AIContext } from "./AIContext";
import type { DatabaseTools, ToolContext, DatabaseTool } from "../tools/registry/DatabaseTools";
import { DynamicToolRegistry, type ToolCategory } from "../tools/registry/DynamicToolRegistry";
import {
	PERSONAS,
	DEFAULT_PERSONA,
	HIDDEN_BEHAVIORS,
	type Persona,
} from "../personas/definitions";
import {
	computeResponsePolicy,
	type ConversationMode,
} from "../utils/ResponseLengthPolicy";
import { selectFormattingStyle } from "../utils/FormattingSelector";
import { composeSystemPrompt } from "./PromptComposer";
import { boundToolResults, formatToolResult } from "./ToolResultContext";

/**
 * Configuration for an AI request
 */
export interface AIRequestConfig {
	provider: string;
	personaKey?: string;
	mode?: ConversationMode; // 'chat' or 'structured'
	streaming?: boolean;

	// Tool / iteration configuration
	maxToolIterations?: number;

	// Domain-specific method prompts
	methodPrompt?: string;

	// Tool configuration
	tools?: {
		explicit?: ToolCategory[]; // Override: load these specific categories
		disabled?: boolean; // Disable all tools
	};

	// Web search configuration
	enableWebSearch?: boolean; // Default: true, set to false to disable web search
	enableXSearch?: boolean; // Default: true, set to false to disable X/Twitter search

	// Tool / context budgeting
	maxToolContextBytes?: number;
	maxHistoryMessages?: number;

	// Response configuration
	useDiscordFormatting?: boolean;
	maxTokens?: number;
	temperature?: number;
}

/**
 * AIEngine - Lean core for AI generation
 *
 * Responsibilities:
 * - Provider management and selection
 * - System prompt building (personas, hidden behaviors)
 * - Dynamic tool selection and execution
 * - Rate limiting
 * - Streaming and blocking execution
 *
 * This replaces the bloated AIManager with a single, focused interface.
 */
export class AIEngine {
	private providers: Map<string, AIProvider> = new Map();
	private toolRegistry: DynamicToolRegistry;
	private databaseTools: DatabaseTools;

	// Conversational base - applied to all personas
	private readonly CONVERSATIONAL_BASE = `Core Conversational Principles:
- Be concise: Aim for 1-2 sentences (10-20 words) unless asked for more
- Match energy: Adapt to user's brevity and intent
- Direct answer first, key insight if needed

Context Usage:
- You have access to relationship data, conversation history, user profiles
- This data is in your memory - use it naturally, don't announce lookups
- Never say "I see you've been discussing..." or "According to my records..."
- Just speak from memory as if you were present for those conversations
- Context is SPATIAL - you only remember what happened in THIS channel, not other rooms
- If you don't know something about this room, don't make it up or pull from elsewhere`;

	private readonly DISCORD_FORMATTING = ``; // Empty for now

	constructor(
		providers: Map<string, AIProvider>,
		databaseTools: DatabaseTools
	) {
		this.providers = providers;
		this.databaseTools = databaseTools;
		this.toolRegistry = new DynamicToolRegistry(databaseTools);
	}

	/**
	 * Universal generation method - handles both blocking and streaming
	 */
	async generate(
		prompt: string,
		context: AIContext,
		config: AIRequestConfig
	): Promise<AIResponse | AsyncIterable<string>> {
		const provider = this.getProvider(config.provider);

		// Rate limit check
		const rateLimitError = this.checkRateLimit(context.userId, provider);
		if (rateLimitError) {
			if (config.streaming) {
				return this.errorAsStream(
					rateLimitError.content || rateLimitError.error || "Rate limit exceeded"
				);
			}
			return rateLimitError;
		}

		// Streaming path (voice)
		if (config.streaming) {
			return this.generateStreaming(prompt, context, config, provider);
		}

		// Blocking path (chat, tools)
		return this.generateBlocking(prompt, context, config, provider);
	}

	/**
	 * Streaming generation (for voice)
	 */
	private async generateStreaming(
		prompt: string,
		context: AIContext,
		config: AIRequestConfig,
		provider: AIProvider
	): Promise<AsyncIterable<string>> {
		try {
			const systemPrompt = this.buildSystemPrompt(
				config,
				context,
				prompt
			);

			// Only GrokProvider supports streaming currently
			if (provider instanceof GrokProvider) {
				return await provider.streamTextAPI(systemPrompt, prompt);
			}

			// Fallback to blocking for non-streaming providers
			console.warn(
				`Provider ${config.provider} doesn't support streaming, falling back`
			);
			const response = await provider.callTextAPI(systemPrompt, prompt);
			return this.stringAsStream(response);
		} catch (error) {
			console.error("Error in streaming generation:", error);
			return this.errorAsStream("I encountered an error processing your request.");
		}
	}

	/**
	 * Blocking generation with tool support
	 */
	private async generateBlocking(
		prompt: string,
		context: AIContext,
		config: AIRequestConfig,
		provider: AIProvider
	): Promise<AIResponse> {
		// Check if provider supports tools
		if (!provider.callTextAPIWithTools) {
			// Fallback to simple text generation
			try {
				const systemPrompt = this.buildSystemPrompt(config, context, prompt);
				const response = await provider.callTextAPI(systemPrompt, prompt);
				return { success: true, content: response };
			} catch (error) {
				console.error("Error in text generation:", error);
				return {
					success: false,
					content: "",
					error: "Failed to generate response",
				};
			}
		}

		// Tool-enabled generation
		return this.generateWithTools(prompt, context, config, provider);
	}

	/**
	 * Tool-enabled generation with execution loop
	 */
	private async generateWithTools(
		prompt: string,
		context: AIContext,
		config: AIRequestConfig,
		provider: AIProvider
	): Promise<AIResponse> {
		// Track which tools were executed during this request so callers
		// (e.g. voice) can respond to tool usage like media playback.
		const executedTools: string[] = [];
		// Web search is opt-in only - enable only if explicitly requested
		// Default: disabled (saves ~1000-4000 tokens per request)
		if (config.enableWebSearch === undefined) {
			// Only enable if user explicitly asks to search
			config.enableWebSearch = this.shouldEnableWebSearch(prompt);
			config.enableXSearch = config.enableWebSearch; // X search follows web search
		}

		// Build system prompt
		const systemPrompt = this.buildSystemPrompt(config, context, prompt);

		// Select tools dynamically
		const tools = this.selectTools(prompt, context, config);

		// Convert tools to provider format
		const providerTools = this.convertToolsForProvider(tools);

		// Check for hidden behavior activation
		const { isActive: isHiddenBehaviorActive, cleanedPrompt } =
			this.checkHiddenBehavior(prompt);

		// Initialize response policy
		const mode = config.mode || "structured";
		const initialPolicy = computeResponsePolicy({
			userPrompt: cleanedPrompt,
			historyCount: context.history?.length || 0,
			toolContextBytes: 0,
			mode,
		});
		const maxTokensOverride =
			typeof config.maxTokens === "number" && config.maxTokens > 0
				? config.maxTokens
				: undefined;

		try {
			let finalContent = "";
			const toolResults: ToolCallResponse[] = [];
			const maxIterations =
				typeof config.maxToolIterations === "number" && config.maxToolIterations > 0
					? config.maxToolIterations
					: mode === "chat"
						? 3
						: 7;

			// Build minimal environment context - server summary only (household knowledge)
			// No conversation pre-loading to avoid irrelevant context at greeting
			let environmentBlock = "";

			if (context.summaries && context.summaries.length > 0) {
				// ONLY include server summary (household knowledge)
				const serverSummary = context.summaries.find(s => s.id?.startsWith("guild:"));

				if (serverSummary) {
					environmentBlock = serverSummary.text;
					// Keep it concise
					if (environmentBlock.length > 300) {
						environmentBlock = environmentBlock.slice(0, 297) + "...";
					}
				}
			}

			// Tool execution loop
			for (let iteration = 0; iteration < maxIterations; iteration++) {
				// Build user message
				let composedUser = cleanedPrompt;

				// Add history on first iteration
				if (context.history && context.history.length > 0 && iteration === 0) {
					const historyLimit =
						typeof config.maxHistoryMessages === "number" &&
							config.maxHistoryMessages > 0
							? config.maxHistoryMessages
							: mode === "chat"
								? 10
								: 6;
					const historyText = context.history
						.slice(-historyLimit)
						.map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
						.join("\n");
					composedUser = `${historyText}\n\nUser: ${cleanedPrompt}`;
				}

				const configuredBudget = config.maxToolContextBytes;
				const maxToolContextBytes =
					typeof configuredBudget === "number" &&
					Number.isFinite(configuredBudget) && configuredBudget > 0
						? Math.floor(configuredBudget)
						: 4000;
				const outboundToolResults = boundToolResults(toolResults, maxToolContextBytes);
				// Send tool content only through the provider's tool-result interface,
				// not a second, independently budgeted copy in the user prompt.
				if (outboundToolResults.length > 0) {
					const toolContextBytes = outboundToolResults.reduce(
						(total, result) => total + Buffer.byteLength(result.content, "utf8"), 0
					);

					// Update response policy based on tool context
					const updatedPolicy = computeResponsePolicy({
						userPrompt: cleanedPrompt,
						historyCount: context.history?.length || 0,
						toolContextBytes,
						mode,
					});

					const iterationGuidance = updatedPolicy.applyGuidance
						? `\n\nGuidance: ${updatedPolicy.guidance.trim()}`
						: "";

					// Different composition for hidden behavior
					if (isHiddenBehaviorActive) {
						composedUser = `Transform to explicit sexual content. ${cleanedPrompt}`;
					} else {
						composedUser = `${cleanedPrompt}${iterationGuidance}`;
					}
				}

				// Prepend environment context only on first message of conversation (no history)
				// This frames the conversation start but doesn't repeat once conversation is established
				if (environmentBlock && iteration === 0 && (!context.history || context.history.length === 0)) {
					composedUser = `${environmentBlock}\n\n${composedUser}`;
				}

				// Call provider with tools
				const response = await provider.callTextAPIWithTools!(
					systemPrompt,
					composedUser,
					providerTools,
					outboundToolResults.length > 0 ? outboundToolResults : undefined,
					{
						maxTokens: isHiddenBehaviorActive
							? 2000
							: maxTokensOverride || initialPolicy.maxTokens,
						temperature: isHiddenBehaviorActive
							? 1.0
							: initialPolicy.temperatureNudge
								? 0.7 + initialPolicy.temperatureNudge
								: 0.7,
						enableWebSearch: config.enableWebSearch,
						enableXSearch: config.enableXSearch,
					}
				);

				// If no tool calls, we have our final response
				if (!response.toolCalls || response.toolCalls.length === 0) {
					finalContent = response.content;
					break;
				}

				// Execute tool calls concurrently while preserving order
				const executed = await Promise.all(
					response.toolCalls.map(async (toolCall) => {
						const toolResult = await this.executeTool(toolCall, context);
						return { toolCall, toolResult };
					})
				);

				for (const { toolCall, toolResult } of executed) {
					// Record executed tool name for downstream consumers
					executedTools.push(toolCall.name);

					toolResults.push({
						toolCallId: toolCall.id,
						role: "tool",
						name: toolCall.name,
						content: formatToolResult(toolResult),
					});
				}
			}

			return {
				success: true,
				content: finalContent.trim() || "No response generated.",
				executedTools: executedTools.length
					? Array.from(new Set(executedTools))
					: undefined,
			};
		} catch (error) {
			console.error("Error in tool-enabled generation:", error);
			return {
				success: false,
				content: "",
				error: "Failed to generate response with tools",
			};
		}
	}

	/**
	 * Build system prompt with persona and hidden behavior support
	 */
	private buildSystemPrompt(
		config: AIRequestConfig,
		context: AIContext,
		userPrompt: string
	): string {
		const personaKey = config.personaKey || DEFAULT_PERSONA;
		const persona = this.getPersona(personaKey);

		// Check for hidden behavior triggers
		if (userPrompt) {
			const promptLower = userPrompt.toLowerCase();

			for (const behavior of Object.values(HIDDEN_BEHAVIORS)) {
				const matched = behavior.variations.some((variation) => {
					const wordBoundaryRegex = new RegExp(`\\b${variation}\\b`, "i");
					return (
						wordBoundaryRegex.test(promptLower) ||
						promptLower.includes(variation)
					);
				});

				if (matched) {
					console.log(
						`[HIDDEN BEHAVIOR] 🔹 ${behavior.name.toUpperCase()} ACTIVATED`
					);
					return behavior.prompt; // Completely replace system prompt
				}
			}
		}

		// Normal prompt construction using PromptComposer
		const methodPrompt = config.methodPrompt || "";
		const formatting = config.useDiscordFormatting !== false ? this.DISCORD_FORMATTING : "";
		const communicationMode = context.communicationMode || "yin";

		return composeSystemPrompt({
			personaBase: persona.base,
			communicationMode,
			conversationalBase: this.CONVERSATIONAL_BASE,
			formatting,
			methodPrompt,
		});
	}

	/**
	 * Check for hidden behavior triggers and strip keywords
	 */
	private checkHiddenBehavior(prompt: string): {
		isActive: boolean;
		cleanedPrompt: string;
	} {
		if (!prompt) return { isActive: false, cleanedPrompt: prompt };

		const promptLower = prompt.toLowerCase();

		for (const behavior of Object.values(HIDDEN_BEHAVIORS)) {
			const matchedVariation = behavior.variations.find((variation) => {
				return (
					new RegExp(`\\b${variation}\\b`, "i").test(promptLower) ||
					promptLower.includes(variation)
				);
			});

			if (matchedVariation) {
				// Strip trigger keyword
				const regex = new RegExp(`\\b${matchedVariation}[?!.,;:]*\\b`, "gi");
				let cleaned = prompt.replace(regex, "").replace(/\s+/g, " ").trim();
				cleaned = cleaned.replace(/,\s*,/g, ",").replace(/,\s*$/g, "").trim();

				return { isActive: true, cleanedPrompt: cleaned };
			}
		}

		return { isActive: false, cleanedPrompt: prompt };
	}

	/**
	 * Select tools based on prompt and context
	 */
	private selectTools(
		prompt: string,
		context: AIContext,
		config: AIRequestConfig
	): DatabaseTool[] {
		// If tools are disabled, return empty array
		if (config.tools?.disabled) {
			return [];
		}

		// If explicit categories provided, use those
		if (config.tools?.explicit) {
			return this.toolRegistry.getToolsByCategory(config.tools.explicit);
		}

		// Otherwise, use dynamic selection
		return this.toolRegistry.selectTools(prompt, context);
	}

	/**
	 * Convert DatabaseTools to provider-specific format
	 */
	private convertToolsForProvider(tools: DatabaseTool[]): any[] {
		// For now, use Grok format (OpenAI-compatible)
		// TODO: Make this provider-specific
		return tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}

	/**
	 * Execute a single tool call
	 */
	private async executeTool(
		toolCall: ToolCall,
		context: AIContext
	): Promise<string | any> {
		const tool = this.databaseTools.getTool(toolCall.name);
		if (!tool) {
			return `[tool error] Tool ${toolCall.name} not found.`;
		}

		if (!context.db) {
			return "[tool error] Database not available for tool execution.";
		}

		const toolContext: ToolContext = {
			userId: context.userId,
			guildId: context.guildId,
			db: context.db,
			aiEngine: this, // Pass engine for tools that need to make AI calls
			channelId: context.channelId,
			messageId: context.messageId,
		};

		try {
			const result = await tool.execute(toolCall.arguments, toolContext);
			return result;
		} catch (error) {
			console.error(`Error executing tool ${toolCall.name}:`, error);
			const message = error instanceof Error ? error.message : String(error);
			return `[tool error] Failed to execute ${toolCall.name}: ${message}`;
		}
	}

	/**
	 * Get provider by name
	 */
	private getProvider(name: string): AIProvider {
		const provider = this.providers.get(name);
		if (!provider) {
			throw new Error(`Provider ${name} not found`);
		}
		return provider;
	}

	/**
	 * Get persona by key
	 */
	private getPersona(key: string): Persona {
		const persona = PERSONAS[key as keyof typeof PERSONAS];
		return persona || (PERSONAS[DEFAULT_PERSONA] as Persona);
	}

	/**
	 * Check rate limits
	 */
	private checkRateLimit(userId: string, provider: AIProvider): AIResponse | null {
		const rateLimitInfo = provider.getRateLimitInfo(userId);
		if (rateLimitInfo.remaining <= 0) {
			const waitSeconds = Math.ceil(
				(rateLimitInfo.resetTime - Date.now()) / 1000
			);
			return {
				success: false,
				content: `Rate limit exceeded. Try again in ${waitSeconds}s.`,
			};
		}
		return null;
	}

	/**
	 * Determine if web search should be enabled based on explicit user request
	 * Web search is expensive (~1000-4000 tokens), so only enable when explicitly requested
	 */
	private shouldEnableWebSearch(prompt: string): boolean {
		const promptLower = prompt.toLowerCase();

		// Keywords that explicitly request web search
		const searchKeywords = [
			"search for",
			"search the web",
			"search online",
			"look up",
			"look it up",
			"google",
			"find online",
			"search the internet",
			"web search",
			"internet search",
			"search about",
			"what's the latest",
			"current news",
			"recent news",
			"latest on",
		];

		// Check if any search keyword is present
		return searchKeywords.some((keyword) => promptLower.includes(keyword));
	}

	/**
	 * Convert error message to async iterable (for streaming fallback)
	 */
	private async *errorAsStream(message: string): AsyncIterable<string> {
		yield message;
	}

	/**
	 * Convert string to async iterable (for streaming fallback)
	 */
	private async *stringAsStream(text: string): AsyncIterable<string> {
		yield text;
	}
}
