/**
 * Big Five Personality Estimator
 *
 * Uses Grok 4.1 to estimate Big Five personality traits based on
 * communication patterns, statistical metrics, and message samples.
 */

import { OmpRuntime, type JsonObjectSchema } from "../../../../ai/runtime/OmpRuntime";
import type {
	AnalyzerResult,
	BigFiveProxies,
	CommunicationStyle,
	ResponsePatterns,
	EmojiSignature,
	UserAnalysisData,
} from "../types";
import { buildBigFivePrompt } from "../prompts";
import { describeStrength } from "../../facts/closeness";

const BIG_FIVE_TRAITS = [
	"extraversion",
	"agreeableness",
	"conscientiousness",
	"neuroticism",
	"openness",
] as const;

const TRAIT_SCHEMA = {
	type: "object",
	properties: {
		score: { type: "number", minimum: 0, maximum: 1 },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		indicators: { type: "array", items: { type: "string" } },
	},
	required: ["score", "confidence", "indicators"],
};

const BIG_FIVE_SCHEMA: JsonObjectSchema = {
	type: "object",
	properties: Object.fromEntries(BIG_FIVE_TRAITS.map((trait) => [trait, TRAIT_SCHEMA])),
	required: [...BIG_FIVE_TRAITS],
};

const BIG_FIVE_SYSTEM_PROMPT =
	"You are a personality-analysis component inside a Discord analytics pipeline. " +
	"Analyze the supplied user data and report your estimates only by calling the submit tool.";

export class BigFiveEstimator {
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

			// Call the model
			const bigFive = await this.requestTraits(prompt);

			if (!bigFive) {
				return {
					success: false,
					error: "AI did not return valid Big Five data",
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
			.map((r) => `${r.name} (${describeStrength(r)})`);

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
	 * Ask the model for structured trait estimates; null when it never submits or the
	 * submission is malformed. Scores and confidences are clamped to 0-1.
	 */
	private async requestTraits(prompt: string): Promise<BigFiveProxies | null> {
		const submitted = await OmpRuntime.get().generateStructured<BigFiveProxies>({
			systemPrompt: BIG_FIVE_SYSTEM_PROMPT,
			prompt,
			schema: BIG_FIVE_SCHEMA,
			label: "profiling.big-five",
		});
		if (!submitted) {
			return null;
		}

		for (const trait of BIG_FIVE_TRAITS) {
			const t = submitted[trait];
			if (
				!t ||
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

		return submitted;
	}
}
