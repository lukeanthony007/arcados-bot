/**
 * System prompt composition for chat and voice replies.
 *
 * Layers, in order:
 * 1. Persona base (WHO the bot is): a registry persona, or ad-hoc text such as a member persona
 * 2. Yin/Yang mode (HOW to communicate); defaults to yin for registry personas only,
 *    since member personas carry their own voice
 * 3. Conversational base (brevity + context-usage discipline)
 * 4. Optional method prompt (domain instructions, e.g. voice media control)
 */

import { DEFAULT_PERSONA, PERSONAS } from "./definitions";
import { type CommunicationMode, YANG_MODE, YIN_MODE } from "./modes";

const CONVERSATIONAL_BASE = `Core Conversational Principles:
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

export interface SystemPromptOptions {
	/** Registry persona key (sophia, casual); ignored when personaText is set */
	persona?: string;
	/** Ad-hoc persona text replacing the registry persona (e.g. a member persona) */
	personaText?: string;
	/** Explicit yin/yang mode from the user's message */
	communicationMode?: CommunicationMode | null;
	/** Domain-specific instructions appended last */
	methodPrompt?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
	const persona =
		PERSONAS[options.persona ?? DEFAULT_PERSONA] ?? PERSONAS[DEFAULT_PERSONA];
	const personaBase = options.personaText ?? persona?.base ?? "";
	const mode =
		options.communicationMode ?? (options.personaText ? undefined : "yin");
	const modePrompt =
		mode === "yang" ? YANG_MODE : mode === "yin" ? YIN_MODE : "";

	return [
		personaBase,
		modePrompt,
		CONVERSATIONAL_BASE,
		options.methodPrompt ?? "",
	]
		.filter(Boolean)
		.join("\n\n");
}
