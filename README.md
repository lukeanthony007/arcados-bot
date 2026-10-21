## Description

A social intelligence engine with LLM interface—maps relationship networks across servers, builds behavioral profiles, and makes the intelligence queryable through natural language with context-aware RAG pipelines.

## Skills / Tools / Stack

- TypeScript
- Retrieval Augmented Generation
- Context Engineering
- PostgreSQL / pgvector
- Multi-Provider LLM Orchestration

# Summary

Social Intelligence gives moderators visibility they've never had: who's connected to whom across servers, how influence flows through communities, and behavioral patterns that predict problems before they surface.

Platforms fragment social data by design. You can't see a user's connections outside your server. You can't see who they talk to elsewhere. You can't see the network topology that explains why certain users show up together, why drama spreads the way it does, or how bad actors coordinate across communities.

This system infers what platforms hide. It tracks interaction patterns across every server where it's deployed, correlates user behavior across contexts, and builds traversable network maps. The result: relationship intelligence that extends beyond any single moderator's view.

Think of it as:

- **Cross-server visibility** — relationship networks inferred from interaction patterns
- **Behavioral early warning** — predictive profiles that surface concerning patterns
- **Network forensics** — trace how users, content, and influence move between communities
- **RAG over social graphs** — LLM queries grounded in live relational data, not static documents

## The Problem

Moderators are blind outside their own servers.

- A user causing problems might be coordinating with others you can't see
- Raids and brigades originate from communities you have no visibility into
- Bad actors build influence networks that span dozens of servers
- By the time harmful behavior surfaces in your community, it's already organized elsewhere

Without cross-context visibility, moderation is reactive. You're always cleaning up after damage is done.

## The Solution

Deploy across multiple communities. Correlate everything. See the network.

**Cross-Server Correlation**

- Track the same users across different contexts
- Infer relationships from co-membership and interaction patterns
- Build network topology that extends beyond any single server

**Behavioral Profiling**

- Communication patterns, timing, triggers, engagement preferences
- Predict how users will behave based on observed patterns
- Surface anomalies—sudden changes in behavior or relationship patterns

**Access Path Mapping**

- Who connects to whom through what intermediaries
- Identify bridging nodes between isolated communities
- Understand how influence and information propagate through networks

**Influence Flow Analysis**

- Who shapes conversation, who amplifies, who follows
- Map information propagation paths
- Identify key nodes for community health or harm

## Who It's For

- Trust & safety teams managing communities at scale
- Moderation teams needing visibility beyond their own servers
- Platform safety researchers studying cross-community dynamics
- Organizations protecting communities from coordinated harm

## LLM Interface & Context Engineering

The intelligence layer is accessed through natural language. Ask questions, get answers grounded in the full social graph.

This is RAG at its most complex—not retrieving static documents, but dynamically assembling context from live relational data: user profiles, relationship networks, conversation history, behavioral patterns. The challenge isn't retrieval. It's knowing what context matters for each query and fitting it within token limits.

**Context Assembly**

Every query triggers a retrieval pipeline:

- Identify relevant users from the query
- Pull behavioral profiles for each
- Retrieve relationship data between them
- Fetch recent conversation segments they participated in
- Score and rank by relevance to the query
- Compress to fit context window

**Multi-Provider Orchestration**

Switch between Grok, Gemini, OpenAI, or Ollama without changing application code. Each provider has different strengths—cost, speed, reasoning depth, tool use. The orchestration layer abstracts this, letting you optimize per-query.

**Dynamic Tool Registry**

The LLM doesn't just answer questions—it can query the intelligence layer directly through function calling:

- `get_user_profile(user_id)` — full behavioral profile
- `get_relationship(user_a, user_b)` — connection strength and history
- `find_path(source, target)` — access path through network
- `search_conversations(query)` — semantic search over history
- `get_network_position(user_id)` — influence metrics and bridging score

Tools are registered dynamically based on available data and query type.

**Managed Disclosure**

Not all context should surface in every response. The system applies disclosure rules:

- Privacy boundaries between users
- Relevance filtering for current conversation
- Sensitivity scoring for behavioral data
- Context budgeting to prioritize high-value information

This is context engineering in practice—managing what an LLM knows and when it's appropriate to use it.

## Architecture

**Ingestion Layer**

- Every observable interaction feeds the intelligence engine
- Cross-server user matching via platform ID
- Real-time enrichment—no batch delays

**Inference Layer**

- Relationship strength scoring from interaction patterns
- Cross-context behavioral correlation
- Network topology inference from partial observations
- Access path calculation between any two users

**Intelligence Layer**

- pgvector semantic search over profiles and relationships
- Predictive profile generation from accumulated behavior
- Traversable graph queries for network analysis
- LLM interface for natural language intelligence queries

## Features

- Cross-server relationship inference from observable interactions
- Behavioral profiles with communication patterns, triggers, and engagement preferences
- Access path mapping between users across fragmented networks
- Monolateral relationship audits—detect interest asymmetry from one side
- Bridging node identification between communities
- Influence flow mapping across network topology
- Anomaly detection for behavioral shifts
- Multi-provider LLM orchestration (Grok, Gemini, OpenAI, Ollama)
- Real-time RAG pipelines with zero-lag retrieval
- Dynamic tool registry for programmatic intelligence access
- Conversation detection with multi-strategy grouping
- Graceful degradation—core inference works with partial data

## Data Model

**User Profiles**

- Cross-server behavioral fingerprint
- Relationship network (inferred and observed)
- Communication patterns and timing
- Engagement triggers and preferences

**Relationship Edges**

- Directed interactions (A→B tracked separately from B→A)
- Cross-server correlation confidence
- Relationship trajectory over time
- Path utility scoring

**Network Topology**

- Inferred connections beyond direct observation
- Bridging nodes and community boundaries
- Influence propagation paths
- Traversal mapping

## How It Works

```
Interaction observed
    ↓
Update behavioral fingerprint
    ↓
Correlate with same user across other servers
    ↓
Update relationship edges (direction, strength, type)
    ↓
Recalculate network topology and access paths
    ↓
Query triggered? → Retrieve:
    - User profile and behavioral patterns
    - Network position and relationships
    - Cross-server activity correlation
    - Relevant conversation history
    ↓
Generate contextual intelligence
```

### Roadmap

1. Cross-platform correlation (Discord + Slack + Telegram)
2. Automated anomaly alerting for behavioral shifts
3. Influence propagation simulation
4. Coordinated behavior detection
5. Export pipelines for external analysis tools

### Instructions

1. Clone repository and install with `bun install`
2. Configure PostgreSQL with pgvector extension
3. Deploy to multiple servers for cross-context correlation
4. Set environment variables for bot token and LLM providers
5. Intelligence builds automatically from observable interactions

### Chat tool context

Blocking `AIEngine.generate()` requests pass retrieved tool results through
`AIProvider.callTextAPIWithTools()`. The consumer preserves narrative summaries,
adds top-level or `data.formatted` details, and falls back to serialized `data`
when no formatted representation exists. Structured failures and missing results
are reported as tool errors rather than `"OK"`. Producers and retrieval scope
are unchanged.

The registry explicitly categorizes the registered camelCase user and relationship
tools, keeping their protocol names intact. Normal chat and explicit category
selection can advertise those definitions; unrelated tools retain legacy name
inference. This changes selection metadata, not producer queries, authorization,
or consent enforcement.

`maxToolContextBytes` bounds the aggregate UTF-8 **content** bytes sent in that
provider argument (default: 4000). Newest results take priority; oversized content
keeps its prefix, with `[truncated]` when space permits. All tool names, roles and
call IDs remain intact, including older results whose content budget is exhausted.
Protocol metadata is outside this content budget. Tool content is not duplicated
in the user prompt. Very small budgets can omit details or error text.

Offline regression check, without installed dependencies or services:

```sh
bun test src/ai/core/AIEngine.test.ts src/ai/tools/registry/DynamicToolRegistry.test.ts
```

The tests exercise the public engine with a captured provider, fake tool results,
real profile/relationship tools backed by a fake DB, and the registered category
catalog. The real-producer fixture requires the called tools to have been
advertised. Serialization faults must not discard other pending results.
The streaming-provider module is stubbed before loading the engine to avoid
SDK/config initialization. This verifies selection and engine-to-provider
transport, not provider SDK behavior, model answer quality, live retrieval,
automatic context enrichment, consent enforcement, or production replies.

### License

MIT
