/**
 * OmpRuntime: the bot's single AI entry point, backed by the omp SDK.
 *
 * Every request runs in a fresh, isolated omp session (in-memory, no discovery, no
 * built-in coding tools). Sessions are cheap (~20-60ms) so there is no pooling.
 *
 * - generate():           text reply, optionally with the bot's tools and web_search
 * - stream():             same, with text deltas as an AsyncIterable for TTS
 * - generateStructured(): schema-validated object via a `submit` tool call
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AgentRegistry,
	type AgentSession,
	type AuthStorage,
	type CreateAgentSessionOptions,
	ModelRegistry,
	SessionManager,
	Settings,
	type ToolDefinition,
	createAgentSession,
	discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";
import { config } from "../../config";
import { APICostTracker } from "../../utils/APICostTracker";
import { getToolCatalog } from "../tools";
import type { ToolContext } from "../tools/registry/DatabaseTools";
import { adaptTool } from "./toolAdapter";

/** Model used for every request (chat, voice and background jobs) */
const MODEL_PROVIDER = "xai";
const MODEL_ID = "grok-4-1-fast-non-reasoning";

/** Bot-local omp state, isolated from the user's ~/.omp configuration */
const OMP_HOME = fileURLToPath(new URL("../../../.omp-bot", import.meta.url));

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export interface ToolAccess {
	/** Request scope passed to every tool call */
	context: ToolContext;
	/** Tool names to expose; defaults to the full catalog */
	names?: string[];
	/** Expose omp's web_search tool */
	webSearch?: boolean;
}

export interface GenerateRequest {
	systemPrompt: string;
	prompt: string;
	/** Prior turns, flattened into the prompt as `User:`/`Assistant:` lines */
	history?: ChatMessage[];
	/** Omit for a tool-less request */
	tools?: ToolAccess;
	/** Cost-tracking label, e.g. "chat.mention" or "enrichment.user-delta" */
	label: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface AIResponse {
	success: boolean;
	content: string;
	error?: string;
	/** Names of tools the model called, in call order (deduplicated) */
	executedTools?: string[];
}

/** JSON Schema for an object (the `submit` tool's parameters) */
export interface JsonObjectSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	[key: string]: unknown;
}

export interface StructuredRequest
	extends Omit<GenerateRequest, "tools" | "history"> {
	schema: JsonObjectSchema;
}

export interface StreamHandle {
	tokens: AsyncIterable<string>;
	result: Promise<AIResponse>;
}

interface Backend {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	settings: Settings;
	agentDir: string;
	cwd: string;
}

export class OmpRuntime {
	private static instance: OmpRuntime | null = null;
	private backendPromise: Promise<Backend> | null = null;

	static get(): OmpRuntime {
		OmpRuntime.instance ??= new OmpRuntime();
		return OmpRuntime.instance;
	}

	generate(request: GenerateRequest): Promise<AIResponse> {
		return this.run(request);
	}

	stream(request: GenerateRequest): StreamHandle {
		const queue: string[] = [];
		let finished = false;
		let wake: (() => void) | null = null;
		const notify = () => {
			wake?.();
			wake = null;
		};

		const result = this.run(request, (delta) => {
			queue.push(delta);
			notify();
		}).finally(() => {
			finished = true;
			notify();
		});

		const tokens: AsyncIterable<string> = {
			async *[Symbol.asyncIterator]() {
				while (true) {
					const next = queue.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (finished) return;
					const { promise, resolve } = Promise.withResolvers<void>();
					wake = resolve;
					await promise;
				}
			},
		};
		return { tokens, result };
	}

	/**
	 * Ask the model for an object matching `schema`. omp validates the `submit` call's
	 * arguments against the schema before it executes, so a captured value is valid.
	 * Returns null when the model never submits.
	 */
	async generateStructured<T>(request: StructuredRequest): Promise<T | null> {
		let submitted: T | null = null;
		const submit: ToolDefinition = {
			name: "submit",
			label: "submit",
			description:
				"Submit your final answer. Call exactly once with the complete result.",
			parameters: request.schema as never,
			async execute(_toolCallId, params) {
				submitted = params as T;
				return { content: [{ type: "text", text: "Submitted." }], details: {} };
			},
		} as ToolDefinition;

		const response = await this.run(
			{
				...request,
				systemPrompt: `${request.systemPrompt}\n\nRespond only by calling the submit tool exactly once with your result.`,
			},
			undefined,
			{
				extraTools: [submit],
				retryPrompt: () =>
					submitted === null
						? "Call the submit tool now with your result."
						: null,
			},
		);
		if (!response.success && submitted === null) {
			console.error(
				`🔸 [${request.label}] structured generation failed: ${response.error}`,
			);
		}
		return submitted;
	}

	private getBackend(): Promise<Backend> {
		this.backendPromise ??= this.createBackend().catch((error) => {
			this.backendPromise = null;
			throw error;
		});
		return this.backendPromise;
	}

	private async createBackend(): Promise<Backend> {
		if (!config.grokApiKey) {
			throw new Error("GROK_API_KEY is not configured");
		}
		const agentDir = `${OMP_HOME}/agent`;
		const cwd = `${OMP_HOME}/workspace`;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		const authStorage = await discoverAuthStorage(agentDir);
		authStorage.keys.setRuntime(MODEL_PROVIDER, config.grokApiKey);
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh();
		const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
		if (!model) {
			throw new Error(`Model ${MODEL_PROVIDER}/${MODEL_ID} is not available`);
		}
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
		});
		return { authStorage, modelRegistry, model, settings, agentDir, cwd };
	}

	private async createSession(
		backend: Backend,
		systemPrompt: string,
		tools: ToolDefinition[],
		toolNames: string[],
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: backend.cwd,
			agentDir: backend.agentDir,
			authStorage: backend.authStorage,
			modelRegistry: backend.modelRegistry,
			model: backend.model,
			thinkingLevel: "off",
			settings: backend.settings,
			sessionManager: SessionManager.inMemory(),
			agentRegistry: new AgentRegistry(),
			bindProcessState: false,
			systemPrompt,
			customTools: tools,
			toolNames,
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			noContextFiles: true,
			skills: [],
			rules: [],
			hasUI: false,
		});
		return session;
	}

	private async resolveTools(
		access: ToolAccess | undefined,
	): Promise<{ tools: ToolDefinition[]; names: string[] }> {
		if (!access) return { tools: [], names: [] };
		const catalog = await getToolCatalog();
		const selected = access.names
			? access.names.flatMap((name) => {
					const tool = catalog.get(name);
					if (!tool) console.warn(`⚠️ Unknown tool requested: ${name}`);
					return tool ? [tool] : [];
				})
			: [...catalog.values()];
		const tools = selected.map((tool) => adaptTool(tool, access.context));
		const names = tools.map((tool) => tool.name);
		if (access.webSearch) names.push("web_search");
		return { tools, names };
	}

	private async run(
		request: GenerateRequest,
		onDelta?: (delta: string) => void,
		structured?: {
			extraTools: ToolDefinition[];
			retryPrompt: () => string | null;
		},
	): Promise<AIResponse> {
		const started = Date.now();
		const executedTools: string[] = [];
		let inputTokens = 0;
		let outputTokens = 0;
		let costUsd = 0;
		let session: AgentSession | null = null;

		const timeout = AbortSignal.timeout(
			request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		const signal = request.signal
			? AbortSignal.any([request.signal, timeout])
			: timeout;
		const onAbort = () => void session?.abort();
		signal.addEventListener("abort", onAbort, { once: true });

		const finish = (response: AIResponse): AIResponse => {
			APICostTracker.getInstance().trackRequest("grok", {
				endpoint: request.label,
				success: response.success,
				error: response.error,
				inputTokens,
				outputTokens,
				latency: Date.now() - started,
				additionalMetadata: {
					model: MODEL_ID,
					via: "omp",
					costUsd,
					tools: executedTools,
				},
			});
			return response;
		};

		try {
			const backend = await this.getBackend();
			const { tools, names } = await this.resolveTools(request.tools);
			const extra = structured?.extraTools ?? [];
			session = await this.createSession(
				backend,
				request.systemPrompt,
				[...tools, ...extra],
				[...names, ...extra.map((tool) => tool.name)],
			);

			session.subscribe((event) => {
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent.type === "text_delta"
				) {
					onDelta?.(event.assistantMessageEvent.delta);
				} else if (event.type === "tool_execution_start") {
					if (!executedTools.includes(event.toolName))
						executedTools.push(event.toolName);
				} else if (
					event.type === "message_end" &&
					event.message.role === "assistant"
				) {
					inputTokens +=
						event.message.usage.input + event.message.usage.cacheRead;
					outputTokens += event.message.usage.output;
					costUsd += event.message.usage.cost.total;
				}
			});

			signal.throwIfAborted();
			await session.prompt(composePrompt(request.prompt, request.history));
			await session.waitForIdle();

			const retry = structured?.retryPrompt();
			if (retry && !signal.aborted) {
				await session.prompt(retry);
				await session.waitForIdle();
			}

			if (signal.aborted) {
				return finish({
					success: false,
					content: "",
					error: timeout.aborted
						? "AI request timed out"
						: "AI request aborted",
					executedTools,
				});
			}

			const last = session.getLastAssistantMessage();
			if (
				!last ||
				last.stopReason === "error" ||
				last.stopReason === "aborted"
			) {
				return finish({
					success: false,
					content: "",
					error: last?.errorMessage ?? "AI request failed",
					executedTools,
				});
			}

			const content = last.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("")
				.trim();
			return finish({ success: true, content, executedTools });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`🔸 [${request.label}] AI request failed:`, message);
			return finish({
				success: false,
				content: "",
				error: message,
				executedTools,
			});
		} finally {
			signal.removeEventListener("abort", onAbort);
			await session?.dispose();
		}
	}
}

function composePrompt(
	prompt: string,
	history: ChatMessage[] | undefined,
): string {
	if (!history?.length) return prompt;
	const lines = history.map(
		(message) =>
			`${message.role === "user" ? "User" : "Assistant"}: ${message.content}`,
	);
	return `${lines.join("\n")}\n\nUser: ${prompt}`;
}
