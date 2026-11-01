/**
 * PromptComposer: Compositional system prompt assembly
 *
 * Simplified architecture:
 * 1. Persona base (WHO the bot is)
 * 2. Yin/Yang mode (HOW to communicate)
 * 3. Conversational base (brevity/structure rules + context usage)
 * 4. Optional formatting
 * 5. Optional method prompt
 */

import type { CommunicationMode } from "../personas/modes";
import { YIN_MODE, YANG_MODE } from "../personas/modes";

export interface PromptComposition {
	personaBase: string;
	/** Omit to skip the yin/yang layer (e.g. user personas that carry their own voice) */
	communicationMode?: CommunicationMode;
	conversationalBase: string;
	formatting?: string;
	methodPrompt?: string;
}

/**
 * Compose system prompt from modular layers
 * Order matters - this defines the prompt hierarchy
 */
export function composeSystemPrompt(composition: PromptComposition): string {
	const layers: string[] = [];

	// Layer 1: Persona base (WHO the bot is - character, voice, personality)
	if (composition.personaBase) {
		layers.push(composition.personaBase);
	}

	// Layer 2: Yin or Yang mode (HOW to communicate - direct vs. metaphorical)
	if (composition.communicationMode) {
		layers.push(composition.communicationMode === "yang" ? YANG_MODE : YIN_MODE);
	}

	// Layer 3: Conversational base (brevity/structure rules + context usage discipline)
	if (composition.conversationalBase) {
		layers.push(composition.conversationalBase);
	}

	// Layer 4: Optional formatting
	if (composition.formatting) {
		layers.push(composition.formatting);
	}

	// Layer 5: Optional method prompt override
	if (composition.methodPrompt) {
		layers.push(composition.methodPrompt);
	}

	// Join with double newline for clear separation
	return layers.filter(Boolean).join("\n\n");
}
