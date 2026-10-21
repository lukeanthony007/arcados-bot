import type { ToolCallResponse } from "../providers/base/AIProvider";

/** Preserve producer summaries and details without mistaking failure for success. */
export function formatToolResult(result: unknown): string {
	if (result == null || (typeof result === "string" && !result.trim())) {
		return "[tool error] Tool returned no result.";
	}
	if (typeof result === "string") return result;
	if (typeof result !== "object") return String(result);

	const value = result as Record<string, unknown>;
	const parts: string[] = [];
	const addText = (text: unknown) => {
		if (typeof text === "string" && text.trim() && !parts.includes(text)) {
			parts.push(text);
		}
	};
	addText(value.error);
	addText(value.summary);
	addText(value.formatted);
	if (value.data && typeof value.data === "object") {
		addText((value.data as Record<string, unknown>).formatted);
	}

	try {
		// Formatted output is the producer's readable representation of its data.
		// Otherwise retain structured details, even when there is also a summary.
		const hasFormatted = [value.formatted, (value.data as Record<string, unknown> | null)?.formatted]
			.some(text => typeof text === "string" && text.trim());
		if (!hasFormatted && value.data !== undefined) {
			addText(JSON.stringify(value.data));
		}
		if (parts.length === 0 && value.success !== false) {
			addText(JSON.stringify(result));
		}
	} catch {
		addText("[tool error] Tool result details could not be serialized.");
	}

	if (value.success === false || value.error) {
		return `[tool error] ${parts.join("\n\n") || "Tool reported failure without details."}`;
	}
	return parts.join("\n\n") || "[tool error] Tool returned no usable result.";
}

/**
 * Bound aggregate UTF-8 content bytes, newest first. Keep all protocol identities,
 * even when older content must be empty. The budget excludes names/IDs/envelopes.
 */
export function boundToolResults(results: ToolCallResponse[], budget: number): ToolCallResponse[] {
	const bounded = new Array<ToolCallResponse>(results.length);
	let remaining = budget;
	for (let i = results.length - 1; i >= 0; i--) {
		const result = results[i]!;
		if (remaining === 0) {
			bounded[i] = { ...result, content: "" };
			continue;
		}
		let content = result.content;
		if (Buffer.byteLength(content, "utf8") > remaining) {
			const marker = remaining >= 12 ? "[truncated]" : "";
			const bytes = Buffer.from(content, "utf8");
			let end = remaining - marker.length;
			// Do not emit a partial UTF-8 character at the cutoff.
			while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
			content = bytes.toString("utf8", 0, end) + marker;
		}
		remaining -= Buffer.byteLength(content, "utf8");
		bounded[i] = { ...result, content };
	}
	return bounded;
}
