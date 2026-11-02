# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

The runtime is Bun (`bun.lock`). There is no build step; TypeScript runs directly.

### Running the bot
- **Start:** `npm start` (`bun run src/main.ts`)
- **Start under Node:** `npm run start:node` (`tsx src/main.ts`)

### Code quality
- **Type-check:** `npx tsc --noEmit -p .`
- **Lint/format:** `npx biome check <paths>` (config in package.json). Many existing files are not formatter-clean; format only files you own rather than whole directories.
- There is no test framework; `test:*` scripts are manual smoke scripts.

### Social intelligence
- **Enrich conversations:** `npm run enrich:conversations:24h` / `:7d` / `:force`
- **Enrich user profiles:** `npm run enrich:users:24h` / `:7d` / `:stale`
- **Enrich relationships:** `npm run enrich:relationships:24h` / `:significant`
- **Enrich guild summary:** `npm run enrich:guild:summary` / `enrich:guild:full`
- **Psychological profiling:** `npm run profile:users`, `profile:users:stale`, `profile:view-user`
- **Keywords:** `npm run keywords:build-vocabulary`, `keywords:extract-all`, `diagnose-keywords`
- **Conversations:** `npm run view-conversations`, `regenerate:conversations`, `analyze:grouping`, `analyze:sorting`, `tune:parameters`, `generate:summaries`

### Database & debugging
- **Inspect a message:** `npm run check-message`
- **Repair sync gaps:** `npm run repair-sync`
- **API costs:** `npm run view-costs`
- **Voice-state migration:** `npm run migrate:voice-state`
- **AI smoke tests:** `npm run test:ai`, `test:conversation`, `test:discord-stream`

## Architecture Overview

### Core Components

**Bot.ts** - The main orchestrator. On initialization:
1. Connects to PostgreSQL (optional but enables all advanced features); `PostgreSQLManager.connect()` runs `initializeSchema()`
2. Sets up Discord event handlers (slash commands, messages, voice state, buttons)
3. Deploys commands (guild-specific when `GUILD_ID` is set, otherwise global) via `CommandDeployer`
4. Initializes conversation workflow, message handler, member personas, voice assistant, voice-state coordinator, media player, state sync, and the enrichment orchestrator/scheduler

### Feature Layers

#### Discord Synchronization (`src/features/discord-sync/`)
Syncs Discord data to PostgreSQL with real-time updates:
- **StateSyncService**: Coordinates live event sync and background reconciliation
- **LiveEventSync**: Real-time event listener that incrementally updates PostgreSQL as Discord events occur (messageCreate, reactionAdd, memberJoin, etc.)
- **ReconciliationSync**: Background healing that validates data consistency, backfills missing data, repairs gaps from bot downtime
- **SyncCoordinator**: Per-resource locking to prevent race conditions between live sync and reconciliation

#### Social Intelligence (`src/features/social-intelligence/`)
Transforms raw Discord interactions into structured relationship and conversation insights:
- **Relationship Mapping** (`relationship-mapping/`): Tracks user interactions, calculates affinity scores, maintains relationship graphs (`user_profiles.relationship_network`)
- **Conversation Detection** (`conversation-detection/`): Groups messages into multi-participant conversation segments using multi-strategy grouping
- **Semantic Analysis** (`semantic-analysis/`): Extracts keywords (TF-IDF + semantic), generates embeddings, labels topics with AI
- **Psychological Profiling** (`psychological-profiling/`): Statistical analyzers plus Big Five/MBTI estimators → `user_profiles.psych_profile`, `behavior_patterns`, `temporal_profile`
- **Enrichment Pipeline** (`enrichment-pipeline/`): Four cascading layers run through `EnrichmentPipelineOrchestrator` and `EnrichmentQueue` (in-memory, retries failed jobs up to 3 times): conversation summaries → user profiles → relationship profiles → guild summary
- **Types** (`types.ts`): Defines `ConversationEntry`, `AffinityScoreResult`, `UserInteractionSummary`, `StreamingConversation`

#### Member Personas (`src/features/user-personas/`)
`/persona init|change|clear` lets the bot speak as a server member (see Common Tasks).

#### Database (`src/database/`)
- **PostgreSQLManager**: Single connection pool; CRUD for guilds, channels, members, messages, user profiles, relationship edges, conversation segments, personas, and embeddings
- Schema is created and migrated in `initializeSchema()` on every connect (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`); `src/database/migrations/*.sql` are historical and not applied automatically
- Handles graceful degradation if PostgreSQL is unavailable
- Returns `DatabaseResult<T>` with `success` flag, `data`, and optional `error` field

#### AI Module (`src/ai/`)
Centralized AI infrastructure with multi-provider support:
- **Core** (`core/`):
  - AIEngine: Core execution interface; builds the system prompt (persona → yin/yang mode → conversational base → method prompt) and runs the tool loop
  - AIFactory: Creates the engine, providers and tool registry
  - AIRequestBuilder: Fluent API for building AI requests (`.chat().blocking().provider().generate()`)
  - AIContext: Request context (guild, user, channel, history, communication mode)
  - ChatSessionManager: Multi-turn chat session state keyed by bot reply message IDs
- **Providers** (`providers/`): GrokProvider (primary, Vercel AI SDK), OpenAIProvider, OllamaProvider; GeminiProvider exists but is disabled in AIFactory
- **Tools** (`tools/`): DatabaseTools registry with user, relationship, conversation, message, server, context, analysis, media and voice tools
- **Personas** (`personas/`): "sophia" (philosophical) and "casual" (friendly) persona definitions; yin/yang communication modes
- **Utils** (`utils/`): MentionResolver and ResponseLengthPolicy utilities

**Response length policy**: `.chat()` sets mode "chat", which caps output at 60 tokens via ResponseLengthPolicy unless `.maxTokens()` is set. Background jobs (summaries, profiling, JSON output) must use `.blocking().mode("structured").maxTokens(n)` instead of `.chat()`.

#### Discord Handlers (`src/handlers/`)
- **Chat** (`chat/`):
  - MessageHandler: Bot mentions and replies; resolves the guild's active member persona
  - ChatAIManager: Domain adapter for chat interactions (wraps AIEngine)
- **Voice** (`voice/`):
  - VoiceAssistantManager: Voice channel orchestration
  - VoiceAIManager: Domain adapter for voice interactions (wraps AIEngine)
  - TTS services (`tts/`): Cartesia, Google, Whisper transcription
  - `/join` and `/leave` slash commands live in `src/commands/`

#### Message Handling (`src/handlers/chat/MessageHandler.ts`)
**Bot mentions** (`handleBotMention`):
1. Detects @bot mentions that are not replies
2. Handles voice join/leave phrases, strips yin/yang keywords, maps self-referential queries (e.g., "who am I") to explicit mentions for tool resolution
3. Generates the response via ChatAIManager (with the active member persona, if any)
4. Sends response in Discord-safe chunks with sanitized @everyone mentions
5. Starts a new chat session

**Bot replies** (`handleSessionContinuation`):
1. Finds the session by the replied-to bot message ID (ChatSessionManager)
2. Continues the conversation with session history
3. Applies the same chunking and sanitization logic

### Supporting Systems

**AI tools** integrate with the database:
- Tools receive guild/user context from AIContext
- User tools retrieve member profiles, summaries, keywords, emojis, notes
- Relationship tools calculate affinity, list top connections
- Conversation tools fetch segments, participants, embeddings
- Analysis tools provide metadata and trends

**LiveEventSync events**:
- messageCreate → increments relationship edges, buffers message for conversation detection, creates streaming conversations, queues user enrichment every 50 messages
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

`src/utils/loadCommands.ts` loads every `.ts` file directly inside `src/commands/` and `src/features/*/commands/` (no recursion). Any exported object with `data` and `execute` is registered; default or named exports both work.

**Command Structure**:
```typescript
import { SlashCommandBuilder } from "discord.js";
import type { Command } from "../types";

export const myCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("mycmd")
    .setDescription("Description")
    .addStringOption(opt => opt.setName("arg").setDescription("Help").setRequired(true)),

  async execute(interaction) {
    const arg = interaction.options.getString("arg");
    await interaction.reply(`Response: ${arg}`);
  },
};
```

Commands only receive the interaction. Shared services are attached to the Discord client in `Bot.initializeFeatures` (e.g. `voiceStateCoordinator`, `userPersonas`) and read back with a small typed interface over `interaction.client`.

## Code Style

- **Formatter**: Biome (see package.json biome config)
- **Language**: TypeScript with strict mode
- **Imports**: ES module syntax (`import ... from "..."`)
- **Format**: Tabs (width 2), line width 100, double quotes, semicolons, trailing commas (ES5)
- **Patterns**: Class-based managers, static singletons for global state (e.g., VoiceAssistantManager, EnrichmentPipelineOrchestrator), error handling via try/catch with logging via console.error
- **Sanitization**: All bot output sanitized for @everyone/@here mentions via `sanitizeEveryone()` function

## Key Files to Know

### Core System
- [Bot.ts](src/Bot.ts) - Main event orchestrator and command dispatcher
- [PostgreSQLManager.ts](src/database/PostgreSQLManager.ts) - Database interface and schema

### Discord Sync
- [StateSyncService.ts](src/features/discord-sync/StateSyncService.ts) - Discord sync coordinator
- [LiveEventSync.ts](src/features/discord-sync/LiveEventSync.ts) - Real-time Discord event sync
- [ReconciliationSync.ts](src/features/discord-sync/ReconciliationSync.ts) - Background healing

### Social Intelligence
- [RelationshipMapper.ts](src/features/social-intelligence/relationship-mapping/RelationshipMapper.ts) - Affinity/relationship logic
- [ConversationDetector.ts](src/features/social-intelligence/conversation-detection/ConversationDetector.ts) - Conversation detection and grouping
- [EnrichmentPipelineOrchestrator.ts](src/features/social-intelligence/enrichment-pipeline/EnrichmentPipelineOrchestrator.ts) - Enrichment layers, cascades and queue processing
- [UserProfileEnrichmentPipeline.ts](src/features/social-intelligence/enrichment-pipeline/layers/UserProfileEnrichmentPipeline.ts) - Incremental user profile summaries
- [PsychologicalProfiler.ts](src/features/social-intelligence/psychological-profiling/PsychologicalProfiler.ts) - Behavioral and personality profiling

### AI Infrastructure
- [AIEngine.ts](src/ai/core/AIEngine.ts) - Core AI execution interface
- [AIFactory.ts](src/ai/core/AIFactory.ts) - Engine and provider factory
- [AIRequestBuilder.ts](src/ai/core/AIRequestBuilder.ts) - Fluent API for AI requests
- [GrokProvider.ts](src/ai/providers/GrokProvider.ts) - Primary provider using Vercel AI SDK
- [DatabaseTools.ts](src/ai/tools/registry/DatabaseTools.ts) - Tool registry for AI

### Discord Handlers
- [MessageHandler.ts](src/handlers/chat/MessageHandler.ts) - Chat message handling
- [ChatAIManager.ts](src/handlers/chat/ChatAIManager.ts) - Chat AI adapter
- [VoiceAssistantManager.ts](src/handlers/voice/VoiceAssistantManager.ts) - Voice orchestration
- [VoiceAIManager.ts](src/handlers/voice/VoiceAIManager.ts) - Voice AI adapter

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

**Add a database table or column**: add `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to `PostgreSQLManager.initializeSchema()`; it runs on every startup.

**Add an enrichment step**: background LLM calls must throw on failure (so `EnrichmentQueue` records and retries them) and return `null` only for legitimate skips; avoid `.chat()` (60-token cap).

**Track new interaction types**: ConversationDetector uses multi-strategy grouping; add new strategies in `conversation-detection/strategies/` directory.

**Integrate new LLM provider**:
1. Create provider class extending [BaseAIProvider](src/ai/providers/base/BaseAIProvider.ts) in [src/ai/providers/](src/ai/providers/)
2. Register in [AIFactory.ts](src/ai/core/AIFactory.ts) provider map
3. Add API key to [config/index.ts](src/config/index.ts)
4. Use Vercel AI SDK for OpenAI-compatible APIs, or native SDKs for platform-specific features
5. Provider will be automatically available via AIRequestBuilder's `.provider()` method

**Debug conversation detection**: ConversationDetector buffers messages per channel with 10-min inactivity timeouts; check `streaming_conversations` table or add logging.

**Extend bot mention handling**: Message handling logic lives in `src/handlers/chat/MessageHandler.ts`; modify sanitization, context resolution, or chunking there.
