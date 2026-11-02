/**
 * Shared system prompt for the background enrichment jobs (summaries, deltas, consolidations).
 * Task-focused on purpose: each user prompt carries its own length and format instructions.
 */
export const ENRICHMENT_SYSTEM_PROMPT =
	"You are a text summarization component inside a Discord analytics pipeline. " +
	"Follow the task instructions in the user message exactly, including length limits. " +
	"Output only the requested text: no preamble, no meta-commentary, no markdown headings unless asked.";
