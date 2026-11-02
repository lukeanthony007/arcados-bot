import type { Snowflake } from "discord.js";
import type {
	ProviderRoutingResult,
	GuildPreferences,
} from "../types/routing.js";

/**
 * Router for provider selection and routing
 * Detects provider from query, manages guild defaults, and handles heuristics
 */
export class ProviderRouter {
	private guildPreferences: Map<Snowflake, GuildPreferences> = new Map();

	/**
	 * Detect provider from query string
	 * Looks for explicit syntax like "on youtube", "from jellyfin", etc.
	 * Also handles heuristic detection (e.g., "christmas" → christmas-movies)
	 */
	public detectProvider(query: string): ProviderRoutingResult {
		const normalizedQuery = query.toLowerCase();

		// Pattern 1: Explicit syntax
		// "stream xyz on youtube" → { provider: "youtube", cleanQuery: "stream xyz" }
		const explicitPatterns = [
			/\bon\s+(youtube|jellyfin|123movies|christmas-movies)\b/i,
			/\bfrom\s+(youtube|jellyfin|123movies|christmas-movies)\b/i,
			/\bvia\s+(youtube|jellyfin|123movies|christmas-movies)\b/i,
		];

		for (const pattern of explicitPatterns) {
			const match = normalizedQuery.match(pattern);
			if (match) {
				const provider = match[1]?.toLowerCase();
				if (!provider) continue;
				// Remove provider syntax from query
				const cleanQuery = normalizedQuery
					.replace(pattern, "")
					.trim()
					.replace(/\s+/g, " ");
				return {
					provider: this.normalizeProviderName(provider),
					cleanQuery: query.replace(pattern, "").trim(), // Keep original case
				};
			}
		}

		// Pattern 2: Heuristic keywords
		// "stream christmas movie" → { provider: "christmas-movies", cleanQuery: "stream christmas movie" }
		if (/\bchristmas\b/i.test(normalizedQuery)) {
			return {
				provider: "christmas-movies",
				cleanQuery: query, // Keep original query
			};
		}

		return {
			provider: null,
			cleanQuery: query,
		};
	}

	/**
	 * Select provider for a guild
	 * Uses explicit detection first, then falls back to guild default, then system default
	 */
	public selectProvider(
		guildId: Snowflake,
		query: string
	): string {
		// Try to detect from query first
		const detection = this.detectProvider(query);
		if (detection.provider) {
			return detection.provider;
		}

		// Use guild default if set
		const preferences = this.guildPreferences.get(guildId);
		if (preferences?.defaultProvider) {
			return preferences.defaultProvider;
		}

		// Fall back to system default
		return "123movies"; // Default provider
	}

	/**
	 * Set default provider for a guild
	 */
	public setDefaultProvider(
		guildId: Snowflake,
		provider: string
	): void {
		const normalizedProvider = this.normalizeProviderName(provider);
		this.guildPreferences.set(guildId, {
			guildId,
			defaultProvider: normalizedProvider,
		});
	}

	/**
	 * Get default provider for a guild
	 */
	public getDefaultProvider(guildId: Snowflake): string | null {
		return this.guildPreferences.get(guildId)?.defaultProvider || null;
	}

	/**
	 * Normalize provider name to standard format
	 */
	private normalizeProviderName(name: string): string {
		const normalized = name.toLowerCase().trim();
		// Map common variations to standard names
		const mapping: Record<string, string> = {
			youtube: "youtube",
			yt: "youtube",
			jellyfin: "jellyfin",
			"123movies": "123movies",
			"123-movies": "123movies",
			"christmas-movies": "christmas-movies",
			christmas: "christmas-movies",
		};

		return mapping[normalized] || normalized;
	}
}

