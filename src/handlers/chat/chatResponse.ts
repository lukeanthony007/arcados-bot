import { getServerSummaryPreface } from "../../ai/context/serverSummary";
import type { CommunicationMode } from "../../ai/personas/modes";
import { buildSystemPrompt } from "../../ai/personas/systemPrompt";
import {
	type AIResponse,
	type ChatMessage,
	OmpRuntime,
} from "../../ai/runtime/OmpRuntime";
import type { PostgreSQLManager } from "../../database/PostgreSQLManager";

/** Max prior messages sent along with a reply */
const MAX_HISTORY_MESSAGES = 10;

export interface ChatResponseRequest {
	db: PostgreSQLManager;
	guildId: string;
	userId: string;
	channelId: string;
	messageId: string;
	/** User text with <@id> mentions intact so tools can extract ids */
	content: string;
	/** Explicit yin/yang mode from the user's message */
	communicationMode?: CommunicationMode | null;
	/** Active member persona replacing the default "sophia" persona */
	personaPrompt?: string;
	/** Prior turns of the session; omit for a fresh mention */
	history?: ChatMessage[];
}

/**
 * Generate a chat reply (bot mention or reply continuation) with the full tool catalog and
 * web search. The server summary frames the first turn only.
 */
export async function generateChatResponse(
	req: ChatResponseRequest,
): Promise<AIResponse> {
	const history = req.history?.slice(-MAX_HISTORY_MESSAGES);
	const hasHistory = !!history?.length;

	let prompt = req.content;
	if (!hasHistory) {
		const preface = await getServerSummaryPreface(req.db, req.guildId);
		if (preface) prompt = `${preface}\n\n${prompt}`;
	}

	return OmpRuntime.get().generate({
		systemPrompt: buildSystemPrompt({
			persona: "sophia",
			personaText: req.personaPrompt,
			communicationMode: req.communicationMode,
		}),
		prompt,
		history: hasHistory ? history : undefined,
		tools: {
			context: {
				guildId: req.guildId,
				userId: req.userId,
				db: req.db,
				channelId: req.channelId,
				messageId: req.messageId,
			},
			webSearch: true,
		},
		label: hasHistory ? "chat.reply" : "chat.mention",
	});
}
