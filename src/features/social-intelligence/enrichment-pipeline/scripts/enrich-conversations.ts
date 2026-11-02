#!/usr/bin/env bun
/**
 * AI-Powered Conversation Enrichment Script
 *
 * Second-pass refinement using AI to:
 * 1. Identify orphan messages that belong to nearby conversations
 * 2. Merge conversations that are clearly the same discussion
 * 3. Split conversations when topics shift
 * 4. Validate and improve grouping quality
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { AIFactory } from "../../../../ai/core/AIFactory";
import type { AIEngine } from "../../../../ai/core/AIEngine";
import { AIRequestBuilder } from "../../../../ai/core/AIRequestBuilder";
import type { AIResponse } from "../../../../ai/providers/base/AIProvider";
import { SocialIntelligence } from "../../index.js";
import { EnhancementOrchestrator } from "../EnhancementOrchestrator";
import { config } from "../../../../config/index.js";

interface Message {
	id: string;
	content: string;
	author_id: string;
	username: string;
	channel_id: string;
	channel_name: string;
	created_at: Date;
	conversation_id: string | null;
}

interface Conversation {
	id: string;
	channel_id: string;
	channel_name: string;
	start_time: Date;
	end_time: Date;
	message_ids: string[];
	participants: string[];
	message_count: number;
}

interface EnrichmentAction {
	type: "merge" | "split" | "assign_orphan" | "no_action";
	confidence: number;
	reason: string;
	details?: any;
}

interface CliOptions {
	lookbackHours: number;
	dryRun: boolean;
	channelFilter?: string;
	regenerateSummaries: boolean;
}

function parseCliArgs(rawArgs: string[]): CliOptions {
	const options: CliOptions = {
		lookbackHours: 24,
		dryRun: rawArgs.includes("--dry-run"),
		channelFilter: undefined,
		regenerateSummaries: rawArgs.includes("--regenerateSummaries"),
	};

	const getNumber = (value?: string): number | null => {
		if (!value) return null;
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	};

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i]!;

		if (arg.startsWith("--lookbackHours")) {
			let value: string | undefined;
			if (arg.includes("=")) {
				value = arg.split("=")[1];
			} else {
				value = rawArgs[i + 1];
				if (value && !value.startsWith("--")) {
					i++;
				} else {
					value = undefined;
				}
			}

			const hours = getNumber(value);
			if (hours !== null) {
				options.lookbackHours = hours;
			} else {
				console.warn(
					`⚠️  Invalid --lookbackHours value "${value}". Falling back to ${options.lookbackHours}h.`
				);
			}
		} else if (/^\d+$/.test(arg) && options.lookbackHours === 24) {
			const hours = getNumber(arg);
			if (hours !== null) {
				options.lookbackHours = hours;
			}
		} else if (arg.startsWith("--channel")) {
			let value: string | undefined;
			if (arg.includes("=")) {
				value = arg.split("=")[1];
			} else if (rawArgs[i + 1] && !rawArgs[i + 1]!.startsWith("--")) {
				value = rawArgs[i + 1];
				i++;
			}
			options.channelFilter = value;
		}
	}

	return options;
}

const db = new PostgreSQLManager();

async function main() {
	const args = parseCliArgs(process.argv.slice(2));
	const hoursBack = args.lookbackHours;
	const dryRun = args.dryRun;
	const channelFilter = args.channelFilter;
	const regenerateSummaries = args.regenerateSummaries;

	console.log("🤖 AI-Powered Conversation Enrichment");
	console.log("=".repeat(80));
	console.log(`Time window: Past ${hoursBack} hours`);
	console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will modify database)"}`);
	if (channelFilter) console.log(`Channel filter: #${channelFilter}`);
	console.log("=".repeat(80));

	const connected = await db.connect();
	if (!connected) {
		console.error("❌ Failed to connect to database");
		process.exit(1);
	}

	const guildId = config.guildId;
	if (!guildId) {
		console.error("❌ No guild ID configured");
		await db.disconnect();
		process.exit(1);
	}

	// Initialize AI
	const { engine } = await AIFactory.create();
	console.log("\n🔧 Initializing AI engine...");

	// Fetch all messages and conversations
	console.log("\n📥 Loading data from database...");
	const { messages, conversations, orphanMessages } = await loadData(
		guildId,
		hoursBack,
		channelFilter
	);

	console.log(`\n🔹 Loaded:`);
	console.log(`   Messages: ${messages.length}`);
	console.log(`   Conversations: ${conversations.length}`);
	console.log(`   Orphan messages: ${orphanMessages.length}`);

	// Group conversations by channel and time proximity for analysis
	const analysisGroups = groupForAnalysis(messages, conversations, orphanMessages);

	console.log(`\n🔍 Analysis groups: ${analysisGroups.length}`);

	// Process each group with rate limiting
	let totalActions = 0;
	const actions: Array<{
		group: number;
		action: EnrichmentAction;
		context?: any;
	}> = [];

	const RATE_LIMIT_DELAY = 6000; // 6 seconds between requests to avoid rate limits

	for (let i = 0; i < analysisGroups.length; i++) {
		const group = analysisGroups[i]!;
		console.log(`\n${"─".repeat(80)}`);
		console.log(
			`📦 Group ${i + 1}/${analysisGroups.length}: #${group.channel_name} (${group.timeWindow})`
		);
		console.log(
			`   ${group.conversations.length} conversations, ${group.orphans.length} orphan messages`
		);

		// Analyze this group with AI
		const action = await analyzeGroup(group, engine, guildId);

		if (action.type !== "no_action") {
			console.log(`\n   🎯 Action: ${action.type.toUpperCase()}`);
			console.log(`   📊 Confidence: ${(action.confidence * 100).toFixed(0)}%`);
			console.log(`   💡 Reason: ${action.reason}`);
			console.log(`   🔍 Details:`, JSON.stringify(action.details, null, 2));

			actions.push({ group: i + 1, action, context: group });
			totalActions++;

			if (!dryRun && action.confidence >= 0.7) {
				console.log(`   ⚙️  Applying action...`);
				await applyAction(action, group, guildId);
				console.log(`   🔹 Applied`);
			} else if (action.confidence < 0.7) {
				console.log(`   ⚠️  Confidence too low, skipping`);
			}
		}

		// Rate limiting: wait between requests
		if (i < analysisGroups.length - 1) {
			console.log(`   ⏱️  Waiting ${RATE_LIMIT_DELAY / 1000}s to avoid rate limits...`);
			await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
		}
	}

	// Cleanup and enrich all conversations
	if (!dryRun) {
		console.log(`\n\n${"=".repeat(80)}`);
		console.log("🧹 CLEANUP & ENRICHMENT");
		console.log("=".repeat(80));
		
		// Step 1: Delete 2-message conversations
		console.log(`\n   🗑️  Cleaning up 2-message conversations...`);
		const deleteResult = await db.query(
			`
			DELETE FROM conversation_segments
			WHERE guild_id = $1
				AND start_time > NOW() - INTERVAL '${hoursBack} hours'
				AND status = 'finalized'
				AND message_count = 2
			RETURNING id
			`,
			[guildId]
		);
		
		const deletedCount = deleteResult.success && deleteResult.data ? deleteResult.data.length : 0;
		console.log(`   🔹 Deleted ${deletedCount} 2-message conversations`);
		
		// Step 2: Enrich all remaining conversations
		console.log(`\n   🔧 Enriching all conversations...`);
		const socialIntelligence = new SocialIntelligence(db);
		
		// Get ALL conversations in the time window (not just missing ones)
		const allConversationsResult = await db.query(
			`
			SELECT id, message_count
			FROM conversation_segments
			WHERE guild_id = $1
				AND start_time > NOW() - INTERVAL '${hoursBack} hours'
				AND status = 'finalized'
				AND message_count >= 3
			ORDER BY start_time DESC
			`,
			[guildId]
		);

		if (allConversationsResult.success && allConversationsResult.data) {
			const conversationsToEnrich = allConversationsResult.data as Array<{ id: string; message_count: number }>;
			console.log(`   Found ${conversationsToEnrich.length} conversations to enrich`);
			
			let enrichedCount = 0;
			let keywordCount = 0;
			let missingSummaryCount = 0;
			
			for (const conv of conversationsToEnrich) {
				try {
					// Check what's missing
					const convResult = await db.query(
						`SELECT features, summary FROM conversation_segments WHERE id = $1`,
						[conv.id]
					);
					
					if (convResult.success && convResult.data && convResult.data.length > 0) {
						const features = convResult.data[0].features;
						const summary = convResult.data[0].summary;
						
						const hasKeywords = features && 
							typeof features === 'object' && 
							'keywords' in features && 
							Array.isArray((features as any).keywords) && 
							(features as any).keywords.length > 0;
						
						const hasSummary = summary && summary.trim() !== '';
						
						// Always enrich to ensure keywords are extracted (even if they exist, refresh them)
						await socialIntelligence.enrichConversation(conv.id);
						
						// Verify keywords were extracted after enrichment
						const verifyResult = await db.query(
							`SELECT features FROM conversation_segments WHERE id = $1`,
							[conv.id]
						);
						
						if (verifyResult.success && verifyResult.data && verifyResult.data.length > 0) {
							const updatedFeatures = verifyResult.data[0].features;
							const hasKeywordsAfter = updatedFeatures && 
								typeof updatedFeatures === 'object' && 
								'keywords' in updatedFeatures && 
								Array.isArray((updatedFeatures as any).keywords) && 
								(updatedFeatures as any).keywords.length > 0;
							
							if (!hasKeywordsAfter && !hasKeywords) {
								console.warn(`   ⚠️  No keywords extracted for conversation ${conv.id} (${conv.message_count} messages)`);
							} else if (!hasKeywords && hasKeywordsAfter) {
								keywordCount++;
							}
						}
						
						if (!hasSummary) {
							missingSummaryCount++;
						}
						
						enrichedCount++;
					}
				} catch (error) {
					console.error(`   ⚠️  Failed to enrich conversation ${conv.id}:`, error);
				}
			}
			
			console.log(`\n   🔹 Enriched ${enrichedCount} conversations`);
			console.log(`   📝 Keywords extracted/refreshed: ${enrichedCount}`);
			
			// Generate or regenerate summaries
			if (regenerateSummaries || missingSummaryCount > 0) {
				const summaryTargetCount = regenerateSummaries
					? conversationsToEnrich.length
					: missingSummaryCount;
				const summaryAction = regenerateSummaries ? "Regenerating" : "Generating";

				console.log(
					`\n   📄 ${summaryAction} summaries for ${summaryTargetCount} conversations...`
				);
				const orchestrator = new EnhancementOrchestrator(db, engine, {
					lookbackHours: hoursBack,
					enableSummaries: true,
					enableOrphans: false,
					enableSplitting: false,
					dryRun: false,
					regenerateSummaries,
					batchSize: 10,
					sleepBetweenBatches: 4000,
				});
				
				try {
					const stats = await orchestrator.enhance(guildId);
					console.log(`   🔹 Generated ${stats.summariesGenerated} summaries`);
				} catch (error) {
					console.error(`   ⚠️  Summary generation failed:`, error);
				}
			}
		}
	}

	// Summary
	console.log(`\n\n${"=".repeat(80)}`);
	console.log("📊 ENRICHMENT SUMMARY");
	console.log("=".repeat(80));
	console.log(`Total actions identified: ${totalActions}`);

	const actionsByType = actions.reduce(
		(acc, { action }) => {
			acc[action.type] = (acc[action.type] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>
	);

	for (const [type, count] of Object.entries(actionsByType)) {
		console.log(`  ${type}: ${count}`);
	}

	if (dryRun) {
		console.log(
			`\n💡 This was a dry run. Run without --dry-run to apply changes.`
		);
	} else {
		console.log(`\n🔹 Changes applied to database`);
	}

	console.log(`\n${"=".repeat(80)}`);
	console.log("🔹 Enrichment complete\n");

	await db.disconnect();
}

async function loadData(
	guildId: string,
	hoursBack: number,
	channelFilter?: string
) {
	// Load all messages
	const messagesResult = await db.query(
		`
    WITH message_conversations AS (
      SELECT m.id, cs.id as conversation_id
      FROM messages m
      JOIN conversation_segments cs ON cs.guild_id = m.guild_id
      WHERE m.id = ANY(cs.message_ids)
        AND m.guild_id = $1
        AND m.created_at > NOW() - INTERVAL '${hoursBack} hours'
    )
    SELECT
      m.id,
      m.content,
      m.author_id,
      COALESCE(mem.username, m.author_id) as username,
      m.channel_id,
      COALESCE(c.name, m.channel_id) as channel_name,
      m.created_at,
      mc.conversation_id
    FROM messages m
    LEFT JOIN message_conversations mc ON m.id = mc.id
    LEFT JOIN channels c ON m.channel_id = c.id
    LEFT JOIN members mem ON m.author_id = mem.user_id AND m.guild_id = mem.guild_id
    WHERE m.guild_id = $1
      AND m.created_at > NOW() - INTERVAL '${hoursBack} hours'
      AND m.active = true
      AND COALESCE(mem.bot, false) = false
      AND COALESCE(c.name, '') NOT IN ('vc-logs', 'mod-logs', 'server-logs', 'audit-logs')
      ${channelFilter ? `AND c.name = '${channelFilter}'` : ""}
    ORDER BY m.created_at ASC
    `,
		[guildId]
	);

	// Load conversations
	const conversationsResult = await db.query(
		`
    SELECT
      cs.id,
      cs.channel_id,
      COALESCE(c.name, cs.channel_id) as channel_name,
      cs.start_time,
      cs.end_time,
      cs.message_ids,
      cs.participants,
      cs.message_count
    FROM conversation_segments cs
    LEFT JOIN channels c ON cs.channel_id = c.id
    WHERE cs.guild_id = $1
      AND cs.start_time > NOW() - INTERVAL '${hoursBack} hours'
      ${channelFilter ? `AND c.name = '${channelFilter}'` : ""}
    ORDER BY cs.start_time ASC
    `,
		[guildId]
	);

	const messages: Message[] = (messagesResult.data || []).map((row: any) => ({
		id: row.id,
		content: row.content || "",
		author_id: row.author_id,
		username: row.username,
		channel_id: row.channel_id,
		channel_name: row.channel_name,
		created_at: new Date(row.created_at),
		conversation_id: row.conversation_id,
	}));

	const conversations: Conversation[] = (conversationsResult.data || []).map(
		(row: any) => ({
			id: row.id,
			channel_id: row.channel_id,
			channel_name: row.channel_name,
			start_time: new Date(row.start_time),
			end_time: new Date(row.end_time),
			message_ids: row.message_ids || [],
			participants: row.participants || [],
			message_count: row.message_count,
		})
	);

	const orphanMessages = messages.filter((m) => !m.conversation_id);

	return { messages, conversations, orphanMessages };
}

interface AnalysisGroup {
	channel_name: string;
	channel_id: string;
	timeWindow: string;
	conversations: Conversation[];
	messages: Message[];
	orphans: Message[];
}

function groupForAnalysis(
	messages: Message[],
	conversations: Conversation[],
	orphans: Message[]
): AnalysisGroup[] {
	const groups: AnalysisGroup[] = [];

	// Group by channel
	const byChannel = new Map<string, Message[]>();
	for (const msg of messages) {
		const msgs = byChannel.get(msg.channel_id) || [];
		msgs.push(msg);
		byChannel.set(msg.channel_id, msgs);
	}

	// For each channel, create time-based groups
	for (const [channelId, channelMessages] of byChannel.entries()) {
		const sortedMsgs = [...channelMessages].sort(
			(a, b) => a.created_at.getTime() - b.created_at.getTime()
		);

		const GAP_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
		let currentGroupMsgs: Message[] = [];

		for (const msg of sortedMsgs) {
			if (currentGroupMsgs.length === 0) {
				currentGroupMsgs.push(msg);
			} else {
				const lastMsg = currentGroupMsgs[currentGroupMsgs.length - 1]!;
				const gap = msg.created_at.getTime() - lastMsg.created_at.getTime();

				if (gap > GAP_THRESHOLD_MS) {
					// Finalize current group
					if (currentGroupMsgs.length >= 2) {
						groups.push(createGroup(currentGroupMsgs, conversations, orphans));
					}
					currentGroupMsgs = [msg];
				} else {
					currentGroupMsgs.push(msg);
				}
			}
		}

		// Finalize last group
		if (currentGroupMsgs.length >= 2) {
			groups.push(createGroup(currentGroupMsgs, conversations, orphans));
		}
	}

	return groups;
}

function createGroup(
	messages: Message[],
	allConversations: Conversation[],
	allOrphans: Message[]
): AnalysisGroup {
	const messageIds = new Set(messages.map((m) => m.id));
	const channelId = messages[0]!.channel_id;
	const channelName = messages[0]!.channel_name;

	// Find conversations that overlap with this group
	const groupConvs = allConversations.filter((conv) =>
		conv.message_ids.some((id) => messageIds.has(id))
	);

	// Find orphans in this group
	const groupOrphans = allOrphans.filter(
		(o) => messageIds.has(o.id) && o.channel_id === channelId
	);

	const startTime = messages[0]!.created_at;
	const endTime = messages[messages.length - 1]!.created_at;
	const timeWindow = `${startTime.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	})} - ${endTime.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	})}`;

	return {
		channel_name: channelName,
		channel_id: channelId,
		timeWindow,
		conversations: groupConvs,
		messages,
		orphans: groupOrphans,
	};
}

async function analyzeGroup(
	group: AnalysisGroup,
	aiEngine: AIEngine,
	guildId: string
): Promise<EnrichmentAction> {
	// Build context for AI
	const context = buildContext(group);

	// Create prompt for AI analysis
	const prompt = `You are analyzing a Discord conversation group to identify grouping issues and suggest improvements.

Channel: #${group.channel_name}
Time window: ${group.timeWindow}
Current state:
- ${group.conversations.length} conversation(s)
- ${group.orphans.length} orphan message(s) (unmapped)

${context}

Your task: Analyze this data and determine if there are any issues with conversation grouping.

Look for:
1. **Orphan messages** that clearly belong to a nearby conversation (same topic, participants responding)
2. **Multiple conversations** that should be merged (continuous discussion, same participants, related topic)
3. **Single conversations** that should be split (clear topic shift, different participant groups)
4. **Correct grouping** (no action needed)

IMPORTANT: When referencing messages, use their message IDs from the [id:...] prefix shown in the data.

Respond with a JSON object:
{
  "type": "merge" | "split" | "assign_orphan" | "no_action",
  "confidence": 0.0-1.0,
  "reason": "Brief explanation of why this action is needed",
  "details": {
    // For "merge": { "conversation_ids": ["conv_id1", "conv_id2", ...] }  <- Use the full conversation IDs shown above
    // For "split": { "conversation_id": "conv_id", "split_after_message_id": "msg_id", "reason": "topic shift from X to Y" }
    // For "assign_orphan": { "orphan_message_ids": ["msg_id1", "msg_id2", ...], "target_conversation_id": "conv_id" }  <- Use message IDs from [id:...]
    // For "no_action": {}
  }
}

Only return the JSON, nothing else.`;

	try {
		// Use Grok (no quota issues), fall back to Ollama
		const provider = process.env.GROK_API_KEY ? "grok" : "ollama";

		const builder = new AIRequestBuilder(aiEngine);
		const result = await builder
			// Structured mode: the chat preset caps output at 60 tokens, which truncates the JSON reply
			.blocking()
			.mode("structured")
			.maxTokens(800)
			.provider(provider as "grok" | "ollama")
			.persona("casual")
			.withoutTools() // Don't need database tools for this analysis
			.generate(prompt);

		const response = result as AIResponse;

		if (!response.success || !response.content) {
			console.error(`   ⚠️  Invalid AI response:`, response);
			return {
				type: "no_action",
				confidence: 0,
				reason: "Invalid AI response format",
			};
		}

		const responseText = response.content;

		// Parse JSON response
		const jsonMatch = responseText.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			console.error(`   ⚠️  No JSON found in response:`, responseText.substring(0, 200));
			return {
				type: "no_action",
				confidence: 0,
				reason: "Failed to parse AI response - no JSON found",
			};
		}

		const action = JSON.parse(jsonMatch[0]) as EnrichmentAction;
		return action;
	} catch (error) {
		console.error(`   ⚠️  AI analysis failed:`, error);
		return {
			type: "no_action",
			confidence: 0,
			reason: `Error: ${error}`,
		};
	}
}

function buildContext(group: AnalysisGroup): string {
	let context = "";

	// Add conversations
	if (group.conversations.length > 0) {
		context += "\nConversations:\n";
		for (let i = 0; i < group.conversations.length; i++) {
			const conv = group.conversations[i]!;
			const convMsgs = group.messages.filter((m) =>
				conv.message_ids.includes(m.id)
			);

			context += `\nConv ${i + 1} (id: ${conv.id}):\n`;
			context += `  Participants: ${conv.participants.length} users\n`;
			context += `  Messages (${convMsgs.length}):\n`;

			for (const msg of convMsgs) {
				const time = msg.created_at.toLocaleTimeString("en-US", {
					hour12: false,
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
				});
				const content =
					msg.content.length > 80
						? msg.content.substring(0, 77) + "..."
						: msg.content;
				context += `    [id:${msg.id}] ${time} @${msg.username}: "${content}"\n`;
			}
		}
	}

	// Add orphans
	if (group.orphans.length > 0) {
		context += "\nOrphan messages (unmapped):\n";
		for (const orphan of group.orphans) {
			const time = orphan.created_at.toLocaleTimeString("en-US", {
				hour12: false,
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
			const content =
				orphan.content.length > 80
					? orphan.content.substring(0, 77) + "..."
					: orphan.content;
			context += `  [id:${orphan.id}] ${time} @${orphan.username}: "${content}"\n`;
		}
	}

	return context;
}

async function applyAction(
	action: EnrichmentAction,
	group: AnalysisGroup,
	guildId: string
): Promise<void> {
	switch (action.type) {
		case "merge":
			if (action.details?.conversation_ids) {
				await mergeConversations(
					action.details.conversation_ids,
					group,
					guildId
				);
			}
			break;

		case "split":
			if (
				action.details?.conversation_id &&
				action.details?.split_after_message_id
			) {
				await splitConversation(
					action.details.conversation_id,
					action.details.split_after_message_id,
					guildId
				);
			}
			break;

		case "assign_orphan":
			if (action.details?.orphan_message_ids) {
				const targetId = action.details.target_conversation_id;
				// Check if target conversation exists in the group (not a placeholder like "new_conversation")
				const targetExists = targetId && group.conversations.some(c => c.id === targetId);

				if (targetExists) {
					// Assign to existing conversation
					await assignOrphans(
						action.details.orphan_message_ids,
						targetId,
						guildId
					);
				} else {
					// No valid target conversation - create a new one from orphans
					await createConversationFromOrphans(
						action.details.orphan_message_ids,
						group,
						guildId
					);
				}
			}
			break;
	}
}

async function mergeConversations(
	convIds: string[],
	group: AnalysisGroup,
	guildId: string
): Promise<void> {
	if (convIds.length < 2) return;

	// Get all conversations to merge
	const convsToMerge = group.conversations.filter((c) => convIds.includes(c.id));
	if (convsToMerge.length < 2) return;

	// Combine all message IDs
	const allMessageIds = new Set<string>();
	const allParticipants = new Set<string>();
	let earliestStart = convsToMerge[0]!.start_time;
	let latestEnd = convsToMerge[0]!.end_time;

	for (const conv of convsToMerge) {
		conv.message_ids.forEach((id) => allMessageIds.add(id));
		conv.participants.forEach((p) => allParticipants.add(p));
		if (conv.start_time < earliestStart) earliestStart = conv.start_time;
		if (conv.end_time > latestEnd) latestEnd = conv.end_time;
	}

	// Keep the first conversation, update it with merged data
	const primaryConv = convsToMerge[0]!;
	await db.query(
		`
    UPDATE conversation_segments
    SET message_ids = $1,
        participants = $2,
        message_count = $3,
        start_time = $4,
        end_time = $5
    WHERE id = $6 AND guild_id = $7
  `,
		[
			Array.from(allMessageIds),
			Array.from(allParticipants),
			allMessageIds.size,
			earliestStart,
			latestEnd,
			primaryConv.id,
			guildId,
		]
	);

	// Delete the other conversations
	for (let i = 1; i < convsToMerge.length; i++) {
		await db.query(
			`DELETE FROM conversation_segments WHERE id = $1 AND guild_id = $2`,
			[convsToMerge[i]!.id, guildId]
		);
	}

	// Trigger enrichment to generate keywords and summary
	const socialIntelligence = new SocialIntelligence(db);
	await socialIntelligence.enrichConversation(primaryConv.id);
}

async function splitConversation(
	convId: string,
	splitAfterMessageId: string,
	guildId: string
): Promise<void> {
	// Get the conversation
	const convResult = await db.query(
		`SELECT * FROM conversation_segments WHERE id = $1 AND guild_id = $2`,
		[convId, guildId]
	);

	if (!convResult.success || !convResult.data || convResult.data.length === 0) {
		return;
	}

	const conv = convResult.data[0];
	const messageIds: string[] = conv.message_ids || [];

	// Find split point
	const splitIndex = messageIds.indexOf(splitAfterMessageId);
	if (splitIndex === -1 || splitIndex === messageIds.length - 1) {
		return;
	}

	const firstHalf = messageIds.slice(0, splitIndex + 1);
	const secondHalf = messageIds.slice(splitIndex + 1);

	if (firstHalf.length < 2 || secondHalf.length < 2) {
		return; // Don't split if either half would be too small
	}

	// Get messages for each half to determine participants and times
	const messagesResult = await db.query(
		`SELECT id, author_id, created_at FROM messages WHERE id = ANY($1) ORDER BY created_at ASC`,
		[messageIds]
	);

	if (!messagesResult.success || !messagesResult.data) return;

	const messages = messagesResult.data;
	const firstHalfMsgs = messages.filter((m: any) => firstHalf.includes(m.id));
	const secondHalfMsgs = messages.filter((m: any) => secondHalf.includes(m.id));

	const firstParticipants = [
		...new Set(firstHalfMsgs.map((m: any) => m.author_id)),
	];
	const secondParticipants = [
		...new Set(secondHalfMsgs.map((m: any) => m.author_id)),
	];

	// Update first conversation
	await db.query(
		`
    UPDATE conversation_segments
    SET message_ids = $1,
        participants = $2,
        message_count = $3,
        end_time = $4
    WHERE id = $5 AND guild_id = $6
  `,
		[
			firstHalf,
			firstParticipants,
			firstHalf.length,
			new Date(firstHalfMsgs[firstHalfMsgs.length - 1].created_at),
			convId,
			guildId,
		]
	);

	// Create new conversation for second half
	const newConvId = `seg_${secondHalfMsgs[0].id}_${Date.now()}_split`;
	await db.query(
		`
    INSERT INTO conversation_segments (
      id, guild_id, channel_id, start_time, end_time,
      message_ids, participants, message_count, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalized')
  `,
		[
			newConvId,
			guildId,
			conv.channel_id,
			new Date(secondHalfMsgs[0].created_at),
			new Date(secondHalfMsgs[secondHalfMsgs.length - 1].created_at),
			secondHalf,
			secondParticipants,
			secondHalf.length,
		]
	);

	// Trigger enrichment for both conversations
	const socialIntelligence = new SocialIntelligence(db);
	await socialIntelligence.enrichConversation(convId);
	await socialIntelligence.enrichConversation(newConvId);
}

async function assignOrphans(
	orphanIds: string[],
	targetConvId: string,
	guildId: string
): Promise<void> {
	// Get target conversation
	const convResult = await db.query(
		`SELECT * FROM conversation_segments WHERE id = $1 AND guild_id = $2`,
		[targetConvId, guildId]
	);

	if (!convResult.success || !convResult.data || convResult.data.length === 0) {
		return;
	}

	const conv = convResult.data[0];
	const currentMessageIds: string[] = conv.message_ids || [];
	const currentParticipants: string[] = conv.participants || [];

	// Get orphan message details
	const orphansResult = await db.query(
		`SELECT id, author_id, created_at FROM messages WHERE id = ANY($1)`,
		[orphanIds]
	);

	if (!orphansResult.success || !orphansResult.data) return;

	const orphans = orphansResult.data;

	// Add orphans to conversation
	const newMessageIds = [...currentMessageIds, ...orphanIds];
	const newParticipants = [
		...new Set([...currentParticipants, ...orphans.map((o: any) => o.author_id)]),
	];

	// Update time range if needed
	const allTimes = [
		...orphans.map((o: any) => new Date(o.created_at).getTime()),
		new Date(conv.start_time).getTime(),
		new Date(conv.end_time).getTime(),
	];
	const newStart = new Date(Math.min(...allTimes));
	const newEnd = new Date(Math.max(...allTimes));

	await db.query(
		`
    UPDATE conversation_segments
    SET message_ids = $1,
        participants = $2,
        message_count = $3,
        start_time = $4,
        end_time = $5
    WHERE id = $6 AND guild_id = $7
  `,
		[
			newMessageIds,
			newParticipants,
			newMessageIds.length,
			newStart,
			newEnd,
			targetConvId,
			guildId,
		]
	);

	// Trigger enrichment to generate keywords and summary
	const socialIntelligence = new SocialIntelligence(db);
	await socialIntelligence.enrichConversation(targetConvId);
}

async function createConversationFromOrphans(
	orphanIds: string[],
	group: AnalysisGroup,
	guildId: string
): Promise<void> {
	if (orphanIds.length < 2) {
		console.warn(`   ⚠️  Not enough orphans to create conversation (need at least 2)`);
		return;
	}

	// Get orphan message details
	const orphansResult = await db.query(
		`SELECT id, author_id, created_at FROM messages WHERE id = ANY($1) ORDER BY created_at ASC`,
		[orphanIds]
	);

	if (!orphansResult.success || !orphansResult.data || orphansResult.data.length === 0) {
		console.warn(`   ⚠️  Failed to fetch orphan messages`);
		return;
	}

	const orphans = orphansResult.data;
	const participants = [...new Set(orphans.map((o: any) => o.author_id))];
	const startTime = new Date(orphans[0].created_at);
	const endTime = new Date(orphans[orphans.length - 1].created_at);

	// Create new conversation
	const newConvId = `seg_${orphans[0].id}_${Date.now()}_orphans`;

	await db.query(
		`
		INSERT INTO conversation_segments (
			id, guild_id, channel_id, start_time, end_time,
			message_ids, participants, message_count, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalized')
		`,
		[
			newConvId,
			guildId,
			group.channel_id,
			startTime,
			endTime,
			orphanIds,
			participants,
			orphanIds.length,
		]
	);

	console.log(`   🔹 Created new conversation ${newConvId} with ${orphanIds.length} messages`);

	// Trigger enrichment to generate keywords and summary
	const socialIntelligence = new SocialIntelligence(db);
	await socialIntelligence.enrichConversation(newConvId);
}

main().catch((error) => {
	console.error("❌ Error:", error);
	process.exit(1);
});
