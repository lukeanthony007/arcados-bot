import type { Message } from "discord.js";

type ChatRole = "system" | "user" | "assistant";

interface ChatTurn {
	role: ChatRole;
	content: string;
}

interface ChatSession {
	userId: string;
	channelId: string;
	persona?: string;
	history: ChatTurn[];
	lastBotMessageId: string;
	lastActiveAt: number;
}

// In-memory session storage keyed by any bot message id in the session
const messageIdToSessionId = new Map<string, string>();
const sessions = new Map<string, ChatSession>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getNow(): number {
	return Date.now();
}

function cleanupExpired(): void {
	const now = getNow();
	for (const [id, session] of sessions) {
		if (now - session.lastActiveAt > SESSION_TTL_MS) {
			sessions.delete(id);
		}
	}
	// Clean dangling message id mappings
	for (const [msgId, sessId] of messageIdToSessionId) {
		if (!sessions.has(sessId)) {
			messageIdToSessionId.delete(msgId);
		}
	}
}

export function startSession(params: {
	initialBotMessage: Message;
	userId: string;
	persona?: string;
	initialUserMessage: string;
	initialAssistantMessage: string;
}): string {
	cleanupExpired();
	const sessionId = params.initialBotMessage.id;
	const history: ChatTurn[] = [];

	if (params.persona && params.persona.trim().length > 0) {
		history.push({ role: "system", content: params.persona.trim() });
	}
	history.push({ role: "user", content: params.initialUserMessage });
	history.push({ role: "assistant", content: params.initialAssistantMessage });

	const session: ChatSession = {
		userId: params.userId,
		channelId: params.initialBotMessage.channelId,
		persona: params.persona,
		history,
		lastBotMessageId: params.initialBotMessage.id,
		lastActiveAt: getNow(),
	};

	sessions.set(sessionId, session);
	messageIdToSessionId.set(params.initialBotMessage.id, sessionId);
	return sessionId;
}

export function getSessionByRepliedMessageId(messageId: string): {
	sessionId: string;
	session: ChatSession;
} | null {
	cleanupExpired();
	const sessionId = messageIdToSessionId.get(messageId);
	if (!sessionId) return null;
	const session = sessions.get(sessionId);
	if (!session) return null;
	return { sessionId, session };
}

export function appendUserTurn(sessionId: string, content: string): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	session.history.push({ role: "user", content });
	session.lastActiveAt = getNow();
}

export function appendAssistantTurnAndTrackMessage(
	sessionId: string,
	botMessage: Message,
	content: string
): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	session.history.push({ role: "assistant", content });
	session.lastBotMessageId = botMessage.id;
	session.lastActiveAt = getNow();
	messageIdToSessionId.set(botMessage.id, sessionId);
}

export function formatHistoryForPrompt(sessionId: string): string {
	const session = sessions.get(sessionId);
	if (!session) return "";
	// Keep only the last 10 turns (user+assistant) for context
	const sys = session.history.filter((t) => t.role === "system");
	const convo = session.history.filter((t) => t.role !== "system");
	const recent = convo.slice(-10);
	const parts: string[] = [];
	if (sys.length > 0) {
		parts.push(`System: ${sys.map((s) => s.content).join("\n")}`);
	}
	for (const turn of recent) {
		const who = turn.role === "user" ? "User" : "Assistant";
		parts.push(`${who}: ${turn.content}`);
	}
	parts.push("Assistant:");
	return parts.join("\n");
}

export function getSessionHistory(
	sessionId: string
): Array<{ role: string; content: string }> {
	const session = sessions.get(sessionId);
	if (!session) return [];
	// Return recent history (excluding system messages for tool calling)
	return session.history
		.filter((t) => t.role !== "system")
		.slice(-10)
		.map((t) => ({
			role: t.role === "user" ? "user" : "assistant",
			content: t.content,
		}));
}
