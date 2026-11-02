import type { DatabaseTool, ToolContext } from "../registry/DatabaseTools.js";
import { VoiceAssistantManager } from "../../../handlers/voice/VoiceAssistantManager.js";
import type { TextChannel, Webhook } from "discord.js";

/**
 * Music control tools for AI assistant
 * Allows AI to play music by sending commands to the music bot
 */

/**
 * Find a text channel to send messages to
 * Priority:
 * 1. Use context.channelId if it's a text channel
 * 2. Find text channel associated with voice channel (same name/category)
 * 3. Fallback to first text channel in guild
 */
async function findTextChannel(
	context: ToolContext,
	session: any
): Promise<TextChannel | null> {
	const { channelId, guildId } = context;
	const client = session.channel.client;

	if (!client) {
		return null;
	}

	const guild = await client.guilds.fetch(guildId);
	if (!guild) {
		return null;
	}

	// Try to use context.channelId if provided
	if (channelId) {
		try {
			const channel = await client.channels.fetch(channelId);
			if (channel && "send" in channel && channel.isTextBased()) {
				return channel as TextChannel;
			}
		} catch (error) {
			// Channel not found or not accessible, continue to other methods
		}
	}

	// Find text channel associated with voice channel
	const voiceChannel = session.channel;
	const voiceChannelName = voiceChannel.name.toLowerCase();
	const voiceParentId = voiceChannel.parentId;

	// Look for text channel with same name or in same category
	const textChannels = guild.channels.cache.filter(
		(ch: any) => ch.isTextBased() && !ch.isDMBased()
	) as any;

	// First, try to find channel with same name
	for (const [, channel] of textChannels) {
		if (channel.name.toLowerCase() === voiceChannelName) {
			return channel as TextChannel;
		}
	}

	// Then, try to find channel in same category
	if (voiceParentId) {
		for (const [, channel] of textChannels) {
			if (channel.parentId === voiceParentId) {
				return channel as TextChannel;
			}
		}
	}

	// Fallback to first text channel
	const firstTextChannel = textChannels.first();
	if (firstTextChannel && firstTextChannel.isTextBased()) {
		return firstTextChannel as TextChannel;
	}

	return null;
}

/**
 * Get or create a webhook for the channel
 * Webhooks are needed so messages appear to come from a user, not a bot
 */
async function getOrCreateWebhook(
	channel: TextChannel
): Promise<Webhook | null> {
	try {
		// Check if bot has permission to manage webhooks
		const permissions = channel.permissionsFor(channel.client.user);
		if (!permissions?.has("ManageWebhooks")) {
			console.error(
				"[MusicTools] Bot does not have permission to manage webhooks"
			);
			return null;
		}

		// Try to find an existing webhook for this channel
		const webhooks = await channel.fetchWebhooks();
		const existingWebhook = webhooks.find(
			(w) => w.owner?.id === channel.client.user?.id
		);

		if (existingWebhook) {
			return existingWebhook;
		}

		// Create a new webhook if none exists
		const webhook = await channel.createWebhook({
			name: "Ariya Music Bot",
			avatar: channel.client.user?.avatarURL() || undefined,
		});

		return webhook;
	} catch (error) {
		console.error("[MusicTools] Error getting/creating webhook:", error);
		return null;
	}
}

export const playMusicTool: DatabaseTool = {
	name: "playMusic",
	description:
		"Play a single song by sending a music bot command. Use this when the user asks to play a specific song (e.g., 'play stairway to heaven', 'play bohemian rhapsody').",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"The song name or search query to play (e.g., 'stairway to heaven', 'bohemian rhapsody queen')",
			},
		},
		required: ["query"],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;
		const { query } = params;

		if (!query || typeof query !== "string") {
			return JSON.stringify({
				success: false,
				error: "Song query is required",
			});
		}

		try {
			const voiceAssistant = VoiceAssistantManager.getInstance();

			// Check if bot is in voice channel
			if (!voiceAssistant.isInVoiceChannel(guildId)) {
				return JSON.stringify({
					success: false,
					error: "Bot is not currently in a voice channel",
				});
			}

			const session = voiceAssistant.getSession(guildId);
			if (!session) {
				return JSON.stringify({
					success: false,
					error: "Voice session not found",
				});
			}

			// Find text channel to send message to
			const textChannel = await findTextChannel(context, session);
			if (!textChannel) {
				return JSON.stringify({
					success: false,
					error: "Could not find a text channel to send the music command",
				});
			}

			// Get or create webhook for the channel
			const webhook = await getOrCreateWebhook(textChannel);
			if (!webhook) {
				return JSON.stringify({
					success: false,
					error: "Failed to get or create webhook for the channel",
				});
			}

			// Send music bot command via webhook
			await webhook.send(`m!p ${query}`);

			return JSON.stringify({
				success: true,
				message: `Queued song: ${query}`,
				channel: textChannel.name,
			});
		} catch (error) {
			console.error("[MusicTools] Error playing music:", error);
			return JSON.stringify({
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to play music",
			});
		}
	},
};

/**
 * Export all music tools for registration
 */
export const musicTools: DatabaseTool[] = [playMusicTool];

