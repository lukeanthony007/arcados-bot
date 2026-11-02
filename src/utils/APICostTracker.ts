import * as fs from "fs/promises";
import * as path from "path";
import type {
	APIRequestRecord,
	ProviderCostStats,
	CostSummary,
	ProviderName,
	Timeframe,
	Environment,
} from "./APICostTypes";
import {
	getTimeframeKey,
	type Timeframe as TimeframeType,
} from "./APICostTypes";
import {
	getProviderPricing,
	getCostTrackingConfig,
	calculateCost,
} from "./APICostConfig";
import { config } from "../config";

/**
 * APICostTracker - Singleton service for tracking API costs
 *
 * Tracks all external API calls, calculates costs, and writes aggregated
 * statistics to files organized by provider and timeframe.
 */
export class APICostTracker {
	private static instance: APICostTracker | null = null;

	private requests: APIRequestRecord[] = [];
	private flushTimer: NodeJS.Timeout | null = null;
	private isFlushing = false;
	private trackingConfig: ReturnType<typeof getCostTrackingConfig> | null = null;
	private environment: Environment | null = null;
	private initialized = false;

	private constructor() {
		// Lazy initialization - don't do anything in constructor
		// This avoids issues with module initialization order
	}

	public static getInstance(): APICostTracker {
		if (!APICostTracker.instance) {
			APICostTracker.instance = new APICostTracker();
		}
		return APICostTracker.instance;
	}

	/**
	 * Initialize the tracker (lazy initialization)
	 */
	private ensureInitialized(): void {
		if (this.initialized) {
			return;
		}

		try {
			this.trackingConfig = getCostTrackingConfig();
			// Determine environment from config
			try {
				this.environment =
					config.nodeEnv === "production" ? "production" : "test";
			} catch {
				this.environment = "test";
			}

			if (this.trackingConfig.enabled) {
				// Defer all async operations to avoid blocking
				setTimeout(() => {
					try {
						this.startPeriodicFlush();
						// Ensure base directory exists
						this.ensureDirectories().catch((err) => {
							console.error(
								"[APICostTracker] Failed to create directories:",
								err
							);
						});
					} catch (err) {
						console.error("[APICostTracker] Setup error:", err);
					}
				}, 0);
			}

			this.initialized = true;
		} catch (error) {
			// If initialization fails, disable tracking
			console.error("[APICostTracker] Initialization error:", error);
			this.trackingConfig = { enabled: false, flushInterval: 300000, historyLimit: 1000, baseDirectory: "api-costs" };
			this.environment = "test";
			this.initialized = true;
		}
	}

	/**
	 * Track an API request
	 */
	public trackRequest(
		provider: ProviderName,
		metadata: {
			endpoint: string;
			success: boolean;
			error?: string;
			inputTokens?: number;
			outputTokens?: number;
			characters?: number;
			latency: number;
			additionalMetadata?: Record<string, any>;
		}
	): void {
		this.ensureInitialized();
		
		if (!this.trackingConfig || !this.trackingConfig.enabled) {
			return;
		}

		const pricing = getProviderPricing(provider);
		const cost = calculateCost(provider, pricing, {
			inputTokens: metadata.inputTokens,
			outputTokens: metadata.outputTokens,
			characters: metadata.characters,
		});

		const record: APIRequestRecord = {
			timestamp: new Date().toISOString(),
			provider,
			environment: this.environment ?? "test",
			endpoint: metadata.endpoint,
			success: metadata.success,
			error: metadata.error,
			inputTokens: metadata.inputTokens,
			outputTokens: metadata.outputTokens,
			characters: metadata.characters,
			cost,
			latency: metadata.latency,
			metadata: metadata.additionalMetadata,
		};

		// Thread-safe: push to array (JavaScript arrays are thread-safe for push)
		this.requests.push(record);

		// Trim if we exceed history limit
		if (this.requests.length > this.trackingConfig.historyLimit * 2) {
			this.requests = this.requests.slice(
				-this.trackingConfig.historyLimit
			);
		}
	}

	/**
	 * Get aggregated stats for a timeframe and optional provider
	 */
	public getStats(
		period: TimeframeType,
		provider?: ProviderName
	): ProviderCostStats[] {
		this.ensureInitialized();
		
		const now = new Date();
		const timeframeKey = getTimeframeKey(now, period);

		// Filter requests by timeframe and provider
		const filtered = this.requests.filter((req) => {
			const reqTimeframe = getTimeframeKey(
				new Date(req.timestamp),
				period
			);
			const timeframeMatch = reqTimeframe === timeframeKey;
			const providerMatch = !provider || req.provider === provider;
			return timeframeMatch && providerMatch;
		});

				// Group by provider
		const byProvider = new Map<ProviderName, APIRequestRecord[]>();
		for (const req of filtered) {
			if (!byProvider.has(req.provider)) {
				byProvider.set(req.provider, []);
			}
			byProvider.get(req.provider)!.push(req);
		}

		// Aggregate stats per provider
		const stats: ProviderCostStats[] = [];
		for (const [prov, reqs] of byProvider.entries()) {
			const successful = reqs.filter((r) => r.success);
			const failed = reqs.filter((r) => !r.success);

			const totalInputTokens = reqs.reduce(
				(sum, r) => sum + (r.inputTokens || 0),
				0
			);
			const totalOutputTokens = reqs.reduce(
				(sum, r) => sum + (r.outputTokens || 0),
				0
			);
			const totalCharacters = reqs.reduce(
				(sum, r) => sum + (r.characters || 0),
				0
			);
			const totalCost = reqs.reduce((sum, r) => sum + r.cost, 0);
			const latencies = reqs.map((r) => r.latency);

			stats.push({
				provider: prov,
				environment: this.environment || "test",
				timeframe: timeframeKey,
				period,
				totalRequests: reqs.length,
				successfulRequests: successful.length,
				failedRequests: failed.length,
				totalInputTokens: totalInputTokens || undefined,
				totalOutputTokens: totalOutputTokens || undefined,
				totalCharacters: totalCharacters || undefined,
				totalCost,
				averageCostPerRequest:
					reqs.length > 0 ? totalCost / reqs.length : 0,
				averageLatency:
					latencies.length > 0
						? latencies.reduce((a, b) => a + b, 0) / latencies.length
						: 0,
				minLatency:
					latencies.length > 0 ? Math.min(...latencies) : 0,
				maxLatency:
					latencies.length > 0 ? Math.max(...latencies) : 0,
				requests: reqs.slice(-100), // Keep last 100 requests in stats
			});
		}

		return stats;
	}

	/**
	 * Get overall cost summary
	 */
	public getSummary(period: TimeframeType): CostSummary {
		this.ensureInitialized();
		
		const stats = this.getStats(period);
		const totalCost = stats.reduce((sum, s) => sum + s.totalCost, 0);
		const totalRequests = stats.reduce(
			(sum, s) => sum + s.totalRequests,
			0
		);

		return {
			timeframe: getTimeframeKey(new Date(), period),
			period,
			environment: this.environment || "test",
			totalCost,
			totalRequests,
			providers: stats.map((s) => ({
				provider: s.provider,
				cost: s.totalCost,
				requests: s.totalRequests,
			})),
		};
	}

	/**
	 * Write stats to files (simplified - single file per provider)
	 */
	public async writeStats(): Promise<void> {
		this.ensureInitialized();
		
		if (this.isFlushing || !this.trackingConfig || !this.trackingConfig.enabled) {
			return;
		}

		this.isFlushing = true;

		try {
			await this.ensureDirectories();

			// Write simplified stats - one file per provider with all timeframes
			const providers: ProviderName[] = [
				"grok",
				"gemini",
				"openai",
				"ollama",
				"cartesia",
				"google-tts",
			];

			for (const provider of providers) {
				await this.writeProviderSummary(provider);
			}

			// Write overall summary
			await this.writeOverallSummary();
		} catch (error) {
			console.error("[APICostTracker] Error writing stats:", error);
		} finally {
			this.isFlushing = false;
		}
	}

	/**
	 * Write simplified provider summary (single file per provider)
	 */
	private async writeProviderSummary(provider: ProviderName): Promise<void> {
		if (!this.trackingConfig) return;

		const filepath = path.join(
			this.trackingConfig.baseDirectory,
			`${provider}.json`
		);

		// Load existing data to accumulate
		let existing: {
			provider: ProviderName;
			environment: Environment;
			allTime: {
				totalCost: number;
				totalRequests: number;
				successfulRequests: number;
				failedRequests: number;
				totalInputTokens?: number;
				totalOutputTokens?: number;
				totalCharacters?: number;
			};
			current: {
				hour: { cost: number; requests: number } | null;
				day: { cost: number; requests: number } | null;
				week: { cost: number; requests: number } | null;
				month: { cost: number; requests: number } | null;
			};
			lastUpdated: string;
		};

		try {
			const data = await fs.readFile(filepath, "utf-8");
			existing = JSON.parse(data);
		} catch {
			// New file
			existing = {
				provider,
				environment: this.environment || "test",
				allTime: {
					totalCost: 0,
					totalRequests: 0,
					successfulRequests: 0,
					failedRequests: 0,
				},
				current: {
					hour: null,
					day: null,
					week: null,
					month: null,
				},
				lastUpdated: new Date().toISOString(),
			};
		}

		// Get current stats for all timeframes (simplified - just cost and requests)
		const periods: TimeframeType[] = ["hour", "day", "week", "month"];
		for (const period of periods) {
			const stats = this.getStats(period, provider);
			const stat = stats[0];
			if (stat) {
				existing.current[period] = {
					cost: stat.totalCost,
					requests: stat.totalRequests,
				};
			}
		}

		// Accumulate all-time stats from all requests
		const allRequests = this.requests.filter((r) => r.provider === provider);
		existing.allTime.totalCost = allRequests.reduce((sum, r) => sum + r.cost, 0);
		existing.allTime.totalRequests = allRequests.length;
		existing.allTime.successfulRequests = allRequests.filter((r) => r.success).length;
		existing.allTime.failedRequests = allRequests.filter((r) => !r.success).length;
		
		const totalInputTokens = allRequests.reduce((sum, r) => sum + (r.inputTokens || 0), 0);
		const totalOutputTokens = allRequests.reduce((sum, r) => sum + (r.outputTokens || 0), 0);
		const totalCharacters = allRequests.reduce((sum, r) => sum + (r.characters || 0), 0);
		
		if (totalInputTokens > 0) {
			existing.allTime.totalInputTokens = totalInputTokens;
			existing.allTime.totalOutputTokens = totalOutputTokens;
		}
		if (totalCharacters > 0) {
			existing.allTime.totalCharacters = totalCharacters;
		}

		existing.lastUpdated = new Date().toISOString();
		existing.environment = this.environment || "test";

		await fs.writeFile(filepath, JSON.stringify(existing, null, 2));
	}

	/**
	 * Write overall summary (single file)
	 */
	private async writeOverallSummary(): Promise<void> {
		if (!this.trackingConfig) return;

		const filepath = path.join(this.trackingConfig.baseDirectory, "summary.json");

		// Load existing to accumulate
		let existing: {
			environment: Environment;
			allTime: {
				totalCost: number;
				totalRequests: number;
				providers: Array<{
					provider: ProviderName;
					cost: number;
					requests: number;
				}>;
			};
			current: {
				hour: { cost: number; requests: number } | null;
				day: { cost: number; requests: number } | null;
				week: { cost: number; requests: number } | null;
				month: { cost: number; requests: number } | null;
			};
			lastUpdated: string;
		};

		try {
			const data = await fs.readFile(filepath, "utf-8");
			existing = JSON.parse(data);
		} catch {
			existing = {
				environment: this.environment || "test",
				allTime: {
					totalCost: 0,
					totalRequests: 0,
					providers: [],
				},
				current: {
					hour: null,
					day: null,
					week: null,
					month: null,
				},
				lastUpdated: new Date().toISOString(),
			};
		}

		// Update current timeframes (simplified - just cost and requests)
		const periods: TimeframeType[] = ["hour", "day", "week", "month"];
		for (const period of periods) {
			const summary = this.getSummary(period);
			existing.current[period] = {
				cost: summary.totalCost,
				requests: summary.totalRequests,
			};
		}

		// Accumulate all-time stats
		existing.allTime.totalCost = this.requests.reduce((sum, r) => sum + r.cost, 0);
		existing.allTime.totalRequests = this.requests.length;

		// Group by provider for all-time
		const byProvider = new Map<ProviderName, { cost: number; requests: number }>();
		for (const req of this.requests) {
			const existing = byProvider.get(req.provider) || { cost: 0, requests: 0 };
			existing.cost += req.cost;
			existing.requests += 1;
			byProvider.set(req.provider, existing);
		}

			existing.allTime.providers = Array.from(byProvider.entries())
				.map(([provider, data]) => ({
					provider,
					cost: data.cost,
					requests: data.requests,
				}))
				.sort((a, b) => b.cost - a.cost); // Sort by cost descending

		existing.lastUpdated = new Date().toISOString();
		existing.environment = this.environment || "test";

		await fs.writeFile(filepath, JSON.stringify(existing, null, 2));
	}

	/**
	 * Ensure all required directories exist
	 */
	private async ensureDirectories(): Promise<void> {
		if (!this.trackingConfig) return;
		
		// Just ensure the base directory exists (simplified structure)
		await fs.mkdir(this.trackingConfig.baseDirectory, { recursive: true });
	}

	/**
	 * Start periodic flush timer
	 */
	private startPeriodicFlush(): void {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
		}

		if (!this.trackingConfig) return;

		this.flushTimer = setInterval(() => {
			this.writeStats().catch((err) => {
				console.error(
					"[APICostTracker] Error in periodic flush:",
					err
				);
			});
		}, this.trackingConfig.flushInterval);
		// Don't keep short-lived scripts alive; flush once when the event loop drains instead
		this.flushTimer.unref();
		process.once("beforeExit", () => {
			this.shutdown().catch((err) => {
				console.error("[APICostTracker] Error in exit flush:", err);
			});
		});
	}

	/**
	 * Flush remaining data and cleanup
	 * Call this on application shutdown
	 */
	public async shutdown(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}

		await this.writeStats();
	}
}

