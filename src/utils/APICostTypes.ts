/**
 * TypeScript interfaces for API cost tracking
 */

export type ProviderName =
	| "grok"
	| "gemini"
	| "openai"
	| "ollama"
	| "cartesia"
	| "google-tts"
	| "cursor";

export type Timeframe = "hour" | "day" | "week" | "month";

export type Environment = "test" | "production";

/**
 * Individual API request record
 */
export interface APIRequestRecord {
	timestamp: string; // ISO 8601 format
	provider: ProviderName;
	environment: Environment;
	endpoint: string; // e.g., "callTextAPI", "synthesize"
	success: boolean;
	error?: string;

	// Token-based providers (Grok, Gemini, OpenAI)
	inputTokens?: number;
	outputTokens?: number;

	// Character-based providers (TTS)
	characters?: number;

	// Cost calculation
	cost: number; // Calculated cost in USD

	// Performance metrics
	latency: number; // Request duration in milliseconds

	// Additional metadata
	metadata?: Record<string, any>; // Provider-specific data
}

/**
 * Aggregated statistics for a provider
 */
export interface ProviderCostStats {
	provider: ProviderName;
	environment: Environment;
	timeframe: string; // e.g., "2025-01-15-14" for hour
	period: Timeframe;

	// Request counts
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;

	// Token usage (for token-based providers)
	totalInputTokens?: number;
	totalOutputTokens?: number;

	// Character usage (for character-based providers)
	totalCharacters?: number;

	// Cost summary
	totalCost: number;
	averageCostPerRequest: number;

	// Performance metrics
	averageLatency: number;
	minLatency: number;
	maxLatency: number;

	// Request history (limited to recent requests)
	requests: APIRequestRecord[];
}

/**
 * Overall cost summary across all providers
 */
export interface CostSummary {
	timeframe: string;
	period: Timeframe;
	environment: Environment;
	totalCost: number;
	totalRequests: number;
	providers: {
		provider: ProviderName;
		cost: number;
		requests: number;
	}[];
}

/**
 * Timeframe key generator helpers
 */
export function getTimeframeKey(
	date: Date,
	period: Timeframe
): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");

	switch (period) {
		case "hour":
			return `${year}-${month}-${day}-${hour}`;
		case "day":
			return `${year}-${month}-${day}`;
		case "week": {
			// ISO week calculation
			const d = new Date(
				Date.UTC(year, date.getMonth(), date.getDate())
			);
			const dayNum = d.getUTCDay() || 7;
			d.setUTCDate(d.getUTCDate() + 4 - dayNum);
			const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
			const weekNum = Math.ceil(
				((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
			);
			return `${year}-W${String(weekNum).padStart(2, "0")}`;
		}
		case "month":
			return `${year}-${month}`;
		default:
			throw new Error(`Unknown period: ${period}`);
	}
}

