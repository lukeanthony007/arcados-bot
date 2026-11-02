import { pgvector, PostgreSQLManager } from "../../../database/PostgreSQLManager.js";
import type { AIEngine } from "../../../ai/core/AIEngine";
import type { AIResponse } from "../../../ai/providers/base/AIProvider";
import { AIRequestBuilder } from "../../../ai/core/AIRequestBuilder";
import { AIContextBuilder } from "../../../ai/core/AIContext.js";
import { AIFactory } from "../../../ai/core/AIFactory";
import { EmbeddingService } from "../semantic-analysis/EmbeddingService.js";
import { PsychologicalProfiler } from "../psychological-profiling/PsychologicalProfiler";

const SUMMARY_STOP_WORDS = new Set([
  "the",
  "and",
  "but",
  "that",
  "with",
  "for",
  "you",
  "your",
  "are",
  "was",
  "were",
  "this",
  "have",
  "has",
  "had",
  "about",
  "from",
  "they",
  "their",
  "them",
  "what",
  "when",
  "where",
  "how",
  "why",
  "there",
  "then",
  "just",
  "like",
  "that’s",
  "thats",
  "aint",
  "dont",
  "didnt",
  "doesnt",
  "cant",
  "im",
  "ive",
  "ill",
  "its",
  "its",
  "lol",
]);

/**
 * Configuration options for conversation enhancement
 */
export interface EnhancementConfig {
  lookbackHours?: number; // How far back to process (default: 24)
  minMessagesForSplit?: number; // Min messages to consider splitting (default: 20)
  minDurationForSplit?: number; // Min duration in minutes (default: 60)
  batchSize?: number; // Process N segments at a time (default: 10)
  sleepBetweenBatches?: number; // Sleep ms between batches (default: 4000 = 15 RPM)
  enableSummaries?: boolean; // Enable summary generation (default: true)
  enableOrphans?: boolean; // Enable orphan classification (default: true)
  enableSplitting?: boolean; // Enable conversation splitting (default: false)
  enableProfiling?: boolean; // Enable psychological profiling (default: false)
  enableCommunityAnalysis?: boolean; // Enable community structure analysis (default: false)
  minMessagesForProfiling?: number; // Min messages for profiling (default: 10)
  profilingBatchSize?: number; // Users per profiling batch (default: 10)
  dryRun?: boolean; // Don't write to database (default: false)
  regenerateSummaries?: boolean; // Regenerate summaries even if they exist (default: false)
}

/**
 * Processing statistics
 */
export interface EnhancementStats {
  segmentsProcessed: number;
  summariesGenerated: number;
  orphansRecovered: number;
  conversationsSplit: number;
  usersProfiled: number;
  communityAnalysisRun: boolean;
  errors: number;
  apiCallsMade: number;
  startTime: Date;
  endTime?: Date;
}

/**
 * EnhancementOrchestrator
 *
 * Coordinates the AI enhancement pipeline for conversation segments.
 * Manages rate limiting, error handling, and progress tracking.
 */
export class EnhancementOrchestrator {
  private db: PostgreSQLManager;
  private aiEngine: AIEngine | null = null;
  private aiEnginePromise: Promise<AIEngine> | null = null;
  private config: Required<EnhancementConfig>;
  private stats: EnhancementStats;
  private apiCallTimestamps: number[] = [];

  // Rate limiting configuration (Gemini free tier: 15 RPM)
  private readonly MAX_CALLS_PER_MINUTE = 15;
  private readonly RATE_LIMIT_WINDOW_MS = 60 * 1000;

  constructor(
    db: PostgreSQLManager,
    aiEngine?: AIEngine,
    config: EnhancementConfig = {}
  ) {
    this.db = db;
    if (aiEngine) {
      this.aiEngine = aiEngine;
    } else {
      // Lazy initialization: engine will be created on first use
      this.aiEnginePromise = AIFactory.create().then(({ engine }) => engine);
    }
    this.config = {
      lookbackHours: config.lookbackHours ?? 24,
      minMessagesForSplit: config.minMessagesForSplit ?? 20,
      minDurationForSplit: config.minDurationForSplit ?? 60,
      batchSize: config.batchSize ?? 10,
      sleepBetweenBatches: config.sleepBetweenBatches ?? 4000,
      enableSummaries: config.enableSummaries ?? true,
      enableOrphans: config.enableOrphans ?? true,
      enableSplitting: config.enableSplitting ?? false,
      enableProfiling: config.enableProfiling ?? false,
      enableCommunityAnalysis: config.enableCommunityAnalysis ?? false,
      minMessagesForProfiling: config.minMessagesForProfiling ?? 10,
      profilingBatchSize: config.profilingBatchSize ?? 10,
      dryRun: config.dryRun ?? false,
      regenerateSummaries: config.regenerateSummaries ?? false,
    };

    this.stats = {
      segmentsProcessed: 0,
      summariesGenerated: 0,
      orphansRecovered: 0,
      conversationsSplit: 0,
      usersProfiled: 0,
      communityAnalysisRun: false,
      errors: 0,
      apiCallsMade: 0,
      startTime: new Date(),
    };
  }

  private async getAIEngine(): Promise<AIEngine> {
    if (this.aiEngine) {
      return this.aiEngine;
    }
    if (!this.aiEnginePromise) {
      this.aiEnginePromise = AIFactory.create().then(({ engine }) => engine);
    }
    this.aiEngine = await this.aiEnginePromise;
    return this.aiEngine;
  }

  /**
   * Run the full enhancement pipeline
   */
  async enhance(guildId: string): Promise<EnhancementStats> {
    console.log("🔹 Starting AI conversation enhancement...");
    console.log(`   Guild: ${guildId}`);
    console.log(`   Lookback: ${this.config.lookbackHours} hours`);
    console.log(`   Batch size: ${this.config.batchSize}`);
    console.log(`   Dry run: ${this.config.dryRun}`);
    console.log("");

    this.stats.startTime = new Date();

    try {
      // Phase 1: Summary Generation (High Priority)
      if (this.config.enableSummaries) {
        await this.runSummaryGeneration(guildId);
      }

      // Phase 2: Orphan Classification (High Priority)
      if (this.config.enableOrphans) {
        await this.runOrphanClassification(guildId);
      }

      // Phase 3: Conversation Splitting (Medium Priority, expensive)
      if (this.config.enableSplitting) {
        await this.runConversationSplitting(guildId);
      }

      // Phase 4: Psychological Profiling (batch process)
      if (this.config.enableProfiling) {
        await this.runUserProfiling(guildId);
      }

      // Phase 5: Community Structure Analysis (behind-the-scenes)
      if (this.config.enableCommunityAnalysis) {
        await this.runCommunityAnalysis(guildId);
      }

      this.stats.endTime = new Date();
      this.printSummary();

      return this.stats;
    } catch (error) {
      console.error("❌ Enhancement pipeline failed:", error);
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * Phase 1: Generate summaries for segments
   */
  private async runSummaryGeneration(guildId: string): Promise<void> {
    console.log(
      "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.log("📄 PHASE 1: Summary Generation");
    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );

    const since = new Date(
      Date.now() - this.config.lookbackHours * 60 * 60 * 1000
    );

    // Query segments without summaries, with old auto-generated summaries, or all if regenerating
    // Old summaries start with number patterns like "2 users:" or "3 users:"
    const summaryCondition = this.config.regenerateSummaries
      ? "TRUE" // Regenerate all summaries
      : `(
          cs.summary IS NULL 
          OR cs.summary = ''
          OR cs.summary ~ '^\\d+\\s+users?:'  -- Old auto-generated format
        )`;

    const segmentsResult = await this.db.query(
      `
      SELECT 
        cs.id, 
        cs.channel_id, 
        cs.message_ids, 
        cs.start_time, 
        cs.end_time, 
        cs.message_count,
        cs.participants
      FROM conversation_segments cs
      WHERE cs.guild_id = $1
        AND ${summaryCondition}
        AND cs.message_count >= 2
        AND cs.start_time >= $2
        AND cs.status = 'finalized'
      ORDER BY cs.start_time DESC
      `,
      [guildId, since]
    );

    if (
      !segmentsResult.success ||
      !segmentsResult.data ||
      segmentsResult.data.length === 0
    ) {
      console.log("   ℹ️  No segments without summaries found");
      return;
    }

    const segments = segmentsResult.data;
    console.log(`   Found ${segments.length} segments without summaries`);
    console.log(`   Processing in batches of ${this.config.batchSize}...\n`);

    // Process in batches
    for (let i = 0; i < segments.length; i += this.config.batchSize) {
      const batch = segments.slice(i, i + this.config.batchSize);
      console.log(
        `   [${i + 1}-${Math.min(i + this.config.batchSize, segments.length)}/${
          segments.length
        }]`
      );

      for (const segment of batch) {
        await this.rateLimit();

        try {
          // Fetch messages for this segment (including attachments and embeds for context)
          const messagesResult = await this.db.query(
            `
            SELECT id, author_id, content, created_at, attachments, embeds
            FROM messages
            WHERE id = ANY($1::TEXT[])
            ORDER BY created_at ASC
            `,
            [segment.message_ids]
          );

          if (
            !messagesResult.success ||
            !messagesResult.data ||
            messagesResult.data.length === 0
          ) {
            console.warn(
              `      ⚠️  Segment ${segment.id.slice(0, 8)}: No messages found`
            );
            continue;
          }

          const messages = messagesResult.data;

          const termCounts = new Map<string, number>();
          for (const rawMessage of messages) {
            const content = (rawMessage.content || "")
              .toLowerCase()
              .replace(/https?:\/\/\S+/g, " ")
              .replace(/[^\w@#]+/g, " ");

            const tokens = content.split(/\s+/);
            for (const token of tokens) {
              const normalized = token.trim();
              if (!normalized || normalized.length < 3) continue;
              if (SUMMARY_STOP_WORDS.has(normalized)) continue;
              termCounts.set(normalized, (termCounts.get(normalized) || 0) + 1);
            }
          }

          const topTerms = Array.from(termCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8);
          const topicHintText = topTerms
            .map(([term, count]) => `${term} (${count})`)
            .join(", ");

          // Build message preview with smart sampling
          // For short conversations: use all messages
          // For long conversations: sample from beginning, middle, and end
          let sampledMessages = messages;
          if (messages.length > 30) {
            // Take first 10, middle 10, last 10
            const start = messages.slice(0, 10);
            const middleIndex = Math.floor(messages.length / 2) - 5;
            const middle = messages.slice(middleIndex, middleIndex + 10);
            const end = messages.slice(-10);
            sampledMessages = [...start, ...middle, ...end];
          }

          const messagePreview = sampledMessages
            .map((m: any) => {
              const content = (m.content || "").trim();
              // Skip bot commands (m!p, !play, .spin, etc.)
              if (content.match(/^(m!|!|\.)\w+/i)) {
                return "(bot command)";
              }
              
              // Check for attachments and embeds to add context
              const hasAttachments = m.attachments && Array.isArray(m.attachments) && m.attachments.length > 0;
              const hasEmbeds = m.embeds && Array.isArray(m.embeds) && m.embeds.length > 0;
              
              // Determine media type from attachments/embeds
              let mediaPlaceholder = "";
              if (hasAttachments || hasEmbeds) {
                // Check if it's a video, image, or other media
                const allUrls = [
                  ...(hasAttachments ? m.attachments : []),
                  ...(hasEmbeds ? m.embeds.map((e: string) => {
                    try {
                      const embed = JSON.parse(e);
                      return embed.url || embed.thumbnail?.url || embed.image?.url || embed.video?.url;
                    } catch {
                      return null;
                    }
                  }).filter(Boolean) : [])
                ];
                
                const hasVideo = allUrls.some((url: string) => 
                  /\.(mp4|webm|mov|avi|mkv|gifv)$/i.test(url) || 
                  /youtube\.com|youtu\.be|vimeo\.com|twitch\.tv/i.test(url) ||
                  /tenor\.com/i.test(url)
                );
                const hasImage = allUrls.some((url: string) => 
                  /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url) ||
                  /i\.imgur\.com|cdn\.discordapp\.com.*\.(jpg|jpeg|png|gif|webp)/i.test(url)
                );
                
                if (hasVideo) {
                  mediaPlaceholder = " [posts video]";
                } else if (hasImage) {
                  mediaPlaceholder = " [posts image]";
                } else {
                  mediaPlaceholder = " [posts media]";
                }
              }
              
              // Combine content with media placeholder
              const fullContent = content.length > 0 
                ? content + mediaPlaceholder 
                : mediaPlaceholder ? mediaPlaceholder.trim() : "(no text content)";
              
              return fullContent;
            })
            .join("\n")
            .substring(0, 3000); // Increased from 2000 to 3000

          const participantCount = Array.isArray(segment.participants)
            ? segment.participants.length
            : 0;
          const duration =
            (new Date(segment.end_time).getTime() -
              new Date(segment.start_time).getTime()) /
            (60 * 1000);

          // Generate summary using AI
          const prompt = `Summarize this Discord conversation in 1-2 concise sentences. State the key topics/actions directly.

BAD EXAMPLES (DO NOT USE):
❌ "Discussed suggestive humor and innuendos..." (generic "discussed", euphemistic)
❌ "Talked about politics..." (vague "talked about")
❌ "Shared a YouTube link" (too vague, missing context)
❌ "Mentioned food and feelings" (passive "mentioned")
❌ "User <@886340655671046176> said..." (Discord user IDs)

GOOD EXAMPLES (USE THIS STYLE):
🔹 "Trump allegedly performed oral sex on Bill Clinton; Hitler had a micropenis; white supremacists struggling"
🔹 "Boyfriend getting halal food; recent meals included steak, rice, green beans, Hawaiian rolls"
🔹 "Invited to walk to gas station; jokingly called 'a bit gay'"
🔹 "Not invited to watch BattleBots; called friends 'fakes'"
🔹 "Shared flying fish video; joked about fish spinning"
🔹 "Joked about ejaculation ('nuttin'), putting it on someone's face; described 11lb processed ham as unnatural abhorrence"
🔹 "Flirting in public as turn-on; already met up for sex"
🔹 "Masturbation jokes, sexual positions, graphic descriptions; compared sex to Jason Statham's Transporter role"

RULES:
1. Use ACTIVE, SPECIFIC language - avoid generic verbs like "discussed", "talked about", "mentioned"
2. Use semicolons to separate multiple topics within the summary
3. For sexual/crude content: state it plainly (e.g., "joked about masturbation", "made crude sexual remarks")
4. Public figures (Trump, celebrities) CAN be mentioned by name
5. Avoid Discord user IDs like <@123456> or usernames
6. IGNORE bot commands (lines marked as "(bot command)")
7. Start directly with the content - no meta-commentary like "The conversation was about..."
8. Prioritize the dominant subject matter indicated by the top recurring terms below; if there's a conflict or repeated grievance, you MUST capture it explicitly
9. When multiple topics appear, emphasize the ones that span the most messages or have emotional weight (arguments, complaints, requests)

Conversation (${messages.length} messages, ${participantCount} participants):
${messagePreview}

Top recurring terms (by frequency): ${topicHintText || "none"}

Summary:`;

          // Try Grok first (better rate limits), fallback to Ollama
          let provider = "grok";
          if (!process.env.GROK_API_KEY && process.env.OLLAMA_URL) {
            provider = "ollama";
          }

          // Retry logic for rate limits
          let response: AIResponse | undefined;
          let retries = 3;
          let lastError: Error | null = null;

          while (retries > 0) {
            try {
              const engine = await this.getAIEngine();
              const builder = new AIRequestBuilder(engine);
              // Use a simple synthetic context for summarization calls
              const ctx = new AIContextBuilder()
                .user("system-summarizer")
                .guild(guildId)
                .build();
              const result = await builder
                // Structured mode: the chat preset caps output at 60 tokens, truncating summaries.
                // The prompt asks for 1-2 sentences; 300 tokens is headroom, not a target.
                .blocking()
                .mode("structured")
                .maxTokens(300)
                .withContext(ctx)
                .provider(provider as "grok" | "ollama")
                .persona("casual")
                .withoutTools() // Summaries don't need database tools
                .generate(prompt);
              // Blocking mode returns AIResponse
              response = result as AIResponse;
              break; // Success, exit retry loop
            } catch (error) {
              lastError =
                error instanceof Error ? error : new Error(String(error));
              const errorMsg = lastError.message.toLowerCase();

              // Check if it's a rate limit error
              if (
                errorMsg.includes("429") ||
                errorMsg.includes("quota") ||
                errorMsg.includes("rate limit")
              ) {
                retries--;
                if (retries > 0) {
                  const waitTime = 10000; // Wait 10 seconds
                  console.log(
                    `      ⏳ Rate limit hit, waiting ${
                      waitTime / 1000
                    }s before retry...`
                  );
                  await this.sleep(waitTime);
                }
              } else {
                // Not a rate limit error, don't retry
                break;
              }
            }
          }

          if (response && response.success && response.content) {
            const summary = response.content.trim();

            // Generate embedding from summary
            let embedding: number[] | null = null;
            try {
              const embeddingService = EmbeddingService.getInstance();
              embedding = await embeddingService.generateEmbedding(summary);
            } catch (error) {
              console.warn(
                `      ⚠️  Failed to generate embedding for segment ${segment.id.slice(
                  0,
                  8
                )}: ${error}`
              );
            }

            // Update database with summary and embedding
            if (!this.config.dryRun) {
              if (embedding) {
                // Convert to pgvector format using toSql()
                await this.db.query(
                  `
                  UPDATE conversation_segments
                  SET summary = $2,
                      embedding = $3::vector,
                      ai_processing_status = 'completed',
                      ai_processed_at = NOW()
                  WHERE id = $1
                  `,
                  [segment.id, summary, pgvector.toSql(embedding)]
                );
              } else{
                await this.db.query(
                  `
                  UPDATE conversation_segments
                  SET summary = $2,
                      ai_processing_status = 'completed',
                      ai_processed_at = NOW()
                  WHERE id = $1
                  `,
                  [segment.id, summary]
                );
              }
            }

            const preview =
              summary.length > 60 ? summary.substring(0, 57) + "..." : summary;
            const embeddingStatus = embedding ? "✓" : "✗";
            console.log(
              `      🔹 Segment ${segment.id.slice(0, 8)}: "${preview}" [embed:${embeddingStatus}]`
            );
            this.stats.summariesGenerated++;
            this.stats.apiCallsMade++;
          } else {
            const errorMsg = lastError
              ? lastError.message.substring(0, 100)
              : "Unknown error";
            console.warn(
              `      ⚠️  Segment ${segment.id.slice(
                0,
                8
              )}: AI generation failed - ${errorMsg}`
            );
            this.stats.errors++;
          }
        } catch (error) {
          console.error(
            `      ✗ Segment ${segment.id.slice(0, 8)} failed: ${error}`
          );
          this.stats.errors++;
        }
      }

      // Sleep between batches
      if (i + this.config.batchSize < segments.length) {
        await this.sleep(this.config.sleepBetweenBatches);
      }
    }

    this.stats.segmentsProcessed += segments.length;
    console.log(
      `\n   🔹 Phase 1 complete: ${this.stats.summariesGenerated} summaries generated\n`
    );
  }

  /**
   * Phase 2: Classify and recover orphaned messages
   */
  private async runOrphanClassification(guildId: string): Promise<void> {
    console.log(
      "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.log("🔍 PHASE 2: Orphan Classification");
    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );

    // TODO: Implement orphan classification
    console.log("   ℹ️  Orphan classification not yet implemented");
  }

  /**
   * Phase 3: Split long conversations by topic
   */
  private async runConversationSplitting(guildId: string): Promise<void> {
    console.log(
      "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.log("✂️  PHASE 3: Conversation Splitting");
    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );

    // TODO: Implement conversation splitting
    console.log("   ℹ️  Conversation splitting not yet implemented");
  }

  /**
   * Phase 4: Psychological Profiling
   */
  private async runUserProfiling(guildId: string): Promise<void> {
    console.log(
      "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.log("🧠 PHASE 4: Psychological Profiling");
    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );

    // Get active users (>= minMessagesForProfiling, not bots)
    const usersResult = await this.db.query(
      `
      SELECT m.user_id, COUNT(msg.id) as message_count
      FROM members m
      LEFT JOIN messages msg ON msg.author_id = m.user_id AND msg.guild_id = m.guild_id
      WHERE m.guild_id = $1
        AND m.bot = false
        AND m.active = true
      GROUP BY m.user_id
      HAVING COUNT(msg.id) >= $2
      ORDER BY COUNT(msg.id) DESC
      `,
      [guildId, this.config.minMessagesForProfiling]
    );

    if (!usersResult.success || !usersResult.data || usersResult.data.length === 0) {
      console.log("   ℹ️  No users found for profiling");
      return;
    }

    const userIds = usersResult.data.map((row: any) => row.user_id);
    console.log(`   Found ${userIds.length} users to profile`);

    // Initialize profiler
    const aiEngine = await this.getAIEngine();
    const profiler = new PsychologicalProfiler(this.db, aiEngine, {
      minMessagesForProfiling: this.config.minMessagesForProfiling,
      batchSize: this.config.profilingBatchSize,
      sleepBetweenBatchesMs: 1000, // 1 second for Grok (better rate limits)
    });

    // Profile users in batches
    const successCount = await profiler.profileBatch(guildId, userIds);

    this.stats.usersProfiled = successCount;
    this.stats.apiCallsMade += profiler.getStats().api_calls_made;

    console.log(
      `\n   🔹 Phase 4 complete: ${successCount}/${userIds.length} users profiled\n`
    );
  }

  /**
   * Phase 5: Community Structure Analysis
   */
  private async runCommunityAnalysis(guildId: string): Promise<void> {
    console.log(
      "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.log("🌐 PHASE 5: Community Structure Analysis");
    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );

    // TODO: Implement community structure analysis (Louvain, PageRank, etc.)
    console.log("   ℹ️  Community structure analysis not yet implemented");
    console.log("   ℹ️  This will include:");
    console.log("      - Clique detection (Louvain algorithm)");
    console.log("      - Influence ranking (PageRank-style)");
    console.log("      - Bridge detection (users connecting groups)");

    this.stats.communityAnalysisRun = false;
  }

  /**
   * Rate limiting to stay within Gemini free tier (15 RPM)
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();

    // Clean old timestamps outside the window
    this.apiCallTimestamps = this.apiCallTimestamps.filter(
      (ts) => now - ts < this.RATE_LIMIT_WINDOW_MS
    );

    // If at limit, wait until oldest call expires
    if (this.apiCallTimestamps.length >= this.MAX_CALLS_PER_MINUTE) {
      const oldestCall = Math.min(...this.apiCallTimestamps);
      const waitTime = this.RATE_LIMIT_WINDOW_MS - (now - oldestCall) + 100; // +100ms buffer
      console.log(
        `      ⏳ Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s...`
      );
      await this.sleep(waitTime);
    }

    // Record this API call
    this.apiCallTimestamps.push(Date.now());
  }

  /**
   * Sleep for specified milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Print enhancement summary
   */
  private printSummary(): void {
    const duration = this.stats.endTime
      ? (this.stats.endTime.getTime() - this.stats.startTime.getTime()) / 1000
      : 0;

    console.log(
      "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    );
    console.log("📊 ENHANCEMENT SUMMARY");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`   Segments Processed:     ${this.stats.segmentsProcessed}`);
    console.log(`   Summaries Generated:    ${this.stats.summariesGenerated}`);
    console.log(`   Orphans Recovered:      ${this.stats.orphansRecovered}`);
    console.log(`   Conversations Split:    ${this.stats.conversationsSplit}`);
    console.log(`   Users Profiled:         ${this.stats.usersProfiled}`);
    console.log(`   Community Analysis:     ${this.stats.communityAnalysisRun ? "Yes" : "No"}`);
    console.log(`   API Calls Made:         ${this.stats.apiCallsMade}`);
    console.log(`   Errors:                 ${this.stats.errors}`);
    console.log(`   Duration:               ${duration.toFixed(1)}s`);
    console.log(
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );
  }

  /**
   * Get current stats
   */
  getStats(): EnhancementStats {
    return { ...this.stats };
  }
}
