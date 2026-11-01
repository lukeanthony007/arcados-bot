/**
 * IncrementalEnrichment
 *
 * Utilities for incremental enrichment - appending deltas instead of full regeneration.
 * Saves tokens by only processing new context and appending observations.
 */

export interface EnrichmentDelta {
	version: number;
	timestamp: string; // ISO 8601
	context_range: string; // e.g., "conversations 45-50" or "last 7 days"
	summary_delta: string; // New observations to append
	confidence: number; // 0-1
}

export interface EnrichmentHistory {
	base_summary: string; // Foundation summary
	deltas: EnrichmentDelta[]; // Incremental updates
	last_consolidated: string; // ISO 8601 timestamp of last full consolidation
	total_versions: number;
}

export class IncrementalEnrichment {
	/**
	 * Create a new enrichment history
	 */
	public static createHistory(baseSummary: string): EnrichmentHistory {
		return {
			base_summary: baseSummary,
			deltas: [],
			last_consolidated: new Date().toISOString(),
			total_versions: 1,
		};
	}

	/**
	 * Append a delta to enrichment history
	 */
	public static appendDelta(
		history: EnrichmentHistory,
		contextRange: string,
		summaryDelta: string,
		confidence: number = 0.8,
	): EnrichmentHistory {
		const delta: EnrichmentDelta = {
			version: history.total_versions + 1,
			timestamp: new Date().toISOString(),
			context_range: contextRange,
			summary_delta: summaryDelta,
			confidence,
		};

		return {
			...history,
			deltas: [...history.deltas, delta],
			total_versions: history.total_versions + 1,
		};
	}

	/**
	 * Get composite summary (base + all deltas)
	 */
	public static getCompositeSummary(history: EnrichmentHistory): string {
		if (history.deltas.length === 0) {
			return history.base_summary;
		}

		// Start with base
		let composite = history.base_summary;

		// Append each delta
		for (const delta of history.deltas) {
			composite += `\n\n${delta.summary_delta}`;
		}

		return composite.trim();
	}

	/**
	 * Check if history needs consolidation
	 * Consolidate if:
	 * - More than 5 deltas accumulated
	 * - Total length exceeds reasonable size
	 * - Last consolidation was > 30 days ago
	 */
	public static needsConsolidation(history: EnrichmentHistory): boolean {
		// Check delta count
		if (history.deltas.length > 5) {
			return true;
		}

		// Check total length
		const composite = this.getCompositeSummary(history);
		if (composite.length > 2000) {
			// Too long
			return true;
		}

		// Check time since last consolidation
		const lastConsolidated = new Date(history.last_consolidated);
		const daysSince =
			(Date.now() - lastConsolidated.getTime()) / (1000 * 60 * 60 * 24);
		if (daysSince > 30) {
			return true;
		}

		return false;
	}

	/**
	 * Consolidate history into new base summary
	 * Should be called with LLM to create coherent consolidated summary
	 */
	public static consolidate(newBaseSummary: string): EnrichmentHistory {
		return {
			base_summary: newBaseSummary,
			deltas: [],
			last_consolidated: new Date().toISOString(),
			total_versions: 1,
		};
	}

	/**
	 * Generate context range string for user profiles
	 */
	public static userContextRange(
		previousConversationCount: number,
		currentConversationCount: number,
	): string {
		if (previousConversationCount === 0) {
			return `initial ${currentConversationCount} conversations`;
		}
		return `conversations ${previousConversationCount + 1}-${currentConversationCount}`;
	}

	/**
	 * Generate context range string for relationship profiles
	 */
	public static relationshipContextRange(
		previousSharedConversations: number,
		currentSharedConversations: number,
	): string {
		if (previousSharedConversations === 0) {
			return `initial ${currentSharedConversations} shared conversations`;
		}
		return `shared conversations ${previousSharedConversations + 1}-${currentSharedConversations}`;
	}

	/**
	 * Generate context range string for time-based enrichment
	 */
	public static timeContextRange(days: number): string {
		if (days === 1) {
			return "last 24 hours";
		}
		if (days === 7) {
			return "last 7 days";
		}
		if (days === 30) {
			return "last 30 days";
		}
		return `last ${days} days`;
	}

	/**
	 * Parse enrichment history from JSONB column
	 */
	public static parseHistory(jsonbData: any): EnrichmentHistory | null {
		if (!jsonbData) {
			return null;
		}

		// If it's a string, parse it
		const data =
			typeof jsonbData === "string" ? JSON.parse(jsonbData) : jsonbData;

		// Validate structure (an empty base summary is valid: first enrichment had no prior profile)
		if (typeof data.base_summary !== "string" || !Array.isArray(data.deltas)) {
			return null;
		}

		return data as EnrichmentHistory;
	}

	/**
	 * Create enrichment prompt for delta generation
	 */
	public static createDeltaPrompt(
		entityType: "user" | "relationship" | "guild",
		baseSummary: string,
		newContext: string,
		contextRange: string,
	): string {
		const prompts = {
			user: `You are updating a user's behavioral profile based on new conversation data.

**Current Profile Summary:**
${baseSummary}

**New Context (${contextRange}):**
${newContext}

**Task:**
Based on the new conversations above, write a brief update (2-3 sentences) describing:
1. Any new interests, topics, or behavioral patterns observed
2. Changes in communication style or activity
3. Notable interactions or developments

Write in active voice, be specific, and focus only on NEW observations not already covered in the current profile.

**Update:**`,

			relationship: `You are updating a relationship profile based on new shared conversations.

**Current Relationship Summary:**
${baseSummary}

**New Shared Context (${contextRange}):**
${newContext}

**Task:**
Based on the new shared conversations, write a brief update (2-3 sentences) describing:
1. New topics or themes in their interactions
2. Changes in interaction frequency or dynamics
3. Notable collaborative or social patterns

Write in active voice, be specific, and focus only on NEW observations.

**Update:**`,

			guild: `You are updating a guild/server summary based on recent activity.

**Current Guild Summary:**
${baseSummary}

**Recent Activity (${contextRange}):**
${newContext}

**Task:**
Based on recent activity, write a brief update (2-3 sentences) describing:
1. New trending topics or discussions
2. Changes in community dynamics or activity patterns
3. Notable events or developments

Write in active voice, be specific, and focus only on NEW observations.

**Update:**`,
		};

		return prompts[entityType];
	}

	/**
	 * Create consolidation prompt for LLM
	 */
	public static createConsolidationPrompt(
		entityType: "user" | "relationship" | "guild",
		history: EnrichmentHistory,
	): string {
		const composite = this.getCompositeSummary(history);

		const prompts = {
			user: `You are consolidating a user's behavioral profile that has accumulated multiple incremental updates.

**Current Profile (Base + Deltas):**
${composite}

**Task:**
Consolidate the above information into a single, coherent profile summary (4-5 sentences) that:
1. Captures the user's core behavioral patterns and interests
2. Integrates all observations chronologically
3. Removes redundancy while preserving important details
4. Maintains active voice and specific examples

**Consolidated Profile:**`,

			relationship: `You are consolidating a relationship profile that has accumulated multiple updates.

**Current Profile (Base + Deltas):**
${composite}

**Task:**
Consolidate into a single, coherent relationship summary (4-5 sentences) that:
1. Describes the overall relationship dynamic
2. Highlights key shared interests and interaction patterns
3. Integrates observations chronologically
4. Removes redundancy

**Consolidated Summary:**`,

			guild: `You are consolidating a guild/server summary that has accumulated updates.

**Current Summary (Base + Deltas):**
${composite}

**Task:**
Consolidate into a single, coherent guild summary (4-5 sentences) that:
1. Describes the server's focus and community culture
2. Highlights key topics and activity patterns
3. Integrates observations about recent trends
4. Provides current state overview

**Consolidated Summary:**`,
		};

		return prompts[entityType];
	}

	/**
	 * Extract recent deltas (last N)
	 */
	public static getRecentDeltas(
		history: EnrichmentHistory,
		count: number = 3,
	): EnrichmentDelta[] {
		return history.deltas.slice(-count);
	}

	/**
	 * Get average confidence across deltas
	 */
	public static getAverageConfidence(history: EnrichmentHistory): number {
		if (history.deltas.length === 0) {
			return 1.0; // Assume base summary is high confidence
		}

		const sum = history.deltas.reduce((acc, delta) => acc + delta.confidence, 0);
		return sum / history.deltas.length;
	}
}
