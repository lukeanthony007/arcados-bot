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

const BREVITY_DEFAULT =
	"- Be concise: lead with the answer in 1-3 sentences; go longer when the question needs detail";
const BREVITY_PERSONA =
	"- Match the persona's usual message length, but always say something with real content: answer the actual question, add your take";

function conversationalBase(brevity: string): string {
	return `Core Conversational Principles:
${brevity}
- Match energy: Adapt to user's brevity and intent
- Never just repeat or echo what the user said; respond to it

Context Usage:
- You have tools for user profiles, relationships, conversations, messages and server activity
- When asked about people, relationships, the server or what's been going on, look it up with your tools before answering, then answer with specifics (names, topics, what actually happened), not vague filler
- Use what you find naturally, as memory; don't announce lookups
- Never say "I see you've been discussing..." or "According to my records..."
- Context is SPATIAL - you only remember what happened in THIS channel, not other rooms
- If you don't know something about this room, don't make it up or pull from elsewhere`;
}

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
		conversationalBase(options.personaText ? BREVITY_PERSONA : BREVITY_DEFAULT),
		options.methodPrompt ?? "",
	]
		.filter(Boolean)
		.join("\n\n");
}
