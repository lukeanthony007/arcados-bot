import type { AIEngine } from "../../ai/core/AIEngine";
import { AIRequestBuilder } from "../../ai/core/AIRequestBuilder";
import type { AIContext } from "../../ai/core/AIContext";
import { enrichAIContext } from "../../ai/core/ContextEnricher";
import type { AIResponse } from "../../ai/providers/base/AIProvider";

/**
 * ChatAIManager - Domain-specific AI interface for chat interactions
 *
 * This manager handles all AI operations for Discord text chat.
 * It provides high-level methods that configure the AI engine appropriately
 * for chat use cases (bot mentions, message replies, slash commands).
 *
 * Responsibilities:
 * - Chat-specific AI configuration (persona, tools, prompts)
 * - Clean interface for MessageHandler
 *
 * NOT responsible for:
 * - Mention detection (stays in MessageHandler)
 * - Mention resolution (stays in MessageHandler)
 * - Message chunking (stays in MessageHandler)
 * - Sanitization (stays in MessageHandler)
 */
export class ChatAIManager {
	private engine: AIEngine;

	constructor(aiEngine: AIEngine) {
		this.engine = aiEngine;
	}

	/**
	 * Generate response for bot mention (no conversation history)
	 *
	 * Use this for:
	 * - First-time bot mentions
	 * - Standalone questions
	 * - Commands
	 *
	 * Configuration:
	 * - Persona: sophia (philosophical, analytical), or a member persona when personaPrompt is given
	 * - Mode: chat (concise, 3 iterations max)
	 * - Tools: user, relationship, conversation (dynamic based on prompt)
	 * - Formatting: disabled (plain text for Discord)
	 */
	async generateMentionResponse(
		prompt: string,
		context: AIContext,
		personaPrompt?: string
	): Promise<AIResponse> {
		const builder = new AIRequestBuilder(this.engine);

		const enrichedContext = await enrichAIContext(context, {}, { query: prompt });

		builder
			.chat()
			.blocking()
			.withContext(enrichedContext)
			.provider("grok")
			.persona("sophia");
		if (personaPrompt) {
			builder.customPersona(personaPrompt);
		}
		const result = await builder.generate(prompt);

		// Blocking mode always returns AIResponse
		if (typeof result === "object" && "success" in result) {
			return result as AIResponse;
		}

		// Fallback (shouldn't happen in blocking mode)
		return {
			success: false,
			content: "Unexpected response type",
		};
	}

	/**
	 * Generate response for message reply (with conversation history)
	 *
	 * Use this for:
	 * - Continuing a conversation
	 * - Replies to previous bot messages
	 * - Multi-turn interactions
	 *
	 * Configuration:
	 * - Same as generateMentionResponse
	 * - Includes conversation history from context
	 * - History limit: 12 messages (6 turns) for chat mode
	 */
	async generateReplyResponse(
		prompt: string,
		context: AIContext,
		history: Array<{ role: string; content: string }>,
		personaPrompt?: string
	): Promise<AIResponse> {
		const builder = new AIRequestBuilder(this.engine);

		const enrichedContext = await enrichAIContext(context, {}, { query: prompt });

		builder
			.chat()
			.blocking()
			.withContext(enrichedContext)
			.history(history)
			.provider("grok")
			.persona("sophia");
		if (personaPrompt) {
			builder.customPersona(personaPrompt);
		}
		const result = await builder.generate(prompt);

		// Blocking mode always returns AIResponse
		if (typeof result === "object" && "success" in result) {
			return result as AIResponse;
		}

		// Fallback (shouldn't happen in blocking mode)
		return {
			success: false,
			content: "Unexpected response type",
		};
	}

	/**
	 * Generate response with custom configuration
	 *
	 * Use this for:
	 * - Slash commands with specific requirements
	 * - Custom personas or modes
	 * - Special tool requirements
	 *
	 * This is a flexible method that allows full control over the builder.
	 */
	async generateCustomResponse(
		prompt: string,
		context: AIContext,
		configurator: (builder: AIRequestBuilder) => AIRequestBuilder
	): Promise<AIResponse> {
		const builder = new AIRequestBuilder(this.engine);

		// Apply custom configuration
		const configured = configurator(builder.withContext(context));

		const result = await configured.generate(prompt);

		// Blocking mode always returns AIResponse
		if (typeof result === "object" && "success" in result) {
			return result as AIResponse;
		}

		// Fallback (shouldn't happen in blocking mode)
		return {
			success: false,
			content: "Unexpected response type",
		};
	}
}
