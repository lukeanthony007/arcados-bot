import type { AIEngine } from "../../ai/core/AIEngine";
import { AIRequestBuilder } from "../../ai/core/AIRequestBuilder";
import type { AIContext } from "../../ai/core/AIContext";
import type { AIResponse } from "../../ai/providers/base/AIProvider";

const RAIA_RUNTIME_URL = process.env.RAIA_RUNTIME_URL?.replace(/\/+$/, "") || "";

/**
 * VoiceAIManager - Domain-specific AI interface for voice interactions
 *
 * This manager handles all AI operations for the voice assistant.
 * It provides high-level methods that configure the AI engine appropriately
 * for voice use cases (command mode, conversation mode, streaming).
 *
 * Responsibilities:
 * - Voice-specific AI configuration (persona, tools, prompts)
 * - Clean interface for VoiceAssistantManager
 *
 * NOT responsible for:
 * - Trigger word detection (stays in VoiceAssistantManager)
 * - Transcription filtering (stays in VoiceAssistantManager)
 * - TTS pipeline (stays in VoiceAssistantManager)
 * - Audio processing (stays in VoiceAssistantManager)
 */
export class VoiceAIManager {
	private engine: AIEngine;

	constructor(aiEngine: AIEngine) {
		this.engine = aiEngine;
	}

	private useRaiaRuntime(): boolean {
		return RAIA_RUNTIME_URL.length > 0;
	}

	private async callRaiaBlocking(
		query: string,
		context: AIContext
	): Promise<AIResponse> {
		const response = await fetch(`${RAIA_RUNTIME_URL}/api/cycle/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: query,
				sessionId: `discord-${context.userId}`,
				history: context.history || [],
			}),
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			return {
				success: false,
				content: "",
				error: `Runtime HTTP ${response.status}: ${text || response.statusText}`,
			};
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let finalContent = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				const event = JSON.parse(line) as Record<string, any>;
				if (event.type === "done") {
					finalContent = String(event.data?.response ?? "");
				} else if (event.type === "error") {
					return {
						success: false,
						content: "",
						error: String(event.message ?? "Runtime stream failed"),
					};
				}
			}
		}

		return {
			success: true,
			content: finalContent,
		};
	}

	private async *callRaiaStreaming(
		query: string,
		context: AIContext
	): AsyncIterable<string> {
		const response = await fetch(`${RAIA_RUNTIME_URL}/api/cycle/stream`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				input: query,
				sessionId: `discord-${context.userId}`,
				history: context.history || [],
			}),
		});

		if (!response.ok || !response.body) {
			const text = await response.text().catch(() => "");
			throw new Error(`Runtime HTTP ${response.status}: ${text || response.statusText}`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let sawText = false;
		let finalContent = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				const event = JSON.parse(line) as Record<string, any>;
				if (event.type === "text") {
					const chunk = String(event.text ?? "");
					if (chunk) {
						sawText = true;
						yield chunk;
					}
				} else if (event.type === "done") {
					finalContent = String(event.data?.response ?? "");
				} else if (event.type === "error") {
					throw new Error(String(event.message ?? "Runtime stream failed"));
				}
			}
		}

		if (!sawText && finalContent) {
			yield finalContent;
		}
	}

	/**
	 * Generate response for command mode (blocking)
	 *
	 * Use this for:
	 * - Single utterance commands ("what's the weather?")
	 * - Music requests ("play arcade fire")
	 * - Quick queries
	 *
	 * Configuration:
	 * - Persona: casual
	 * - Mode: chat (concise, 3 iterations max)
	 * - Tools: media, voice (dynamic based on prompt)
	 * - Formatting: disabled (optimized for TTS)
	 */
	async generateCommandResponse(
		query: string,
		context: AIContext
	): Promise<AIResponse> {
		if (this.useRaiaRuntime()) {
			return this.callRaiaBlocking(query, context);
		}

		const builder = new AIRequestBuilder(this.engine);

		const result = await builder
			.voice()
			.blocking()
			.withContext(context)
			.provider("grok")
			.generate(query);

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
	 * Stream response for conversation mode (low-latency)
	 *
	 * Use this for:
	 * - Multi-turn conversations
	 * - Long-form responses
	 * - Real-time playback during generation
	 *
	 * Configuration:
	 * - Persona: casual
	 * - Mode: chat
	 * - Tools: media, voice (dynamic)
	 * - Streaming: enabled
	 * - Formatting: paragraph-based (separated with \n)
	 */
	async streamConversationResponse(
		query: string,
		context: AIContext
	): Promise<AsyncIterable<string>> {
		if (this.useRaiaRuntime()) {
			return this.callRaiaStreaming(query, context);
		}

		const builder = new AIRequestBuilder(this.engine);

		const result = await builder
			.voiceStream()
			.withContext(context)
			.provider("grok")
			.generate(query);

		// Streaming mode returns AsyncIterable<string>
		if (result && typeof result === "object" && Symbol.asyncIterator in result) {
			return result as AsyncIterable<string>;
		}

		// Fallback: convert AIResponse to async iterable
		if (typeof result === "object" && "content" in result) {
			const response = result as AIResponse;
			return (async function* () {
				yield response.content || "";
			})();
		}

		// Final fallback
		return (async function* () {
			yield "";
		})();
	}

	/**
	 * Generate response for conversation mode (blocking, with history)
	 *
	 * Use this for:
	 * - Multi-turn conversations where streaming isn't needed
	 * - When you need to wait for the full response
	 *
	 * Configuration:
	 * - Same as streamConversationResponse, but blocking
	 * - Includes conversation history from context
	 */
	async generateConversationResponse(
		query: string,
		context: AIContext
	): Promise<AIResponse> {
		if (this.useRaiaRuntime()) {
			return this.callRaiaBlocking(query, context);
		}

		const builder = new AIRequestBuilder(this.engine);

		const result = await builder
			.voice()
			.blocking()
			.withContext(context)
			.history(context.history || [])
			.provider("grok")
			.generate(query);

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
