/**
 * Temporal Pattern Analyzer
 *
 * Analyzes user activity patterns over time:
 * - Circadian rhythm (peak hours, timezone estimation)
 * - Activity patterns (messages per day, active streaks)
 * - Regularity and burst tendency
 */

import type {
	AnalyzerResult,
	CircadianRhythm,
	ActivityPatterns,
	TemporalProfile,
	MessageData,
} from "../types";

export class TemporalPatternAnalyzer {
	/**
	 * Analyze temporal patterns from user messages
	 */
	static async analyze(
		messages: MessageData[]
	): Promise<AnalyzerResult<TemporalProfile>> {
		try {
			if (messages.length < 10) {
				return {
					success: false,
					error: "Insufficient messages for temporal analysis (need >= 10)",
					confidence: 0,
				};
			}

			// Sort messages by timestamp
			const sortedMessages = [...messages].sort(
				(a, b) => a.created_at.getTime() - b.created_at.getTime()
			);

			// Analyze circadian rhythm
			const circadianRhythm = this.analyzeCircadianRhythm(sortedMessages);

			// Analyze activity patterns
			const activityPatterns = this.analyzeActivityPatterns(sortedMessages);

			// Calculate confidence based on message count and time span
			const confidence = this.calculateConfidence(sortedMessages);

			const profile: TemporalProfile = {
				circadian_rhythm: circadianRhythm,
				activity_patterns: activityPatterns,
			};

			return {
				success: true,
				data: profile,
				confidence,
			};
		} catch (error) {
			return {
				success: false,
				error: `Temporal pattern analysis failed: ${error}`,
				confidence: 0,
			};
		}
	}

	/**
	 * Analyze circadian rhythm patterns
	 */
	private static analyzeCircadianRhythm(
		messages: MessageData[]
	): CircadianRhythm {
		// Count messages by hour (UTC)
		const hourCounts: Record<number, number> = {};
		for (let i = 0; i < 24; i++) {
			hourCounts[i] = 0;
		}

		for (const msg of messages) {
			const hour = msg.created_at.getUTCHours();
			hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;
		}

		// Find peak hours (top 4 hours with most activity)
		const sortedHours = Object.entries(hourCounts)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 4)
			.map(([hour]) => Number.parseInt(hour))
			.sort((a, b) => a - b);

		// Estimate timezone from peak hour
		const timezoneEstimate = this.estimateTimezone(sortedHours);

		// Calculate regularity score (inverse of std dev of activity distribution)
		const regularityScore = this.calculateRegularityScore(hourCounts);

		// Calculate night owl score (activity 0-6 UTC relative to total)
		const nightActivity = [0, 1, 2, 3, 4, 5, 6].reduce(
			(sum, hour) => sum + (hourCounts[hour] ?? 0),
			0
		);
		const nightOwlScore = nightActivity / messages.length;

		return {
			peak_hours_utc: sortedHours,
			timezone_estimate: timezoneEstimate,
			regularity_score: regularityScore,
			night_owl_score: nightOwlScore,
		};
	}

	/**
	 * Estimate timezone from peak activity hours
	 */
	private static estimateTimezone(peakHoursUTC: number[]): string {
		if (peakHoursUTC.length === 0) return "UTC";

		// Calculate modal peak hour
		const modalPeak = peakHoursUTC[Math.floor(peakHoursUTC.length / 2)] ?? 0;

		// Most people are active 18:00-23:00 local time
		// Map UTC peak to local timezone offset
		const estimatedLocalPeak = 20; // Assume 8 PM local
		const offset = (modalPeak - estimatedLocalPeak + 24) % 24;
		const offsetHours = offset > 12 ? offset - 24 : offset;

		// Map offset to IANA timezone (common ones)
		const timezoneMap: Record<number, string> = {
			"-8": "America/Los_Angeles",
			"-7": "America/Denver",
			"-6": "America/Chicago",
			"-5": "America/New_York",
			"-4": "America/Halifax",
			"-3": "America/Sao_Paulo",
			0: "Europe/London",
			1: "Europe/Paris",
			2: "Europe/Athens",
			3: "Europe/Moscow",
			5: "Asia/Karachi",
			8: "Asia/Singapore",
			9: "Asia/Tokyo",
			10: "Australia/Sydney",
		};

		return timezoneMap[offsetHours] || `UTC${offsetHours >= 0 ? "+" : ""}${offsetHours}`;
	}

	/**
	 * Calculate regularity score from hour distribution
	 */
	private static calculateRegularityScore(
		hourCounts: Record<number, number>
	): number {
		const values = Object.values(hourCounts);
		const mean = values.reduce((sum, val) => sum + val, 0) / values.length;

		if (mean === 0) return 0;

		const variance =
			values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
			values.length;
		const stdDev = Math.sqrt(variance);

		// Normalize: lower std dev = higher regularity
		const coefficientOfVariation = stdDev / mean;
		return Math.max(0, 1 - Math.min(1, coefficientOfVariation / 2));
	}

	/**
	 * Analyze activity patterns
	 */
	private static analyzeActivityPatterns(
		messages: MessageData[]
	): ActivityPatterns {
		if (messages.length === 0) {
			return {
				messages_per_day_avg: 0,
				active_days_per_week: 0,
				longest_active_streak_days: 0,
				burst_tendency: 0,
			};
		}

		// Group messages by day
		const dayGroups = new Map<string, MessageData[]>();
		for (const msg of messages) {
			const dayKey = msg.created_at.toISOString().slice(0, 10); // YYYY-MM-DD
			const group = dayGroups.get(dayKey);
			if (group) {
				group.push(msg);
			} else {
				dayGroups.set(dayKey, [msg]);
			}
		}

		const days = [...dayGroups.keys()].sort();
		const totalDays = days.length;

		// Calculate messages per day average
		const messagesPerDayAvg = messages.length / Math.max(1, totalDays);

		// Calculate active days per week
		const firstDay = new Date(days[0] ?? "");
		const lastDay = new Date(days[days.length - 1] ?? "");
		const totalWeeks =
			(lastDay.getTime() - firstDay.getTime()) / (7 * 24 * 60 * 60 * 1000);
		const activeDaysPerWeek = Math.min(7, totalDays / Math.max(1, totalWeeks));

		// Calculate longest active streak
		const longestStreak = this.calculateLongestStreak(days);

		// Calculate burst tendency
		const burstTendency = this.calculateBurstTendency(messages);

		return {
			messages_per_day_avg: messagesPerDayAvg,
			active_days_per_week: activeDaysPerWeek,
			longest_active_streak_days: longestStreak,
			burst_tendency: burstTendency,
		};
	}

	/**
	 * Calculate longest consecutive active streak
	 */
	private static calculateLongestStreak(days: string[]): number {
		if (days.length === 0) return 0;

		let maxStreak = 1;
		let currentStreak = 1;

		for (let i = 1; i < days.length; i++) {
			const prevKey = days[i - 1];
			const currKey = days[i];
			if (prevKey === undefined || currKey === undefined) continue;
			const prevDay = new Date(prevKey);
			const currDay = new Date(currKey);
			const dayDiff =
				(currDay.getTime() - prevDay.getTime()) / (24 * 60 * 60 * 1000);

			if (dayDiff === 1) {
				currentStreak++;
				maxStreak = Math.max(maxStreak, currentStreak);
			} else {
				currentStreak = 1;
			}
		}

		return maxStreak;
	}

	/**
	 * Calculate burst tendency (messages sent in rapid succession)
	 */
	private static calculateBurstTendency(messages: MessageData[]): number {
		if (messages.length < 2) return 0;

		const burstThresholdMinutes = 2; // Messages within 2 minutes = burst
		let burstMessages = 0;

		for (let i = 1; i < messages.length; i++) {
			const current = messages[i];
			const previous = messages[i - 1];
			if (!current || !previous) continue;
			const timeDiff =
				(current.created_at.getTime() - previous.created_at.getTime()) /
				(60 * 1000);

			if (timeDiff <= burstThresholdMinutes) {
				burstMessages++;
			}
		}

		return burstMessages / messages.length;
	}

	/**
	 * Calculate confidence based on data quality
	 */
	private static calculateConfidence(messages: MessageData[]): number {
		// More messages and longer time span = higher confidence
		const messageCount = messages.length;
		const firstMsg = messages[0];
		const lastMsg = messages[messages.length - 1];
		if (!firstMsg || !lastMsg) return 0;
		const timeSpanDays =
			(lastMsg.created_at.getTime() - firstMsg.created_at.getTime()) /
			(24 * 60 * 60 * 1000);

		// Message count contribution (0-0.5)
		const messageConfidence = Math.min(0.5, messageCount / 200);

		// Time span contribution (0-0.5)
		const timeConfidence = Math.min(0.5, timeSpanDays / 60);

		return messageConfidence + timeConfidence;
	}
}
