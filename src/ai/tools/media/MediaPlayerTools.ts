import type { DatabaseTool, ToolContext, DatabaseToolResult } from "../registry/DatabaseTools.js";
import { MediaPlayerManager } from "../../../features/media-player/MediaPlayerManager.js";
import { VoiceAssistantManager } from "../../../handlers/voice/VoiceAssistantManager.js";
import { VoiceConnectionManager } from "../../../handlers/voice/tts/services/VoiceConnectionManager.js";
import { AIRequestBuilder } from "../../core/AIRequestBuilder.js";
import type { AIResponse } from "../../providers/base/AIProvider.js";
import type { TextChannel, VoiceChannel } from "discord.js";
import { ChannelType } from "discord.js";

/**
 * Media player control tools for AI assistant
 * Allows AI to control the built-in media player
 */

/**
 * Find text channel for media player
 * Uses the same improved matching logic as the play command
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

	// Discord voice channels have built-in text chat - use the voice channel directly!
	// Discord's API allows sending messages to voice channel IDs - they appear in the voice channel's text chat
	const voiceChannel = session.channel;

	// Use the voice channel directly as the text channel
	const textChannel = voiceChannel as any as TextChannel;

	return textChannel;
}

/**
 * Generate a haiku about experiencing the music query
 * Format: 5-7-5 syllables
 */
function generateMusicHaiku(query: string): string {
	const queryLower = query.toLowerCase();

	// Extract artist/song if in "song by artist" or "artist - song" format
	const byMatch = queryLower.match(/(.+?)\s+by\s+(.+)/);
	const dashMatch = queryLower.match(/(.+?)\s+-\s+(.+)/);

	let songPart = queryLower;
	let artistPart = "";

	if (byMatch) {
		songPart = byMatch[1]?.trim() ?? songPart;
		artistPart = byMatch[2]?.trim() ?? artistPart;
	} else if (dashMatch) {
		artistPart = dashMatch[1]?.trim() ?? artistPart;
		songPart = dashMatch[2]?.trim() ?? songPart;
	}

	// Simple haiku templates focused on the experience
	const haikus = [
		`Waves of sound now flow\nThrough speakers, filling the space\nMusic starts to play`,
		`Melody begins\nRhythm finds its way to ears\nSoundscape unfolds now`,
		`Notes begin to rise\nHarmony fills the silence\nMusic takes its place`,
		`Audio streams forth\nBeats and melodies combine\nSoundscape comes alive`,
		`Tune begins to play\nFilling empty air with sound\nMusic finds its way`,
	];

	// Return a random haiku
	return haikus[Math.floor(Math.random() * haikus.length)] ?? haikus[0]!;
}

export const playMediaTool: DatabaseTool = {
	name: "playMedia",
	description:
		"Play a song or search query using the built-in media player. Use this when the user asks to play music (e.g., 'play billy joel', 'play stairway to heaven'). The tool returns a haiku about experiencing the music - respond with ONLY that haiku, nothing else.",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"The song name, artist, or search query to play (e.g., 'billy joel', 'stairway to heaven', 'spongebob theme song')",
			},
		},
		required: ["query"],
	},
	async execute(params, context: ToolContext) {
		const { guildId, userId } = context;
		const { query } = params;

		if (!query || typeof query !== "string") {
			return {
				success: false,
				error: "Query is required",
			} as DatabaseToolResult;
		}

		try {
			const voiceAssistant = VoiceAssistantManager.getInstance();
			const mediaPlayer = MediaPlayerManager.getInstance();
			const connectionManager = VoiceConnectionManager.getInstance();

			// Get user's voice channel and join if not already in one
			let session = voiceAssistant.getSession(guildId);
			let voiceChannel: VoiceChannel | null = null;

			if (!session) {
				// Bot is not in a voice channel, try to join user's channel
				const client = mediaPlayer.getClient();
				if (!client) {
					return {
						success: false,
						error: "Bot client not available",
					} as DatabaseToolResult;
				}

				const guild = await client.guilds.fetch(guildId);
				if (!guild) {
					return {
						success: false,
						error: "Guild not found",
					} as DatabaseToolResult;
				}

				const member = await guild.members.fetch(userId);
				if (!member?.voice?.channel) {
					return {
						success: false,
						error: "You need to be in a voice channel first!",
					} as DatabaseToolResult;
				}

				voiceChannel = member.voice.channel as VoiceChannel;

				// Join the user's voice channel
				await connectionManager.joinChannel(voiceChannel);

				// Get the session after joining
				session = voiceAssistant.getSession(guildId);
				if (!session) {
					return {
						success: false,
						error: "Failed to join voice channel",
					} as DatabaseToolResult;
				}
			} else {
				voiceChannel = session.channel;
			}

			// Find text channel
			const textChannel = await findTextChannel(context, session);
			if (!textChannel) {
				return {
					success: false,
					error: "Could not find a text channel",
				} as DatabaseToolResult;
			}

			// Get user object
			const user = await session.channel.client.users.fetch(userId);

			// Play media
			const track = await mediaPlayer.play(
				guildId,
				query,
				user,
				textChannel,
				voiceChannel
			);

			if (!track) {
				return {
					success: false,
					error: `Could not find any results for "${query}"`,
				} as DatabaseToolResult;
			}

			// Generate haiku about experiencing the music
			const haiku = generateMusicHaiku(query);

			return {
				success: true,
				formatted: haiku,
				data: {
					track: {
						title: track.title,
						channel: track.channel,
						duration: track.durationFormatted,
					},
				},
			} as DatabaseToolResult;
		} catch (error) {
			console.error("[MediaPlayerTools] Error playing media:", error);
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Failed to play media",
			} as DatabaseToolResult;
		}
	},
};

export const pauseMediaTool: DatabaseTool = {
	name: "pauseMedia",
	description: "Pause the currently playing media.",
	parameters: {
		type: "object",
		properties: {},
		required: [],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;

		try {
			const mediaPlayer = MediaPlayerManager.getInstance();
			mediaPlayer.pause(guildId);

			return JSON.stringify({
				success: true,
				message: "Media paused",
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error pausing media:", error);
			return JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : "Failed to pause media",
			});
		}
	},
};

export const resumeMediaTool: DatabaseTool = {
	name: "resumeMedia",
	description: "Resume the paused media.",
	parameters: {
		type: "object",
		properties: {},
		required: [],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;

		try {
			const mediaPlayer = MediaPlayerManager.getInstance();
			mediaPlayer.resume(guildId);

			return JSON.stringify({
				success: true,
				message: "Media resumed",
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error resuming media:", error);
			return JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : "Failed to resume media",
			});
		}
	},
};

export const stopMediaTool: DatabaseTool = {
	name: "stopMedia",
	description: "Stop the currently playing media and clear the queue.",
	parameters: {
		type: "object",
		properties: {},
		required: [],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;

		try {
			const mediaPlayer = MediaPlayerManager.getInstance();
			await mediaPlayer.stop(guildId);

			return JSON.stringify({
				success: true,
				message: "Media stopped",
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error stopping media:", error);
			return JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : "Failed to stop media",
			});
		}
	},
};

export const skipMediaTool: DatabaseTool = {
	name: "skipMedia",
	description: "Skip to the next track in the queue.",
	parameters: {
		type: "object",
		properties: {},
		required: [],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;

		try {
			const mediaPlayer = MediaPlayerManager.getInstance();
			await mediaPlayer.skip(guildId);

			return JSON.stringify({
				success: true,
				message: "Skipped to next track",
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error skipping media:", error);
			return JSON.stringify({
				success: false,
				error: error instanceof Error ? error.message : "Failed to skip media",
			});
		}
	},
};

export const skipBackMediaTool: DatabaseTool = {
	name: "skipBackMedia",
	description: "Go back to the previous track.",
	parameters: {
		type: "object",
		properties: {},
		required: [],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;

		try {
			const mediaPlayer = MediaPlayerManager.getInstance();
			await mediaPlayer.skipBack(guildId);

			return JSON.stringify({
				success: true,
				message: "Went back to previous track",
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error skipping back:", error);
			return JSON.stringify({
				success: false,
				error:
					error instanceof Error ? error.message : "Failed to skip back",
			});
		}
	},
};

export const setVolumeTool: DatabaseTool = {
	name: "setVolume",
	description: "Set the media player volume (0-100).",
	parameters: {
		type: "object",
		properties: {
			volume: {
				type: "number",
				description: "Volume level from 0 to 100",
			},
		},
		required: ["volume"],
	},
	async execute(params, context: ToolContext) {
		const { guildId } = context;
		const { volume } = params;

		if (typeof volume !== "number" || volume < 0 || volume > 100) {
			return JSON.stringify({
				success: false,
				error: "Volume must be a number between 0 and 100",
			});
		}

		try {
			const mediaPlayer = MediaPlayerManager.getInstance();
			mediaPlayer.setVolume(guildId, volume);

			return JSON.stringify({
				success: true,
				message: `Volume set to ${volume}%`,
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error setting volume:", error);
			return JSON.stringify({
				success: false,
				error:
					error instanceof Error ? error.message : "Failed to set volume",
			});
		}
	},
};

export const generatePlaylistTool: DatabaseTool = {
	name: "generatePlaylist",
	description:
		"Generate a playlist based on a theme or description and add songs to the queue. Use this when the user asks for a playlist (e.g., 'give me a 10 song 80s playlist', 'playlist to kill nazi zombies to').",
	parameters: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description:
					"The playlist theme or description (e.g., '10 song 80s playlist', 'playlist to kill nazi zombies to', '20 songs for working out')",
			},
			count: {
				type: "number",
				description:
					"Number of songs to generate (optional, will be parsed from query if not provided). Defaults to 10, maximum 30.",
			},
		},
		required: ["query"],
	},
	async execute(params, context: ToolContext) {
		const { guildId, userId } = context;
		const { query, count: providedCount } = params;

		if (!query || typeof query !== "string") {
			return JSON.stringify({
				success: false,
				error: "Playlist query is required",
			});
		}

		try {
			const voiceAssistant = VoiceAssistantManager.getInstance();
			const mediaPlayer = MediaPlayerManager.getInstance();
			const connectionManager = VoiceConnectionManager.getInstance();

			// Get user's voice channel and join if not already in one
			let session = voiceAssistant.getSession(guildId);
			let voiceChannel: VoiceChannel | null = null;

			if (!session) {
				// Bot is not in a voice channel, try to join user's channel
				const client = mediaPlayer.getClient();
				if (!client) {
					return JSON.stringify({
						success: false,
						error: "Bot client not available",
					});
				}

				const guild = await client.guilds.fetch(guildId);
				if (!guild) {
					return JSON.stringify({
						success: false,
						error: "Guild not found",
					});
				}

				const member = await guild.members.fetch(userId);
				if (!member?.voice?.channel) {
					return JSON.stringify({
						success: false,
						error: "You need to be in a voice channel first!",
					});
				}

				voiceChannel = member.voice.channel as VoiceChannel;

				// Join the user's voice channel
				await connectionManager.joinChannel(voiceChannel);

				// Get the session after joining
				session = voiceAssistant.getSession(guildId);
				if (!session) {
					return JSON.stringify({
						success: false,
						error: "Failed to join voice channel",
					});
				}
			} else {
				voiceChannel = session.channel;
			}

			// Parse song count
			function parseSongCount(q: string): number {
				const patterns = [
					/(\d+)\s*(?:song|songs|track|tracks)/i,
					/(?:song|songs|track|tracks).*?(\d+)/i,
					/\b(\d+)\s*(?:song|track)/i,
				];

				for (const pattern of patterns) {
					const match = q.match(pattern);
					if (match && match[1]) {
						const count = parseInt(match[1], 10);
						if (count > 0 && count <= 30) {
							return count;
						}
					}
				}

				return 10; // Default
			}

			let songCount = providedCount
				? Math.min(Math.max(1, Math.floor(providedCount)), 30)
				: parseSongCount(query);

			songCount = Math.min(Math.max(1, songCount), 30);

			// Find text channel
			const textChannel = await findTextChannel(context, session);
			if (!textChannel) {
				return JSON.stringify({
					success: false,
					error: "Could not find a text channel",
				});
			}

			// Generate playlist using AI
			if (!context.aiEngine) {
				return JSON.stringify({
					success: false,
					error: "AI engine not available in tool context",
				});
			}

			const playlistPrompt = `Generate a playlist of exactly ${songCount} songs based on this request: "${query}"

Return ONLY a JSON array of song titles, one per line, in this exact format:
["Song Title 1", "Song Title 2", "Song Title 3", ...]

Do not include any explanations, descriptions, or additional text. Only return the JSON array.`;

			const builder = new AIRequestBuilder(context.aiEngine);
			const result = await builder
				.chat()
				.blocking()
				.provider("grok")
				.persona("casual")
				.withoutTools() // Don't need database tools for playlist generation
				.generate(playlistPrompt);

			const playlistResponse = result as AIResponse;

			if (!playlistResponse.success || !playlistResponse.content) {
				return JSON.stringify({
					success: false,
					error: "Failed to generate playlist",
				});
			}

			// Parse playlist from response
			let songs: string[] = [];
			const content = playlistResponse.content.trim();

			try {
				const jsonMatch = content.match(/\[[\s\S]*?\]/);
				if (jsonMatch) {
					songs = JSON.parse(jsonMatch[0]);
				} else {
					songs = JSON.parse(content);
				}

				if (!Array.isArray(songs)) {
					throw new Error("Response is not an array");
				}

				songs = songs
					.filter((s) => typeof s === "string" && s.trim().length > 0)
					.map((s) => s.trim())
					.slice(0, songCount);
			} catch (parseError) {
				const lines = content
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0 && !line.startsWith("```"));

				const cleanedLines = lines
					.map((line) =>
						line.replace(/^```(?:json)?/i, "").replace(/```$/, "")
					)
					.map((line) => line.trim())
					.filter((line) => line.length > 0);

				songs = cleanedLines
					.map((line) => {
						const quotedMatch = line.match(/["']([^"']+)["']/);
						if (quotedMatch && quotedMatch[1]) {
							return quotedMatch[1];
						}
						return line.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "");
					})
					.filter((s): s is string => typeof s === "string" && s.length > 0)
					.slice(0, songCount);
			}

			if (songs.length === 0) {
				return JSON.stringify({
					success: false,
					error: "Could not parse songs from playlist generation",
				});
			}

			// Get user object
			const user = await session.channel.client.users.fetch(userId);

			// Add songs to queue with 15-minute duration cap
			const addedTracks: string[] = [];
			const maxDurationSeconds = 15 * 60; // 15 minutes
			let totalDuration = 0;

			for (const song of songs) {
				// Check if we've reached the duration limit
				if (totalDuration >= maxDurationSeconds) {
					break;
				}

				const track = await mediaPlayer.play(
					guildId,
					song,
					user,
					textChannel,
					voiceChannel
				);
				if (track) {
					addedTracks.push(track.title);
					totalDuration += track.duration || 0;

					// Stop if adding this track exceeded the limit
					if (totalDuration >= maxDurationSeconds) {
						break;
					}
				}
			}

			return JSON.stringify({
				success: true,
				message: `Generated and queued ${addedTracks.length} songs (${Math.floor(totalDuration / 60)}:${String(Math.floor(totalDuration % 60)).padStart(2, '0')})`,
				songCount: addedTracks.length,
				songs: addedTracks,
			});
		} catch (error) {
			console.error("[MediaPlayerTools] Error generating playlist:", error);
			return JSON.stringify({
				success: false,
				error:
					error instanceof Error
						? error.message
						: "Failed to generate playlist",
			});
		}
	},
};

/**
 * Export all media player tools for registration
 */
export const mediaPlayerTools: DatabaseTool[] = [
	playMediaTool,
	pauseMediaTool,
	resumeMediaTool,
	stopMediaTool,
	skipMediaTool,
	skipBackMediaTool,
	setVolumeTool,
	generatePlaylistTool,
];

