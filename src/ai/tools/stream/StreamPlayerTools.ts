import type {
  DatabaseTool,
  ToolContext,
  DatabaseToolResult,
} from "../registry/DatabaseTools.js";
import { StreamPlayerManager } from "../../../features/stream-chrome/StreamPlayerManager.js";
import { StreamController } from "../../../features/stream-chrome/core/StreamController.js";
import { PlaybackAction } from "../../../features/stream-chrome/types/playback.js";
import { parseTimeString } from "../../../features/stream-chrome/utils/timeParser.js";
import type { SearchResult } from "../../../features/stream-chrome/types.js";
import type { VoiceChannel } from "discord.js";
import { ChannelType } from "discord.js";

/**
 * Stream player tools for AI assistant
 * Allows AI to stream video content to voice channels
 */

// Lock to prevent concurrent tool executions for the same guild+query
const executionLocks = new Map<string, Promise<any>>();

/**
 * Get a lock key for a request
 */
function getLockKey(guildId: string, query: string): string {
  return `${guildId}:${query.toLowerCase().trim()}`;
}

/**
 * Find voice channel from context
 */
async function findVoiceChannel(
  context: ToolContext,
  channelId?: string
): Promise<VoiceChannel | null> {
  if (!context.guildId) {
    return null;
  }

  // Try to get client from context (would need to be passed in)
  // For now, we'll need to get it from StreamPlayerManager
  const streamManager = StreamPlayerManager.getInstance();
  const session = streamManager.getActiveSession(context.guildId);

  if (channelId) {
    try {
      // This would need client access - we'll need to modify context or manager
      // For now, return null and handle in tool execution
      return null;
    } catch (error) {
      return null;
    }
  }

  return null;
}

export const streamContentTool: DatabaseTool = {
  name: "streamContent",
  description:
    "Stream video content to Discord voice channel. Supports YouTube, Jellyfin, 123movies, Christmas movies. Use: 'stream the simpsons', 'stream xyz on youtube', 'stream christmas movie'. Can include provider in query like 'stream xyz on youtube' or specify provider parameter.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Content to stream. Can include provider: 'xyz on youtube', 'simpsons s01e03', 'christmas movie'. Supports natural language queries.",
      },
      provider: {
        type: "string",
        description:
          "Optional provider override: 'youtube', 'jellyfin', '123movies', 'christmas-movies'. If not specified, will auto-detect from query or use default.",
        enum: ["youtube", "jellyfin", "123movies", "christmas-movies"],
      },
      channelId: {
        type: "string",
        description:
          "Optional voice channel ID to stream to. If not provided, will use the user's current voice channel.",
      },
    },
    required: ["query"],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      const { query, channelId, provider } = params;

      if (!query || typeof query !== "string") {
        return {
          success: false,
          error: "Query parameter is required",
        };
      }

      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      // Get voice channel - auto-detect user's voice channel if not specified
      let voiceChannelId: string;

      if (channelId) {
        voiceChannelId = channelId;
      } else {
        // Try to find user's current voice channel
        const streamManager = StreamPlayerManager.getInstance();
        const client = (streamManager as any).client;

        if (!client) {
          return {
            success: false,
            error: "Bot client not available. Please specify a voice channel.",
          };
        }

        const guild = await client.guilds.fetch(context.guildId);
        if (!guild) {
          return {
            success: false,
            error: "Guild not found",
          };
        }

        // Get the user's voice channel
        const member = await guild.members.fetch(context.userId);
        if (!member?.voice?.channel) {
          return {
            success: false,
            error:
              "You need to be in a voice channel first! Please join a voice channel or specify which channel to stream to.",
          };
        }

        voiceChannelId = member.voice.channel.id;
        console.log(
          `[StreamPlayerTools] Auto-detected user's voice channel: ${member.voice.channel.name} (${voiceChannelId})`
        );
      }

      // Use StreamController for new architecture
      const controller = StreamController.getInstance();
      
      // Auto-detect provider based on query (ProviderRouter will handle this)
      // ProviderRouter will detect "on youtube", "from jellyfin", etc.
      // Also handles heuristic detection like "christmas" → christmas-movies
      
      const result = await controller.streamContent({
        guildId: context.guildId,
        voiceChannelId,
        query,
        provider: provider as string | undefined, // Optional explicit provider override
      });

      if (result.success) {
        // If multiple results found, format them for user selection
        if (result.requiresSelection && result.searchResults) {
          const optionsText = result.searchResults
            .map(
              (r, i) => `${i + 1}. ${r.title}${r.year ? ` (${r.year})` : ""}`
            )
            .join("\n");

          const formattedMessage = `${result.message}\n\n${optionsText}\n\nReply with the number (1-${result.searchResults.length}) or a description to select.\n\n[IMPORTANT: When the user replies with a selection, you MUST immediately call the selectContent tool with their selection.]`;

          return {
            success: true,
            formatted: formattedMessage,
            summary: `Found ${result.searchResults.length} results. Waiting for user selection. When user replies with a selection, call selectContent tool.`,
            data: {
              searchResults: result.searchResults,
              requiresSelection: true,
            },
          };
        }

        return {
          success: true,
          formatted: result.message,
          summary: `Started streaming "${query}"`,
        };
      } else {
        return {
          success: false,
          error: result.error || result.message,
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in streamContent:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to start stream",
      };
    }
  },
};

export const selectContentTool: DatabaseTool = {
  name: "selectContent",
  description:
    "IMPORTANT: Use this tool when the user replies with a selection after you have presented them with multiple search results for streaming. Supports numeric selection ('1', '2', 'option 3', 'the second one') and fuzzy name matching ('the one with homer', 'simpsons s01e03'). Always call this tool immediately when the user provides a selection.",
  parameters: {
    type: "object",
    properties: {
      selection: {
        type: "string",
        description:
          "The user's selection - can be a number ('2', 'option 3'), ordinal text ('the second one'), or fuzzy description ('the one with homer', 'simpsons season 1 episode 3').",
      },
    },
    required: ["selection"],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    console.log(
      "[StreamPlayerTools] selectContent called with params:",
      params
    );

    try {
      if (!context.guildId) {
        console.error("[StreamPlayerTools] No guildId in context");
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const { selection } = params;
      console.log(`[StreamPlayerTools] Processing selection: "${selection}"`);

      if (!selection) {
        return {
          success: false,
          error: "Selection is required",
        };
      }

      // Use StreamController for unified selection (supports both numeric and fuzzy)
      const controller = StreamController.getInstance();
      const result = await controller.selectContent(context.guildId, selection);

      console.log(
        `[StreamPlayerTools] selectContent result: success=${result.success}, message=${result.message}`
      );

      if (result.success) {
        return {
          success: true,
          formatted: result.message,
          summary: `Selected and started streaming: "${selection}"`,
        };
      } else {
        return {
          success: false,
          error: result.error || result.message,
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in selectContent:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to select result",
      };
    }
  },
};


export const stopStreamTool: DatabaseTool = {
  name: "stopStream",
  description:
    "Stop, close, or end the current stream if one is playing. Use this when the user asks to stop, close, or end streaming. Common phrases include: 'stop stream', 'close stream', 'end stream', 'stop the stream', 'close the stream', 'end the stream', 'stop streaming', 'quit stream', 'cancel stream'. Always call this tool when the user wants to stop any active stream.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const streamManager = StreamPlayerManager.getInstance();

      // Check if a stream is active (in any state)
      if (!streamManager.isStreaming(context.guildId)) {
        return {
          success: false,
          error: "No stream is currently active",
        };
      }

      // Stop the stream (works for any active state)
      await streamManager.stopStream(context.guildId);

      return {
        success: true,
        formatted: "🔹 Stream stopped successfully.",
        summary: "Stopped the current stream",
      };
    } catch (error) {
      console.error("[StreamPlayerTools] Error in stopStream:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to stop stream",
      };
    }
  },
};

export const searchYouTubeTool: DatabaseTool = {
  name: "searchYouTube",
  description:
    "Search YouTube for videos and stream them to a voice channel. Use this when the user asks to stream, play, or search YouTube content (e.g., 'stream youtube', 'stream [query] from youtube', 'play youtube video', 'search youtube for X', 'find video on youtube'). If the user says just 'stream youtube' without a specific video query, you should ask them what they want to search for before calling this tool. IMPORTANT: Call this tool ONCE when the user wants to search YouTube. The tool will automatically detect if the user is in a voice channel. If the user is not in a voice channel, the search will still work and you can ask them to join one when they select a video. Do NOT call this tool multiple times for the same request.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query for YouTube (e.g., 'charlie the unicorn', 'funny cat videos', 'tutorial python'). This is required - if the user didn't specify what to search for, ask them first before calling this tool.",
      },
      channelId: {
        type: "string",
        description:
          "Optional voice channel ID to stream to. If not provided, will try to auto-detect the user's current voice channel. If user is not in a voice channel, the search will still proceed and voice channel will be needed when user selects a video.",
      },
    },
    required: ["query"],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    const { query, channelId } = params;

    if (!query || typeof query !== "string") {
      return {
        success: false,
        error: "Query parameter is required",
      };
    }

    if (!context.guildId) {
      return {
        success: false,
        error: "Guild context required",
      };
    }

    // Check for existing execution lock (prevent concurrent calls)
    const lockKey = getLockKey(context.guildId, query);
    const existingLock = executionLocks.get(lockKey);
    if (existingLock) {
      console.log(
        `[StreamPlayerTools] Concurrent request detected for "${query}", waiting for existing execution...`
      );
      try {
        const existingResult = await existingLock;
        // If the existing execution returned results, return those
        if (
          existingResult &&
          typeof existingResult === "object" &&
          "success" in existingResult &&
          existingResult.success
        ) {
          return existingResult;
        }
      } catch (error) {
        // If existing execution failed, continue with new execution
        console.log(
          `[StreamPlayerTools] Existing execution failed, proceeding with new request`
        );
      }
    }

    // Check if there's already an active search session for this query
    const streamManagerCheck = StreamPlayerManager.getInstance();
    const existingSession = streamManagerCheck.getActiveSession(
      context.guildId
    );
    if (
      existingSession &&
      existingSession.state === "searching" &&
      existingSession.query.toLowerCase() === query.toLowerCase()
    ) {
      console.log(
        `[StreamPlayerTools] Active search session found for "${query}", returning existing results`
      );
      const searchResults = (existingSession as any).pendingSearchResults as
        | SearchResult[]
        | undefined;
      if (searchResults && searchResults.length > 0) {
        const optionsText = searchResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}${r.description ? ` - ${r.description}` : ""
              }`
          )
          .join("\n");

        const formattedMessage = `Found ${searchResults.length} results for "${query}". Please select one:\n\n${optionsText}\n\nReply with the number (1-${searchResults.length}) to select.`;

        return {
          success: true,
          formatted: formattedMessage,
          summary: `Found ${searchResults.length} YouTube results (returning existing results).`,
          data: {
            searchResults,
            requiresSelection: true,
          },
        };
      }
    }

    // Create execution lock
    const executionPromise = (async (): Promise<
      string | DatabaseToolResult
    > => {
      try {
        // Get voice channel - auto-detect user's voice channel if not specified
        // But don't fail if user is not in a voice channel - we'll need it later when they select
        let voiceChannelId: string | undefined;

        if (channelId) {
          voiceChannelId = channelId;
        } else {
          // Try to find user's current voice channel
          const streamManager = StreamPlayerManager.getInstance();
          const client = (streamManager as any).client;

          if (client) {
            try {
              const guild = await client.guilds.fetch(context.guildId);
              if (guild) {
                const member = await guild.members.fetch(context.userId);
                if (member?.voice?.channel) {
                  voiceChannelId = member.voice.channel.id;
                  console.log(
                    `[StreamPlayerTools] Auto-detected user's voice channel: ${member.voice.channel.name} (${voiceChannelId})`
                  );
                } else {
                  console.log(
                    `[StreamPlayerTools] User is not in a voice channel, will need it when they select a video`
                  );
                }
              }
            } catch (error) {
              console.warn(
                `[StreamPlayerTools] Could not fetch voice channel info:`,
                error
              );
              // Continue without voice channel - we'll need it later
            }
          }
        }

        // If no voice channel found, we can still search, but we'll need it later
        if (!voiceChannelId) {
          console.log(
            `[StreamPlayerTools] No voice channel specified or detected, proceeding with search anyway`
          );
        }

        // Stream content with YouTube provider
        const streamManager = StreamPlayerManager.getInstance();

        // If no voice channel detected, we still want to search, but we'll need it later
        // For now, we'll use a placeholder or try to get it one more time
        if (!voiceChannelId) {
          // Try one more time to get voice channel
          const client = (streamManager as any).client;
          if (client) {
            try {
              const guild = await client.guilds.fetch(context.guildId);
              const member = await guild.members.fetch(context.userId);
              if (member?.voice?.channel) {
                voiceChannelId = member.voice.channel.id;
              }
            } catch (error) {
              // Ignore
            }
          }
        }

        // If still no voice channel, we can't proceed with streaming
        // But we should still try to search and show results, then ask for voice channel
        if (!voiceChannelId) {
          // For now, we need a voice channel to proceed
          // In the future, we could modify streamContent to allow search without voice channel
          return {
            success: false,
            error:
              "You need to be in a voice channel to stream videos. Please join a voice channel first, then try again.",
          };
        }

        const result = await streamManager.streamContent({
          guildId: context.guildId,
          voiceChannelId,
          query,
          provider: "youtube", // Use YouTube provider
        });

        if (result.success) {
          // If multiple results found, format them for user selection
          if (result.requiresSelection && result.searchResults) {
            const optionsText = result.searchResults
              .map(
                (r, i) =>
                  `${i + 1}. ${r.title}${r.description ? ` - ${r.description}` : ""
                  }`
              )
              .join("\n");

            const formattedMessage = `Found ${result.searchResults.length} results for "${query}". Please select one:\n\n${optionsText}\n\nReply with the number (1-${result.searchResults.length}) to select.`;

            return {
              success: true,
              formatted: formattedMessage,
              summary: `Found ${result.searchResults.length} YouTube results. Waiting for user selection.`,
              data: {
                searchResults: result.searchResults,
                requiresSelection: true,
              },
            };
          }

          return {
            success: true,
            formatted: result.message,
            summary: `Started streaming YouTube video "${query}"`,
          };
        } else {
          return {
            success: false,
            error: result.error || result.message,
          };
        }
      } catch (error) {
        console.error("[StreamPlayerTools] Error in searchYouTube:", error);
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to search YouTube",
        };
      } finally {
        // Remove lock after execution completes
        executionLocks.delete(lockKey);
      }
    })();

    // Store the lock
    executionLocks.set(lockKey, executionPromise);

    // Return the result
    return executionPromise;
  },
};

export const searchJellyfinTool: DatabaseTool = {
  name: "searchJellyfin",
  description:
    "Search Jellyfin for movies or TV shows and stream them to a Discord voice channel. Use this when the user asks to stream, play, or search Jellyfin content (e.g., 'stream jellyfin', 'stream [query] from jellyfin', 'play movie from jellyfin', 'search jellyfin for X'). If the user says just 'stream jellyfin' without a specific movie/show query, you should ask them what they want to search for before calling this tool.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query for Jellyfin (e.g., 'the labyrinth', 'apocalypse now', 'the simpsons'). This is required - if the user didn't specify what to search for, ask them first before calling this tool.",
      },
      channelId: {
        type: "string",
        description:
          "Optional voice channel ID to stream to. If not provided, will use the user's current voice channel.",
      },
    },
    required: ["query"],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      const { query, channelId } = params;

      if (!query || typeof query !== "string") {
        return {
          success: false,
          error: "Query parameter is required",
        };
      }

      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      // Get voice channel - auto-detect user's voice channel if not specified
      let voiceChannelId: string;

      if (channelId) {
        voiceChannelId = channelId;
      } else {
        // Try to find user's current voice channel
        const streamManager = StreamPlayerManager.getInstance();
        const client = (streamManager as any).client;

        if (!client) {
          return {
            success: false,
            error: "Bot client not available. Please specify a voice channel.",
          };
        }

        const guild = await client.guilds.fetch(context.guildId);
        if (!guild) {
          return {
            success: false,
            error: "Guild not found",
          };
        }

        // Get the user's voice channel
        const member = await guild.members.fetch(context.userId);
        if (!member?.voice?.channel) {
          return {
            success: false,
            error:
              "You need to be in a voice channel first! Please join a voice channel or specify which channel to stream to.",
          };
        }

        voiceChannelId = member.voice.channel.id;
        console.log(
          `[StreamPlayerTools] Auto-detected user's voice channel: ${member.voice.channel.name} (${voiceChannelId})`
        );
      }

      // Stream content with Jellyfin provider
      const streamManager = StreamPlayerManager.getInstance();
      const result = await streamManager.streamContent({
        guildId: context.guildId,
        voiceChannelId,
        query,
        provider: "jellyfin", // Use Jellyfin provider
      });

      if (result.success) {
        // If multiple results found, format them for user selection
        if (result.requiresSelection && result.searchResults) {
          const optionsText = result.searchResults
            .map(
              (r, i) =>
                `${i + 1}. ${r.title}${r.year ? ` (${r.year})` : ""}${r.description ? ` - ${r.description}` : ""
                }`
            )
            .join("\n");

          const formattedMessage = `${result.message}\n\n${optionsText}\n\nReply with the number (1-${result.searchResults.length}) or a description to select.\n\n[IMPORTANT: When the user replies with a selection, you MUST immediately call the selectContent tool with their selection.]`;

          return {
            success: true,
            formatted: formattedMessage,
            summary: `Found ${result.searchResults.length} Jellyfin results. Waiting for user selection. When user replies with a selection, call selectContent tool.`,
            data: {
              searchResults: result.searchResults,
              requiresSelection: true,
            },
          };
        }

        return {
          success: true,
          formatted: result.message,
          summary: `Started streaming Jellyfin content "${query}"`,
        };
      } else {
        return {
          success: false,
          error: result.error || result.message,
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in searchJellyfin:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to search Jellyfin",
      };
    }
  },
};

// Playback control tools
export const pauseStreamTool: DatabaseTool = {
  name: "pauseStream",
  description:
    "Pause the current stream. Use when user asks to pause, stop playback temporarily, or put stream on hold.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.PAUSE
      );

      if (result.success) {
        return {
          success: true,
          formatted: "⏸️ Stream paused.",
          summary: "Paused the current stream",
        };
      } else {
        return {
          success: false,
          error: result.error || "Failed to pause stream",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in pauseStream:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to pause stream",
      };
    }
  },
};

export const resumeStreamTool: DatabaseTool = {
  name: "resumeStream",
  description:
    "Resume, unpause, continue, or play the current stream. Use when user asks to resume, continue, unpause, or play after pausing.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.RESUME
      );

      if (result.success) {
        return {
          success: true,
          formatted: "▶️ Stream resumed.",
          summary: "Resumed the current stream",
        };
      } else {
        return {
          success: false,
          error: result.error || "Failed to resume stream",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in resumeStream:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to resume stream",
      };
    }
  },
};

export const seekStreamTool: DatabaseTool = {
  name: "seekStream",
  description:
    "Seek to a specific time in the stream. Use when user asks to go to a specific time like 'go to 5:30', 'seek to 1:30:00', 'jump to 90 seconds'.",
  parameters: {
    type: "object",
    properties: {
      time: {
        type: "string",
        description:
          "Time to seek to. Supports formats: '5:30' (5 min 30 sec), '1:30:00' (1 hour 30 min), '90s' (90 seconds), '1h30m' (1 hour 30 min).",
      },
    },
    required: ["time"],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const { time } = params;
      if (!time || typeof time !== "string") {
        return {
          success: false,
          error: "Time parameter is required",
        };
      }

      const seconds = parseTimeString(time);
      if (seconds === null) {
        return {
          success: false,
          error: `Invalid time format: "${time}". Use formats like "5:30", "1:30:00", "90s", or "1h30m".`,
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.SEEK,
        { position: seconds }
      );

      if (result.success) {
        return {
          success: true,
          formatted: `⏩ Seeked to ${time}.`,
          summary: `Seeked stream to ${time}`,
        };
      } else {
        return {
          success: false,
          error: result.error || "Failed to seek stream",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in seekStream:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to seek stream",
      };
    }
  },
};

export const skipForwardTool: DatabaseTool = {
  name: "skipForward",
  description:
    "Skip forward N seconds in the stream. Use when user asks to skip ahead, fast forward, or jump forward.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description:
          "Number of seconds to skip forward. Default is 10 if not specified.",
      },
    },
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const seconds = params.seconds || 10;
      if (typeof seconds !== "number" || seconds < 0) {
        return {
          success: false,
          error: "Seconds must be a positive number",
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.SKIP_FORWARD,
        { seconds }
      );

      if (result.success) {
        return {
          success: true,
          formatted: `⏩ Skipped forward ${seconds} seconds.`,
          summary: `Skipped forward ${seconds} seconds`,
        };
      } else {
        return {
          success: false,
          error: result.error || "Failed to skip forward",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in skipForward:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to skip forward",
      };
    }
  },
};

export const skipBackwardTool: DatabaseTool = {
  name: "skipBackward",
  description:
    "Skip backward N seconds in the stream. Use when user asks to rewind, go back, or jump backward.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description:
          "Number of seconds to skip backward. Default is 10 if not specified.",
      },
    },
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const seconds = params.seconds || 10;
      if (typeof seconds !== "number" || seconds < 0) {
        return {
          success: false,
          error: "Seconds must be a positive number",
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.SKIP_BACKWARD,
        { seconds }
      );

      if (result.success) {
        return {
          success: true,
          formatted: `⏪ Skipped backward ${seconds} seconds.`,
          summary: `Skipped backward ${seconds} seconds`,
        };
      } else {
        return {
          success: false,
          error: result.error || "Failed to skip backward",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in skipBackward:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to skip backward",
      };
    }
  },
};

export const restartStreamTool: DatabaseTool = {
  name: "restartStream",
  description:
    "Restart the stream from the beginning. Use when user asks to restart, start over, or go back to the beginning.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.RESTART
      );

      if (result.success) {
        return {
          success: true,
          formatted: "🔄 Stream restarted from the beginning.",
          summary: "Restarted the stream",
        };
      } else {
        return {
          success: false,
          error: result.error || "Failed to restart stream",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in restartStream:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to restart stream",
      };
    }
  },
};

export const nextEpisodeTool: DatabaseTool = {
  name: "nextEpisode",
  description:
    "Skip to the next episode (TV shows only, Jellyfin provider). Use when user asks for next episode, next, or skip to next episode.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(params, context): Promise<string | DatabaseToolResult> {
    try {
      if (!context.guildId) {
        return {
          success: false,
          error: "Guild context required",
        };
      }

      const controller = StreamController.getInstance();
      const result = await controller.controlPlayback(
        context.guildId,
        PlaybackAction.NEXT_EPISODE
      );

      if (result.success) {
        return {
          success: true,
          formatted: "⏭️ Skipped to next episode.",
          summary: "Skipped to next episode",
        };
      } else {
        return {
          success: false,
          error:
            result.error ||
            "Next episode not supported. This feature is only available for TV shows on Jellyfin.",
        };
      }
    } catch (error) {
      console.error("[StreamPlayerTools] Error in nextEpisode:", error);
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to skip to next episode",
      };
    }
  },
};

/**
 * Export all stream player tools for registration
 * New tools use StreamController, old tools kept for backward compatibility
 */
export const streamPlayerTools: DatabaseTool[] = [
  streamContentTool,
  selectContentTool,
  pauseStreamTool,
  resumeStreamTool,
  seekStreamTool,
  skipForwardTool,
  skipBackwardTool,
  restartStreamTool,
  nextEpisodeTool,
  stopStreamTool,
  // Deprecated tools (kept for backward compatibility)
  searchYouTubeTool,
  searchJellyfinTool,
];
