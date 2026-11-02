import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type {
	DatabaseTool,
	DatabaseToolResult,
	ToolContext,
} from "../tools/registry/DatabaseTools";

/** Per-call cap on tool output sent to the model */
const MAX_TOOL_OUTPUT_CHARS = 4000;

/**
 * Expose a bot tool to an omp session, bound to one request's context.
 * The tool's JSON Schema passes through as-is (omp accepts raw JSON Schema, as for MCP tools).
 */
export function adaptTool(
	tool: DatabaseTool,
	context: ToolContext,
): ToolDefinition {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		// Raw JSON Schema; omp normalizes it the same way it does MCP tool schemas
		parameters: tool.parameters as never,
		loadMode: "essential",
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const result = await tool.execute(params, context);
			const text = typeof result === "string" ? result : formatResult(result);
			const capped =
				text.length > MAX_TOOL_OUTPUT_CHARS
					? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…(truncated)`
					: text;
			return { content: [{ type: "text", text: capped }], details: {} };
		},
	} as ToolDefinition;
}

/** Summary plus the most readable payload a tool provided (many tools nest `formatted` inside `data`) */
function formatResult(result: DatabaseToolResult): string {
	if (!result.success)
		return `Error: ${result.error ?? result.summary ?? "tool failed"}`;
	const nested = result.data?.formatted;
	const payload =
		result.formatted ??
		(typeof nested === "string"
			? nested
			: result.data !== undefined
				? JSON.stringify(result.data)
				: "");
	return [result.summary, payload].filter(Boolean).join("\n\n") || "OK";
}
