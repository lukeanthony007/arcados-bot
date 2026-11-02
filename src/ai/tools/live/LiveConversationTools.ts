import type { DatabaseTool, ToolContext } from "../registry/DatabaseTools";
import { ConversationDetector } from "../../../features/social-intelligence/conversation-detection/ConversationDetector";
import {
	describeStrength,
	getPairFacts,
} from "../../../features/social-intelligence/facts/closeness";

/**
 * Get live conversation context from the current channel
 * Returns active conversation participants and recent messages before finalization
 */
export const getLiveConversationContext: DatabaseTool = {
	name: "getLiveConversationContext",
	description:
		"Get the current active conversation happening in a channel right now, including participants and recent messages. Use this when the bot is mentioned in an ongoing conversation to understand the conversation context.",
	parameters: {
		type: "object",
		properties: {
			channelId: {
				type: "string",
				description: "Channel ID to get live conversation from",
			},
			messageLimit: {
				type: "number",
				description:
					"Number of recent messages to retrieve from buffer (default: 10, max: 20)",
			},
		},
		required: ["channelId"],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const channelId = String(params.channelId);
			const messageLimit = Math.min(params.messageLimit || 10, 20);

			const conversationManager = new ConversationDetector(context.db);
			const liveData = conversationManager.getLiveConversationInChannel(
				channelId,
				context.guildId,
			);

			if (!liveData.buffer || liveData.activeConversations.length === 0) {
				return {
					success: true,
					summary: "No active conversation in this channel right now",
					data: {
						hasActiveConversation: false,
						participants: [],
						messages: [],
					},
					formatted: "No active conversation detected in this channel.",
				};
			}

			// Get participant details
			const participantIds = new Set<string>();
			for (const convo of liveData.activeConversations) {
				for (const participantId of convo.participants) {
					participantIds.add(participantId);
				}
			}

			const participants: Array<{
				userId: string;
				displayName: string;
				username: string;
			}> = [];

			for (const userId of participantIds) {
				const memberResult = await context.db.query(
					`SELECT display_name, username, global_name
           FROM members
           WHERE guild_id = $1 AND user_id = $2`,
					[context.guildId, userId],
				);

				if (memberResult.success && memberResult.data && memberResult.data.length > 0) {
					const member = memberResult.data[0];
					participants.push({
						userId,
						displayName: member.display_name || member.global_name || member.username,
						username: member.username,
					});
				} else {
					participants.push({
						userId,
						displayName: "Unknown User",
						username: "unknown",
					});
				}
			}

			// Get recent messages
			const recentMessages = liveData.recentMessages.slice(-messageLimit);

			// Format messages for AI consumption
			const formattedMessages = await Promise.all(
				recentMessages.map(async (msg) => {
					const authorResult = await context.db.query(
						`SELECT display_name, username, global_name
             FROM members
             WHERE guild_id = $1 AND user_id = $2`,
						[context.guildId, msg.author_id],
					);

					const authorName =
						authorResult.success &&
						authorResult.data &&
						authorResult.data.length > 0
							? authorResult.data[0].display_name ||
								authorResult.data[0].global_name ||
								authorResult.data[0].username
							: "Unknown";

					return {
						author: authorName,
						content: msg.content,
						timestamp: msg.created_at.toISOString(),
						isReply: !!msg.referenced_message_id,
						hasMentions: (msg.mentioned_user_ids?.length || 0) > 0,
					};
				}),
			);

			// Calculate conversation duration
			const buffer = liveData.buffer;
			const durationMinutes = Math.round(
				(buffer.lastActivity.getTime() - buffer.startTime.getTime()) / (1000 * 60),
			);

			// Format as natural text for AI
			const formatted = `Active Conversation in Channel:

Participants (${participants.length}):
${participants.map((p) => `- ${p.displayName} (@${p.username})`).join("\n")}

Conversation Timeline:
- Started: ${buffer.startTime.toLocaleString()}
- Last Activity: ${buffer.lastActivity.toLocaleString()}
- Duration: ${durationMinutes} minutes
- Messages: ${recentMessages.length} recent messages

Recent Messages:
${formattedMessages
	.map(
		(msg, i) =>
			`${i + 1}. [${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.author}: ${msg.content.substring(0, 150)}${msg.content.length > 150 ? "..." : ""}`,
	)
	.join("\n")}`;

			return {
				success: true,
				summary: `Active conversation with ${participants.length} participants, ${recentMessages.length} recent messages, ongoing for ${durationMinutes} minutes`,
				data: {
					hasActiveConversation: true,
					participants,
					messages: formattedMessages,
					conversationStart: buffer.startTime,
					lastActivity: buffer.lastActivity,
					durationMinutes,
					messageCount: recentMessages.length,
					activeConversationCount: liveData.activeConversations.length,
				},
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in getLiveConversationContext:", error);
			return {
				success: false,
				error: "Unable to retrieve live conversation context",
			};
		}
	},
};

/**
 * Get closeness between conversation participants
 * Provides social context about how participants know each other
 */
export const getConversationParticipantRelationships: DatabaseTool = {
	name: "getConversationParticipantRelationships",
	description:
		"Get how the participants of the current active conversation know each other: for every pair, a closeness label (very close / close / regular / occasional, or no recorded interactions), replies, mentions and shared conversations. Closeness is computed from real interactions. Use this to understand group dynamics and who knows whom.",
	parameters: {
		type: "object",
		properties: {
			channelId: {
				type: "string",
				description: "Channel ID to analyze participant relationships",
			},
		},
		required: ["channelId"],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const channelId = String(params.channelId);

			const conversationManager = new ConversationDetector(context.db);

			// Get active participants
			const participantIds =
				conversationManager.getActiveParticipantsInChannel(
					channelId,
					context.guildId,
				);

			if (participantIds.length === 0) {
				return {
					success: true,
					summary: "No active participants in channel",
					data: { relationships: [] },
					formatted: "No active conversation participants found.",
				};
			}

			if (participantIds.length === 1) {
				return {
					success: true,
					summary: "Only one participant in conversation",
					data: { relationships: [] },
					formatted: "Only one participant in the conversation (no relationships to analyze).",
				};
			}

			// Get participant names
			const participantNames = new Map<string, string>();
			for (const userId of participantIds) {
				const memberResult = await context.db.query(
					`SELECT display_name, username, global_name
           FROM members
           WHERE guild_id = $1 AND user_id = $2`,
					[context.guildId, userId],
				);

				if (
					memberResult.success &&
					memberResult.data &&
					memberResult.data.length > 0
				) {
					const member = memberResult.data[0];
					participantNames.set(
						userId,
						member.display_name || member.global_name || member.username,
					);
				} else {
					participantNames.set(userId, "Unknown User");
				}
			}

			// Closeness for every participant pair (from the first member's point of view)
			const relationships: Array<{
				user1: string;
				user2: string;
				interacted: boolean;
				description: string;
				share: number;
				reciprocity: number;
				replies: number;
				mentions: number;
				sharedConversations: number;
			}> = [];

			const pairs: Array<[string, string]> = [];
			for (let i = 0; i < participantIds.length; i++) {
				for (let j = i + 1; j < participantIds.length; j++) {
					pairs.push([participantIds[i]!, participantIds[j]!]);
				}
			}
			const pairFacts = await Promise.all(
				pairs.map(([a, b]) => getPairFacts(context.db, context.guildId, a, b)),
			);

			pairs.forEach(([user1Id, user2Id], index) => {
				const facts = pairFacts[index];
				relationships.push({
					user1: participantNames.get(user1Id) || "Unknown",
					user2: participantNames.get(user2Id) || "Unknown",
					interacted: facts !== null,
					description: facts ? describeStrength(facts) : "no recorded interactions",
					share: facts?.share ?? 0,
					reciprocity: facts?.reciprocity ?? 0,
					replies: (facts?.a_to_b.replies ?? 0) + (facts?.b_to_a.replies ?? 0),
					mentions: (facts?.a_to_b.mentions ?? 0) + (facts?.b_to_a.mentions ?? 0),
					sharedConversations: facts?.shared_conversations ?? 0,
				});
			});

			// Strongest first (share of the first member's interactions); strangers last
			relationships.sort((a, b) => b.share - a.share);

			const strangers = relationships.filter((r) => !r.interacted);
			const closePairs = relationships.filter((r) => r.share >= 0.1);

			const formatted = `Participant Relationships:

${relationships
	.map(
		(rel) =>
			`${rel.user1} ↔ ${rel.user2}: ${rel.description}${
				rel.interacted
					? ` (${rel.replies} replies, ${rel.mentions} mentions, ${rel.sharedConversations} shared conversations)`
					: ""
			}`,
	)
	.join("\n")}

Social Context:
${closePairs.length > 0 ? `- ${closePairs.length} close pair(s): people who interact frequently` : ""}
${strangers.length > 0 ? `- ${strangers.length} pair(s) have never interacted` : ""}`;

			return {
				success: true,
				summary: `Relationships for ${participantIds.length} participants, ${relationships.length} pairs analyzed`,
				data: {
					participants: participantIds.map((id) => ({
						userId: id,
						displayName: participantNames.get(id) || "Unknown",
					})),
					relationships,
					closePairCount: closePairs.length,
					strangerPairCount: strangers.length,
				},
				formatted,
			};
		} catch (error) {
			console.error(
				"🔸 Error in getConversationParticipantRelationships:",
				error,
			);
			return {
				success: false,
				error: "Unable to retrieve participant relationships",
			};
		}
	},
};

/**
 * Get recent conversation topics from a channel
 * Queries finalized conversation segments for historical context
 */
export const getRecentChannelTopics: DatabaseTool = {
	name: "getRecentChannelTopics",
	description:
		"Get recent conversation topics and summaries from a channel's finalized conversation segments. Use this to understand what has been discussed in the past hours/days, beyond the current active conversation.",
	parameters: {
		type: "object",
		properties: {
			channelId: {
				type: "string",
				description: "Channel ID to retrieve conversation topics from",
			},
			lookbackHours: {
				type: "number",
				description:
					"How many hours to look back for conversations (default: 24, max: 168 for 7 days)",
			},
			limit: {
				type: "number",
				description: "Maximum number of conversation topics to return (default: 10)",
			},
		},
		required: ["channelId"],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const channelId = String(params.channelId);
			const lookbackHours = Math.min(params.lookbackHours || 24, 168); // Max 7 days
			const limit = Math.min(params.limit || 10, 20); // Max 20 conversations

			const lookbackTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

			// Query finalized and active conversation segments
			const result = await context.db.query(
				`SELECT
          id,
          participants,
          start_time,
          end_time,
          message_count,
          features,
          summary,
          message_ids,
          status
        FROM conversation_segments
        WHERE guild_id = $1
          AND channel_id = $2
          AND end_time >= $3
          AND status IN ('finalized', 'active')
        ORDER BY end_time DESC
        LIMIT $4`,
				[context.guildId, channelId, lookbackTime, limit],
			);

			let conversations: any[] = [];

			// If we found segments, use them
			if (result.success && result.data && result.data.length > 0) {
				conversations = result.data;
			} else {
				// Fallback: Query recent messages directly from messages table
				const messagesResult = await context.db.query(
					`SELECT
            m.id,
            m.author_id,
            m.content,
            m.created_at,
            mem.display_name,
            mem.username,
            mem.global_name
          FROM messages m
          LEFT JOIN members mem ON mem.user_id = m.author_id AND mem.guild_id = m.guild_id
          WHERE m.guild_id = $1
            AND m.channel_id = $2
            AND m.created_at >= $3
            AND m.active = true
          ORDER BY m.created_at DESC
          LIMIT $4`,
					[context.guildId, channelId, lookbackTime, limit * 10], // Get more messages to group into conversations
				);

				if (messagesResult.success && messagesResult.data && messagesResult.data.length > 0) {
					// Group messages into conversation-like summaries
					const messages = messagesResult.data as Array<{
						id: string;
						author_id: string;
						content: string;
						created_at: string | Date;
						display_name?: string;
						username?: string;
						global_name?: string;
					}>;

					// Sort messages chronologically (oldest first) for proper grouping
					const sortedMessages = [...messages].sort(
						(a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
					);

					// Group messages by time windows (messages within 30 minutes of each other)
					const grouped: Array<{
						participants: Set<string>;
						participantNames: Map<string, string>;
						messages: typeof messages;
						startTime: Date;
						endTime: Date;
					}> = [];

					for (const msg of sortedMessages) {
						const msgTime = new Date(msg.created_at);
						const authorName = msg.display_name || msg.global_name || msg.username || "Unknown";

						// Find or create a group for this message
						let added = false;
						for (const group of grouped) {
							const timeDiff = msgTime.getTime() - group.endTime.getTime();
							// If within 30 minutes of the last message in group, add to it
							if (timeDiff >= 0 && timeDiff <= 30 * 60 * 1000) {
								group.messages.push(msg);
								group.participants.add(msg.author_id);
								group.participantNames.set(msg.author_id, authorName);
								group.endTime = msgTime; // Update end time
								added = true;
								break;
							}
						}

						if (!added) {
							// Create new group
							grouped.push({
								participants: new Set([msg.author_id]),
								participantNames: new Map([[msg.author_id, authorName]]),
								messages: [msg],
								startTime: msgTime,
								endTime: msgTime,
							});
						}
					}

					// Convert grouped messages into conversation-like format
					conversations = grouped
						.filter((group) => group.messages.length >= 2) // Only include groups with 2+ messages
						.slice(0, limit)
						.map((group, idx) => {
							const participantIds = Array.from(group.participants);
							const participantNames = Array.from(group.participantNames.values());
							const durationMinutes = Math.round(
								(group.endTime.getTime() - group.startTime.getTime()) / (1000 * 60),
							);

							// Create a simple summary from message content
							const messageSnippets = group.messages
								.slice(0, 3)
								.map((m) => {
									const content = (m.content || "").trim();
									return content.length > 100 ? `${content.substring(0, 100)}...` : content;
								})
								.filter((s) => s.length > 0);

							const summary =
								messageSnippets.length > 0
									? `Discussion about: ${messageSnippets.join("; ")}`
									: "Recent conversation";

							return {
								id: `msg-group-${idx}`,
								participants: participantIds,
								participantNames,
								start_time: group.startTime,
								end_time: group.endTime,
								message_count: group.messages.length,
								summary,
								features: {},
								message_ids: group.messages.map((m) => m.id),
								status: "active", // These are derived from messages, so mark as active
							};
						});
				}

				// If still no conversations found, return early
				if (conversations.length === 0) {
					return {
						success: true,
						summary: "No recent conversations found in this channel",
						data: { conversations: [] },
						formatted: `No conversations or messages in the past ${lookbackHours} hours.`,
					};
				}
			}

			// Enrich with participant names
			const enriched = await Promise.all(
				conversations.map(async (convo: any) => {
					const participantIds = convo.participants || [];
					let participantNames: string[] = [];

					// If participantNames already exists (from message fallback), use it
					if (convo.participantNames && Array.isArray(convo.participantNames)) {
						participantNames = convo.participantNames;
					} else {
						// Otherwise, look up names from database
						for (const userId of participantIds) {
							const memberResult = await context.db.query(
								`SELECT display_name, username, global_name
               FROM members
               WHERE guild_id = $1 AND user_id = $2`,
								[context.guildId, userId],
							);

							if (
								memberResult.success &&
								memberResult.data &&
								memberResult.data.length > 0
							) {
								const member = memberResult.data[0];
								participantNames.push(
									member.display_name || member.global_name || member.username,
								);
							}
						}
					}

					// Calculate duration
					const durationMinutes = Math.round(
						(new Date(convo.end_time).getTime() -
							new Date(convo.start_time).getTime()) /
							(1000 * 60),
					);

					// Extract interaction types from features
					const interactionTypes = convo.features?.interaction_types || [];

					return {
						id: convo.id,
						participants: participantNames,
						participantCount: participantIds.length,
						startTime: new Date(convo.start_time),
						endTime: new Date(convo.end_time),
						durationMinutes,
						messageCount: convo.message_count,
						summary: convo.summary || "No summary available",
						interactionTypes,
					};
				}),
			);

			// Format as natural text
			const now = new Date();
			const formatted = `Recent Conversations in Channel (past ${lookbackHours}h):

${enriched
	.map((convo, i) => {
		const hoursAgo = Math.round(
			(now.getTime() - convo.endTime.getTime()) / (1000 * 60 * 60),
		);
		const timeAgo =
			hoursAgo < 1
				? "Less than 1 hour ago"
				: hoursAgo === 1
					? "1 hour ago"
					: `${hoursAgo} hours ago`;

		return `${i + 1}. ${timeAgo}
   Participants: ${convo.participants.join(", ")} (${convo.participantCount} users)
   Duration: ${convo.durationMinutes} minutes
   Messages: ${convo.messageCount}
   ${convo.summary ? `Summary: ${convo.summary}` : ""}`;
	})
	.join("\n\n")}

Total: ${enriched.length} conversations in the past ${lookbackHours} hours`;

			return {
				success: true,
				summary: `Found ${enriched.length} recent conversations in channel over past ${lookbackHours} hours`,
				data: {
					conversations: enriched,
					lookbackHours,
					totalCount: enriched.length,
				},
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in getRecentChannelTopics:", error);
			return {
				success: false,
				error: "Unable to retrieve recent channel topics",
			};
		}
	},
};

/**
 * Get server-wide activity summary
 * Shows what's happening across multiple channels
 */
export const getServerActivitySummary: DatabaseTool = {
	name: "getServerActivitySummary",
	description:
		"Get a server-wide summary of recent activity across all channels. Returns high-level summaries only. For detailed analysis with full message content (especially for server summaries or drama), use getRecentConversationMessages instead.",
	parameters: {
		type: "object",
		properties: {
			lookbackHours: {
				type: "number",
				description:
					"How many hours to look back for activity (default: 24, max: 168)",
			},
			channelLimit: {
				type: "number",
				description:
					"Maximum number of active channels to include (default: 5)",
			},
		},
		required: [],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const lookbackHours = Math.min(params.lookbackHours || 24, 168);
			const channelLimit = Math.min(params.channelLimit || 5, 10);
			const lookbackTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

			// Get most active channels with conversation counts
			const channelActivity = await context.db.query(
				`SELECT
          channel_id,
          COUNT(*) as conversation_count,
          SUM(message_count) as total_messages,
          (
            SELECT COUNT(DISTINCT participant_id)
            FROM conversation_segments cs2, unnest(cs2.participants) participant_id
            WHERE cs2.channel_id = conversation_segments.channel_id
              AND cs2.guild_id = $1
              AND cs2.end_time >= $2
              AND cs2.status = 'finalized'
          ) as unique_participants
        FROM conversation_segments
        WHERE guild_id = $1
          AND end_time >= $2
          AND status = 'finalized'
        GROUP BY channel_id
        ORDER BY conversation_count DESC
        LIMIT $3`,
				[context.guildId, lookbackTime, channelLimit],
			);

			if (
				!channelActivity.success ||
				!channelActivity.data ||
				channelActivity.data.length === 0
			) {
				return {
					success: true,
					summary: "No recent server activity found",
					data: { channels: [] },
					formatted: `No activity detected in the past ${lookbackHours} hours.`,
				};
			}

			// Get channel names
			const enrichedChannels = await Promise.all(
				channelActivity.data.map(async (ch: any) => {
					const channelResult = await context.db.query(
						`SELECT name, type FROM channels WHERE id = $1 AND guild_id = $2`,
						[ch.channel_id, context.guildId],
					);

					const channelName =
						channelResult.success &&
						channelResult.data &&
						channelResult.data.length > 0
							? channelResult.data[0].name
							: "unknown-channel";

					// Get recent conversation topics for this channel
					const recentTopics = await context.db.query(
						`SELECT summary, message_count, participants
            FROM conversation_segments
            WHERE guild_id = $1
              AND channel_id = $2
              AND end_time >= $3
              AND status = 'finalized'
            ORDER BY end_time DESC
            LIMIT 3`,
						[context.guildId, ch.channel_id, lookbackTime],
					);

					const topics =
						recentTopics.success && recentTopics.data
							? recentTopics.data.map((t: any) => ({
									summary: t.summary || "Conversation",
									messageCount: t.message_count,
									participantCount: (t.participants || []).length,
								}))
							: [];

					return {
						channelId: ch.channel_id,
						channelName,
						conversationCount: ch.conversation_count,
						totalMessages: ch.total_messages,
						uniqueParticipants: ch.unique_participants,
						recentTopics: topics,
					};
				}),
			);

			// Format as natural text
			const formatted = `Server Activity Summary (past ${lookbackHours}h):

Most Active Channels:
${enrichedChannels
	.map((ch: { channelName: string; conversationCount: number; totalMessages: number; uniqueParticipants: number; recentTopics: Array<{ summary: string; participantCount: number; messageCount: number }> }, i: number) => {
		const topicsText =
			ch.recentTopics.length > 0
				? ch.recentTopics
						.map(
							(t: any) =>
								`${t.summary} (${t.participantCount} participants, ${t.messageCount} messages)`,
						)
						.join(", ")
				: "No recent topics";

		return `${i + 1}. #${ch.channelName}
   Conversations: ${ch.conversationCount}
   Total Messages: ${ch.totalMessages}
   Active Users: ${ch.uniqueParticipants}
   Recent Topics: ${topicsText}`;
	})
	.join("\n\n")}

Server-wide: ${enrichedChannels.reduce((sum: number, ch: { conversationCount: number }) => sum + ch.conversationCount, 0)} conversations, ${enrichedChannels.reduce((sum: number, ch: { totalMessages: number }) => sum + ch.totalMessages, 0)} messages`;

			return {
				success: true,
				summary: `${channelActivity.data.length} active channels in past ${lookbackHours} hours`,
				data: {
					channels: enrichedChannels,
					lookbackHours,
					totalChannels: enrichedChannels.length,
				},
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in getServerActivitySummary:", error);
			return {
				success: false,
				error: "Unable to retrieve server activity summary",
			};
		}
	},
};

export const liveConversationTools = [
	getLiveConversationContext,
	getConversationParticipantRelationships,
	getRecentChannelTopics,
	getServerActivitySummary,
];
