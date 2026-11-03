# Social Intelligence

Turns the Discord message history in PostgreSQL into facts, conversations and written understanding that the bot's tools and prompts read. Everything that can be computed from `messages` is computed on demand; only model-written text and conversation boundaries are stored.

## Facts (`facts/`)

Deterministic, always current, never stored.

- **closeness.ts** is the one definition of how much two members interact. An interaction is a reply (3 points), a direct mention in a message pinging at most 3 people (2), or taking part in the same conversation (1). Each is weighted with a 180-day half-life. `getConnections` lists a member's closest people, `getPairFacts` describes one pair (strength, reciprocity, share of the member's interactions, raw counts), `getGuildGraph` returns every edge. Bots and group pings are excluded. Reactions are not counted; they are not recorded as events.
- **memberFacts.ts** measures one member: volume, active hours (America/New_York), writing style, how others respond. `describeMemberFacts` renders it as prompt lines.
- **graph.ts** summarizes the server network (hubs, strongest pairs, communities) from the closeness graph over active, non-bot members.

## Conversations (`conversations/`)

A conversation is a run of human messages in one channel that:

- never goes quiet for more than 20 minutes, unless the next message replies to a message already in the conversation within 6 hours of the previous one;
- spans at most 24 hours;
- has at least 3 messages from at least 2 people.

`segmenter.ts` is a pure function from a channel's messages to segments; ids derive from the channel and the first message, so re-running gives the same conversations. `isSignificant` (3+ participants or 10+ messages) decides which ones get a model-written summary.

`store.ts` applies the segmenter and reconciles with `conversation_segments`. `segmentChannelTail` re-segments the window that could still change and upserts it: unchanged conversations are no-ops, changed ones are updated and re-summarized, vanished ids are deleted. `channelsToSegment` picks the channels worth a pass. A conversation is `active` while its last message is under 20 minutes old, `finalized` after.

`ConversationSegmenter.ts` is the service. Every 2 minutes it re-segments channels with new messages (or an open conversation) and queues newly finalized conversations for a summary. It keeps no in-memory state, so a crash costs nothing.

`bun run resegment:history [--channel <name>]` re-segments whole channel histories with the current rule. Existing conversations that share at least 80% of their messages with a new one keep their id, summary and embedding; the rest are replaced and queued. Safe to re-run.

## Summaries and topic labels (`enrichment-pipeline/layers/ConversationEnrichmentPipeline.ts`)

One structured model call per significant conversation returns `{ summary, topic_label }`. The prompt shows sampled messages as `Name: content` (first, middle and last ten for long conversations) with slurs masked and mentions resolved to names. The `topic_label` is 2-5 words naming the subject, such as "A Plague Tale". The summary, label and an embedding of the summary (local, `semantic-analysis/EmbeddingService.ts`, used for semantic search) are written in one UPDATE with `ai_processing_status = 'completed'`.

Segments with no messages left are marked `skipped`. A budget refusal leaves the segment `pending` for the backlog sweep. Rate-limit errors retry up to 3 times.

Topics come only from `topic_label` and `summary`; there is no keyword extraction.

## Understanding (`understanding/`)

Written once per subject from facts, conversation summaries and a sample of real messages, then regenerated whole when stale.

- **memberDossier.ts**: identity, voice, interests, people, recent activity and Big Five. MBTI is derived from the Big Five relative to the server, never asked of the model. Needs 30 messages; stale after 25 new ones.
- **pairDossier.ts**: how two members relate. Regenerated when enough new shared conversations accumulate.
- **serverDossier.ts**: what the server is, stored in `guilds.server_summary` and prepended to the first turn of a chat.

`bun run dossier:stale|member|pair|server` writes them by hand.

## Enrichment queue and budget (`enrichment-pipeline/`)

`EnrichmentScheduler` runs every 5 minutes; `EnrichmentQueue` is in-memory and retries a failed job up to 3 times; `EnrichmentPipelineOrchestrator` runs the layers. `EnrichmentRateLimiter` enforces a $1/day and $40/month cap, persisted in `.cache/enrichment-budget.json` so a crash loop cannot respend it. `bun run enrich:conversations:24h|7d|force` runs summaries by hand.

## Deliberately not stored

- Closeness, relationship edges, interaction counts, member statistics: recomputed from `messages`.
- Keywords, vocabularies, TF-IDF: not used.
- In-progress conversation buffers: the segmenter recomputes from messages.
- Reactions as relationship signal.
