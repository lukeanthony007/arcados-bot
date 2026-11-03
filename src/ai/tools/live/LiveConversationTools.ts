import {
	describeStrength,
	getPairFacts,
} from "../../../features/social-intelligence/facts/closeness";
import type { EpisodeFocus } from "../../../features/social-intelligence/conversations/attention";
import { describeFocus } from "../../../features/social-intelligence/conversations/focusText";
import type { DatabaseTool, ToolContext } from "../registry/DatabaseTools";

interface SegmentRow {
	id: string;
	channel_id: string;
	participants: string[];
	message_ids: string[] | null;
	message_count: number;
	start_time: Date;
	end_time: Date;
	summary: string | null;
	topic_label: string | null;
	status: string;
}

/** Accepts a channel ID, a channel name ("chat" / "#chat"), or falls back to the context channel. */
async function resolveChannelId(
	input: unknown,
	context: ToolContext,
): Promise<string | null> {
	const raw = typeof input === "string" ? input.trim().replace(/^#/, "") : "";
	if (raw.length === 0) return context.channelId ?? null;
	if (/^\d{15,22}$/.test(raw)) return raw;
	const result = await context.db.query(
		`SELECT id FROM channels
     WHERE guild_id = $1 AND LOWER(name) = LOWER($2)
     ORDER BY id LIMIT 1`,
		[context.guildId, raw],
	);
	return result.success && result.data && result.data.length > 0
		? result.data[0].id
		: null;
}

async function loadNames(
	context: ToolContext,
	ids: string[],
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (ids.length === 0) return names;
	const result = await context.db.query(
		`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
     FROM members
     WHERE user_id = ANY($1::text[]) AND guild_id = $2`,
		[[...new Set(ids)], context.guildId],
	);
	if (result.success && result.data) {
		for (const member of result.data) names.set(member.user_id, member.name);
	}
	return names;
}

interface FocusRow {
	id: string;
	participants: string[];
	start_time: Date;
	end_time: Date;
	topic_label: string | null;
	status: string;
	focus: EpisodeFocus | null;
}

const FOCUS_SELECT = `SELECT id, participants, start_time, end_time, topic_label, status, focus
	FROM conversation_segments`;

async function getActiveSegments(
	context: ToolContext,
	channelId: string,
): Promise<SegmentRow[]> {
	const result = await context.db.query(
		`SELECT id, channel_id, participants, message_ids, message_count, start_time, end_time,
            summary, topic_label, status
     FROM conversation_segments
     WHERE guild_id = $1 AND channel_id = $2 AND status = 'active'
     ORDER BY end_time DESC`,
		[context.guildId, channelId],
	);
	return result.success && result.data ? result.data : [];
}

/**
 * Get live conversation context from the current channel
 * Returns the still-going conversation(s) and their latest messages
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
				description: "Channel ID (or name) to get the live conversation from",
			},
			messageLimit: {
				type: "number",
				description:
					"Number of recent messages to retrieve (default: 10, max: 20)",
			},
		},
		required: ["channelId"],
	},
	execute: async (params: Record<string, unknown>, context: ToolContext) => {
		try {
			const channelId = await resolveChannelId(
				String(params.channelId ?? ""),
				context,
			);
			const messageLimit = Math.min(Number(params.messageLimit) || 10, 20);
			if (!channelId) {
				return { success: false, error: "Channel not found" };
			}

			const segments = await getActiveSegments(context, channelId);
			if (segments.length === 0) {
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

			const participantIds = [
				...new Set(segments.flatMap((s) => s.participants)),
			];
			const messageIds = segments.flatMap((s) => s.message_ids ?? []);
			const msgResult =
				messageIds.length > 0
					? await context.db.query(
							`SELECT id, author_id, content, created_at, referenced_message_id
               FROM messages
               WHERE id = ANY($1::text[]) AND guild_id = $2 AND active = true
               ORDER BY created_at DESC
               LIMIT $3`,
							[messageIds, context.guildId, messageLimit],
						)
					: null;
			const recent: Array<{
				id: string;
				author_id: string;
				content: string | null;
				created_at: Date;
				referenced_message_id: string | null;
			}> =
				msgResult?.success && msgResult.data
					? [...msgResult.data].reverse()
					: [];

			const names = await loadNames(context, [
				...participantIds,
				...recent.map((m) => m.author_id),
			]);
			const participants = participantIds.map((userId) => ({
				userId,
				displayName: names.get(userId) ?? "Unknown User",
			}));

			const formattedMessages = recent.map((msg) => ({
				author: names.get(msg.author_id) ?? "Unknown",
				content: msg.content ?? "",
				timestamp: new Date(msg.created_at).toISOString(),
				isReply: !!msg.referenced_message_id,
			}));

			const startTime = new Date(
				Math.min(...segments.map((s) => new Date(s.start_time).getTime())),
			);
			const lastActivity = new Date(
				Math.max(...segments.map((s) => new Date(s.end_time).getTime())),
			);
			const durationMinutes = Math.round(
				(lastActivity.getTime() - startTime.getTime()) / 60000,
			);
			const topics = segments
				.map((s) => s.topic_label)
				.filter((t): t is string => !!t);

			const formatted = `Active Conversation in Channel:

Participants (${participants.length}):
${participants.map((p) => `- ${p.displayName}`).join("\n")}

Conversation Timeline:
- Started: ${startTime.toLocaleString()}
- Last Activity: ${lastActivity.toLocaleString()}
- Duration: ${durationMinutes} minutes
- Messages so far: ${segments.reduce((sum, s) => sum + s.message_count, 0)}${
				topics.length > 0 ? `\n- Topic: ${topics.join("; ")}` : ""
			}

Recent Messages:
${formattedMessages
	.map(
		(msg, i) =>
			`${i + 1}. [${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.author}: ${msg.content.substring(0, 150)}${msg.content.length > 150 ? "..." : ""}`,
	)
	.join("\n")}`;

			return {
				success: true,
				summary: `Active conversation with ${participants.length} participants, ${formattedMessages.length} recent messages, ongoing for ${durationMinutes} minutes`,
				data: {
					hasActiveConversation: true,
					participants,
					messages: formattedMessages,
					conversationStart: startTime,
					lastActivity,
					durationMinutes,
					messageCount: formattedMessages.length,
					activeConversationCount: segments.length,
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
				description:
					"Channel ID (or name) to analyze participant relationships",
			},
		},
		required: ["channelId"],
	},
	execute: async (params: Record<string, unknown>, context: ToolContext) => {
		try {
			const channelId = await resolveChannelId(
				String(params.channelId ?? ""),
				context,
			);
			if (!channelId) {
				return { success: false, error: "Channel not found" };
			}

			const segments = await getActiveSegments(context, channelId);
			const participantIds = [
				...new Set(segments.flatMap((s) => s.participants)),
			];

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
					formatted:
						"Only one participant in the conversation (no relationships to analyze).",
				};
			}

			const participantNames = await loadNames(context, participantIds);

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
					description: facts
						? describeStrength(facts)
						: "no recorded interactions",
					share: facts?.share ?? 0,
					reciprocity: facts?.reciprocity ?? 0,
					replies: (facts?.a_to_b.replies ?? 0) + (facts?.b_to_a.replies ?? 0),
					mentions:
						(facts?.a_to_b.mentions ?? 0) + (facts?.b_to_a.mentions ?? 0),
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
 * Reads stored conversation segments (topic_label + summary)
 */
export const getRecentChannelTopics: DatabaseTool = {
	name: "getRecentChannelTopics",
	description:
		"Get recent conversation topics and summaries from a channel's stored conversations (topic label plus summary). Use this to understand what has been discussed in the past hours/days, beyond the current active conversation.",
	parameters: {
		type: "object",
		properties: {
			channelId: {
				type: "string",
				description:
					"Channel ID (or name) to retrieve conversation topics from",
			},
			lookbackHours: {
				type: "number",
				description:
					"How many hours to look back for conversations (default: 24, max: 168 for 7 days)",
			},
			limit: {
				type: "number",
				description:
					"Maximum number of conversation topics to return (default: 10)",
			},
		},
		required: ["channelId"],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const channelId = await resolveChannelId(params.channelId, context);
			if (!channelId) {
				return { success: false, error: "Channel not found" };
			}
			const lookbackHours = Math.min(params.lookbackHours || 24, 168);
			const limit = Math.min(params.limit || 10, 20);
			const lookbackTime = new Date(
				Date.now() - lookbackHours * 60 * 60 * 1000,
			);

			const result = await context.db.query(
				`SELECT id, channel_id, participants, message_ids, message_count, start_time, end_time,
                summary, topic_label, status
         FROM conversation_segments
         WHERE guild_id = $1
           AND channel_id = $2
           AND end_time >= $3
         ORDER BY end_time DESC
         LIMIT $4`,
				[context.guildId, channelId, lookbackTime, limit],
			);
			const segments: SegmentRow[] =
				result.success && result.data ? result.data : [];

			if (segments.length === 0) {
				return {
					success: true,
					summary: "No recent conversations found in this channel",
					data: { conversations: [] },
					formatted: `No conversations in the past ${lookbackHours} hours.`,
				};
			}

			const names = await loadNames(
				context,
				segments.flatMap((s) => s.participants),
			);
			const enriched = segments.map((seg) => ({
				id: seg.id,
				participants: seg.participants.map((id) => names.get(id) ?? "Unknown"),
				participantCount: seg.participants.length,
				startTime: new Date(seg.start_time),
				endTime: new Date(seg.end_time),
				durationMinutes: Math.round(
					(new Date(seg.end_time).getTime() -
						new Date(seg.start_time).getTime()) /
						60000,
				),
				messageCount: seg.message_count,
				topic: seg.topic_label,
				summary: seg.summary,
				ongoing: seg.status === "active",
			}));

			const now = new Date();
			const formatted = `Recent Conversations in Channel (past ${lookbackHours}h):

${enriched
	.map((convo, i) => {
		const hoursAgo = Math.round(
			(now.getTime() - convo.endTime.getTime()) / (1000 * 60 * 60),
		);
		const timeAgo = convo.ongoing
			? "Happening now"
			: hoursAgo < 1
				? "Less than 1 hour ago"
				: hoursAgo === 1
					? "1 hour ago"
					: `${hoursAgo} hours ago`;

		return `${i + 1}. ${timeAgo}${convo.topic ? ` - ${convo.topic}` : ""}
   Participants: ${convo.participants.join(", ")} (${convo.participantCount} users)
   Duration: ${convo.durationMinutes} minutes
   Messages: ${convo.messageCount}
   ${convo.summary ? `Summary: ${convo.summary}` : "Summary: (not yet summarized)"}`;
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
			const lookbackTime = new Date(
				Date.now() - lookbackHours * 60 * 60 * 1000,
			);

			const channelActivity = await context.db.query(
				`SELECT
          cs.channel_id,
          COALESCE(c.name, 'unknown-channel') AS channel_name,
          COUNT(*) AS conversation_count,
          SUM(cs.message_count) AS total_messages,
          (
            SELECT COUNT(DISTINCT participant_id)
            FROM conversation_segments cs2, unnest(cs2.participants) participant_id
            WHERE cs2.channel_id = cs.channel_id
              AND cs2.guild_id = $1
              AND cs2.end_time >= $2
          ) AS unique_participants
        FROM conversation_segments cs
        LEFT JOIN channels c ON c.id = cs.channel_id AND c.guild_id = cs.guild_id
        WHERE cs.guild_id = $1
          AND cs.end_time >= $2
        GROUP BY cs.channel_id, c.name
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

			const enrichedChannels = await Promise.all(
				channelActivity.data.map(async (ch: any) => {
					const recentTopics = await context.db.query(
						`SELECT topic_label, summary, message_count, participants
            FROM conversation_segments
            WHERE guild_id = $1
              AND channel_id = $2
              AND end_time >= $3
            ORDER BY end_time DESC
            LIMIT 3`,
						[context.guildId, ch.channel_id, lookbackTime],
					);

					const topics =
						recentTopics.success && recentTopics.data
							? recentTopics.data.map((t: any) => ({
									topic: t.topic_label || null,
									summary: t.summary || "Conversation",
									messageCount: t.message_count,
									participantCount: (t.participants || []).length,
								}))
							: [];

					return {
						channelId: ch.channel_id,
						channelName: ch.channel_name as string,
						conversationCount: Number(ch.conversation_count),
						totalMessages: Number(ch.total_messages),
						uniqueParticipants: Number(ch.unique_participants),
						recentTopics: topics,
					};
				}),
			);

			const formatted = `Server Activity Summary (past ${lookbackHours}h):

Most Active Channels:
${enrichedChannels
	.map((ch, i) => {
		const topicsText =
			ch.recentTopics.length > 0
				? ch.recentTopics
						.map(
							(t: {
								topic: string | null;
								summary: string;
								participantCount: number;
								messageCount: number;
							}) =>
								`${t.topic ? `${t.topic}: ` : ""}${t.summary} (${t.participantCount} participants, ${t.messageCount} messages)`,
						)
						.join(" | ")
				: "No recent topics";

		return `${i + 1}. #${ch.channelName}
   Conversations: ${ch.conversationCount}
   Total Messages: ${ch.totalMessages}
   Active Users: ${ch.uniqueParticipants}
   Recent Topics: ${topicsText}`;
	})
	.join("\n\n")}

Server-wide: ${enrichedChannels.reduce((sum, ch) => sum + ch.conversationCount, 0)} conversations, ${enrichedChannels.reduce((sum, ch) => sum + ch.totalMessages, 0)} messages`;

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

/**
 * Social shape of a conversation: who is focused on whom, bids, centre, unattended
 */
export const getConversationFocus: DatabaseTool = {
	name: "getConversationFocus",
	description:
		"Get what is happening socially in a conversation: who is paying attention to whom, which pairs are talking to each other, who is the centre of attention, who keeps turning to someone who gives little back, whose bids for attention go unanswered. Reads the channel's active conversation, or its most recent finished one; pass conversationId for a specific one. Use this when asked about the dynamics, vibe or social situation of a conversation (as opposed to what it is about).",
	parameters: {
		type: "object",
		properties: {
			channel: {
				type: "string",
				description:
					"Channel ID or name (default: the current channel). Ignored when conversationId is given",
			},
			conversationId: {
				type: "string",
				description: "A specific conversation (segment) ID",
			},
		},
		required: [],
	},
	execute: async (params: Record<string, unknown>, context: ToolContext) => {
		try {
			const conversationId =
				typeof params.conversationId === "string" ? params.conversationId.trim() : "";
			let row: FocusRow | undefined;
			if (conversationId) {
				const result = await context.db.query(
					`${FOCUS_SELECT} WHERE guild_id = $1 AND id = $2`,
					[context.guildId, conversationId],
				);
				row = result.success ? result.data?.[0] : undefined;
			} else {
				const channelId = await resolveChannelId(params.channel, context);
				if (!channelId) return { success: false, error: "Channel not found" };
				const result = await context.db.query(
					`${FOCUS_SELECT}
					 WHERE guild_id = $1 AND channel_id = $2 AND focus IS NOT NULL
					 ORDER BY (status = 'active') DESC, end_time DESC LIMIT 1`,
					[context.guildId, channelId],
				);
				row = result.success ? result.data?.[0] : undefined;
			}
			if (!row) {
				return {
					success: true,
					summary: "No conversation found",
					data: { found: false },
					formatted: "No conversation with attention data found.",
				};
			}
			const focus = row.focus;
			if (!focus) {
				return {
					success: true,
					summary: "Conversation has no attention data yet",
					data: { found: true, hasFocus: false, conversationId: row.id },
					formatted: "This conversation has no attention data yet.",
				};
			}
			const focusIds = [
				...Object.keys(focus.matrix),
				...Object.values(focus.matrix).flatMap((r) => Object.keys(r)),
				...focus.bids.flatMap((b) => (b.to ? [b.from, b.to] : [b.from])),
			];
			const names = await loadNames(context, [...row.participants, ...focusIds]);
			const nameOf = (id: string) => names.get(id) ?? "Unknown User";
			const lines = describeFocus(focus, nameOf);
			const state = row.status === "active" ? "ongoing" : "finished";
			const formatted = [
				`Conversation (${state}, ${new Date(row.start_time).toLocaleString()} – ${new Date(row.end_time).toLocaleString()})${row.topic_label ? `: ${row.topic_label}` : ""}`,
				`Participants: ${row.participants.map(nameOf).join(", ")}`,
				...(lines.length ? lines : ["Nothing socially distinctive: no clear pairs, pursuits or unanswered bids."]),
			].join("\n");
			return {
				success: true,
				summary: `Social shape of a ${state} conversation with ${row.participants.length} participants`,
				data: {
					found: true,
					hasFocus: true,
					conversationId: row.id,
					status: row.status,
					participants: row.participants.map((userId) => ({
						userId,
						displayName: nameOf(userId),
					})),
					focus,
				},
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in getConversationFocus:", error);
			return {
				success: false,
				error: "Unable to retrieve conversation focus",
			};
		}
	},
};

export const liveConversationTools = [
	getLiveConversationContext,
	getConversationParticipantRelationships,
	getConversationFocus,
	getRecentChannelTopics,
	getServerActivitySummary,
];
