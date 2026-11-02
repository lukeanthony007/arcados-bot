import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import type { KeywordScore } from "../semantic-analysis/types";

/**
 * Centralized scoring logic for conversation grouping
 * Calculates relationship, semantic, temporal, and keyword scores to determine
 * if messages belong to the same conversation
 */
export class ConversationScorer {
  private db: PostgreSQLManager;
  private edgeCache: Map<string, { data: any; expiredAt: number }> = new Map();
  private readonly EDGE_CACHE_TTL = 5 * 60 * 1000; // 5 minute cache TTL

  // Scoring weights (sum to 1.0)
  private readonly RELATIONSHIP_WEIGHT = 0.45; // Reduced from 0.5
  private readonly SEMANTIC_WEIGHT = 0.25; // Reduced from 0.3
  private readonly TIME_WEIGHT = 0.2; // Unchanged
  private readonly KEYWORD_WEIGHT = 0.1; // New keyword dimension

  // Thresholds
  private readonly COMBINED_SCORE_THRESHOLD = 0.35;
  private readonly TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  constructor(db: PostgreSQLManager) {
    this.db = db;
  }

  /**
   * Calculate relationship score between a user and a set of participants (0-1)
   * Based on interaction history and affinity
   */
  async calculateRelationshipScore(
    userId: string,
    participants: Set<string>,
    guildId: string
  ): Promise<number> {
    if (participants.size === 0 || participants.has(userId)) {
      return 0;
    }

    let totalScore = 0;
    let count = 0;

    for (const participantId of participants) {
      if (participantId === userId) continue;

      // Edges are directed (author → other), so a pair's history spans both rows
      const [edgeAB, edgeBA] = await Promise.all([
        this.getCachedEdge(guildId, userId, participantId),
        this.getCachedEdge(guildId, participantId, userId),
      ]);
      if (edgeAB?.data || edgeBA?.data) {
        // Normalize edge interaction count to 0-1 range
        const interactionCount = (edgeAB?.data?.total || 0) + (edgeBA?.data?.total || 0);

        // Use logarithmic scale to prevent extreme values
        const normalizedScore = Math.min(1, Math.log10(interactionCount + 1) / 3);
        totalScore += normalizedScore;
        count++;
      }
    }

    return count > 0 ? totalScore / count : 0;
  }

  /**
   * Calculate semantic similarity score between a message and group embeddings (0-1)
   * Uses cosine similarity on averaged group embeddings
   */
  calculateSemanticScore(
    messageEmbedding: number[] | undefined,
    groupEmbeddings: number[][]
  ): number {
    if (!messageEmbedding || groupEmbeddings.length === 0) {
      return 0;
    }

    // Calculate average embedding for the group
    const avgEmbedding = this.averageEmbeddings(groupEmbeddings);
    if (!avgEmbedding) {
      return 0;
    }

    // Calculate cosine similarity
    const similarity = this.cosineSimilarity(messageEmbedding, avgEmbedding);

    // Normalize from [-1, 1] to [0, 1]
    return (similarity + 1) / 2;
  }

  /**
   * Calculate time-based score (0-1)
   * Messages within the time window get higher scores
   */
  calculateTimeScore(
    messageTime: number,
    groupTimeRange: { min: number; max: number }
  ): number {
    const timeDiff = Math.min(
      Math.abs(messageTime - groupTimeRange.min),
      Math.abs(messageTime - groupTimeRange.max)
    );

    if (timeDiff > this.TIME_WINDOW_MS) {
      return 0;
    }

    return 1 - timeDiff / this.TIME_WINDOW_MS;
  }

  /**
   * Calculate keyword overlap score (0-1)
   * Measures how many keywords are shared between message and group
   */
  calculateKeywordScore(
    messageKeywords: KeywordScore[] | undefined,
    groupKeywords: KeywordScore[] | undefined
  ): number {
    if (!messageKeywords || !groupKeywords ||
        messageKeywords.length === 0 || groupKeywords.length === 0) {
      return 0;
    }

    // Create sets of keyword terms for overlap calculation
    const messageTerms = new Set(messageKeywords.map(k => k.word.toLowerCase()));
    const groupTerms = new Set(groupKeywords.map(k => k.word.toLowerCase()));

    // Calculate Jaccard similarity: intersection / union
    const intersection = new Set(
      [...messageTerms].filter(term => groupTerms.has(term))
    );
    const union = new Set([...messageTerms, ...groupTerms]);

    // Jaccard coefficient
    const jaccardScore = intersection.size / union.size;

    // Also consider weighted overlap based on keyword importance
    const messageScoreMap = new Map(
      messageKeywords.map(k => [k.word.toLowerCase(), k.score])
    );
    const groupScoreMap = new Map(
      groupKeywords.map(k => [k.word.toLowerCase(), k.score])
    );

    let weightedOverlap = 0;
    let totalPossibleWeight = 0;

    for (const term of union) {
      const messageScore = messageScoreMap.get(term) || 0;
      const groupScore = groupScoreMap.get(term) || 0;

      // Shared importance
      weightedOverlap += Math.min(messageScore, groupScore);
      // Maximum possible importance
      totalPossibleWeight += Math.max(messageScore, groupScore);
    }

    const weightedScore = totalPossibleWeight > 0
      ? weightedOverlap / totalPossibleWeight
      : 0;

    // Combine Jaccard and weighted scores (favor weighted)
    return 0.3 * jaccardScore + 0.7 * weightedScore;
  }

  /**
   * Calculate combined score from individual components
   * Uses weighted average of relationship, semantic, temporal, and keyword scores
   */
  calculateCombinedScore(scores: {
    relationship: number;
    semantic: number;
    time: number;
    keywords?: number;
  }): number {
    const keywordScore = scores.keywords ?? 0;

    return (
      scores.relationship * this.RELATIONSHIP_WEIGHT +
      scores.semantic * this.SEMANTIC_WEIGHT +
      scores.time * this.TIME_WEIGHT +
      keywordScore * this.KEYWORD_WEIGHT
    );
  }

  /**
   * Check if a combined score meets the threshold for grouping
   */
  meetsThreshold(score: number): boolean {
    return score > this.COMBINED_SCORE_THRESHOLD;
  }

  /**
   * Get scoring weights for external use (e.g., debugging)
   */
  getWeights(): { relationship: number; semantic: number; time: number; keywords: number } {
    return {
      relationship: this.RELATIONSHIP_WEIGHT,
      semantic: this.SEMANTIC_WEIGHT,
      time: this.TIME_WEIGHT,
      keywords: this.KEYWORD_WEIGHT,
    };
  }

  /**
   * Get threshold for external use
   */
  getThreshold(): number {
    return this.COMBINED_SCORE_THRESHOLD;
  }

  /**
   * Private helper: Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i]! * vecB[i]!;
      normA += vecA[i]! * vecA[i]!;
      normB += vecB[i]! * vecB[i]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator > 0 ? dotProduct / denominator : 0;
  }

  /**
   * Private helper: Average multiple embedding vectors
   */
  private averageEmbeddings(embeddings: number[][]): number[] | null {
    if (embeddings.length === 0) {
      return null;
    }

    const embeddingLength = embeddings[0]!.length;
    const avgEmbedding = new Array(embeddingLength).fill(0);

    for (const embedding of embeddings) {
      for (let i = 0; i < embeddingLength && i < embedding.length; i++) {
        avgEmbedding[i] += embedding[i]!;
      }
    }

    for (let i = 0; i < avgEmbedding.length; i++) {
      avgEmbedding[i] /= embeddings.length;
    }

    return avgEmbedding;
  }

  /**
   * Get or retrieve edge data with caching
   */
  private async getCachedEdge(
    guildId: string,
    user1: string,
    user2: string
  ): Promise<any> {
    const cacheKey = `${guildId}:${user1}:${user2}`;
    const now = Date.now();

    // Check cache
    const cached = this.edgeCache.get(cacheKey);
    if (cached && cached.expiredAt > now) {
      return cached.data;
    }

    // Fetch from DB
    const data = await this.db.getEdgeForPair(guildId, user1, user2);

    // Update cache
    this.edgeCache.set(cacheKey, {
      data,
      expiredAt: now + this.EDGE_CACHE_TTL,
    });

    return data;
  }

  /**
   * Cleanup expired cache entries
   */
  cleanupCache(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.edgeCache.entries()) {
      if (entry.expiredAt < now) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.edgeCache.delete(key);
    }
  }
}
