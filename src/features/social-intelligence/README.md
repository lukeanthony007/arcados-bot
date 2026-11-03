# Social Intelligence

Turns the Discord message history in PostgreSQL into facts, conversations and written understanding that the bot's tools and prompts read. Everything that can be computed from `messages` is computed on demand; only model-written text and conversation boundaries are stored.

## Facts (`facts/`)

Deterministic, always current, never stored.

- **closeness.ts** is the one definition of how much two members interact. An interaction is a reply (3 points), a direct mention in a message pinging at most 3 people (2), a unit of inferred attention inside a conversation (1, from `episode_attention`), a reaction (1) or taking part in the same conversation (1), counted over the whole history: a friendship is what two people built, and going quiet doesn't undo it. Recency is reported separately (when they last interacted, whether the other person is still in the server) and `describeStrength` says it in words. `getConnections` lists a member's closest people, `getPairFacts` describes one pair (strength, reciprocity, share of the member's interactions, raw counts), `getGuildGraph` returns every edge. Bots and group pings are excluded.
- **attention.ts** is the attention network: where each member's attention goes and comes from, inside conversations, over the whole history (or a period, with `sinceDays`/`asOf`). `getAttentionProfile` (flows out and in, who they pursue and who pursues them, how often their bids for attention are answered and how often they answer others', their roles in groups, one-on-one vs group, warmth given and received, when they were last around), `getAttentionEdge` (one pair, both directions, with situations, channels, tones, valence and when they last talked) and `getSocialStructure`. Standing is built from ratios volume can't buy: how much attention someone draws per attention given, how many people turn to them, and how often their bids and openers land, shrunk toward the server baseline for small samples. Each member gets a shape (draws, engine, balanced) and, when most of their attention comes from one or two people, anchors. Cliques are communities on reciprocal attention; the periphery is people whose reaching out lands clearly less often than the server's and who trade a real share of attention with nobody. People who are quiet or gone are marked, not dropped. `describe*` functions render all of it in words, with bands instead of percentages.
- **memberFacts.ts** measures one member: volume, active hours (America/New_York), writing style, how others respond. `describeMemberFacts` renders it as prompt lines.
- **graph.ts** summarizes the server network: hubs and communities from `getSocialStructure`, strongest pairs from the closeness graph.

## Conversations (`conversations/`)

A conversation is a run of human messages in one channel that:

- never goes quiet for more than 20 minutes, unless the next message replies to a message already in the conversation within 6 hours of the previous one;
- spans at most 24 hours;
- has at least 3 messages from at least 2 people.

`segmenter.ts` is a pure function from a channel's messages to segments; ids derive from the channel and the first message, so re-running gives the same conversations. `isSignificant` (3+ participants or 10+ messages) decides which ones get a model-written summary.

`store.ts` applies the segmenter and reconciles with `conversation_segments`. `segmentChannelTail` re-segments the window that could still change and upserts it: unchanged conversations are no-ops, changed ones are updated and re-summarized, vanished ids are deleted. `channelsToSegment` picks the channels worth a pass. A conversation is `active` while its last message is under 20 minutes old, `finalized` after.

`ConversationSegmenter.ts` is the service. Every 2 minutes it re-segments channels with new messages (or an open conversation) and queues newly finalized conversations for a summary. It keeps no in-memory state, so a crash costs nothing.

`bun run resegment:history [--channel <name>]` re-segments whole channel histories with the current rule. Existing conversations that share at least 80% of their messages with a new one keep their id, summary and embedding; the rest are replaced and queued. Safe to re-run.

### Attention (`conversations/attention.ts`)

Who focused on whom inside each conversation, computed deterministically on every segmentation pass.

- Every message carries one unit of attention. Replies and mentions are explicit. An implicit message is attributed by recency, continuation and the author's **affinity prior** (`prior.ts`: their share of explicit replies and mentions to each member over the last year; built from explicit signals only so inferences never reinforce themselves). What the evidence doesn't support goes to the room. In a two-person conversation it all goes to the other person.
- `focusMap` turns the attributions into the conversation's social shape: the attention matrix, **bids** (a turn aimed at someone who hadn't just addressed the author, or opened to the room) and whether they were answered within 4 turns or 20 minutes, and **structures**: reciprocal pairs, pursuits, a centre, people left unattended, people talking to the room. `focusText.ts` renders it in words.
- `store.ts` writes `episode_attention` (per directed pair: mass, explicit part, bids, answered) and `conversation_segments.focus`.

## Summaries and topic labels (`enrichment-pipeline/layers/ConversationEnrichmentPipeline.ts`)

One structured model call per significant conversation returns `{ summary, topic_label, dynamics }`. `dynamics` holds roles (drivers, responders, ignored), up to 8 directed exchanges with a tone, a valence (warm = affirming, cold = undermining) and a note, running bits, and personal news (plans, outcomes, life updates people share). The prompt shows sampled messages as `Name: content` with slurs masked and mentions resolved to names, plus the conversation's measured attention as hints the model may correct. The summary, label, dynamics and an embedding of the summary (local, `semantic-analysis/EmbeddingService.ts`, used for semantic search) are written with `ai_processing_status = 'completed'`; exchanges also go to `conversation_exchanges` (`source='model'`).

Segments with no messages left are marked `skipped`. A budget refusal leaves the segment `pending` for the backlog sweep. Rate-limit errors retry up to 3 times.

Topics come only from `topic_label` and `summary`; there is no keyword extraction.

## Understanding (`understanding/`)

Written once per subject from facts, conversation summaries and a sample of real messages, then regenerated whole when stale.

- **memberDossier.ts**: identity, voice, interests, people, social position (from the attention profile), recent activity and Big Five. MBTI is derived from the Big Five relative to the server, never asked of the model. Needs 30 messages; stale after 25 new ones.
- **pairDossier.ts**: how two members relate, grounded in their attention edge (who seeks whom, asymmetry, warmth). Regenerated when enough new shared conversations accumulate.
- **serverDossier.ts**: what the server is and its structure (where attention gathers, tight circles, people reaching out without much return), stored in `guilds.server_summary` and prepended to the first turn of a chat.

`bun run dossier:stale|member|pair|server` writes them by hand.

## Enrichment queue and budget (`enrichment-pipeline/`)

`EnrichmentScheduler` runs every 5 minutes; `EnrichmentQueue` is in-memory and retries a failed job up to 3 times; `EnrichmentPipelineOrchestrator` runs the layers. `EnrichmentRateLimiter` enforces a $1/day and $40/month cap, persisted in `.cache/enrichment-budget.json` so a crash loop cannot respend it. `bun run enrich:conversations:24h|7d|force` runs summaries by hand.

## Deliberately not stored

- Closeness, attention profiles and edges, social structure, member statistics: recomputed from `messages`, `episode_attention` and `conversation_segments` on demand.
- Keywords, vocabularies, TF-IDF: not used.
- In-progress conversation buffers: the segmenter recomputes from messages.
- Reactions are not part of attention (they are counted only in closeness).
