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
- **Dossiers:** `npm run dossier:member <id|name>`, `dossier:pair <a> <b>`, `dossier:server`, `dossier:stale [--dry-run]` (the bot writes these itself as they go stale)
- **Conversations:** `npm run resegment:history [--channel <name>]` (re-apply the segmentation rule to stored history)
- **Tests:** `npm test` (`bun test src`)
- **Examine grouping:** `npm run conversations:day <YYYY-MM-DD> [channel] [--all]` prints how the rule groups one day without writing anything

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
4. Initializes the conversation segmenter, message handler, member personas, voice assistant, voice-state coordinator, media player, state sync, and the enrichment orchestrator/scheduler

### Feature Layers

#### Discord Synchronization (`src/features/discord-sync/`)
Syncs Discord data to PostgreSQL with real-time updates:
- **StateSyncService**: Coordinates live event sync and background reconciliation
- **LiveEventSync**: Real-time event listener that incrementally updates PostgreSQL as Discord events occur (messageCreate, reactionAdd, memberJoin, etc.)
- **ReconciliationSync**: Background healing that validates data consistency, backfills missing data, repairs gaps from bot downtime
- **SyncCoordinator**: Per-resource locking to prevent race conditions between live sync and reconciliation

#### Social Intelligence (`src/features/social-intelligence/`)
Transforms raw Discord interactions into structured relationship and conversation insights:
- **Facts** (`facts/closeness.ts`): the one definition of closeness between two members, computed on demand from `messages`, `episode_attention` and `conversation_segments` (never stored): replies (3 pts), direct mentions (2), inferred attention in conversations (1 per unit), reactions (1), shared conversations (1), 180-day half-life decay; per pair `strength`, `share` of the subject's interactions, `reciprocity`. `getConnections`, `getPairFacts`, `getGuildGraph`, `describeStrength`
- **Conversations** (`conversations/`): `segmenter.ts` is the pure rule (see Conversation Lifecycle), `attention.ts` attributes each message's attention and maps each conversation's social shape (see Attention), `prior.ts` loads the affinity prior, `focusText.ts` renders a focus map in words, `dynamics.ts` is the summarizer's read of a conversation (roles, directed exchanges with tone and valence, bits, news), `store.ts` applies segmentation and attention to a channel's tail or whole history idempotently, `ConversationSegmenter.ts` runs it every 2 minutes; `message_reactions` is written by LiveEventSync for closeness
- **Attention network** (`facts/attention.ts`): aggregates `episode_attention` + `conversation_segments.focus` + the summarizer's exchanges (180-day half-life) into `getAttentionProfile` (where a member's attention goes and comes from, who they pursue / who pursues them, bid uptake both ways, roles in groups, situations, warmth given/received), `getAttentionEdge` (one pair in both directions: attention, bids, situations, channels, tones, valence, notes) and `getSocialStructure` (standing = PageRank on directed attention, cliques = modularity communities on reciprocal attention, periphery = low-uptake bidders); `describeProfile`/`describeEdge`/`describeStructureOverview` render them for prompts and tools
- **Facts** also include `facts/memberFacts.ts` (`getMemberFacts`: activity, writing style, timing in America/New_York, responsiveness, measured from `messages`) and `facts/graph.ts` (`summarizeGraph`: hubs and communities from `getSocialStructure`, strongest pairs from closeness)
- **Understanding** (`understanding/`): dossiers written in one pass from facts + conversation summaries + real messages via `generateStructured`, stored as JSON sections plus rendered text, regenerated whole when stale (never appended to):
  - `memberDossier.ts` → `user_profiles.dossier` + `summary` (identity, voice, interests, people, social position from the attention profile, recent, Big Five with evidence/confidence, MBTI derived relative to the server's other dossiers, `X` where undecided); stale after 25 new messages or a new summarized conversation; needs 30+ messages; `{ store: false }` builds without writing
  - `pairDossier.ts` → `pair_dossiers` (dynamic, history, tone, grounded in the attention edge) for the strongest pairs with 3+ summarized shared conversations
  - `serverDossier.ts` → `guilds.dossier` + `guilds.server_summary` (overview, culture, topics from summaries, structure from `getSocialStructure`, recent); stale after 20 new summaries or 7 days
- **Semantic Analysis** (`semantic-analysis/EmbeddingService.ts`): local embeddings for message and summary search
- **Enrichment Pipeline** (`enrichment-pipeline/`): one budgeted in-memory queue (`EnrichmentQueue`, retries failed jobs up to 3 times; `EnrichmentRateLimiter` $1/day at real Grok prices) drained every 5 minutes by `EnrichmentScheduler`, which first runs `EnrichmentPipelineOrchestrator.enqueueStaleDossiers` per guild. Jobs: conversation summaries + topic labels (`layers/ConversationEnrichmentPipeline.ts`, enqueued by the segmenter), member/pair/server dossiers. Nothing cascades

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
- messageCreate → stores the message (conversations and closeness are derived from stored messages, nothing else happens here)
- reactionAdd/reactionRemove → `message_reactions` rows (closeness counts them)
- guildMemberAdd/Update → updates member profiles
- channelCreate/Update/Delete → updates channel records
- roleCreate/Update/Delete → updates role records

**Conversation Lifecycle**:
1. `ConversationSegmenter` runs every 2 minutes: for each channel with new messages (or an open conversation) it re-segments the recent tail with `segmentChannelTail` and upserts `conversation_segments`
2. The rule (`conversations/segmenter.ts`, pure): a **session** is a run in one channel with no silence over 20 minutes (a reply to a message in the run within 2 hours stitches across one), capped at 24 hours; a long session is cut into **episodes** where the active speakers change (overlap ≤ 0.45 over ≥10 messages and ≥3 minutes on each side) or the chat pauses ≥8 minutes, never between a reply and what it answers; runs over 40 messages prefer a cut, over 80 must cut at the best seam. An episode with 3+ messages from 2+ people is a conversation; bot commands and bot authors are excluded. Ids are `conv_<channel>_<first message id>` (and `session_id` the same for the run), so reruns are no-ops
3. A conversation whose last message is within 20 minutes is stored `status='active'` (live tools read it); afterwards `finalized`. A late reply that reopens a finalized one updates it in place and resets its summary
4. Finalized conversations with 3+ people or 10+ messages are queued for a summary + `topic_label` + `dynamics` (roles, directed exchanges with a tone and a valence: warm/neutral/cold, running bits, personal news); the prompt includes the conversation's measured attention as hints the model may correct; smaller ones are `skipped`
5. Backfilled messages (downtime recovery) trigger `resegmentChannelHistory` for the channel; `npm run resegment:history` does it for everything (matching conversations keep their summaries)
6. Every stored conversation gets its attention computed (see Attention): `episode_attention` rows and `conversation_segments.focus`. The summarizer's exchanges are stored in `conversation_exchanges` (`source='model'`, with tone, valence and note)

**Attention** (`conversations/attention.ts`, pure):
- Every message carries one unit of attention. A reply gives 0.8 to the replied-to author and the rest to its mentions; a mention (≤3 people) splits it; an implicit message is attributed by recency (the last 4 other speakers within 5 minutes), continuation (who the author was already talking to) and the **affinity prior** (`prior.ts`: the author's share of explicit replies/mentions to each member over the last year, so inferences never feed themselves); what the evidence doesn't support goes to the room. In a two-person conversation it all goes to the other person
- `focusMap` per conversation: the attention matrix, per-person given/room/received, **bids** (a turn, i.e. a run of one author's messages, aimed at one person who hadn't just addressed them, or opened to the room; in groups an implicit turn needs ≥70% of its attention on one person) and whether the target turned back within 4 turns / 20 minutes, and **structures**: reciprocal pairs, pursuits (≥2.5 given, ≤40% returned), a centre, people left unattended, people talking to the room
- Stored by `store.ts` on every pass: `episode_attention` (per directed pair: mass, explicit part, bids, answered) and `conversation_segments.focus`. Tools: `getAttentionProfile`, `getSocialStructure`, `getConversationFocus`, and `getRelationship` includes the edge

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
- [segmenter.ts](src/features/social-intelligence/conversations/segmenter.ts) - The conversation rule; [store.ts](src/features/social-intelligence/conversations/store.ts) applies it to a channel idempotently
- [EnrichmentPipelineOrchestrator.ts](src/features/social-intelligence/enrichment-pipeline/EnrichmentPipelineOrchestrator.ts) - Enrichment layers, cascades and queue processing
- [memberDossier.ts](src/features/social-intelligence/understanding/memberDossier.ts) - Member dossier writer, staleness, server-relative MBTI
- [serverDossier.ts](src/features/social-intelligence/understanding/serverDossier.ts) - Server dossier (what chat prepends to the first turn)

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
- `UserPersonaService.buildPersona` makes sure the member has a fresh dossier (`writeMemberDossier` when missing or stale), gathers recent messages, conversation summaries and their closest connections, has the model write a character profile, and stores it in `user_personas` with real messages as voice examples
- `/persona change` sets the guild's row in `guild_active_personas`; MessageHandler looks it up on every mention/reply and passes the persona to `generateChatResponse` (voice is unaffected)
- Each turn, `personaContext.ts` adds (1) who the persona member is actually closest to (`getConnections`, see Facts above), which overrides the profile on who they're close to, and (2) their real history with the people involved (speaker, @mentions, members named in the message): pair facts, shared conversation summaries (slurs masked), and recent messages between them (group pings, bare mentions/links and slurs filtered)
- The profile writer gets the same `getConnections` ranking, so rebuilt profiles describe the right people
- `generateChatResponse` strips a copied speaker label from replies and turns bare `@123…` ids into `<@123…>` mentions
- The service is attached to the Discord client as `client.userPersonas`

**Add a database table or column**: add `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to `PostgreSQLManager.initializeSchema()`; it runs on every startup.

**Add a dossier section or a new dossier kind**: dossier shapes live in `understanding/types.ts`; each writer (`memberDossier.ts`, `pairDossier.ts`, `serverDossier.ts`) gathers facts + summaries + real messages, calls `OmpRuntime.generateStructured`, renders text, and stores both in one statement. Writers throw on model failure (the queue retries up to 3 times) and return `null` only for "not enough evidence". New kinds need a `find*Stale` query, an `EnrichmentLayer` value, and a case in `EnrichmentPipelineOrchestrator.processJob`.

**Change what counts as a conversation**: the rule is `conversations/segmenter.ts` (pure, tested with `npm test`); change the constants or the split logic there, then `npm run resegment:history` to apply it to stored history (matching conversations keep their summaries).

**Debug conversation detection**: conversations are recomputed from `messages` every 2 minutes (`ConversationSegmenter`); inspect `conversation_segments` (`status='active'` = still going; coverage = messages appearing in some `message_ids`). Nothing lives in memory, so re-running a pass or `resegment:history` is always safe.

**Extend bot mention handling**: Message handling logic lives in `src/handlers/chat/MessageHandler.ts`; modify sanitization, context resolution, or chunking there.
