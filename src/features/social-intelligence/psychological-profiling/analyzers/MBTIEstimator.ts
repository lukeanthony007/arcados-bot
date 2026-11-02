/**
 * MBTI Estimator
 *
 * Estimates Myers-Briggs Type Indicator (MBTI) personality types using a hybrid approach:
 * 1. Derive from Big Five using research-based correlations (no AI cost)
 * 2. Validate with behavioral indicators (statistical analysis)
 * 3. Optional AI validation for low-confidence cases (5% of users)
 */

import type { AIEngine } from "../../../../ai/core/AIEngine";
import { AIRequestBuilder } from "../../../../ai/core/AIRequestBuilder";
import { AIContextBuilder } from "../../../../ai/core/AIContext";
import type {
	AnalyzerResult,
	BigFiveProxies,
	CommunicationStyle,
	ResponsePatterns,
	TemporalProfile,
	MBTIType,
	MBTIDichotomy,
	UserAnalysisData,
} from "../types";
import {
	BIG_FIVE_TO_MBTI_CORRELATIONS,
	getMBTITypeString,
	getMBTIDescriptors,
} from "../mbti-mappings";
import { buildMBTIValidationPrompt } from "../prompts";

/** |score| below this reports a neutral "X" letter (no lean at all). */
const MBTI_LEAN_THRESHOLD = 0.1;
/** |score| at/above this carries the full Big Five-derived confidence. */
const MBTI_FULL_LEAN_SCORE = 0.6;

/** Letters for a negative / positive dichotomy score. */
const MBTI_DICHOTOMY_LETTERS = {
	E_I: ["I", "E"],
	S_N: ["S", "N"],
	T_F: ["T", "F"],
	J_P: ["J", "P"],
} as const;

export class MBTIEstimator {
	private aiEngine: AIEngine | null;

	constructor(aiEngine?: AIEngine) {
		this.aiEngine = aiEngine || null;
	}

	/**
	 * Estimate MBTI type from Big Five + behavioral patterns
	 * Only calls AI if confidence < 0.5
	 */
	async estimate(
		bigFive: BigFiveProxies,
		communicationStyle?: CommunicationStyle,
		responsePatterns?: ResponsePatterns,
		temporalProfile?: TemporalProfile,
		data?: UserAnalysisData
	): Promise<AnalyzerResult<MBTIType>> {
		try {
			// Step 1: Derive from Big Five (research-based correlations)
			const derived = this.deriveFromBigFive(bigFive);

			// Step 2: Validate with behavioral indicators
			const validated = this.validateWithBehaviors(
				derived,
				communicationStyle,
				responsePatterns,
				temporalProfile
			);

			// Step 3: Optional AI validation for low confidence
			if (
				this.aiEngine &&
				validated.confidence < 0.5 &&
				data &&
				data.messages.length >= 100
			) {
				return await this.aiValidate(validated, data);
			}

			return {
				success: true,
				data: validated,
				confidence: validated.confidence,
			};
		} catch (error) {
			return {
				success: false,
				error: `MBTI estimation failed: ${error}`,
				confidence: 0,
			};
		}
	}

	/**
	 * Step 1: Derive MBTI from Big Five using research-based correlations
	 */
	private deriveFromBigFive(bigFive: BigFiveProxies): MBTIType {
		// E/I from Extraversion (r=0.74)
		const E_I = this.buildDichotomy(
			bigFive.extraversion.score,
			bigFive.extraversion.confidence,
			BIG_FIVE_TO_MBTI_CORRELATIONS.E_I.mapping,
			"E",
			"I",
			bigFive.extraversion.indicators
		);

		// S/N from Openness inverse (r=-0.72)
		const S_N = this.buildDichotomy(
			bigFive.openness.score,
			bigFive.openness.confidence,
			BIG_FIVE_TO_MBTI_CORRELATIONS.S_N.mapping,
			"N",
			"S",
			bigFive.openness.indicators
		);

		// T/F from Agreeableness inverse (r=-0.44)
		const T_F = this.buildDichotomy(
			bigFive.agreeableness.score,
			bigFive.agreeableness.confidence,
			BIG_FIVE_TO_MBTI_CORRELATIONS.T_F.mapping,
			"F",
			"T",
			bigFive.agreeableness.indicators
		);

		// J/P from Conscientiousness (r=0.49)
		const J_P = this.buildDichotomy(
			bigFive.conscientiousness.score,
			bigFive.conscientiousness.confidence,
			BIG_FIVE_TO_MBTI_CORRELATIONS.J_P.mapping,
			"P",
			"J",
			bigFive.conscientiousness.indicators
		);

		// Build MBTI type
		const typeString = getMBTITypeString(
			E_I.preference,
			S_N.preference,
			T_F.preference,
			J_P.preference
		);

		const avgConfidence =
			(E_I.confidence + S_N.confidence + T_F.confidence + J_P.confidence) / 4;

		return {
			type: typeString,
			confidence: avgConfidence,
			dichotomies: { E_I, S_N, T_F, J_P },
			descriptors: getMBTIDescriptors(typeString),
		};
	}

	/**
	 * Build a single MBTI dichotomy from Big Five trait
	 */
	private buildDichotomy(
		bigFiveScore: number,
		bigFiveConfidence: number,
		mapping: (score: number) => number,
		highPreference: MBTIDichotomy["preference"],
		lowPreference: MBTIDichotomy["preference"],
		indicators: string[]
	): MBTIDichotomy {
		// Map Big Five score (0-1) to MBTI score (-1 to +1)
		const mbtiScore = mapping(bigFiveScore);

		// Always report the leaning letter; X only when the score is (near) exactly neutral.
		// Stored Big Five scores sit on a 0.1 grid and 62-73% of E/I and S/N scores fall in
		// 0.4-0.6, so a 0.3 neutral threshold turned most letters into X. How weak the lean is
		// is carried by the dichotomy confidence below instead.
		let preference: MBTIDichotomy["preference"];
		if (mbtiScore >= MBTI_LEAN_THRESHOLD) {
			preference = highPreference;
		} else if (mbtiScore <= -MBTI_LEAN_THRESHOLD) {
			preference = lowPreference;
		} else {
			preference = "X"; // No lean
		}

		// Apply confidence penalty for correlation strength
		// E/I: 0.85 (strong), S/N: 0.85 (strong), T/F: 0.70 (moderate), J/P: 0.75 (moderate)
		const correlationPenalty =
			highPreference === "E"
				? 0.85
				: highPreference === "N"
					? 0.85
					: highPreference === "F"
						? 0.7
						: 0.75;

		// A weak lean (score near 0) is a weak claim: scale confidence by how far the score is
		// from neutral, reaching full weight at |score| >= MBTI_FULL_LEAN_SCORE.
		const leanStrength = Math.min(1, Math.abs(mbtiScore) / MBTI_FULL_LEAN_SCORE);
		const confidence = bigFiveConfidence * correlationPenalty * leanStrength;

		return {
			score: mbtiScore,
			preference,
			confidence,
			indicators: indicators.slice(0, 3), // Use Big Five indicators initially
		};
	}

	/**
	 * Step 2: Validate with behavioral indicators
	 */
	private validateWithBehaviors(
		mbtiType: MBTIType,
		communicationStyle?: CommunicationStyle,
		responsePatterns?: ResponsePatterns,
		temporalProfile?: TemporalProfile
	): MBTIType {
		if (!communicationStyle || !responsePatterns || !temporalProfile) {
			// No behavioral data available, return derived type as-is
			return mbtiType;
		}

		// Extract behavioral indicators for each dichotomy
		const E_I_indicators = this.extractE_I_Indicators(
			communicationStyle,
			responsePatterns,
			temporalProfile
		);
		const S_N_indicators = this.extractS_N_Indicators(communicationStyle);
		const T_F_indicators = this.extractT_F_Indicators(communicationStyle);
		const J_P_indicators = this.extractJ_P_Indicators(
			communicationStyle,
			temporalProfile
		);

		// Validate each dichotomy
		const E_I = this.validateDichotomy(
			mbtiType.dichotomies.E_I,
			E_I_indicators,
			"E",
			"I"
		);
		const S_N = this.validateDichotomy(
			mbtiType.dichotomies.S_N,
			S_N_indicators,
			"N",
			"S"
		);
		const T_F = this.validateDichotomy(
			mbtiType.dichotomies.T_F,
			T_F_indicators,
			"F",
			"T"
		);
		const J_P = this.validateDichotomy(
			mbtiType.dichotomies.J_P,
			J_P_indicators,
			"P",
			"J"
		);

		// Rebuild type with validated dichotomies
		const typeString = getMBTITypeString(
			E_I.preference,
			S_N.preference,
			T_F.preference,
			J_P.preference
		);

		const avgConfidence =
			(E_I.confidence + S_N.confidence + T_F.confidence + J_P.confidence) / 4;

		return {
			type: typeString,
			confidence: avgConfidence,
			dichotomies: { E_I, S_N, T_F, J_P },
			descriptors: getMBTIDescriptors(typeString),
		};
	}

	/**
	 * Extract E/I behavioral indicators
	 */
	private extractE_I_Indicators(
		communicationStyle: CommunicationStyle,
		responsePatterns: ResponsePatterns,
		temporalProfile: TemporalProfile
	): { score: number; indicators: string[] } {
		const indicators: string[] = [];
		let score = 0;

		// High message rate → E
		const messagesPerDay = temporalProfile.activity_patterns?.messages_per_day_avg || 0;
		if (messagesPerDay > 30) {
			indicators.push("high_message_rate");
			score += 0.3;
		} else if (messagesPerDay < 10) {
			indicators.push("low_message_rate");
			score -= 0.3;
		}

		// Rapid responses → E
		const latency = responsePatterns.avg_response_latency_minutes;
		if (latency !== undefined) {
			if (latency < 15) {
				indicators.push("rapid_responses");
				score += 0.2;
			} else if (latency > 60) {
				indicators.push("thoughtful_responses");
				score -= 0.2;
			}
		}

		// High conversation initiation → E
		const initiation = responsePatterns.conversation_initiation_rate;
		if (initiation !== undefined) {
			if (initiation > 0.4) {
				indicators.push("conversation_initiator");
				score += 0.2;
			} else if (initiation < 0.2) {
				indicators.push("conversation_responder");
				score -= 0.2;
			}
		}

		// Verbose communication → I (introverts tend to elaborate more)
		if (communicationStyle.elaboration_style === "verbose") {
			indicators.push("detailed_messages");
			score -= 0.15;
		} else if (communicationStyle.elaboration_style === "brief") {
			indicators.push("concise_messages");
			score += 0.15;
		}

		return { score, indicators };
	}

	/**
	 * Extract S/N behavioral indicators
	 */
	private extractS_N_Indicators(communicationStyle: CommunicationStyle): {
		score: number;
		indicators: string[];
	} {
		const indicators: string[] = [];
		let score = 0;

		// High formality → S (Sensors tend to be more formal/traditional)
		if (communicationStyle.formality > 0.7) {
			indicators.push("formal_language");
			score -= 0.2;
		} else if (communicationStyle.formality < 0.3) {
			indicators.push("casual_language");
			score += 0.1;
		}

		// High emoji richness → N (Intuitives tend to be more creative/expressive)
		if (communicationStyle.emoji_richness > 0.7) {
			indicators.push("creative_emoji_use");
			score += 0.25;
		} else if (communicationStyle.emoji_richness < 0.3) {
			indicators.push("minimal_emoji_use");
			score -= 0.15;
		}

		// High question frequency → N (Intuitives are more curious)
		if (communicationStyle.question_frequency > 0.5) {
			indicators.push("asks_many_questions");
			score += 0.2;
		} else if (communicationStyle.question_frequency < 0.2) {
			indicators.push("statement_focused");
			score -= 0.1;
		}

		return { score, indicators };
	}

	/**
	 * Extract T/F behavioral indicators
	 */
	private extractT_F_Indicators(communicationStyle: CommunicationStyle): {
		score: number;
		indicators: string[];
	} {
		const indicators: string[] = [];
		let score = 0;

		// High formality → T (Thinkers tend to be more formal/objective)
		if (communicationStyle.formality > 0.7) {
			indicators.push("objective_tone");
			score -= 0.15;
		} else if (communicationStyle.formality < 0.3) {
			indicators.push("casual_tone");
			score += 0.1;
		}

		// High emoji richness → F (Feelers are more emotionally expressive)
		if (communicationStyle.emoji_richness > 0.7) {
			indicators.push("emotionally_expressive");
			score += 0.25;
		} else if (communicationStyle.emoji_richness < 0.3) {
			indicators.push("reserved_expression");
			score -= 0.2;
		}

		return { score, indicators };
	}

	/**
	 * Extract J/P behavioral indicators
	 */
	private extractJ_P_Indicators(
		communicationStyle: CommunicationStyle,
		temporalProfile: TemporalProfile
	): { score: number; indicators: string[] } {
		const indicators: string[] = [];
		let score = 0;

		// High regularity → J (Judgers have consistent schedules)
		const regularity = temporalProfile.circadian_rhythm?.regularity_score || 0.5;
		if (regularity > 0.75) {
			indicators.push("consistent_timing");
			score += 0.3;
		} else if (regularity < 0.4) {
			indicators.push("flexible_timing");
			score -= 0.3;
		}

		// Low burst tendency → J (Judgers are more steady)
		const burstTendency = temporalProfile.activity_patterns?.burst_tendency || 0.5;
		if (burstTendency < 0.4) {
			indicators.push("steady_activity");
			score += 0.2;
		} else if (burstTendency > 0.7) {
			indicators.push("sporadic_activity");
			score -= 0.2;
		}

		// High formality → J (Judgers are more structured)
		if (communicationStyle.formality > 0.7) {
			indicators.push("structured_messages");
			score += 0.15;
		} else if (communicationStyle.formality < 0.3) {
			indicators.push("spontaneous_messages");
			score -= 0.15;
		}

		return { score, indicators };
	}

	/**
	 * Validate a dichotomy against behavioral indicators
	 */
	private validateDichotomy(
		dichotomy: MBTIDichotomy,
		behavioral: { score: number; indicators: string[] },
		highPreference: string,
		lowPreference: string
	): MBTIDichotomy {
		// Check if behavioral indicators contradict Big Five derivation
		const derived_preference = dichotomy.preference;
		const behavioral_preference =
			behavioral.score > 0.3
				? highPreference
				: behavioral.score < -0.3
					? lowPreference
					: "X";

		let adjusted_confidence = dichotomy.confidence;

		// If behavioral contradicts derived, reduce confidence
		if (
			derived_preference !== "X" &&
			behavioral_preference !== "X" &&
			derived_preference !== behavioral_preference
		) {
			adjusted_confidence *= 0.7; // 30% confidence penalty for contradiction
		}

		// If behavioral confirms derived, boost confidence slightly
		if (
			derived_preference !== "X" &&
			behavioral_preference !== "X" &&
			derived_preference === behavioral_preference
		) {
			adjusted_confidence = Math.min(1.0, adjusted_confidence * 1.1); // 10% boost
		}

		// Combine Big Five and behavioral indicators
		const combined_indicators = [
			...dichotomy.indicators,
			...behavioral.indicators,
		].slice(0, 5); // Max 5 indicators

		return {
			score: dichotomy.score,
			preference: dichotomy.preference,
			confidence: adjusted_confidence,
			indicators: combined_indicators,
		};
	}

	/**
	 * Step 3: Optional AI validation for low confidence cases
	 */
	private async aiValidate(
		mbtiType: MBTIType,
		data: UserAnalysisData
	): Promise<AnalyzerResult<MBTIType>> {
		if (!this.aiEngine) {
			return {
				success: true,
				data: mbtiType,
				confidence: mbtiType.confidence,
			};
		}

		try {
			const prompt = buildMBTIValidationPrompt(mbtiType, data);

			const ctx = new AIContextBuilder()
				.user("system-profiler")
				.guild(data.guildId)
				.build();

			const builder = new AIRequestBuilder(this.aiEngine);
			// Structured mode: the chat preset caps output at 60 tokens, truncating the JSON
			const result = await builder
				.blocking()
				.mode("structured")
				.maxTokens(800)
				.withContext(ctx)
				.provider("grok")
				.withoutTools()
				.generate(prompt);

			if (!result || !("content" in result) || !result.content) {
				return {
					success: true,
					data: mbtiType,
					confidence: mbtiType.confidence,
				};
			}

			// Parse AI response
			const validated = this.parseAIResponse(result.content);

			if (!validated) {
				return {
					success: true,
					data: mbtiType,
					confidence: mbtiType.confidence,
				};
			}

			// Build validated MBTI type
			const typeString = getMBTITypeString(
				validated.E_I.preference,
				validated.S_N.preference,
				validated.T_F.preference,
				validated.J_P.preference
			);

			const avgConfidence =
				(validated.E_I.confidence +
					validated.S_N.confidence +
					validated.T_F.confidence +
					validated.J_P.confidence) /
				4;

			return {
				success: true,
				data: {
					type: typeString,
					confidence: avgConfidence,
					dichotomies: validated,
					descriptors: getMBTIDescriptors(typeString),
				},
				confidence: avgConfidence,
			};
		} catch (error) {
			console.error(`AI validation failed: ${error}`);
			return {
				success: true,
				data: mbtiType,
				confidence: mbtiType.confidence,
			};
		}
	}

	/**
	 * Parse AI response into validated dichotomies
	 */
	private parseAIResponse(content: string): {
		E_I: MBTIDichotomy;
		S_N: MBTIDichotomy;
		T_F: MBTIDichotomy;
		J_P: MBTIDichotomy;
	} | null {
		try {
			// Remove markdown code blocks if present
			const cleaned = content.replace(/```json\s*|\s*```/g, "").trim();

			// Parse JSON
			const parsed = JSON.parse(cleaned);

			// Validate structure
			if (!parsed.E_I || !parsed.S_N || !parsed.T_F || !parsed.J_P) {
				console.error("Invalid MBTI validation structure:", parsed);
				return null;
			}

			// Validate each dichotomy
			for (const dichotomy of ["E_I", "S_N", "T_F", "J_P"] as const) {
				const d = parsed[dichotomy];
				if (
					typeof d.score !== "number" ||
					typeof d.confidence !== "number" ||
					typeof d.preference !== "string" ||
					!Array.isArray(d.indicators)
				) {
					console.error(`Invalid ${dichotomy} structure:`, d);
					return null;
				}

				// Clamp scores and confidence
				d.score = Math.max(-1, Math.min(1, d.score));
				d.confidence = Math.max(0, Math.min(1, d.confidence));

				// The score is authoritative: derive the letter from it so the model can't
				// return a letter that contradicts its own score (positive = E/N/F/P).
				const [low, high] = MBTI_DICHOTOMY_LETTERS[dichotomy];
				d.preference =
					d.score >= MBTI_LEAN_THRESHOLD ? high : d.score <= -MBTI_LEAN_THRESHOLD ? low : "X";
			}

			return parsed as {
				E_I: MBTIDichotomy;
				S_N: MBTIDichotomy;
				T_F: MBTIDichotomy;
				J_P: MBTIDichotomy;
			};
		} catch (error) {
			console.error("Failed to parse MBTI validation response:", error);
			console.error("Content:", content);
			return null;
		}
	}
}
