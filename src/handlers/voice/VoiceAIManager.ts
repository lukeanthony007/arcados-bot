import { getServerSummaryPreface } from "../../ai/context/serverSummary";
import { buildSystemPrompt } from "../../ai/personas/systemPrompt";
import {
	type AIResponse,
	type ChatMessage,
	OmpRuntime,
	type StreamHandle,
	type ToolAccess,
} from "../../ai/runtime/OmpRuntime";
import type { PostgreSQLManager } from "../../database/PostgreSQLManager";

/** Voice media-control instructions (formerly AIRequestBuilder.voice()) */
const VOICE_METHOD_PROMPT = `You control the built-in media player for this Discord server.

Play & queue requests:
- When the user asks to play, queue, or put on music/audio, you MUST call the playMedia tool with their query.
- Do NOT respond with bot commands like "m!p ..." or instructions to use another bot.
- Do NOT describe that you are calling tools or the media player.

Voice control:
- For pause/resume/skip/stop/volume, use the appropriate voice/media tools when available.

Response style:
- When you successfully trigger media playback or control, you should not send any spoken explanation – an empty or minimal response is ideal, because the audio itself is the response.`;

const VOICE_SYSTEM_PROMPT = buildSystemPrompt({
	persona: "casual",
	methodPrompt: VOICE_METHOD_PROMPT,
});

const VOICE_STREAM_SYSTEM_PROMPT = buildSystemPrompt({
	persona: "casual",
	methodPrompt: `${VOICE_METHOD_PROMPT}\n\nStreaming voice. Separate paragraphs with \\n.`,
});

/** Per-request voice scope. `db` is absent when PostgreSQL is unavailable: then no tools are offered. */
export interface VoiceAIContext {
	userId: string;
	guildId: string;
	channelId?: string;
	db?: PostgreSQLManager;
	history?: Array<{ role: string; content: string }>;
}

export interface VoiceRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** `result` is absent on the RAIA path, which reports no tool usage */
export type VoiceTokenStream = Pick<StreamHandle, "tokens"> & Partial<Pick<StreamHandle, "result">>;

function toChatHistory(history: VoiceAIContext["history"]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const message of history ?? []) {
		if (message.role === "user" || message.role === "assistant") {
			messages.push({ role: message.role, content: message.content });
		}
	}
	return messages;
}

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
	private useRaiaRuntime(): boolean {
		return RAIA_RUNTIME_URL.length > 0;
	}

	private async callRaiaBlocking(
		query: string,
		context: VoiceAIContext
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

	/** The RAIA path has no timeout of its own; the omp path enforces it inside the runtime */
	private raiaBlockingWithTimeout(
		query: string,
		context: VoiceAIContext,
		options: VoiceRequestOptions
	): Promise<AIResponse> {
		const call = this.callRaiaBlocking(query, context);
		const timeoutMs = options.timeoutMs;
		if (!timeoutMs) return call;
		const timeout = new Promise<AIResponse>((_, reject) => {
			AbortSignal.timeout(timeoutMs).addEventListener(
				"abort",
				() => reject(new Error(`AI response timeout after ${timeoutMs}ms`)),
				{ once: true }
			);
		});
		return Promise.race([call, timeout]);
	}

	private async *callRaiaStreaming(
		query: string,
		context: VoiceAIContext
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
		context: VoiceAIContext,
		options: VoiceRequestOptions = {}
	): Promise<AIResponse> {
		if (this.useRaiaRuntime()) {
			return this.raiaBlockingWithTimeout(query, context, options);
		}

		return OmpRuntime.get().generate({
			systemPrompt: VOICE_SYSTEM_PROMPT,
			prompt: await this.withServerPreface(query, context, []),
			tools: this.toolAccess(context),
			label: "voice.command",
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
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
		context: VoiceAIContext,
		options: VoiceRequestOptions = {}
	): Promise<VoiceTokenStream> {
		if (this.useRaiaRuntime()) {
			return { tokens: this.callRaiaStreaming(query, context) };
		}

		const history = toChatHistory(context.history);
		return OmpRuntime.get().stream({
			systemPrompt: VOICE_STREAM_SYSTEM_PROMPT,
			prompt: await this.withServerPreface(query, context, history),
			history,
			tools: this.toolAccess(context),
			label: "voice.conversation",
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
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
		context: VoiceAIContext,
		options: VoiceRequestOptions = {}
	): Promise<AIResponse> {
		if (this.useRaiaRuntime()) {
			return this.raiaBlockingWithTimeout(query, context, options);
		}

		const history = toChatHistory(context.history);
		return OmpRuntime.get().generate({
			systemPrompt: VOICE_SYSTEM_PROMPT,
			prompt: await this.withServerPreface(query, context, history),
			history,
			tools: this.toolAccess(context),
			label: "voice.conversation",
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	}

	/** Prepend the server summary on the first turn only (no history), matching chat */
	private async withServerPreface(
		query: string,
		context: VoiceAIContext,
		history: ChatMessage[]
	): Promise<string> {
		if (history.length > 0 || !context.db) return query;
		const preface = await getServerSummaryPreface(context.db, context.guildId);
		return preface ? `${preface}\n\n${query}` : query;
	}

	private toolAccess(context: VoiceAIContext): ToolAccess | undefined {
		if (!context.db) return undefined;
		return {
			context: {
				userId: context.userId,
				guildId: context.guildId,
				db: context.db,
				channelId: context.channelId,
			},
			webSearch: true,
		};
	}
}
