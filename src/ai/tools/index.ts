/**
 * Tool catalog: every database/media/stream tool the bot exposes to the model.
 *
 * Voice, music, media and stream tools are imported lazily because they pull in
 * Discord voice/native modules and import VoiceAssistantManager (circular at load time).
 */

import { analysisTools } from "./analysis/AnalysisTools";
import { contextTools } from "./context/ContextTools";
import { conversationTools } from "./conversation/ConversationTools";
import { dramaAnalysisTools } from "./drama/DramaAnalysisTools";
import { liveConversationTools } from "./live/LiveConversationTools";
import { messageTools } from "./message/MessageTools";
import type { DatabaseTool } from "./registry/DatabaseTools";
import { relationshipTools } from "./relationship/RelationshipTools";
import { semanticSearchTools } from "./search/SemanticSearchTools";
import { serverTools } from "./server/ServerTools";
import { storylineTools } from "./storyline/StorylineTools";
import { userTools } from "./user/UserTools";

let catalogPromise: Promise<Map<string, DatabaseTool>> | null = null;

async function loadOptional(
	label: string,
	load: () => Promise<DatabaseTool[]>,
): Promise<DatabaseTool[]> {
	try {
		return await load();
	} catch (error) {
		console.warn(
			`⚠️ Failed to load ${label} tools:`,
			error instanceof Error ? error.message : String(error),
		);
		return [];
	}
}

async function buildCatalog(): Promise<Map<string, DatabaseTool>> {
	const groups: DatabaseTool[][] = [
		userTools,
		relationshipTools,
		conversationTools,
		messageTools,
		serverTools,
		contextTools,
		analysisTools,
		liveConversationTools,
		dramaAnalysisTools,
		semanticSearchTools,
		storylineTools,
		await loadOptional(
			"voice",
			async () => (await import("./voice/VoiceTools")).voiceTools,
		),
		await loadOptional(
			"music",
			async () => (await import("./music/MusicTools")).musicTools,
		),
		await loadOptional(
			"media player",
			async () => (await import("./media/MediaPlayerTools")).mediaPlayerTools,
		),
		await loadOptional(
			"stream player",
			async () =>
				(await import("./stream/StreamPlayerTools")).streamPlayerTools,
		),
	];

	const catalog = new Map<string, DatabaseTool>();
	for (const tool of groups.flat()) {
		if (catalog.has(tool.name)) {
			console.warn(
				`⚠️ Duplicate tool name "${tool.name}"; keeping the later definition`,
			);
		}
		catalog.set(tool.name, tool);
	}
	return catalog;
}

/** All tools, keyed by name. Loaded once per process. */
export function getToolCatalog(): Promise<Map<string, DatabaseTool>> {
	catalogPromise ??= buildCatalog();
	return catalogPromise;
}
