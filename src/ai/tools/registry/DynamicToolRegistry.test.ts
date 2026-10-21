import { describe, expect, test } from "bun:test";
import type { AIContext } from "../../core/AIContext";
import type { DatabaseTool, DatabaseTools } from "./DatabaseTools";
import { DynamicToolRegistry } from "./DynamicToolRegistry";
import type { ToolCategory } from "./DynamicToolRegistry";
import { userTools } from "../user/UserTools";
import { relationshipTools } from "../relationship/RelationshipTools";

const context: AIContext = { userId: "offline-user", domain: "chat" };
const names = (tools: DatabaseTool[]) => tools.map(tool => tool.name).sort();
function registry(tools: DatabaseTool[]) {
	// Category selection needs only the catalog, never tool execution or a DB.
	return new DynamicToolRegistry({ getAllTools: () => tools } as DatabaseTools);
}
function fixture(name: string): DatabaseTool {
	return {
		name, description: "Offline category fixture",
		parameters: { type: "object", properties: {}, required: [] },
		execute: async () => { throw new Error("Selection must not execute tools"); },
	};
}

describe("registered memory tool availability", () => {
	const tools = [...userTools, ...relationshipTools];
	test("the user category advertises the real user catalog under original names", () => {
		expect(names(registry(tools).getToolsByCategory(["user"]))).toEqual(names(userTools));
	});
	test("relationship tools do not disappear or become user tools because of their names", () => {
		expect(names(registry(tools).getToolsByCategory(["relationship"]))).toEqual(names(relationshipTools));
	});
	test("ordinary chat exposes the registered profile and relationship definitions", () => {
		expect(names(registry(tools).selectTools("Hello", context))).toEqual(names(tools));
	});
	test("other domains do not automatically acquire social tools", () => {
		const selected = registry(tools);
		expect(selected.selectTools("Hello", { ...context, domain: "voice" })).toEqual([]);
		expect(selected.selectTools("Hello", { ...context, domain: "slash" })).toEqual([]);
	});
	test("keyword selection remains available without changing tool names", () => {
		expect(names(registry(tools).selectTools("relationship", { ...context, domain: "slash" })))
			.toEqual(names(relationshipTools));
	});
	test("legacy and unrelated category inference remains unchanged", () => {
		const legacy: Record<ToolCategory, string> = {
			user: "get_user_note", relationship: "relationship_hint",
			conversation: "get_recent_conversations", message: "search_messages",
			media: "play_media", voice: "control_voice", stream: "start_stream",
			server: "guild_info", analysis: "analysis_report",
		};
		const selected = registry(Object.values(legacy).map(fixture));
		for (const category of Object.keys(legacy) as ToolCategory[]) {
			expect(names(selected.getToolsByCategory([category]))).toEqual([legacy[category]]);
		}
	});
	test("unknown and object-prototype names stay uncategorized", () => {
		const selected = registry(["unknownTool", "constructor", "toString", "__proto__"].map(fixture));
		expect(selected.selectTools("Hello", context)).toEqual([]);
	});
});
