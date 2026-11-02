# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

The runtime is Bun (`bun.lock`). There is no build step; TypeScript runs directly.

### Running the bot
- **Start:** `npm start` (`bun run src/main.ts`)

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
- **Facts** (`facts/closeness.ts`): the one definition of closeness between two members, computed on demand from `messages` + `conversation_segments` (never stored): replies (3 pts), direct mentions (2), shared conversations (1), 180-day half-life decay; per pair `strength`, `share` of the subject's interactions, `reciprocity`. `getConnections`, `getPairFacts`, `getGuildGraph`, `describeStrength`
- **Relationship Mapping** (`relationship-mapping/`): `RelationshipMapper.recordInteraction` keeps live `relationship_edges` counters (used only by conversation grouping and enrichment scheduling)
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
AI infrastructure built on the omp SDK:
- **Runtime** (`runtime/`): `OmpRuntime.get()` is the single AI entry point, built on the omp SDK (`@oh-my-pi/pi-coding-agent`). Every request runs in a fresh, isolated in-memory omp session (~20-60ms to create) with a replaced system prompt, no built-in coding tools, and state under `.omp-bot/` (gitignored), not `~/.omp`.
  - `generate({ systemPrompt, prompt, history?, tools?, label })` → `AIResponse { success, content, error?, executedTools? }`
  - `stream(...)` → `{ tokens: AsyncIterable<string>, result }` (voice)
  - `generateStructured<T>({ systemPrompt, prompt, schema, label })` → schema-validated object via a `submit` tool, or null
  - `tools: { context: ToolContext, names?, webSearch? }` exposes the bot tool catalog (default: all) plus omp's `web_search`
  - Model: Cursor's default "Auto" route (`cursor/default`), using the Cursor login in the user's omp credential store (`omp` → `/login cursor`). When Cursor fails (usage limit, outage, no login), omp's retry fallback chain re-runs the request on `xai/grok-4-1-fast-non-reasoning` (key from `GROK_API_KEY`). Cost tracking records the model that actually answered (`cursor` or `grok`); timeouts happen inside the runtime
  - The omp SDK requires Bun; run scripts with `bun run`, not Node/tsx
- **Tools** (`tools/`): `getToolCatalog()` in `tools/index.ts` loads every `DatabaseTool` (user, relationship, conversation, message, server, context, analysis, live, drama, search, storyline, voice, music, media, stream); `runtime/toolAdapter.ts` binds them to a request's `ToolContext` for omp
- **Personas** (`personas/`): "sophia" and "casual" definitions, yin/yang modes, and `buildSystemPrompt()` (persona → yin/yang → conversational base → method prompt) for chat and voice
- **Context** (`context/`): `getServerSummaryPreface()` frames the first turn of a conversation
- **Utils** (`utils/`): MentionResolver

#### Discord Handlers (`src/handlers/`)
- **Chat** (`chat/`):
  - MessageHandler: Bot mentions and replies; resolves the guild's active member persona
  - `chatResponse.ts`: `generateChatResponse()` builds the chat system prompt and calls OmpRuntime
  - ChatSessionManager: Multi-turn chat session state keyed by bot reply message IDs
- **Voice** (`voice/`):
  - VoiceAssistantManager: Voice channel orchestration
  - VoiceAIManager: Voice replies through OmpRuntime (or the optional RAIA runtime when `RAIA_RUNTIME_URL` is set)
  - TTS services (`tts/`): Cartesia, Google, Whisper transcription
  - `/join` and `/leave` slash commands live in `src/commands/`

#### Message Handling (`src/handlers/chat/MessageHandler.ts`)
**Bot mentions** (`handleBotMention`):
1. Detects @bot mentions that are not replies
2. Handles voice join/leave phrases and strips yin/yang keywords; the prompt names the speaker (`Name (<@id>): message`) so the model knows who it is talking to
3. Generates the response via `generateChatResponse` (with the active member persona, if any)
4. Sends response in Discord-safe chunks with sanitized @everyone mentions
5. Starts a new chat session

**Bot replies** (`handleSessionContinuation`):
1. Finds the session by the replied-to bot message ID (ChatSessionManager)
2. Continues the conversation with session history
3. Applies the same chunking and sanitization logic

### Supporting Systems

**AI tools** integrate with the database:
- Tools receive guild/user/channel context through `ToolContext`
- User tools retrieve member profiles, summaries, keywords, emojis, notes
- Relationship tools (`getUserConnections`, `getRelationship`, `getMutualConnections`) and `getServerNetwork` read `facts/closeness.ts`; user params accept an ID or a name (`resolveUserId`: exact, then fuzzy `word_similarity` over names and aliases)
- Conversation tools fetch segments, participants, embeddings
- Analysis tools provide metadata and trends

**LiveEventSync events**:
- messageCreate → increments relationship edges, buffers message for conversation detection, queues user enrichment every 50 messages
- reactionAdd/reactionRemove → increments edge counters
- guildMemberAdd/Update → updates member profiles
- channelCreate/Update/Delete → updates channel records
- roleCreate/Update/Delete → updates role records
- Conversations are finalized after 10-20 min of channel inactivity (in-memory buffers; lost on a crash)

**Conversation Lifecycle**:
1. ConversationDetector buffers human messages per channel in memory (bot commands are dropped at ingest)
2. After 10-20 min inactivity, a 50-message buffer or a 30-min span: multi-strategy grouping (reply chains, mentions, proximity) + validation (≥3 messages, ≥2 participants, ≤24h, no gap >8h)
3. Finalized segments stored in `conversation_segments` as `pending`; nearby/overlapping segments are merged
4. The enrichment queue summarizes significant `pending` segments; small ones are marked `skipped`
5. Monologues and exchanges under 3 messages are intentionally never grouped
6. Messages the live detector missed (downtime, old history) are added with `npm run regenerate:conversations [--since YYYY-MM-DD] [--until YYYY-MM-DD]`, which replays stored messages per channel; re-runs skip already-grouped messages

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
- [closeness.ts](src/features/social-intelligence/facts/closeness.ts) - The one definition of closeness between members
- [ConversationDetector.ts](src/features/social-intelligence/conversation-detection/ConversationDetector.ts) - Conversation detection and grouping
- [EnrichmentPipelineOrchestrator.ts](src/features/social-intelligence/enrichment-pipeline/EnrichmentPipelineOrchestrator.ts) - Enrichment layers, cascades and queue processing
- [UserProfileEnrichmentPipeline.ts](src/features/social-intelligence/enrichment-pipeline/layers/UserProfileEnrichmentPipeline.ts) - Incremental user profile summaries
- [PsychologicalProfiler.ts](src/features/social-intelligence/psychological-profiling/PsychologicalProfiler.ts) - Behavioral and personality profiling

### AI Infrastructure
- [OmpRuntime.ts](src/ai/runtime/OmpRuntime.ts) - AI entry point on the omp SDK
- [toolAdapter.ts](src/ai/runtime/toolAdapter.ts) - Bot tools as omp custom tools
- [tools/index.ts](src/ai/tools/index.ts) - Tool catalog
- [systemPrompt.ts](src/ai/personas/systemPrompt.ts) - Chat/voice system prompt composition

### Discord Handlers
- [MessageHandler.ts](src/handlers/chat/MessageHandler.ts) - Chat message handling
- [chatResponse.ts](src/handlers/chat/chatResponse.ts) - Chat AI entry point
- [VoiceAssistantManager.ts](src/handlers/voice/VoiceAssistantManager.ts) - Voice orchestration
- [VoiceAIManager.ts](src/handlers/voice/VoiceAIManager.ts) - Voice AI adapter

## Common Tasks

**Modify AI behavior**:
- Personas are defined in [personas/definitions.ts](src/ai/personas/definitions.ts)
- Compose chat/voice prompts with `buildSystemPrompt({ persona, personaText?, communicationMode?, methodPrompt? })`; `personaText` replaces the registry persona (yin/yang is then skipped unless explicitly requested)
- Example: `OmpRuntime.get().generate({ systemPrompt: buildSystemPrompt({ persona: "casual" }), prompt, tools: { context }, label: "feature.name" })`
- To change the model or fallback, edit `MODEL_PROVIDER`/`MODEL_ID`/`FALLBACK_MODELS` in [OmpRuntime.ts](src/ai/runtime/OmpRuntime.ts); the provider needs an omp login or a key set via `authStorage.keys.setRuntime`

**Member personas** (`/persona init|change|clear`, [src/features/user-personas/](src/features/user-personas/)):
- `UserPersonaService.buildPersona` refreshes the member's profile (UserProfileEnrichmentPipeline, falling back to PsychologicalProfiler), gathers recent messages, conversation summaries and their closest connections, has the model write a character profile, and stores it in `user_personas` with real messages as voice examples
- `/persona change` sets the guild's row in `guild_active_personas`; MessageHandler looks it up on every mention/reply and passes the persona to `generateChatResponse` (voice is unaffected)
- Each turn, `personaContext.ts` adds (1) who the persona member is actually closest to (`getConnections`, see Facts above), which overrides the profile on who they're close to, and (2) their real history with the people involved (speaker, @mentions, members named in the message): pair facts, shared conversation summaries (slurs masked), and recent messages between them (group pings, bare mentions/links and slurs filtered)
- The profile writer gets the same `getConnections` ranking, so rebuilt profiles describe the right people
- `generateChatResponse` strips a copied speaker label from replies and turns bare `@123…` ids into `<@123…>` mentions
- The service is attached to the Discord client as `client.userPersonas`

**Add a database table or column**: add `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to `PostgreSQLManager.initializeSchema()`; it runs on every startup.

**Add an enrichment step**: use `OmpRuntime.generate` with a task-focused system prompt (or `generateStructured` for JSON); throw on `success: false` so `EnrichmentQueue` records and retries the job, and return `null` only for legitimate skips.

**Track new interaction types**: ConversationDetector uses multi-strategy grouping; add new strategies in `conversation-detection/strategies/` directory.

**Debug conversation detection**: ConversationDetector buffers messages per channel with 10-20 min inactivity timeouts; inspect `conversation_segments` (coverage = messages appearing in some segment's `message_ids`) or add logging.

**Extend bot mention handling**: Message handling logic lives in `src/handlers/chat/MessageHandler.ts`; modify sanitization, context resolution, or chunking there.
