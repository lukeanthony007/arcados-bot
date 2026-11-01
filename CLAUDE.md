# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Running the bot
- **Development mode with auto-restart:** `npm run dev`
- **Production start:** `npm start`
- **Production with environment variable:** `NODE_ENV=production npm start`
- **Debug mode with inspector:** `npm run start:debug`

### Code quality
- **Lint code:** `npm run lint`
- **Fix linting issues:** `npm run lint:fix`
- **Format code:** `npm run format`

### Building
- **Compile TypeScript:** `npm run build`
- **Production build (compile + clean cache):** `npm run build:prod`
- **Clean build artifacts:** `npm run clean`

### Database & Synchronization
- **Sync guild data to PostgreSQL:** `npm run sync:guild`
- **Drop guild data from PostgreSQL:** `npm run drop:guild`
- **Recreate PostgreSQL schema:** `npm run recreate:schema`
- **Clean all PostgreSQL data:** `npm run drop:all`
- **Heal database inconsistencies:** Database healer runs automatically on bot startup (DatabaseHealer class)
- **Sync a single channel:** `npm run sync:channel`
- **Regenerate relationship network:** `npm run regenerate:relationships`
- **Regenerate conversations:** `npm run regenerate:conversations`
- **Generate embeddings:** `npm run generate:embeddings` (uses Bun)

### Testing & Debugging
- **Test minimal bot functionality:** `npm run test:minimal`
- **Test action creation:** `npm run test:actions`
- **Test voice channel features:** `npm run test:voice`
- **Test PostgreSQL connection:** `npm run test:postgres`
- **Test AI assistant:** `npm run test:ai`
- **Watch database changes:** `npm run watch-db`
- **Watch user changes:** `npm run watch-users`
- **Check recent activity:** `npm run view:recent`
- **Inspect active conversations (24h):** `npm run inspect:conversations`
- **Analyze conversation grouping accuracy:** `npm run analyze:conversation-accuracy` (uses Gemini AI to compare programmatic vs semantic conversation detection)

## Architecture Overview

### Core Components

**Bot.ts** - The main orchestrator. On initialization:
1. Connects to PostgreSQL (optional but enables all advanced features)
2. Sets up Discord event handlers (slash commands, bot mentions, message replies)
3. Deploys commands (guild-specific or globally)
4. Initializes relationship/conversation tracking, database healing, and live sync watching

### Feature Layers

#### Discord Synchronization (`src/features/discord-sync/`)
Syncs Discord data to PostgreSQL with real-time updates:
- **StateSyncService**: Coordinates live event sync and background reconciliation
- **LiveEventSync**: Real-time event listener that incrementally updates PostgreSQL as Discord events occur (messageCreate, reactionAdd, memberJoin, etc.)
- **ReconciliationSync**: Background healing that validates data consistency, backfills missing data, repairs gaps from bot downtime
- **SyncCoordinator**: Per-resource locking to prevent race conditions between live sync and reconciliation

#### Social Intelligence (`src/features/social-intelligence/`)
Transforms raw Discord interactions into structured relationship and conversation insights:
- **Relationship Mapping**: Tracks user interactions, calculates affinity scores, maintains relationship graphs
- **Conversation Detection**: Groups messages into multi-participant conversation segments using multi-strategy grouping
- **Semantic Analysis**: Extracts keywords (TF-IDF + semantic), generates embeddings, labels topics with AI
- **Types** (`types.ts`): Defines `ConversationEntry`, `AffinityScoreResult`, `UserInteractionSummary`, `StreamingConversation`

#### Database (`src/features/database/`)
- **PostgreSQLManager**: Single connection pool; provides query methods for CRUD operations on guilds, channels, members, messages, relationship edges, conversation segments, and embeddings
- Handles graceful degradation if PostgreSQL is unavailable
- Returns `DatabaseResult<T>` with `success` flag, `data`, and optional `error` field

#### AI Module (`src/ai/`)
Centralized AI infrastructure with multi-provider support:
- **Core** (`core/`):
  - **NEW ARCHITECTURE** (preferred):
    - AIEngine: Core execution interface for AI requests
    - AIFactory: Creates engine and context instances
    - AIRequestBuilder: Fluent API for building AI requests (`.chat().blocking().provider().generate()`)
    - AIContext: Request context (persona, tools, guild)
  - **LEGACY** (deprecated, see migration guide in AIManager JSDoc):
    - AIManager: Singleton orchestrator (use AIEngine + AIRequestBuilder instead)
    - ChatSessionManager: Multi-turn conversation state
- **Providers** (`providers/`):
  - GrokProvider: Uses Vercel AI SDK with Grok 4.1 Fast (non-reasoning) for AI assistant
  - GeminiProvider: Native SDK with Gemini 2.0 Flash for social intelligence
  - OpenAIProvider, OllamaProvider: Additional provider options
- **Tools** (`tools/`): DatabaseTools registry with user, relationship, conversation, message, server, context, and analysis tools
- **Personas** (`personas/`): "sophia" (philosophical) and "casual" (friendly) persona definitions
- **Utils** (`utils/`): MentionResolver and ResponseLengthPolicy utilities

#### Discord Handlers (`src/features/discord-handlers/`)
Discord-specific message and voice handling:
- **Chat** (`chat/`):
  - MessageHandler: Handles bot mentions and replies
  - ChatAIManager: Domain adapter for chat interactions (wraps AIEngine)
- **Voice** (`voice/`):
  - VoiceAssistantManager: Voice channel orchestration
  - VoiceAIManager: Domain adapter for voice interactions (wraps AIEngine)
  - TTS services: Text-to-speech integrations (Cartesia, Google)
  - Commands: Join/leave voice commands

Note: `src/features/chat-assistant/` and `src/features/voice-assistant/` now re-export from discord-handlers for backward compatibility.

#### Message Handling in Bot.ts
**Bot mentions** (lines 169-315):
1. Detects @botname mentions (not replies, uses regex patterns)
2. Extracts user content, maps self-referential queries (e.g., "who am I") to explicit mentions for tool resolution
3. Generates AI response via AIManager
4. Sends response in Discord-safe chunks (max 1900 chars) with sanitized @everyone mentions
5. Starts a new chat session

**Bot replies** (lines 318-400):
1. Tracks message replies to bot messages using session IDs (stored in ChatSessionManager)
2. Continues conversation context by passing session history to AI
3. Applies same chunking and sanitization logic

### Supporting Systems

**AIManager tools** integrate with database:
- Tools implicitly use guild context (set via `runWithGuildContext`) to infer guildId
- User tools retrieve member profiles, summaries, keywords, emojis, notes
- Relationship tools calculate affinity, list top connections
- Conversation tools fetch segments, participants, embeddings
- Analysis tools provide metadata and trends

**LiveEventSync events**:
- messageCreate → increments relationship edges, buffers message for conversation detection, creates streaming conversations
- reactionAdd/reactionRemove → increments edge counters
- guildMemberAdd/Update → updates member profiles
- channelCreate/Update/Delete → updates channel records
- roleCreate/Update/Delete → updates role records
- Streaming conversations created on 2+ messages, finalized after 10-min inactivity

**Conversation Lifecycle**:
1. ConversationDetector buffers messages per channel
2. On 2+ messages: create `streaming_conversation` (immediately queryable with preliminary keywords)
3. After 10-min inactivity OR 50-message buffer: multi-strategy grouping + validation
4. Full enrichment: hybrid keywords, embeddings, AI topic labels
5. Finalized segments stored in `conversation_segments` table
6. Used for context retrieval (what topics have users discussed)

## Configuration

**Environment Variables** (src/config/index.ts):
- **Required**: `BOT_TOKEN` (Discord bot token)
- **Optional Discord**: `GUILD_ID` (for guild-specific command deployment), `BOT_PREFIX`, `BOT_OWNER_ID`, `SPAWN_CHANNEL_ID` (for voice channel manager)
- **Optional Database**: `POSTGRES_URL` (connection string; default: local postgres), `DB_NAME` (default: "arcados")
- **Optional Integrations**: `OPENAI_API_KEY`, `GROK_API_KEY`, `GEMINI_API_KEY`, `YOUTUBE_API_KEY`, `OLLAMA_URL`, `OLLAMA_MODEL`

Bot gracefully degrades if PostgreSQL is unavailable; all Discord features work without it.

## Adding Commands

Commands are in `src/commands/` and dynamically loaded via `loadCommands()` in Bot.ts:63-66.

**Command Structure**:
```typescript
import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types";

const myCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("mycmd")
    .setDescription("Description")
    .addStringOption(opt => opt.setName("arg").setDescription("Help").setRequired(true)),

  async execute(interaction) {
    const arg = interaction.options.getString("arg");
    await interaction.reply(`Response: ${arg}`);
  },
};

export default myCommand;
```

Commands automatically receive guild context and can access AI tools, database methods, and user/relationship data.

## Code Style

- **Formatter**: Biome (see package.json biome config)
- **Language**: TypeScript with strict mode
- **Imports**: ES module syntax (`import ... from "..."`)
- **Format**: Tabs (width 2), line width 100, double quotes, semicolons, trailing commas (ES5)
- **Patterns**: Class-based managers, static singletons for global state (e.g., AIManager), error handling via try/catch with logging via console.error
- **Sanitization**: All bot output sanitized for @everyone/@here mentions via `sanitizeEveryone()` function

## Key Files to Know

### Core System
- [Bot.ts](src/Bot.ts) - Main event orchestrator and command dispatcher
- [PostgreSQLManager.ts](src/database/PostgreSQLManager.ts) - Database interface

### Discord Sync
- [StateSyncService.ts](src/features/discord-sync/StateSyncService.ts) - Discord sync coordinator
- [LiveEventSync.ts](src/features/discord-sync/LiveEventSync.ts) - Real-time Discord event sync
- [ReconciliationSync.ts](src/features/discord-sync/ReconciliationSync.ts) - Background healing

### Social Intelligence
- [RelationshipMapper.ts](src/features/social-intelligence/relationship-mapping/RelationshipMapper.ts) - Affinity/relationship logic
- [ConversationDetector.ts](src/features/social-intelligence/conversation-detection/ConversationDetector.ts) - Conversation detection and grouping
- [EnhancementOrchestrator.ts](src/features/social-intelligence/enrichment-pipeline/EnhancementOrchestrator.ts) - AI-powered conversation enrichment

### AI Infrastructure (NEW)
- [AIEngine.ts](src/ai/core/AIEngine.ts) - Core AI execution interface
- [AIFactory.ts](src/ai/core/AIFactory.ts) - Engine and context factory
- [AIRequestBuilder.ts](src/ai/core/AIRequestBuilder.ts) - Fluent API for AI requests
- [GrokProvider.ts](src/ai/providers/GrokProvider.ts) - Grok 4.1 Fast provider using Vercel AI SDK
- [GeminiProvider.ts](src/ai/providers/GeminiProvider.ts) - Gemini Flash provider for social intelligence
- [DatabaseTools.ts](src/ai/tools/registry/DatabaseTools.ts) - Tool registry for AI

### AI Infrastructure (LEGACY - deprecated)
- [AIManager.ts](src/ai/core/AIManager.ts) - Legacy singleton orchestrator (use AIEngine instead)

### Discord Handlers
- [MessageHandler.ts](src/features/discord-handlers/chat/MessageHandler.ts) - Chat message handling
- [ChatAIManager.ts](src/features/discord-handlers/chat/ChatAIManager.ts) - Chat AI adapter
- [VoiceAssistantManager.ts](src/features/discord-handlers/voice/VoiceAssistantManager.ts) - Voice orchestration
- [VoiceAIManager.ts](src/features/discord-handlers/voice/VoiceAIManager.ts) - Voice AI adapter

## Common Tasks

**Modify AI behavior**:
- Personas are defined in [personas/definitions.ts](src/ai/personas/definitions.ts)
- Use AIRequestBuilder's `.persona()` method to select persona
- Example: `new AIRequestBuilder(engine).chat().blocking().provider("grok").persona("casual").generate(prompt)`
- Use `.customPersona(text)` for ad-hoc persona text that replaces the registry persona; the yin/yang layer is then skipped unless a mode is explicitly requested
- AI providers are in [src/ai/providers/](src/ai/providers/)

**Member personas** (`/persona init|change|clear`, [src/features/user-personas/](src/features/user-personas/)):
- `UserPersonaService.buildPersona` refreshes the member's profile (RelationshipMapper → UserProfileEnrichmentPipeline, falling back to PsychologicalProfiler), gathers recent messages, conversation summaries and top relationships, has Grok write a character profile, and stores it in `user_personas` with real messages as voice examples
- `/persona change` sets the guild's row in `guild_active_personas`; MessageHandler looks it up on every mention/reply and passes `buildPersonaPrompt(...)` to ChatAIManager (voice is unaffected)
- The service is attached to the Discord client as `client.userPersonas`

**Add a database schema**: PostgreSQLManager has schema creation methods; update via migration pattern in `recreate:schema` script.

**Track new interaction types**: ConversationDetector uses multi-strategy grouping; add new strategies in `conversation-detection/strategies/` directory.

**Integrate new LLM provider**:
1. Create provider class extending [BaseAIProvider](src/ai/providers/base/BaseAIProvider.ts) in [src/ai/providers/](src/ai/providers/)
2. Register in [AIFactory.ts](src/ai/core/AIFactory.ts) provider map
3. Add API key to [config/index.ts](src/config/index.ts)
4. Use Vercel AI SDK for OpenAI-compatible APIs, or native SDKs for platform-specific features
5. Provider will be automatically available via AIRequestBuilder's `.provider()` method

**Debug conversation detection**: ConversationDetector buffers messages per channel with 10-min inactivity timeouts; check `streaming_conversations` table or add logging.

**Extend bot mention handling**: Message handling logic in Bot.ts; modify sanitization, context resolution, or chunking as needed.
