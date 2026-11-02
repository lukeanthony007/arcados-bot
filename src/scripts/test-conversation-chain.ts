import "dotenv/config";
import * as readline from "readline";
import { generateChatResponse } from "../handlers/chat/chatResponse.js";
import { PostgreSQLManager } from "../database/PostgreSQLManager.js";

const userId = process.env.USER_ID || "test-user";
const guildId = process.env.GUILD_ID;
const botUserId = process.env.BOT_USER_ID; // optional: the bot's Discord user ID

interface ConversationMessage {
	role: "user" | "assistant";
	content: string;
}

let conversationHistory: ConversationMessage[] = [];
let turnCount = 0;
let db: PostgreSQLManager;
let dbConnected = false;

/**
 * Process user input - handle mentions, self-queries, etc.
 */
function processUserInput(input: string): string {
	let userContent = input.trim();

	if (botUserId) {
		const mentionRe = new RegExp(`<@!?${botUserId}>`, "g");
		userContent = userContent.replace(mentionRe, "").trim();
	}

	userContent = userContent.replace(/^@bot\b/i, "").trim();

	userContent = userContent.replace(/@(\d{10,})/g, "<@$1>");

	return userContent;
}

/**
 * Display conversation history in a readable format
 */
function displayHistory(): void {
	if (conversationHistory.length === 0) {
		console.log("\nNo conversation history yet.\n");
		return;
	}

	conversationHistory.forEach((msg) => {
		const prefix = msg.role === "user" ? "🤤" : "👻";
		console.log(`\n${prefix}: ${msg.content}`);
	});
	console.log();
}

/**
 * Handle special commands
 */
function handleCommand(input: string): boolean {
	const cmd = input.trim().toLowerCase();

	if (cmd === "/exit" || cmd === "/quit") {
		return true; // Signal to exit
	}

	if (cmd === "/clear") {
		conversationHistory = [];
		turnCount = 0;
		console.log("History cleared.\n");
		return false;
	}

	if (cmd === "/history") {
		displayHistory();
		return false;
	}

	if (cmd === "/reset") {
		conversationHistory = [];
		turnCount = 0;
		console.log("Conversation reset.\n");
		return false;
	}

	if (cmd === "/help") {
		console.log("\nCommands:");
		console.log("  /clear   - Clear conversation history");
		console.log("  /history - Show conversation history");
		console.log("  /reset   - Reset conversation");
		console.log("  /exit    - Exit the program");
		console.log("  /help    - Show this help\n");
		return false;
	}

	return false; // Not a command, continue processing
}

/**
 * Process a single turn of conversation
 */
async function processTurn(userInput: string): Promise<void> {
	const processedInput = processUserInput(userInput);

	if (!processedInput) {
		return;
	}

	// Add user message to history
	conversationHistory.push({ role: "user", content: processedInput });
	turnCount++;

	// Print with emoji (line already cleared in readline handler)
	console.log(`🤤: ${processedInput}`);

	try {
		// First turn has no history; later turns pass the prior messages
		const response = await generateChatResponse({
			db,
			guildId: guildId as string,
			userId,
			speakerName: process.env.SPEAKER_NAME || "Tester",
			channelId: "test-channel",
			messageId: `test-${turnCount}`,
			content: processedInput,
			history: turnCount === 1 ? undefined : conversationHistory.slice(0, -1),
		});

		if (!response.success) {
			console.error("Error:", response.error || "Unknown error");
			// Remove the user message from history since it failed
			conversationHistory.pop();
			turnCount--;
			return;
		}

		// Add assistant response to history
		conversationHistory.push({ role: "assistant", content: response.content });

		console.log(`✨: ${response.content}\n`);
	} catch (error) {
		console.error("Error:", error);
		// Remove the user message from history since it failed
		conversationHistory.pop();
		turnCount--;
	}
}

/**
 * Process batch messages from command-line arguments
 */
async function processBatchMessages(messages: string[]): Promise<void> {
	for (const msg of messages) {
		await processTurn(msg);
	}
	console.log();
}

/**
 * Interactive REPL mode
 */
async function startInteractiveMode(): Promise<void> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "> ",
	});

	console.log(`\nConversation Chain Test`);
	console.log(`Type /help for commands\n`);

	rl.prompt();

	rl.on("line", async (input: string) => {
		const trimmed = input.trim();

		if (!trimmed) {
			rl.prompt();
			return;
		}

		// Clear the readline prompt line by moving up and clearing
		process.stdout.write("\x1b[1A\r\x1b[K");

		// Handle commands
		if (trimmed.startsWith("/")) {
			const shouldExit = handleCommand(trimmed);
			if (shouldExit) {
				rl.close();
				return;
			}
			rl.prompt();
			return;
		}

		// Process as user message
		await processTurn(trimmed);
		rl.prompt();
	});

	rl.on("close", async () => {
		console.log("\nExiting...\n");

		// Flush cost tracking data before exiting
		try {
			const { APICostTracker } = await import("../utils/APICostTracker.js");
			const tracker = APICostTracker.getInstance();
			await Promise.race([
				tracker.writeStats(),
				new Promise((resolve) => setTimeout(resolve, 2000)),
			]);
		} catch (err) {
			// Ignore errors in cost tracking
		}

		if (dbConnected) {
			await db.disconnect();
		}

		process.exit(0);
	});
}

/**
 * Main function
 */
async function main(): Promise<void> {
	if (!process.env.BOT_TOKEN) {
		console.warn("BOT_TOKEN not set.");
	}

	if (!guildId) {
		console.error("GUILD_ID is required.");
		process.exit(1);
	}


	// Initialize database (optional but enables environment context)
	db = new PostgreSQLManager();
	dbConnected = await db.connect();
	if (!dbConnected) {
		console.warn("Database not connected.");
	}


	// Check for command-line arguments (batch mode)
	const args = process.argv.slice(2);
	if (args.length > 0) {
		// Process batch messages first
		await processBatchMessages(args);
	}

	// Start interactive mode
	await startInteractiveMode();
}

main().catch(async (err) => {
	console.error("Error:", err);
	try {
		// Best-effort DB cleanup if we created one
		if (db && db.isConnected()) {
			await db.disconnect();
		}
	} catch {
		// ignore
	}
	process.exit(1);
});

