import * as dotenv from "dotenv";

dotenv.config();

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BotConfig {
  // Required
  botToken: string;

  // Optional Discord settings
  guildId?: string;
  /** Run the enrichment queue (summaries, dossiers) automatically; `ENRICHMENT_AUTO=false` pauses it */
  enrichmentAuto: boolean;
  botPrefix: string;
  botOwnerId?: string;
  spawnChannelIds?: string[];
  spawnChannelId?: string; // Single spawn channel for voice channel manager
  excludedChannelIds?: string[];
  permanentChannelIds?: string[];
  starboardChannelId?: string;

  // Database settings
  postgresUrl?: string;
  dbName: string;

  // Cache settings
  redisUrl?: string;

  // Development
  nodeEnv: "development" | "production" | "test";
  port: number;

  // Optional integrations
  webhookUrl?: string;
  openaiApiKey?: string;
  grokApiKey?: string;
  geminiApiKey?: string;
  youtubeApiKey?: string;
  grokEnableWebSearch: boolean;
  grokEnableXSearch: boolean;

  // Ollama settings
  ollamaUrl?: string;
  ollamaModel?: string;

  // Feature flags
  enableTopicSplitting: boolean;

  // Voice Assistant settings
  googleTtsApiKey?: string;
  googleTtsLanguageCode: string;
  googleTtsVoiceName: string;
  whisperApiKey?: string;
  whisperUrl?: string;
  voiceAssistantTriggerWord: string;
  voiceAssistantEnabled: boolean;
  voiceAssistantLogLevel: LogLevel;

  // Cartesia TTS settings
  cartesiaApiKey?: string;
  cartesiaVoiceId?: string;
  cartesiaModel?: string;

  // Stream Player settings
  streamPlayerEnabled: boolean;
  streamPlayerHeadless: boolean;
  streamPlayerTimeout: number;
  streamPlayerMaxDuration: number;
  streamPlayerUserEmail?: string; // Discord user account email for Go Live streaming
  streamPlayerUserPassword?: string; // Discord user account password for Go Live streaming
  streamPlayerUserToken?: string; // Alternative: Discord user account token (if using token auth)
  streamPlayerUserAgent?: string;
  streamPlayerTestOnInit: boolean; // Test Discord streaming workflow on bot initialization

  // Jellyfin settings
  jellyfinServerUrl?: string; // Jellyfin server base URL
  jellyfinApiKey?: string; // API key for authentication
  jellyfinUserId?: string; // User ID (optional, can be derived from API key)

  // Plex settings
  plexServerUrl?: string; // Plex server base URL (e.g., http://localhost:32400)

  // Database healing settings
  healing: {
    messageEmbeddings: {
      enabled: boolean;
      batchSize: number;
      maxMessages: number;
      ageLimit: number | null;
    };
    conversationEmbeddings: {
      enabled: boolean;
    };
    userProfiles: {
      enabled: boolean;
      minConversations: number;
      maxUsers: number;
    };
    relationships: {
      enabled: boolean;
      minInteractions: number;
      maxRelationships: number;
      requireUserProfiles: boolean;
    };
    guildMetadata: {
      enabled: boolean;
      minRelationships: number;
      minConversations: number;
    };
  };
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return defaultValue;
  }
}

function parseLogLevel(value: string | undefined, defaultValue: LogLevel): LogLevel {
  if (!value) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value.trim().toLowerCase() as LogLevel;
    default:
      return defaultValue;
  }
}

function validateConfig(): BotConfig {
  const requiredVars = ["BOT_TOKEN"] as const;

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      throw new Error(`🔸 Missing required environment variable: ${varName}`);
    }
  }

  const config: BotConfig = {
    // Required
    botToken: process.env.BOT_TOKEN as string,

    // Optional Discord settings
    guildId: process.env.GUILD_ID || undefined,
    enrichmentAuto: process.env.ENRICHMENT_AUTO !== "false",
    botPrefix: process.env.BOT_PREFIX || "!",
    botOwnerId: process.env.BOT_OWNER_ID || undefined,
    spawnChannelIds: process.env.SPAWN_CHANNEL_IDS
      ? process.env.SPAWN_CHANNEL_IDS.split(",").map((id) => id.trim())
      : undefined,
    spawnChannelId:
      process.env.SPAWN_CHANNEL_ID ||
      (process.env.SPAWN_CHANNEL_IDS
        ? process.env.SPAWN_CHANNEL_IDS.split(",")[0]?.trim()
        : undefined),
    excludedChannelIds: process.env.EXCLUDED_CHANNEL_IDS
      ? process.env.EXCLUDED_CHANNEL_IDS.split(",").map((id) => id.trim())
      : undefined,
    permanentChannelIds: process.env.PERMANENT_CHANNEL_IDS
      ? process.env.PERMANENT_CHANNEL_IDS.split(",").map((id) => id.trim())
      : undefined,
    starboardChannelId: process.env.STARBOARD_CHANNEL_ID || undefined,

    // Database settings
    postgresUrl: process.env.POSTGRES_URL || undefined,
    dbName: process.env.DB_NAME || "arcados",

    // Cache settings
    redisUrl: process.env.REDIS_URL || undefined,

    // Development
    nodeEnv:
      (process.env.NODE_ENV as "development" | "production" | "test") ||
      "development",
    port: Number.parseInt(process.env.PORT || "3000", 10),

    // Optional integrations
    webhookUrl: process.env.WEBHOOK_URL || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    grokApiKey: process.env.GROK_API_KEY || undefined,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    youtubeApiKey: process.env.YOUTUBE_API_KEY || undefined,
    grokEnableWebSearch: parseBoolean(
      process.env.GROK_ENABLE_WEB_SEARCH,
      true
    ),
    grokEnableXSearch: parseBoolean(process.env.GROK_ENABLE_X_SEARCH, true),

    // Ollama settings
    ollamaUrl: process.env.OLLAMA_URL || undefined,
    ollamaModel: process.env.OLLAMA_MODEL || undefined,

    // Feature flags
    enableTopicSplitting: parseBoolean(
      process.env.ENABLE_TOPIC_SPLITTING,
      false
    ),

    // Voice Assistant settings
    googleTtsApiKey: process.env.GOOGLE_TTS_API_KEY || undefined,
    googleTtsLanguageCode: process.env.GOOGLE_TTS_LANGUAGE_CODE || "en-US",
    googleTtsVoiceName: process.env.GOOGLE_TTS_VOICE_NAME || "en-US-Wavenet-D",
    whisperApiKey: process.env.WHISPER_API_KEY || undefined,
    whisperUrl: process.env.WHISPER_URL || undefined,
    voiceAssistantTriggerWord: process.env.VOICE_ASSISTANT_TRIGGER_WORD || "aria",
    voiceAssistantEnabled: parseBoolean(
      process.env.VOICE_ASSISTANT_ENABLED,
      true
    ),
    voiceAssistantLogLevel: parseLogLevel(
      process.env.VOICE_ASSISTANT_LOG_LEVEL,
      "info"
    ),

    // Cartesia TTS settings
    cartesiaApiKey: process.env.CARTESIA_API_KEY || undefined,
    cartesiaVoiceId: process.env.CARTESIA_VOICE_ID || undefined,
    cartesiaModel: process.env.CARTESIA_MODEL || undefined,

    // Stream Player settings
    streamPlayerEnabled: parseBoolean(process.env.STREAM_PLAYER_ENABLED, true),
    streamPlayerHeadless: parseBoolean(
      process.env.STREAM_PLAYER_HEADLESS,
      true
    ),
    streamPlayerTimeout: Number.parseInt(
      process.env.STREAM_PLAYER_TIMEOUT || "30000",
      10
    ),
    streamPlayerMaxDuration: Number.parseInt(
      process.env.STREAM_PLAYER_MAX_DURATION || "43200000",
      10
    ), // 12 hours default
    streamPlayerUserEmail: process.env.STREAM_PLAYER_USER_EMAIL || undefined,
    streamPlayerUserPassword: process.env.STREAM_PLAYER_USER_PASSWORD || undefined,
    streamPlayerUserToken: process.env.STREAM_PLAYER_USER_TOKEN || undefined,
    streamPlayerUserAgent:
      process.env.STREAM_PLAYER_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    streamPlayerTestOnInit: parseBoolean(
      process.env.STREAM_PLAYER_TEST_ON_INIT,
      true
    ),

    // Jellyfin settings
    jellyfinServerUrl: process.env.JELLYFIN_SERVER_URL || undefined,
    jellyfinApiKey: process.env.JELLYFIN_API_KEY || undefined,
    jellyfinUserId: process.env.JELLYFIN_USER_ID || undefined,

    // Plex settings
    plexServerUrl: process.env.PLEX_SERVER_URL || undefined,

    // Database healing settings
    healing: {
      messageEmbeddings: {
        enabled: parseBoolean(process.env.HEALING_MESSAGE_EMBEDDINGS_ENABLED, true),
        batchSize: Number.parseInt(process.env.HEALING_MESSAGE_BATCH_SIZE || "32", 10),
        maxMessages: Number.parseInt(process.env.HEALING_MESSAGE_MAX || "2000", 10),
        ageLimit: process.env.HEALING_MESSAGE_AGE_LIMIT
          ? Number.parseInt(process.env.HEALING_MESSAGE_AGE_LIMIT, 10)
          : null,
      },
      conversationEmbeddings: {
        enabled: parseBoolean(process.env.HEALING_CONVERSATION_EMBEDDINGS_ENABLED, true),
      },
      userProfiles: {
        enabled: parseBoolean(process.env.HEALING_USER_PROFILES_ENABLED, true),
        minConversations: Number.parseInt(process.env.HEALING_USER_MIN_CONVERSATIONS || "5", 10),
        maxUsers: Number.parseInt(process.env.HEALING_USER_MAX || "20", 10),
      },
      relationships: {
        enabled: parseBoolean(process.env.HEALING_RELATIONSHIPS_ENABLED, true),
        minInteractions: Number.parseInt(process.env.HEALING_REL_MIN_INTERACTIONS || "100", 10),
        maxRelationships: Number.parseInt(process.env.HEALING_REL_MAX || "30", 10),
        requireUserProfiles: parseBoolean(process.env.HEALING_REL_REQUIRE_PROFILES, true),
      },
      guildMetadata: {
        enabled: parseBoolean(process.env.HEALING_GUILD_METADATA_ENABLED, true),
        minRelationships: Number.parseInt(process.env.HEALING_GUILD_MIN_RELATIONSHIPS || "10", 10),
        minConversations: Number.parseInt(process.env.HEALING_GUILD_MIN_CONVERSATIONS || "20", 10),
      },
    },
  };

  // Validate node environment
  if (!["development", "production", "test"].includes(config.nodeEnv)) {
    throw new Error(
      "🔸 Invalid NODE_ENV. Must be one of: development, production, test"
    );
  }

  return config;
}

export const config = validateConfig();

// Helper function to check if we're in development
export const isDevelopment = config.nodeEnv === "development";
export const isProduction = config.nodeEnv === "production";
export const isTest = config.nodeEnv === "test";
