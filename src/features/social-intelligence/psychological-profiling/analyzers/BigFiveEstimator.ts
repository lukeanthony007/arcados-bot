/**
 * Big Five Personality Estimator
 *
 * Uses Grok 4.1 to estimate Big Five personality traits based on
 * communication patterns, statistical metrics, and message samples.
 */

import type { AIEngine } from "../../../../ai/core/AIEngine";
import { AIRequestBuilder } from "../../../../ai/core/AIRequestBuilder";
import { AIContextBuilder } from "../../../../ai/core/AIContext";
import type {
	AnalyzerResult,
	BigFiveProxies,
	CommunicationStyle,
	ResponsePatterns,
	EmojiSignature,
	UserAnalysisData,
} from "../types";
import { buildBigFivePrompt } from "../prompts";

export class BigFiveEstimator {
	private aiEngine: AIEngine;

	constructor(aiEngine: AIEngine) {
		this.aiEngine = aiEngine;
	}

	/**
	 * Estimate Big Five personality traits using AI
	 */
	async estimate(
		data: UserAnalysisData,
		communicationStyle?: CommunicationStyle,
		responsePatterns?: ResponsePatterns,
		emojiSignature?: EmojiSignature
	): Promise<AnalyzerResult<BigFiveProxies>> {
		try {
			if (data.messages.length < 10) {
				return {
					success: false,
					error: "Insufficient messages for Big Five estimation (need >= 10)",
					confidence: 0,
				};
			}

			// Build prompt with all available data
			const prompt = this.buildPrompt(
				data,
				communicationStyle,
				responsePatterns,
				emojiSignature
			);

			// Call Grok 4.1
			const response = await this.callGrok(prompt, data.guildId);

			if (!response.success || !response.content) {
				return {
					success: false,
					error: response.error || "AI response failed",
					confidence: 0,
				};
			}

			// Parse JSON response
			const bigFive = this.parseResponse(response.content);

			if (!bigFive) {
				return {
					success: false,
					error: "Failed to parse AI response as valid Big Five data",
					confidence: 0,
				};
			}

			// Calculate overall confidence (average of trait confidences)
			const avgConfidence =
				(bigFive.extraversion.confidence +
					bigFive.agreeableness.confidence +
					bigFive.conscientiousness.confidence +
					bigFive.neuroticism.confidence +
					bigFive.openness.confidence) /
				5;

			return {
				success: true,
				data: bigFive,
				confidence: avgConfidence,
			};
		} catch (error) {
			return {
				success: false,
				error: `Big Five estimation failed: ${error}`,
				confidence: 0,
			};
		}
	}

	/**
	 * Build prompt for Grok
	 */
	private buildPrompt(
		data: UserAnalysisData,
		communicationStyle?: CommunicationStyle,
		responsePatterns?: ResponsePatterns,
		emojiSignature?: EmojiSignature
	): string {
		// Format communication style
		const verbosityLine =
			communicationStyle?.verbosity !== undefined
				? `Verbosity: ${(communicationStyle.verbosity * 100).toFixed(0)}th percentile (${communicationStyle.elaboration_style})`
				: communicationStyle
					? `Elaboration style: ${communicationStyle.elaboration_style}`
					: "";
		const commStyleText = communicationStyle
			? `Formality: ${(communicationStyle.formality * 100).toFixed(0)}% formal
${verbosityLine}
Emoji richness: ${(communicationStyle.emoji_richness * 100).toFixed(0)}%
Question frequency: ${communicationStyle.question_frequency.toFixed(2)} questions per 100 messages`
			: "Not available";

		// Format emoji usage
		const emojiText = emojiSignature
			? `Emojis per message: ${emojiSignature.emoji_per_message.toFixed(2)}
Timing: ${emojiSignature.emoji_timing}
Top emojis: ${Object.entries(emojiSignature.top_emojis)
					.slice(0, 5)
					.map(([emoji, count]) => `${emoji} (${count})`)
					.join(", ")}`
			: "Not available";

		// Format response patterns
		const responseLines: string[] = [];
		if (responsePatterns?.avg_response_latency_minutes !== undefined) {
			responseLines.push(
				`Median response latency: ${responsePatterns.avg_response_latency_minutes.toFixed(1)} minutes`
			);
		}
		if (responsePatterns?.question_answer_rate !== undefined) {
			responseLines.push(
				`Question answer rate: ${(responsePatterns.question_answer_rate * 100).toFixed(0)}%`
			);
		}
		if (responsePatterns?.turn_taking_balance !== undefined) {
			responseLines.push(
				`Turn-taking balance: ${(responsePatterns.turn_taking_balance * 100).toFixed(0)}%`
			);
		}
		if (responsePatterns?.conversation_initiation_rate !== undefined) {
			responseLines.push(
				`Conversation initiation: ${(responsePatterns.conversation_initiation_rate * 100).toFixed(0)}%`
			);
		}
		const responseText = responseLines.length > 0 ? responseLines.join("\n") : "Not available";

		// Get message samples (latest 15 chronologically, sanitize content)
		const messageSamples = [...data.messages]
			.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
			.slice(-15)
			.map((m) => {
				const content = m.content.trim().substring(0, 200);
				return content || "(empty message)";
			});

		// Get top relationships
		const topRelationships = data.relationships
			.slice(0, 5)
			.map(
				(r) =>
					`${r.user_id} (${r.affinity_percentage.toFixed(0)}% affinity, ${r.interaction_count} interactions)`
			);

		return buildBigFivePrompt({
			messageCount: data.messages.length,
			communicationStyle: commStyleText,
			emojiUsage: emojiText,
			responsePatterns: responseText,
			topKeywords: data.keywords || [],
			topRelationships,
			messageSamples,
		});
	}

	/**
	 * Call Grok 4.1 API
	 */
	private async callGrok(prompt: string, guildId: string): Promise<{
		success: boolean;
		content?: string;
		error?: string;
	}> {
		try {
			const ctx = new AIContextBuilder()
				.user("system-profiler")
				.guild(guildId)
				.build();

			const builder = new AIRequestBuilder(this.aiEngine);
			const result = await builder
				.blocking()
				.mode("structured")
				.maxTokens(512)
				.withContext(ctx)
				.provider("grok") // Use Grok 4.1
				.withoutTools() // No database tools needed for this
				.generate(prompt);

			if (result && "content" in result && result.content) {
				return {
					success: true,
					content: result.content,
				};
			}

			return {
				success: false,
				error: "No content in AI response",
			};
		} catch (error) {
			return {
				success: false,
				error: `Grok API call failed: ${error}`,
			};
		}
	}

	/**
	 * Parse AI response into BigFiveProxies
	 */
	private parseResponse(content: string): BigFiveProxies | null {
		try {
			// Remove markdown code blocks if present
			let cleaned = content.replace(/```json\s*|\s*```/g, "").trim();

			// If the model added any leading/trailing text around the JSON object,
			// try to isolate the JSON portion between the first "{" and the last "}".
			const firstBrace = cleaned.indexOf("{");
			const lastBrace = cleaned.lastIndexOf("}");
			if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
				cleaned = cleaned.slice(firstBrace, lastBrace + 1);
			}

			let parsed: any;

			try {
				// First attempt: direct parse
				parsed = JSON.parse(cleaned);
			} catch (primaryError) {
				// Some Grok responses duplicate a line (e.g. "indicators") where the first
				// occurrence is truncated and the second is complete. This produces invalid
				// JSON like:
				//   "indicators": ["casual_greetings", "group_addr
				//   "indicators": ["casual_greetings", "group_addressing", ...]
				//
				// As a robustness fallback, drop obviously truncated indicator lines when
				// they are immediately followed by a full "indicators" line.
				const lines = cleaned.split("\n");
				const repairedLines: string[] = [];

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i] ?? "";
					const next = lines[i + 1] ?? "";

					if (
						line.includes(`"indicators"`) &&
						!line.includes("]") &&
						next.includes(`"indicators"`) &&
						next.includes("]")
					) {
						// Skip this truncated line; the next line has the full field.
						continue;
					}

					repairedLines.push(line);
				}

				const repaired = repairedLines.join("\n");

				try {
					parsed = JSON.parse(repaired);
					console.warn(
						"BigFiveEstimator: repaired malformed JSON from Grok response"
					);
				} catch {
					// Re-throw original error so outer catch logs the full content once.
					throw primaryError;
				}
			}

			// Validate structure
			if (
				!parsed.extraversion ||
				!parsed.agreeableness ||
				!parsed.conscientiousness ||
				!parsed.neuroticism ||
				!parsed.openness
			) {
				console.error("Invalid Big Five structure:", parsed);
				return null;
			}

			// Validate each trait
			for (const trait of [
				"extraversion",
				"agreeableness",
				"conscientiousness",
				"neuroticism",
				"openness",
			]) {
				const t = parsed[trait];
				if (
					typeof t.score !== "number" ||
					typeof t.confidence !== "number" ||
					!Array.isArray(t.indicators)
				) {
					console.error(`Invalid ${trait} structure:`, t);
					return null;
				}

				// Clamp scores and confidence to 0-1 range
				t.score = Math.max(0, Math.min(1, t.score));
				t.confidence = Math.max(0, Math.min(1, t.confidence));
			}

			return parsed as BigFiveProxies;
		} catch (error) {
			console.error("Failed to parse Big Five response:", error);
			console.error("Content:", content);
			return null;
		}
	}
}
