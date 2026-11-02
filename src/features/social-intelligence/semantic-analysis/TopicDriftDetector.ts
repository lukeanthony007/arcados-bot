import type { AIEngine } from "../../../ai/core/AIEngine";
import type { AIResponse } from "../../../ai/providers/base/AIProvider";
import { AIRequestBuilder } from "../../../ai/core/AIRequestBuilder";
import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { EmbeddingService } from "./EmbeddingService";
import { TFIDFExtractor } from "./TFIDFExtractor";
import { KeywordExtractor } from "./KeywordExtractor";
import type { KeywordMessage, KeywordScore } from "./types";

export interface Message {
  id: string;
  author_id: string;
  content: string;
  created_at: Date;
  embedding?: number[];
}

export interface TopicLabel {
  label: string;
  confidence: number;
  timestamp: Date;
}

export interface DriftDetectionResult {
  shouldSplit: boolean;
  driftScore: number;
  newTopicLabel?: string;
  confidence: number;
  reason: string;
}

export interface ConversationSplit {
  splitIndex: number;
  beforeTopic: string;
  afterTopic: string;
  confidence: number;
  reason: string;
}

export interface TopicDriftDetectorOptions {
  aiEngine?: AIEngine;
  aiFailureCooldownMs?: number;
}

/**
 * Service for detecting topic drift in conversations using embeddings and AI
 */
export class TopicDriftDetector {
  private aiEngine: AIEngine | null;
  private embeddingService: EmbeddingService;
  private db: PostgreSQLManager;
  private tfidfExtractor: TFIDFExtractor;
  private keywordExtractor: KeywordExtractor;
  private readonly aiFailureCooldownMs: number;
  private aiCooldownUntil: number | null = null;

  // Balanced thresholds (tuned for meaningful topic change detection)
  private readonly BASE_SEMANTIC_THRESHOLD = 0.5;
  private readonly HIGH_CONFIDENCE_THRESHOLD = 0.8; // Raised to 80% to check more windows
  private readonly LOW_CONFIDENCE_THRESHOLD = 0.4;

  // Keyword-based drift detection thresholds
  private readonly KEYWORD_HIGH_OVERLAP = 0.4; // High keyword overlap = same topic
  private readonly KEYWORD_LOW_OVERLAP = 0.15; // Low keyword overlap = different topic

  // Use Ollama (GPT-OSS) for topic labeling (switched from Gemini due to high API costs)
  // Final AI assistant responses use Grok
  private readonly TOPIC_MODEL = "ollama" as const;
  private readonly AI_USAGE_WINDOW_MS = 60 * 1000; // Track AI usage per minute
  private readonly AI_MAX_CALLS_PER_WINDOW = 20; // Max AI calls per window
  private readonly AI_THROTTLE_COOLDOWN_MS = 60 * 1000; // Cooldown after hitting limit
  private readonly AI_THROTTLE_LOG_INTERVAL_MS = 10 * 1000;
  private aiUsageHistory: number[] = [];
  private lastAiThrottleLog = 0;

  constructor(
    db: PostgreSQLManager,
    options: TopicDriftDetectorOptions = {}
  ) {
    this.aiEngine = options.aiEngine ?? null;
    this.embeddingService = EmbeddingService.getInstance();
    this.db = db;
    this.tfidfExtractor = new TFIDFExtractor();
    this.keywordExtractor = new KeywordExtractor(db);
    this.aiFailureCooldownMs = options.aiFailureCooldownMs ?? 30 * 60 * 1000;
  }

  setAIEngine(aiEngine: AIEngine | null): void {
    this.aiEngine = aiEngine ?? null;
    if (!aiEngine) {
      this.aiCooldownUntil = null;
    }
  }

  private canUseAI(): boolean {
    if (!this.aiEngine) {
      return false;
    }

    const now = Date.now();

    if (this.aiCooldownUntil && now < this.aiCooldownUntil) {
      return false;
    }

    this.cleanupAIUsageHistory(now);

    if (this.aiUsageHistory.length >= this.AI_MAX_CALLS_PER_WINDOW) {
      if (now - this.lastAiThrottleLog > this.AI_THROTTLE_LOG_INTERVAL_MS) {
        console.warn(
          "🔸 TopicDriftDetector throttling Ollama usage to avoid rate limits."
        );
        this.lastAiThrottleLog = now;
      }
      this.aiCooldownUntil = now + this.AI_THROTTLE_COOLDOWN_MS;
      return false;
    }

    return true;
  }

  private registerAIFailure(error: unknown): void {
    this.aiCooldownUntil = Date.now() + this.aiFailureCooldownMs;
    console.warn(
      "🔸 TopicDriftDetector AI failure; entering cooldown:",
      error instanceof Error ? error.message : error
    );
  }

  private recordAIUsage(): void {
    this.aiUsageHistory.push(Date.now());
  }

  private cleanupAIUsageHistory(now: number): void {
    if (this.aiUsageHistory.length === 0) {
      return;
    }
    const cutoff = now - this.AI_USAGE_WINDOW_MS;
    // Remove timestamps older than cutoff
    let firstValidIndex = 0;
    while (
      firstValidIndex < this.aiUsageHistory.length &&
      this.aiUsageHistory[firstValidIndex]! < cutoff
    ) {
      firstValidIndex++;
    }
    if (firstValidIndex > 0) {
      this.aiUsageHistory = this.aiUsageHistory.slice(firstValidIndex);
    }
  }

  /**
   * Generate a short topic label for a set of messages using AI
   */
  async generateTopicLabel(
    messages: Message[],
    guildId: string,
    userId: string = "system"
  ): Promise<TopicLabel> {
    if (messages.length === 0) {
      return {
        label: "empty conversation",
        confidence: 0,
        timestamp: new Date(),
      };
    }

    // Sample messages for topic generation (max 10 for efficiency)
    const sampledMessages = this.sampleMessages(messages, 10);

    // Build message preview
    const messagePreview = sampledMessages
      .map((m) => {
        const content = m.content.trim();
        return content.length > 0 ? content : "(no text content)";
      })
      .slice(0, 10)
      .join("\n");

    // Use AI to generate topic label when available
    const prompt = `Analyze these messages and provide a SHORT topic label (2-5 words max).

Messages:
${messagePreview}

Respond with ONLY the topic label, nothing else. Examples: "planning dinner", "game discussion", "work project", "meme sharing"`;

    if (this.canUseAI()) {
      try {
        this.recordAIUsage();
        const builder = new AIRequestBuilder(this.aiEngine!);
        const result = await builder
          .blocking()
          .mode("structured")
          .maxTokens(150)
          .provider("ollama")
          .persona("casual")
          .withoutTools()
          .generate(prompt);
        const response = result as AIResponse;

        if (response.success && response.content) {
          const label = response.content.trim().toLowerCase();
          const shortLabel =
            label.length > 50 ? label.substring(0, 50).trim() : label;

          return {
            label: shortLabel,
            confidence: 0.8,
            timestamp: new Date(),
          };
        } else {
          this.registerAIFailure(
            new Error(response.error || "AI response missing content")
          );
        }
      } catch (error) {
        this.registerAIFailure(error);
      }
    }

    // Fallback: extract keywords
    const keywords = this.extractKeywords(
      messages.map((m) => m.content).join(" ")
    );
    const fallbackLabel =
      Array.from(keywords).slice(0, 3).join(" ") || "general chat";

    return {
      label: fallbackLabel,
      confidence: 0.4, // Lower confidence for keyword-based
      timestamp: new Date(),
    };
  }

  /**
   * Detect if a new message represents topic drift from current conversation
   */
  async detectTopicDrift(
    newMessage: Message,
    conversationMessages: Message[],
    currentTopicLabel?: string,
    guildId: string = "",
    userId: string = "system",
    conversationKeywords?: KeywordScore[]
  ): Promise<DriftDetectionResult> {
    // Need at least 3 messages to establish a topic
    if (conversationMessages.length < 3) {
      return {
        shouldSplit: false,
        driftScore: 0,
        confidence: 0,
        reason: "Not enough messages to establish topic",
      };
    }

    // Fast first-pass: Keyword-based drift detection
    if (conversationKeywords && conversationKeywords.length > 0) {
      const keywordOverlap = await this.calculateKeywordOverlap(
        newMessage,
        conversationKeywords,
        conversationMessages,
        guildId
      );

      // High keyword overlap = clearly same topic (fast path)
      if (keywordOverlap >= this.KEYWORD_HIGH_OVERLAP) {
        return {
          shouldSplit: false,
          driftScore: 1 - keywordOverlap,
          confidence: 0.85,
          reason: `High keyword overlap (${(keywordOverlap * 100).toFixed(1)}%) - same topic`,
        };
      }

      // Very low keyword overlap = likely different topic (fast path)
      if (keywordOverlap < this.KEYWORD_LOW_OVERLAP) {
        // Still check with embeddings/AI for final confirmation
        // but this is a strong signal
      }
      // Moderate overlap (0.15-0.4) falls through to embeddings/AI
    }

    // Second-pass: Semantic similarity using embeddings
    await this.ensureEmbeddings([
      ...conversationMessages.slice(-10),
      newMessage,
    ]);

    // Calculate semantic drift using embeddings
    const semanticDrift = await this.calculateSemanticDrift(
      newMessage,
      conversationMessages
    );

    // High semantic similarity = clearly same topic
    if (semanticDrift.similarity > this.HIGH_CONFIDENCE_THRESHOLD) {
      return {
        shouldSplit: false,
        driftScore: 1 - semanticDrift.similarity,
        confidence: 0.9,
        reason: "High semantic similarity to conversation",
      };
    }

    // Very low similarity = likely different topic
    if (semanticDrift.similarity < this.LOW_CONFIDENCE_THRESHOLD) {
      // Use AI to make final decision on borderline cases
      const aiDecision = await this.shouldSplitConversation(
        currentTopicLabel || "unknown",
        [...conversationMessages.slice(-5), newMessage],
        semanticDrift.similarity,
        guildId,
        userId
      );

      if (aiDecision.shouldSplit) {
        return {
          shouldSplit: true,
          driftScore: 1 - semanticDrift.similarity,
          newTopicLabel: aiDecision.newTopicLabel,
          confidence: aiDecision.confidence,
          reason: "AI detected clear topic change",
        };
      }
    }

    // Moderate similarity - check with AI if topic label exists
    if (
      currentTopicLabel &&
      semanticDrift.similarity >= this.LOW_CONFIDENCE_THRESHOLD &&
      semanticDrift.similarity <= this.HIGH_CONFIDENCE_THRESHOLD
    ) {
      const aiDecision = await this.shouldSplitConversation(
        currentTopicLabel,
        [...conversationMessages.slice(-5), newMessage],
        semanticDrift.similarity,
        guildId,
        userId
      );

      return {
        shouldSplit: aiDecision.shouldSplit,
        driftScore: 1 - semanticDrift.similarity,
        newTopicLabel: aiDecision.newTopicLabel,
        confidence: aiDecision.confidence,
        reason: aiDecision.shouldSplit
          ? "AI detected topic change"
          : "AI confirmed topic continuation",
      };
    }

    // Default: don't split (conservative)
    return {
      shouldSplit: false,
      driftScore: 1 - semanticDrift.similarity,
      confidence: 0.6,
      reason: "Moderate similarity, keeping conversation together",
    };
  }

  /**
   * Analyze a conversation for internal topic splits (post-processing)
   */
  async analyzeConversationForSplits(
    messages: Message[],
    guildId: string = "",
    userId: string = "system",
    options?: {
      participantCount?: number;
      durationMinutes?: number;
      dominantTopic?: string;
    }
  ): Promise<ConversationSplit[]> {
    if (messages.length < 10) {
      return []; // Too short to split
    }

    if (options?.participantCount && options.participantCount <= 2) {
      return []; // Don't split tight 2-person chats
    }

    if (options?.durationMinutes && options.durationMinutes <= 45) {
      return []; // Keep shorter conversations intact
    }

    await this.ensureEmbeddings(messages);

    const splits: ConversationSplit[] = [];
    const windowSize = 5; // Analyze 5-message windows (balanced granularity)
    const stepSize = 3; // Move forward 3 messages at a time
    const topicCache = new Map<string, TopicLabel>();
    const MAX_TOPIC_COMPARISONS = 10;
    let topicComparisons = 0;

    const getTopicLabelForRange = async (
      start: number,
      end: number
    ): Promise<TopicLabel> => {
      const normalizedStart = Math.max(
        0,
        Math.min(messages.length - 1, Math.floor(start))
      );
      const normalizedEnd = Math.max(
        normalizedStart + 1,
        Math.min(messages.length, Math.floor(end))
      );
      const cacheKey = `${normalizedStart}:${normalizedEnd}`;
      if (!topicCache.has(cacheKey)) {
        const slice = messages.slice(normalizedStart, normalizedEnd);
        const label = await this.generateTopicLabel(slice, guildId, userId);
        topicCache.set(cacheKey, label);
      }
      return topicCache.get(cacheKey)!;
    };

    // Slide window through conversation
    for (let i = 0; i + windowSize < messages.length; i += stepSize) {
      const beforeStart = Math.max(0, i - 5);
      const beforeEnd = i + Math.floor(windowSize / 2);
      const afterStart = beforeEnd;
      const afterEnd = Math.min(messages.length, i + windowSize + 5);

      const beforeWindow = messages.slice(beforeStart, beforeEnd);
      const afterWindow = messages.slice(afterStart, afterEnd);

      if (beforeWindow.length < 3 || afterWindow.length < 3) continue;

      // Calculate semantic shift between windows
      const beforeEmbedding = await this.calculateAverageEmbedding(
        beforeWindow.map((m) => m.embedding).filter(Boolean) as number[][]
      );
      const afterEmbedding = await this.calculateAverageEmbedding(
        afterWindow.map((m) => m.embedding).filter(Boolean) as number[][]
      );

      if (!beforeEmbedding || !afterEmbedding) continue;

      const similarity = this.cosineSimilarity(beforeEmbedding, afterEmbedding);

      // Check if there might be a topic change
      // Use semantic similarity as a signal, but also check AI for topic changes even with high similarity
      const lowSimilarity = similarity < this.BASE_SEMANTIC_THRESHOLD;
      const moderateSimilarity = similarity < this.HIGH_CONFIDENCE_THRESHOLD;

      // Always check for topic changes at moderate similarity or lower
      if (moderateSimilarity) {
        // Generate topics for both windows
        const beforeTopic = await getTopicLabelForRange(beforeStart, beforeEnd);
        const afterTopic = await getTopicLabelForRange(afterStart, afterEnd);

        let different = lowSimilarity;
        let confidence = lowSimilarity ? 0.7 : 0.5;

        if (!different) {
          if (topicComparisons >= MAX_TOPIC_COMPARISONS) {
            continue;
          }
          topicComparisons++;
          const comparison = await this.areTopicsDifferent(
            beforeTopic.label,
            afterTopic.label,
            beforeWindow,
            afterWindow,
            guildId,
            userId
          );
          different = comparison.different;
          confidence = comparison.confidence;
        }

        // Split if AI confirms difference, or if semantic similarity is very low
        if (different) {
          splits.push({
            splitIndex: i + windowSize / 2,
            beforeTopic: beforeTopic.label,
            afterTopic: afterTopic.label,
            confidence,
            reason: lowSimilarity
              ? `Low semantic similarity (${(similarity * 100).toFixed(
                  1
                )}%) + topic change: "${beforeTopic.label}" → "${
                  afterTopic.label
                }"`
              : `Topic change: "${beforeTopic.label}" → "${afterTopic.label}"`,
          });

          // Skip ahead to avoid overlapping splits
          i += windowSize;
        }
      }
    }

    return splits;
  }

  /**
   * Calculate keyword overlap between new message and conversation keywords
   * Returns Jaccard similarity (0-1) between keyword sets
   */
  private async calculateKeywordOverlap(
    newMessage: Message,
    conversationKeywords: KeywordScore[],
    conversationMessages: Message[],
    guildId: string
  ): Promise<number> {
    try {
      // Extract keywords from new message (fast TF-IDF)
      const newMessageKeywordData: KeywordMessage = {
        id: newMessage.id,
        content: newMessage.content,
        author_id: newMessage.author_id,
      };

      // Use fast TF-IDF extraction (no vocabulary needed for single message)
      const newMessageKeywords = await this.keywordExtractor.extractKeywords(
        [newMessageKeywordData],
        guildId,
        { method: "tfidf", topN: 10 } // Fast TF-IDF, top 10 keywords
      );

      // Get keyword terms as sets (normalize to lowercase for comparison)
      const conversationTerms = new Set(
        conversationKeywords.map((k) => k.word.toLowerCase().trim())
      );
      const newMessageTerms = new Set(
        newMessageKeywords.terms.map((k) => k.word.toLowerCase().trim())
      );

      // Calculate Jaccard similarity (intersection / union)
      const intersection = new Set(
        [...conversationTerms].filter((term) => newMessageTerms.has(term))
      );
      const union = new Set([...conversationTerms, ...newMessageTerms]);

      if (union.size === 0) {
        return 0; // No keywords in either set
      }

      const overlap = intersection.size / union.size;
      return overlap;
    } catch (error) {
      console.error("🔸 Failed to calculate keyword overlap:", error);
      // Fallback: return moderate overlap to let embeddings handle it
      return 0.25;
    }
  }

  /**
   * Calculate semantic drift between new message and conversation
   */
  private async calculateSemanticDrift(
    newMessage: Message,
    conversationMessages: Message[]
  ): Promise<{ similarity: number; averageEmbedding: number[] | null }> {
    if (!newMessage.embedding || conversationMessages.length === 0) {
      return { similarity: 0.5, averageEmbedding: null };
    }

    // Get embeddings from recent messages (last 10)
    const recentMessages = conversationMessages.slice(-10);
    const recentEmbeddings = recentMessages
      .map((m) => m.embedding)
      .filter((emb): emb is number[] => emb !== undefined);

    if (recentEmbeddings.length === 0) {
      return { similarity: 0.5, averageEmbedding: null };
    }

    // Calculate average embedding of recent messages
    const avgEmbedding = await this.calculateAverageEmbedding(recentEmbeddings);
    if (!avgEmbedding) {
      return { similarity: 0.5, averageEmbedding: null };
    }

    // Calculate cosine similarity
    const similarity = this.cosineSimilarity(
      newMessage.embedding,
      avgEmbedding
    );

    return { similarity, averageEmbedding: avgEmbedding };
  }

  /**
   * Use AI to determine if conversation should split
   */
  private async shouldSplitConversation(
    currentTopicLabel: string,
    recentMessages: Message[],
    semanticSimilarity: number,
    guildId: string,
    userId: string
  ): Promise<{
    shouldSplit: boolean;
    newTopicLabel?: string;
    confidence: number;
  }> {
    // Sample messages for AI analysis
    const messagePreview = recentMessages
      .map((m, idx) => {
        const content = m.content.trim();
        return `[${idx + 1}] ${content.length > 0 ? content : "(no text)"}`;
      })
      .join("\n");

    const prompt = `Current conversation topic: "${currentTopicLabel}"
Semantic similarity: ${(semanticSimilarity * 100).toFixed(1)}%

Recent messages:
${messagePreview}

Are these messages about the SAME topic or a DIFFERENT topic?

Rules:
- If SAME topic or naturally related: respond with "continue"
- If DIFFERENT topic: respond with "split: [new topic label]"
- Be BALANCED - split on meaningful topic changes, but keep related subtopics together
- Group related discussions (like "bot testing" or "bot development") as one conversation

Response format: Either "continue" OR "split: [2-5 word topic label]"`;

    if (this.canUseAI()) {
      try {
        this.recordAIUsage();
        const builder = new AIRequestBuilder(this.aiEngine!);
        const result = await builder
          .blocking()
          .mode("structured")
          .maxTokens(200)
          .provider("ollama")
          .persona("casual")
          .withoutTools()
          .generate(prompt);
        const response = result as AIResponse;

        if (response.success && response.content) {
          const rawContent = response.content.trim();
          const content = rawContent.toLowerCase();

          const splitMatch = rawContent.match(/split\s*[:\-]\s*(.+)$/i);
          if (splitMatch && splitMatch[1]) {
            const newLabel = splitMatch[1].trim();
            return {
              shouldSplit: true,
              newTopicLabel: newLabel || "new topic",
              confidence: 0.85,
            };
          }

          if (content.includes("different")) {
            const inferredLabel =
              splitMatch?.[1]?.trim() ||
              rawContent.replace(/different( topic)?/i, "").trim();
            return {
              shouldSplit: true,
              newTopicLabel: inferredLabel || "new topic",
              confidence: 0.8,
            };
          }

          if (content.includes("continue") || content.includes("same")) {
            return {
              shouldSplit: false,
              confidence: 0.85,
            };
          }
        } else {
          this.registerAIFailure(
            new Error(response.error || "AI response missing content")
          );
        }
      } catch (error) {
        this.registerAIFailure(error);
      }
    }

    // Fallback: use semantic similarity threshold + heuristic topic label
    const fallbackTopic = await this.generateTopicLabel(
      recentMessages,
      guildId,
      userId
    );
    const shouldSplit =
      semanticSimilarity < this.LOW_CONFIDENCE_THRESHOLD ||
      fallbackTopic.confidence >= 0.7;

    return {
      shouldSplit,
      newTopicLabel: shouldSplit ? fallbackTopic.label : undefined,
      confidence: shouldSplit ? 0.65 : 0.55,
    };
  }

  /**
   * Determine if two topic labels represent different topics
   */
  private async areTopicsDifferent(
    topic1: string,
    topic2: string,
    messages1: Message[],
    messages2: Message[],
    guildId: string,
    userId: string
  ): Promise<{ different: boolean; confidence: number }> {
    // If topics are very similar strings, they're likely the same
    const stringSimilarity = this.stringSimilarity(topic1, topic2);
    if (stringSimilarity > 0.7) {
      return { different: false, confidence: 0.9 };
    }

    const prompt = `Compare these two conversation segments:

Segment 1 topic: "${topic1}"
Sample messages: ${messages1
      .slice(0, 3)
      .map((m) => m.content.substring(0, 100))
      .join(" | ")}

Segment 2 topic: "${topic2}"
Sample messages: ${messages2
      .slice(0, 3)
      .map((m) => m.content.substring(0, 100))
      .join(" | ")}

Are these about DIFFERENT topics or the SAME/RELATED topic?
- If DIFFERENT: respond "different"
- If SAME or RELATED: respond "same"

Be balanced - group related subtopics together, but split clearly different discussions.`;

    if (this.canUseAI()) {
      try {
        this.recordAIUsage();
        const builder = new AIRequestBuilder(this.aiEngine!);
        // Structured mode: the chat preset caps output at 60 tokens
        const result = await builder
          .blocking()
          .mode("structured")
          .maxTokens(150)
          .provider("ollama")
          .persona("casual")
          .withoutTools()
          .generate(prompt);
        const response = result as AIResponse;

        if (response.success && response.content) {
          const content = response.content.trim().toLowerCase();
          return {
            different: content.includes("different"),
            confidence: 0.8,
          };
        } else {
          this.registerAIFailure(
            new Error(response.error || "AI response missing content")
          );
        }
      } catch (error) {
        this.registerAIFailure(error);
      }
    }

    return this.heuristicTopicComparison(topic1, topic2, stringSimilarity);
  }

  private heuristicTopicComparison(
    topic1: string,
    topic2: string,
    stringSimilarity: number
  ): { different: boolean; confidence: number } {
    if (stringSimilarity > 0.7) {
      return { different: false, confidence: 0.8 };
    }

    const tokens1 = new Set(
      topic1
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2)
    );
    const tokens2 = new Set(
      topic2
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2)
    );

    const intersection = Array.from(tokens1).filter((token) =>
      tokens2.has(token)
    );
    const unionSize = new Set([...tokens1, ...tokens2]).size || 1;
    const jaccard = intersection.length / unionSize;

    const different = jaccard < 0.25 || stringSimilarity < 0.35;
    const confidence = different ? 0.6 : 0.55;
    return { different, confidence };
  }

  /**
   * Calculate average embedding from array of embeddings
   */
  private async calculateAverageEmbedding(
    embeddings: number[][]
  ): Promise<number[] | null> {
    if (embeddings.length === 0) return null;

    const dim = embeddings[0]!.length;
    const avg = new Array(dim).fill(0);

    for (const emb of embeddings) {
      if (emb.length !== dim) continue;
      for (let i = 0; i < dim; i++) {
        avg[i] += emb[i]!;
      }
    }

    for (let i = 0; i < dim; i++) {
      avg[i] /= embeddings.length;
    }

    return avg;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length || vec1.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i]! * vec2[i]!;
      normA += vec1[i]! * vec1[i]!;
      normB += vec2[i]! * vec2[i]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    // Return value between 0 and 1 (normalize from -1 to 1)
    const similarity = dotProduct / denominator;
    return (similarity + 1) / 2;
  }

  /**
   * Calculate string similarity (Jaccard similarity of words)
   */
  private stringSimilarity(str1: string, str2: string): number {
    const words1 = new Set(
      str1
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );
    const words2 = new Set(
      str2
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );

    const intersection = new Set(
      [...words1].filter((word) => words2.has(word))
    );
    const union = new Set([...words1, ...words2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Sample messages evenly from a list
   */
  private sampleMessages(messages: Message[], maxSamples: number): Message[] {
    if (messages.length <= maxSamples) {
      return messages;
    }

    const step = messages.length / maxSamples;
    const sampled: Message[] = [];

    for (let i = 0; i < maxSamples; i++) {
      const index = Math.floor(i * step);
      sampled.push(messages[index]!);
    }

    return sampled;
  }

  /**
   * Extract keywords from text (simplified)
   */
  /**
   * Extract keywords using TF-IDF (no hardcoded stopwords)
   * Uses simple frequency-based approach when vocabulary is not available
   */
  private extractKeywords(text: string): Set<string> {
    // Create a simple KeywordMessage for TF-IDF extraction
    const message: KeywordMessage = {
      id: "temp",
      content: text,
      author_id: "system",
    };

    try {
      // Use TF-IDF's simple extraction (no vocabulary needed)
      const keywords = this.tfidfExtractor.extractKeywordsSimple([message], 5);
      return new Set(keywords.map((k) => k.word));
    } catch (error) {
      console.error("🔸 Failed to extract keywords with TF-IDF:", error);
      // Fallback to basic tokenization if TF-IDF fails
      const words = text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2);
      return new Set(words.slice(0, 5));
    }
  }

  /**
   * Ensure a set of messages contains embeddings, generating them when needed.
   */
  private async ensureEmbeddings(messages: Message[]): Promise<void> {
    const indices: number[] = [];
    const texts: string[] = [];

    messages.forEach((msg, idx) => {
      if (!msg) return;
      if (msg.embedding && msg.embedding.length > 0) return;
      if (!this.hasEmbeddableText(msg.content)) return;
      indices.push(idx);
      texts.push(msg.content);
    });

    if (texts.length === 0) {
      return;
    }

    try {
      const embeddings = await this.embeddingService.generateBatch(texts);
      indices.forEach((messageIndex, idx) => {
        messages[messageIndex]!.embedding = embeddings[idx]!;
      });
    } catch (error) {
      console.error("🔸 Failed to backfill embeddings for topic drift:", error);
    }
  }

  private hasEmbeddableText(content: string): boolean {
    if (!content) {
      return false;
    }
    const withoutEmojis = content.replace(/<(a?):[\w]+:\d+>/g, "");
    const trimmed = withoutEmojis.trim();
    return trimmed.length >= 3;
  }
}
