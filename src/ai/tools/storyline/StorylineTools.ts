import type { DatabaseTool, ToolContext } from "../registry/DatabaseTools.js";

/**
 * Enhanced storyline aggregation with thematic clustering
 * Groups conversations by semantic themes and identifies narrative arcs
 */
export const getStorylineAggregation: DatabaseTool = {
	name: "getStorylineAggregation",
	description:
		"Get an aggregated view of recent server activity with conversations grouped by themes and topics. Returns thematic summaries only. For detailed analysis with full message content (especially for server summaries or drama), use getRecentConversationMessages instead.",
	parameters: {
		type: "object",
		properties: {
			lookbackHours: {
				type: "number",
				description:
					"How many hours to look back for storylines (default: 48, max: 336 for 14 days)",
			},
			minConversationSize: {
				type: "number",
				description:
					"Minimum messages in a conversation to include (default: 3)",
			},
			includeChannelBreakdown: {
				type: "boolean",
				description:
					"Include breakdown by channel (default: true)",
			},
		},
		required: [],
	},
	execute: async (params: any, context: ToolContext) => {
		try {
			const lookbackHours = Math.min(params.lookbackHours || 48, 336);
			const minConversationSize = params.minConversationSize || 3;
			const includeChannelBreakdown = params.includeChannelBreakdown !== false;

			const lookbackTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

			// Get all finalized conversation segments in the time window
			const segmentsResult = await context.db.query(
				`SELECT
          id,
          channel_id,
          participants,
          start_time,
          end_time,
          message_count,
          topic_label,
          summary,
          message_ids,
          status
        FROM conversation_segments
        WHERE guild_id = $1
          AND end_time >= $2
          AND message_count >= $3
          AND status = 'finalized'
        ORDER BY start_time ASC`,
				[context.guildId, lookbackTime, minConversationSize]
			);

			if (
				!segmentsResult.success ||
				!segmentsResult.data ||
				segmentsResult.data.length === 0
			) {
				return {
					success: true,
					summary: "No significant storylines found in the time window",
					data: { storylines: [], themes: [], channels: [] },
					formatted: `No storylines detected in the past ${lookbackHours} hours.`,
				};
			}

			const segments = segmentsResult.data;

			// Get channel names for all segments
			const channelIds = Array.from(
				new Set(segments.map((s: any) => s.channel_id))
			);
			const channelsResult = await context.db.query(
				`SELECT id, name, type FROM channels WHERE guild_id = $1 AND id = ANY($2::text[])`,
				[context.guildId, channelIds]
			);

			const channelMap = new Map<string, string>();
			if (channelsResult.success && channelsResult.data) {
				for (const ch of channelsResult.data) {
					channelMap.set(ch.id, ch.name);
				}
			}

			// Get unique participant user IDs across all segments
			const allParticipantIds = new Set<string>();
			for (const seg of segments) {
				const participantIds = seg.participants || [];
				for (const pid of participantIds) {
					allParticipantIds.add(pid);
				}
			}

			// Resolve participant names in bulk
			const participantNamesResult = await context.db.query(
				`SELECT user_id, display_name, username, global_name
         FROM members
         WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
				[context.guildId, Array.from(allParticipantIds)]
			);

			const participantNameMap = new Map<string, string>();
			if (participantNamesResult.success && participantNamesResult.data) {
				for (const p of participantNamesResult.data) {
					participantNameMap.set(
						p.user_id,
						p.display_name || p.global_name || p.username || "Unknown"
					);
				}
			}

			// Analyze segments for thematic clustering
			const themeClusters = new Map<
				string,
				Array<{
					segment: any;
					channelName: string;
					participantNames: string[];
				}>
			>();

			// Cluster by the summarizer's topic label; segments without one fall back to the
			// opening words of their summary
			for (const seg of segments) {
				const summary = (seg.summary || "").trim();
				const channelName = channelMap.get(seg.channel_id) || seg.channel_id;
				const participantNames = (seg.participants || [])
					.map((pid: string) => participantNameMap.get(pid) || pid)
					.filter((name: string) => name !== "Unknown");

				const label = typeof seg.topic_label === "string" ? seg.topic_label.trim().toLowerCase() : "";
				let theme = label;
				if (!theme && summary.length > 20) {
					theme = summary
						.toLowerCase()
						.split(/\s+/)
						.filter((w: string) => w.length > 3)
						.slice(0, 3)
						.join(" ");
				}
				if (!theme) theme = "unlabeled";

				// Group by theme
				if (!themeClusters.has(theme)) {
					themeClusters.set(theme, []);
				}

				themeClusters.get(theme)?.push({
					segment: seg,
					channelName,
					participantNames,
				});
			}

			// Create theme summaries
			const themes = Array.from(themeClusters.entries())
				.map(([themeName, conversations]) => {
					const totalMessages = conversations.reduce(
						(sum, c) => sum + (c.segment.message_count || 0),
						0
					);
					const uniqueParticipants = new Set<string>();
					for (const conv of conversations) {
						for (const name of conv.participantNames) {
							uniqueParticipants.add(name);
						}
					}

					// Calculate time span
					const times = conversations.map((c) => ({
						start: new Date(c.segment.start_time),
						end: new Date(c.segment.end_time),
					}));
					const earliest = new Date(
						Math.min(...times.map((t) => t.start.getTime()))
					);
					const latest = new Date(Math.max(...times.map((t) => t.end.getTime())));

					return {
						theme: themeName,
						conversationCount: conversations.length,
						totalMessages,
						uniqueParticipants: Array.from(uniqueParticipants),
						participantCount: uniqueParticipants.size,
						firstOccurrence: earliest,
						lastOccurrence: latest,
						conversations: conversations.slice(0, 5), // Include up to 5 sample conversations per theme
					};
				})
				.sort((a, b) => b.totalMessages - a.totalMessages); // Sort by message volume

			// Channel breakdown
			let channelBreakdown: any[] = [];
			if (includeChannelBreakdown) {
				const channelStats = new Map<
					string,
					{ name: string; messages: number; conversations: number }
				>();

				for (const seg of segments) {
					const channelName = channelMap.get(seg.channel_id) || seg.channel_id;
					if (!channelStats.has(seg.channel_id)) {
						channelStats.set(seg.channel_id, {
							name: channelName,
							messages: 0,
							conversations: 0,
						});
					}

					const stats = channelStats.get(seg.channel_id)!;
					stats.messages += seg.message_count || 0;
					stats.conversations += 1;
				}

				channelBreakdown = Array.from(channelStats.values()).sort(
					(a, b) => b.messages - a.messages
				);
			}

			// Format output
			let formatted = `Storyline Aggregation (past ${lookbackHours}h):\n\n`;

			formatted += `📊 OVERVIEW:\n`;
			formatted += `   Total Conversations: ${segments.length}\n`;
			formatted += `   Total Messages: ${segments.reduce((sum: number, s: any) => sum + (s.message_count || 0), 0)}\n`;
			formatted += `   Unique Themes: ${themes.length}\n`;
			formatted += `   Active Participants: ${allParticipantIds.size}\n\n`;

			formatted += `🎭 THEMES (${themes.length} identified):\n\n`;

			for (const [idx, theme] of themes.entries()) {
				const timeSpanHours = Math.round(
					(theme.lastOccurrence.getTime() - theme.firstOccurrence.getTime()) /
						(1000 * 60 * 60)
				);

				formatted += `${idx + 1}. ${theme.theme.toUpperCase().replace(/-/g, " ")}\n`;
				formatted += `   Volume: ${theme.conversationCount} conversations, ${theme.totalMessages} messages\n`;
				formatted += `   Participants: ${theme.participantCount} unique users\n`;
				formatted += `   Time Span: ${timeSpanHours}h (${formatTimeAgo(theme.firstOccurrence)} to ${formatTimeAgo(theme.lastOccurrence)})\n`;

				if (theme.conversations.length > 0) {
					formatted += `   Sample Conversations:\n`;
					for (const conv of theme.conversations.slice(0, 3)) {
						const duration = Math.round(
							(new Date(conv.segment.end_time).getTime() -
								new Date(conv.segment.start_time).getTime()) /
								(1000 * 60)
						);
						formatted += `     • #${conv.channelName}: ${conv.participantNames.slice(0, 3).join(", ")}${conv.participantNames.length > 3 ? ` +${conv.participantNames.length - 3} more` : ""} (${conv.segment.message_count} msgs, ${duration}m)\n`;
						if (conv.segment.summary) {
							formatted += `       ${conv.segment.summary.substring(0, 100)}${conv.segment.summary.length > 100 ? "..." : ""}\n`;
						}
					}
				}
				formatted += `\n`;
			}

			if (includeChannelBreakdown && channelBreakdown.length > 0) {
				formatted += `📍 CHANNEL BREAKDOWN:\n\n`;
				for (const [idx, ch] of channelBreakdown.entries()) {
					formatted += `${idx + 1}. #${ch.name}: ${ch.conversations} conversations, ${ch.messages} messages\n`;
				}
				formatted += `\n`;
			}

			// Identify narrative arcs (themes that evolved over time)
			const narrativeArcs: string[] = [];
			for (const theme of themes) {
				if (theme.conversationCount >= 3) {
					const timeSpanHours = Math.round(
						(theme.lastOccurrence.getTime() - theme.firstOccurrence.getTime()) /
							(1000 * 60 * 60)
					);
					if (timeSpanHours >= 6) {
						narrativeArcs.push(
							`${theme.theme}: ${theme.conversationCount} conversations over ${timeSpanHours}h`
						);
					}
				}
			}

			if (narrativeArcs.length > 0) {
				formatted += `🎬 NARRATIVE ARCS (recurring themes):\n`;
				for (const arc of narrativeArcs) {
					formatted += `   • ${arc}\n`;
				}
			}

			return {
				success: true,
				summary: `Identified ${themes.length} thematic storylines across ${segments.length} conversations`,
				data: {
					themes,
					channelBreakdown,
					narrativeArcs,
					totalConversations: segments.length,
					totalMessages: segments.reduce(
						(sum: number, s: any) => sum + (s.message_count || 0),
						0
					),
					lookbackHours,
				},
				formatted,
			};
		} catch (error) {
			console.error("🔸 Error in getStorylineAggregation:", error);
			return {
				success: false,
				error: "Unable to generate storyline aggregation",
			};
		}
	},
};

/**
 * Helper function to format time ago
 */
function formatTimeAgo(date: Date): string {
	const now = new Date();
	const hoursAgo = Math.round((now.getTime() - date.getTime()) / (1000 * 60 * 60));

	if (hoursAgo < 1) return "just now";
	if (hoursAgo === 1) return "1h ago";
	if (hoursAgo < 24) return `${hoursAgo}h ago`;

	const daysAgo = Math.floor(hoursAgo / 24);
	if (daysAgo === 1) return "1d ago";
	return `${daysAgo}d ago`;
}

export const storylineTools = [getStorylineAggregation];
