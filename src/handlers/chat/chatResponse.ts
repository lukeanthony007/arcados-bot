import { getServerSummaryPreface } from "../../ai/context/serverSummary";
import type { CommunicationMode } from "../../ai/personas/modes";
import { buildSystemPrompt } from "../../ai/personas/systemPrompt";
import {
	type AIResponse,
	type ChatMessage,
	OmpRuntime,
} from "../../ai/runtime/OmpRuntime";
import type {
	PostgreSQLManager,
	UserPersonaData,
} from "../../database/PostgreSQLManager";
import { buildPersonaContext } from "../../features/user-personas/personaContext";
import { buildPersonaPrompt } from "../../features/user-personas/personaPrompt";

/** Max prior messages sent along with a reply */
const MAX_HISTORY_MESSAGES = 10;

export interface ChatResponseRequest {
	db: PostgreSQLManager;
	guildId: string;
	userId: string;
	/** Display name of the person who sent the message */
	speakerName: string;
	channelId: string;
	messageId: string;
	/** User text with <@id> mentions intact so tools can extract ids */
	content: string;
	/** Explicit yin/yang mode from the user's message */
	communicationMode?: CommunicationMode | null;
	/** Active member persona replacing the default "sophia" persona */
	persona?: UserPersonaData;
	/** Prior turns of the session; omit for a fresh mention */
	history?: ChatMessage[];
}

/** How chat turns are framed, so the model knows who it is talking to */
const CHAT_FORMAT = `Chat format:
- Each user message starts with the speaker's name and mention, e.g. "Lucas (<@123>): hey". Reply to that speaker; they are who "you"/"me" refers to.
- Mention someone only when addressing them, written as <@id>. Never write bare ids, and never echo a user's message back as a tag.
- Your reply is just the message text: don't start it with a "Name (<@id>):" label.`;

/**
 * Generate a chat reply (bot mention or reply continuation) with the full tool catalog and
 * web search. The server summary frames the first turn only.
 */
export async function generateChatResponse(
	req: ChatResponseRequest,
): Promise<AIResponse> {
	const history = req.history?.slice(-MAX_HISTORY_MESSAGES);
	const hasHistory = !!history?.length;

	let prompt = `${req.speakerName} (<@${req.userId}>): ${req.content}`;
	if (req.persona) {
		const context = await buildPersonaContext(
			req.db,
			req.guildId,
			req.persona,
			{
				speakerId: req.userId,
				content: req.content,
			},
		);
		if (context) prompt = `${context}\n\n${prompt}`;
	}
	if (!hasHistory) {
		const preface = await getServerSummaryPreface(req.db, req.guildId);
		if (preface) prompt = `${preface}\n\n${prompt}`;
	}

	const response = await OmpRuntime.get().generate({
		systemPrompt: buildSystemPrompt({
			persona: "sophia",
			personaText: req.persona ? buildPersonaPrompt(req.persona) : undefined,
			communicationMode: req.communicationMode,
			methodPrompt: CHAT_FORMAT,
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
	if (!response.success) return response;
	// Models sometimes copy the turn label ("Lucas (<@123…>): …") onto the reply
	const label = new RegExp(
		`^${escapeRegExp(req.speakerName)}\\s*\\(<@!?${req.userId}>\\)\\s*:?\\s*`,
	);
	const content = response.content
		.replace(label, "")
		// …or write "@123…" instead of Discord's "<@123…>" mention syntax
		.replace(/(?<![<\w])@!?(\d{17,20})\b/g, "<@$1>");
	return { ...response, content };
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
