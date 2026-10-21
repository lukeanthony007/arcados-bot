import { describe, expect, mock, test } from "bun:test";
import type { AIProvider, ToolCall, ToolCallResponse } from "../providers/base/AIProvider";
import type { AIContext } from "./AIContext";
import { DatabaseTools } from "../tools/registry/DatabaseTools";
import type { DatabaseTool } from "../tools/registry/DatabaseTools";
import { getUserInfoTool } from "../tools/user/UserTools";
import { getRelationshipBetweenTool } from "../tools/relationship/RelationshipTools";

// The engine's static streaming-provider import otherwise loads SDKs and config.
// No production provider, configuration, database or bot is loaded/executed here.
mock.module("../providers/GrokProvider", () => ({ GrokProvider: class {} }));
const { AIEngine } = await import("./AIEngine");

const userId = "11111111111111111";
const peerId = "22222222222222222";
const context: AIContext = { userId, guildId: "offline-guild", domain: "chat", db: {} as AIContext["db"] };
const call = (name: string, id = "response|call", args = {}): ToolCall => ({ name, id, arguments: args });

type Captured = { userPrompt: string; results: ToolCallResponse[]; toolNames: string[] };
async function run(
	tools: DatabaseTool[],
	turns: ToolCall[][],
	options: { budget?: number; context?: AIContext; requireAdvertisedCalls?: boolean } = {},
) {
	const captured: Captured[] = [];
	const provider: AIProvider = {
		callTextAPI: async () => { throw new Error("Unexpected non-tool path"); },
		callImageAPI: async () => { throw new Error("Unexpected image path"); },
		getProviderName: () => "offline",
		getModelName: () => "captured",
		getRateLimitInfo: () => ({ remaining: 100, resetTime: 0 }),
		callTextAPIWithTools: async (_system, userPrompt, _tools, results) => {
			const index = captured.length;
			const toolNames = _tools.map(tool => tool.function.name);
			const requested = turns[index];
			if (options.requireAdvertisedCalls) {
				for (const requestedCall of requested || []) {
					expect(toolNames).toContain(requestedCall.name);
				}
			}
			captured.push({ userPrompt, results: structuredClone(results || []), toolNames });
			return { content: "Offline completion", toolCalls: requested };
		},
	};
	const registry = new DatabaseTools();
	registry.registerTools(tools);
	const engine = new AIEngine(new Map([["offline", provider]]), registry);
	const response = await engine.generate("Tell me about their relationship", options.context || context, {
		provider: "offline", mode: "chat", enableWebSearch: false, enableXSearch: false,
		maxToolContextBytes: options.budget, maxToolIterations: turns.length + 1,
	});
	expect(response).toMatchObject({ success: true, content: "Offline completion" });
	return captured;
}

function resultTool(result: unknown, name = "getUserInfo"): DatabaseTool {
	return {
		name, description: "Offline fixture", parameters: { type: "object", properties: {}, required: [] },
		execute: async () => result as Awaited<ReturnType<DatabaseTool["execute"]>>,
	};
}
const byteCount = (results: ToolCallResponse[]) => results.reduce((sum, result) => sum + Buffer.byteLength(result.content), 0);

describe("chat tool context reaching the provider", () => {
	test("real profile and relationship tools retain narrative and formatted details with a fake DB", async () => {
		let memberReads = 0;
		const db = {
			query: async (sql: string) => {
				if (sql.includes("SELECT * FROM members")) {
					memberReads++;
					return { success: true, data: memberReads === 1 ? [] : [{
						user_id: userId, display_name: "Mira", username: "mira", active: false,
						joined_at: "2024-01-01", keywords: ["astronomy"], roles: [],
					}] };
				}
				return { success: true, data: [{ user_id: peerId, display_name: "Sol", username: "sol" }] };
			},
			getUserProfile: async () => ({ success: true, data: { summary: "Mira organizes telescope nights" } }),
			getMemberRelationshipNetwork: async () => ({ success: true, data: [{
				user_id: peerId, affinity_percentage: 82.5, interaction_count: 17,
				last_interaction: "2026-01-01", summary: "They collaborate on star charts", conversations: [],
			}] }),
		};
		const captured = await run([getUserInfoTool, getRelationshipBetweenTool], [[
			call("getUserInfo", "r|profile", { userId }),
			call("getRelationshipBetween", "r|relationship", { user1Id: userId, user2Id: peerId }),
		]], { context: { ...context, db: db as unknown as AIContext["db"] }, requireAdvertisedCalls: true });
		const results = captured[1]!.results;
		expect(results[0]).toMatchObject({ name: "getUserInfo", role: "tool", toolCallId: "r|profile" });
		expect(results[0]!.content).toContain("Mira organizes telescope nights");
		expect(results[0]!.content).toContain("astronomy");
		expect(results[1]).toMatchObject({ name: "getRelationshipBetween", toolCallId: "r|relationship" });
		expect(results[1]!.content).toContain("Relationship affinity: 82.5%");
		expect(results[1]!.content).toContain("Sol");
		expect(results[1]!.content).toContain("They collaborate on star charts");
	});

	test.each([
		[{ success: true, summary: "Mira's narrative", data: { richContext: { interests: ["nebulae"] } } }, ["Mira's narrative", "nebulae"]],
		[{ success: true, summary: "Network overview", formatted: "Mira trusts Sol" }, ["Network overview", "Mira trusts Sol"]],
		[{ success: false, error: "No relationship found" }, ["[tool error]", "No relationship found"]],
		[{ success: false, summary: "Profile lookup unavailable" }, ["[tool error]", "Profile lookup unavailable"]],
		[{ success: false }, ["[tool error]"]],
		[null, ["[tool error]"]],
		[undefined, ["[tool error]"]],
		["", ["[tool error]"]],
		[false, ["false"]],
		[0, ["0"]],
		[{ data: { count: 0, relationships: [] } }, ['"count":0', '"relationships":[]']],
		["No stored profile", ["No stored profile"]],
	] as [unknown, string[]][])("preserves meaningful result %j", async (result, fragments) => {
		const captured = await run([resultTool(result)], [[call("getUserInfo")]]);
		const content = captured[1]!.results[0]!.content;
		for (const fragment of fragments) expect(content).toContain(fragment);
		expect(content).not.toBe("OK");
	});

	test("tool execution failures reach the provider as errors", async () => {
		const tool = resultTool(null);
		tool.execute = async () => { throw new Error("Offline lookup failed"); };
		const captured = await run([tool], [[call(tool.name)]]);
		expect(captured[1]!.results[0]!.content).toContain("[tool error]");
		expect(captured[1]!.results[0]!.content).toContain("Offline lookup failed");
	});

	const circular: { self?: unknown } = {};
	circular.self = circular;
	test.each([["BigInt", 1n], ["cycle", circular]] as [string, unknown][])(
		"isolates %s serialization failure without losing pending results",
		async (_name, data) => {
			const captured = await run([
				resultTool({ success: true, summary: "Useful profile narrative", data }),
				resultTool("Separate relationship detail", "getRelationshipBetween"),
			], [[call("getUserInfo", "r|profile"), call("getRelationshipBetween", "r|relationship")]]);
			const results = captured[1]!.results;
			expect(results.map(result => result.toolCallId)).toEqual(["r|profile", "r|relationship"]);
			expect(results[0]!.content).toContain("Useful profile narrative");
			expect(results[0]!.content).toContain("could not be serialized");
			expect(results[1]!.content).toBe("Separate relationship detail");
		},
	);

	test.each([1, 12, 53, 128])("bounds UTF-8 content to %i bytes across turns without dropping call IDs", async (budget) => {
		const first = "EARLY " + "🌌".repeat(100);
		const second = "LATEST " + "é".repeat(100);
		const captured = await run([resultTool(first), resultTool(second, "getRelationshipBetween")], [
			[call("getUserInfo", "r1|one"), call("getUserInfo", "r1|two")],
			[call("getRelationshipBetween", "r2|three")],
		], { budget });
		for (const turn of captured.slice(1)) {
			expect(byteCount(turn.results)).toBeLessThanOrEqual(budget);
			expect(turn.userPrompt).not.toContain("EARLY");
			expect(turn.userPrompt).not.toContain("LATEST");
			for (const result of turn.results) expect(result.content).not.toContain("�");
		}
		expect(captured[2]!.results.map(({ toolCallId }) => toolCallId)).toEqual(["r1|one", "r1|two", "r2|three"]);
		expect(captured[2]!.results[2]!.content.startsWith(second.slice(0, 1))).toBe(true);
		expect(captured[2]!.results[0]!.content).toBe("");
	});

	test("default budget also applies to structured tool outputs", async () => {
		const captured = await run([resultTool({ success: true, data: { detail: "x".repeat(6000) } })], [[call("getUserInfo")]]);
		expect(byteCount(captured[1]!.results)).toBeLessThanOrEqual(4000);
		expect(captured[1]!.results[0]!.content).toContain("[truncated]");
	});
});
