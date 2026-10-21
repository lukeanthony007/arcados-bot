import type { DatabaseTools, DatabaseTool } from "./DatabaseTools";
import type { AIContext } from "../../core/AIContext";

/**
 * Tool categories for dynamic loading
 */
export type ToolCategory =
	| "user" // User profile tools
	| "relationship" // Relationship/affinity tools
	| "conversation" // Conversation history tools
	| "message" // Message search tools
	| "media" // Media playback tools
	| "voice" // Voice control tools
	| "stream" // Stream player tools
	| "server" // Server/guild info tools
	| "analysis"; // Analysis/drama tools

// Keep the registered protocol names intact instead of relying on snake-case
// heuristics for these camelCase built-ins. Other tools retain legacy inference.
const MEMORY_TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
	getUserInfo: "user",
	getUserSummary: "user",
	searchUsers: "user",
	getUserActivity: "user",
	getUserRoles: "user",
	getUserRelationships: "relationship",
	getRelationshipBetween: "relationship",
	getTopRelationships: "relationship",
	getMutualConnections: "relationship",
	analyzeRelationship: "relationship",
};

/**
 * Strategy for loading tools based on context and keywords
 */
export interface ToolLoadStrategy {
	// Always load these (e.g., web_search)
	always: ToolCategory[];

	// Load based on keyword detection in the prompt
	keywords: Map<string, ToolCategory[]>;

	// Load based on domain (voice, chat, slash)
	domain: Map<"voice" | "chat" | "slash", ToolCategory[]>;
}

/**
 * Default tool loading strategy
 * Optimized to minimize token usage by loading only relevant tools
 */
const DEFAULT_STRATEGY: ToolLoadStrategy = {
	// No tools loaded by default - only load based on keywords/domain
	always: [],

	// Keyword-based tool selection
	keywords: new Map([
		// Media/playback keywords
		["play", ["media", "stream"]], // Play can be for both media and streaming
		["music", ["media", "stream"]], // Music can be from YouTube/Jellyfin
		["song", ["media", "stream"]],
		["pause", ["voice", "media"]],
		["stop", ["voice", "media"]],
		["resume", ["voice", "media"]],
		["leave", ["voice"]],
		["skip", ["media"]],

		// Stream keywords
		["stream", ["stream"]],
		["movie", ["stream"]],
		["watch", ["stream"]],
		["jellyfin", ["stream"]],
		["youtube", ["stream"]],

		// User/social keywords
		["who is", ["user", "relationship"]],
		["tell me about", ["user", "conversation"]],
		["what does", ["user"]],
		["profile", ["user"]],

		// Conversation keywords
		["recent", ["conversation", "message"]],
		["talking about", ["conversation"]],
		["discussed", ["conversation"]],
		["conversation", ["conversation"]],

		// Server keywords
		["server", ["server"]],
		["guild", ["server"]],
		["channel", ["server"]],
		["member", ["server"]],

		// Relationship keywords
		["friends", ["relationship"]],
		["relationship", ["relationship"]],
		["connections", ["relationship"]],
		["affinity", ["relationship"]],

		// Analysis keywords
		["drama", ["analysis"]],
		["conflict", ["analysis"]],
		["analyze", ["analysis"]],
	]),

	// Domain-based tool selection
	domain: new Map([
		["voice", ["media", "voice", "stream"]], // Voice always gets media + voice + stream tools
		["chat", ["user", "relationship", "conversation"]], // Chat gets social tools
		["slash", []], // Slash commands load tools explicitly
	]),
};

/**
 * DynamicToolRegistry - Intelligent tool selection to optimize token usage
 *
 * Instead of loading all 15-20 tools per request (~2000 tokens), this registry
 * analyzes the prompt and context to load only relevant tools (~300-700 tokens).
 *
 * Token savings: ~1300-1700 tokens per request (40-50% reduction)
 */
export class DynamicToolRegistry {
	private toolsByCategory: Map<ToolCategory, DatabaseTool[]> = new Map();
	private loadStrategy: ToolLoadStrategy;
	private allTools: DatabaseTool[];

	constructor(
		databaseTools: DatabaseTools,
		customStrategy?: Partial<ToolLoadStrategy>
	) {
		this.allTools = databaseTools.getAllTools();
		this.loadStrategy = customStrategy
			? { ...DEFAULT_STRATEGY, ...customStrategy }
			: DEFAULT_STRATEGY;

		// Initialize category map
		this.categorizeTools();
	}

	/**
	 * Categorize all tools by their category
	 * This is called once during initialization
	 */
	private categorizeTools(): void {
		for (const tool of this.allTools) {
			const category = this.inferCategory(tool.name);
			if (category) {
				if (!this.toolsByCategory.has(category)) {
					this.toolsByCategory.set(category, []);
				}
				this.toolsByCategory.get(category)!.push(tool);
			}
		}
	}

	/**
	 * Infer the category of a tool based on its name
	 */
	private inferCategory(toolName: string): ToolCategory | null {
		if (Object.hasOwn(MEMORY_TOOL_CATEGORIES, toolName)) {
			return MEMORY_TOOL_CATEGORIES[toolName]!;
		}

		// User tools
		if (
			toolName.startsWith("get_user") ||
			toolName.startsWith("search_user") ||
			toolName.includes("profile")
		) {
			return "user";
		}

		// Relationship tools
		if (
			toolName.includes("relationship") ||
			toolName.includes("affinity") ||
			toolName.includes("connection")
		) {
			return "relationship";
		}

		// Conversation tools
		if (
			toolName.includes("conversation") ||
			toolName.startsWith("get_recent_conversations")
		) {
			return "conversation";
		}

		// Message tools
		if (toolName.includes("message") || toolName.includes("search")) {
			return "message";
		}

		// Media tools
		if (toolName.includes("media") || toolName.includes("play")) {
			return "media";
		}

		// Voice tools
		if (toolName.includes("voice") || toolName.includes("control")) {
			return "voice";
		}

		// Stream tools
		if (toolName.includes("stream") || toolName.includes("movie")) {
			return "stream";
		}

		// Server tools
		if (
			toolName.includes("server") ||
			toolName.includes("guild") ||
			toolName.includes("channel")
		) {
			return "server";
		}

		// Analysis tools
		if (toolName.includes("analysis") || toolName.includes("drama")) {
			return "analysis";
		}

		return null;
	}

	/**
	 * Select tools based on prompt analysis and context
	 * This is the main method that optimizes token usage
	 */
	selectTools(prompt: string, context: AIContext): DatabaseTool[] {
		const selectedCategories = new Set<ToolCategory>();

		// 1. Add always-loaded categories
		for (const category of this.loadStrategy.always) {
			selectedCategories.add(category);
		}

		// 2. Add domain-based categories
		if (context.domain) {
			const domainCategories = this.loadStrategy.domain.get(context.domain);
			if (domainCategories) {
				for (const category of domainCategories) {
					selectedCategories.add(category);
				}
			}
		}

		// 3. Add keyword-based categories
		const promptLower = prompt.toLowerCase();
		for (const [keyword, categories] of this.loadStrategy.keywords.entries()) {
			if (promptLower.includes(keyword)) {
				for (const category of categories) {
					selectedCategories.add(category);
				}
			}
		}

		// 4. Get tools for selected categories
		return this.getToolsByCategory(Array.from(selectedCategories));
	}

	/**
	 * Get tools for specific categories (manual selection)
	 */
	getToolsByCategory(categories: ToolCategory[]): DatabaseTool[] {
		const tools: DatabaseTool[] = [];
		const seenToolNames = new Set<string>();

		for (const category of categories) {
			const categoryTools = this.toolsByCategory.get(category);
			if (categoryTools) {
				for (const tool of categoryTools) {
					// Avoid duplicates (a tool might be in multiple categories)
					if (!seenToolNames.has(tool.name)) {
						tools.push(tool);
						seenToolNames.add(tool.name);
					}
				}
			}
		}

		return tools;
	}

	/**
	 * Get all tools (fallback for when dynamic selection is disabled)
	 */
	getAllTools(): DatabaseTool[] {
		return this.allTools;
	}

	/**
	 * Get statistics about tool selection (for debugging)
	 */
	getSelectionStats(prompt: string, context: AIContext): {
		selectedCategories: ToolCategory[];
		toolCount: number;
		estimatedTokens: number;
	} {
		const tools = this.selectTools(prompt, context);
		const categories: ToolCategory[] = [];

		// Infer which categories were selected
		for (const [category, categoryTools] of this.toolsByCategory.entries()) {
			if (tools.some((t) => categoryTools.includes(t))) {
				categories.push(category);
			}
		}

		return {
			selectedCategories: categories,
			toolCount: tools.length,
			// Rough estimate: ~100-150 tokens per tool definition
			estimatedTokens: tools.length * 125,
		};
	}
}
