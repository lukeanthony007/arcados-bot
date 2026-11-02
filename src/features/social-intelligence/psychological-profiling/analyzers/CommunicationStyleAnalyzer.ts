/**
 * Communication Style Analyzer
 *
 * Statistical analysis of user communication patterns without AI cost.
 * Analyzes:
 * - Message length (verbosity)
 * - Formality (capitalization, punctuation, vocabulary)
 * - Emoji usage (richness and density)
 * - Question frequency
 * - Elaboration style
 */

import type {
	AnalyzerResult,
	CommunicationStyle,
	ElaborationStyle,
	MessageData,
} from "../types";

export class CommunicationStyleAnalyzer {
	/**
	 * Analyze communication style from user messages
	 */
	static async analyze(
		messages: MessageData[],
		guildMessageLengths?: number[]
	): Promise<AnalyzerResult<CommunicationStyle>> {
		try {
			if (messages.length < 5) {
				return {
					success: false,
					error: "Insufficient messages for communication style analysis (need >= 5)",
					confidence: 0,
				};
			}

			// Calculate message lengths
			const lengths = messages
				.map((m) => m.content.trim().length)
				.filter((len) => len > 0);

			if (lengths.length === 0) {
				return {
					success: false,
					error: "No non-empty messages found",
					confidence: 0,
				};
			}

			const avgLength = lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
			const stdDevLength = Math.sqrt(
				lengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) /
					lengths.length
			);

			// Verbosity percentile among the guild's authors (omitted without guild data)
			let verbosity: number | undefined;
			if (guildMessageLengths && guildMessageLengths.length > 0) {
				const below = guildMessageLengths.filter((len) => len < avgLength).length;
				verbosity = below / guildMessageLengths.length;
			}

			// Calculate formality score (0=casual, 1=formal)
			const formality = this.calculateFormality(messages);

			// Calculate emoji richness (diversity + frequency)
			const emojiRichness = this.calculateEmojiRichness(messages);

			// Calculate question frequency
			const questionFrequency = this.calculateQuestionFrequency(messages);

			// Determine elaboration style
			const elaborationStyle = this.determineElaborationStyle(
				avgLength,
				stdDevLength
			);

			// Calculate confidence based on message count
			const confidence = Math.min(0.9, 0.3 + (messages.length / 100) * 0.6);

			const style: CommunicationStyle = {
				formality,
				emoji_richness: emojiRichness,
				question_frequency: questionFrequency,
				elaboration_style: elaborationStyle,
			};
			if (verbosity !== undefined) style.verbosity = verbosity;

			return {
				success: true,
				data: style,
				confidence,
			};
		} catch (error) {
			return {
				success: false,
				error: `Communication style analysis failed: ${error}`,
				confidence: 0,
			};
		}
	}

	/**
	 * Calculate formality score based on linguistic patterns
	 */
	private static calculateFormality(messages: MessageData[]): number {
		let formalityScore = 0;
		let indicators = 0;

		for (const msg of messages) {
			const content = msg.content.trim();
			if (content.length === 0) continue;

			// Capitalization (proper sentence case)
			const sentenceRegex = /[.!?]\s+[A-Z]/g;
			const properSentences = (content.match(sentenceRegex) || []).length;
			const totalSentences = (content.match(/[.!?]/g) || []).length + 1;
			const capitalizationRatio =
				totalSentences > 0 ? properSentences / totalSentences : 0;

			// Punctuation usage
			const hasPunctuation = /[.!?,;:]/.test(content);

			// Contractions (informal marker)
			const contractionRegex = /(n't|'ll|'ve|'re|'m|'d|'s)\b/gi;
			const contractions = (content.match(contractionRegex) || []).length;
			const words = content.split(/\s+/).length;
			const contractionRate = words > 0 ? contractions / words : 0;

			// Slang/casual markers
			const slangRegex =
				/\b(lol|lmao|lmfao|omg|wtf|tbh|ngl|idk|imo|brb|gtg|gonna|wanna|gotta)\b/gi;
			const slangCount = (content.match(slangRegex) || []).length;
			const slangRate = words > 0 ? slangCount / words : 0;

			// Aggregate formality indicators
			formalityScore += capitalizationRatio * 0.3;
			formalityScore += hasPunctuation ? 0.2 : 0;
			formalityScore += Math.max(0, 0.3 - contractionRate * 2); // Penalize contractions
			formalityScore += Math.max(0, 0.2 - slangRate * 5); // Penalize slang heavily

			indicators++;
		}

		return indicators > 0 ? Math.min(1, formalityScore / indicators) : 0.5;
	}

	/**
	 * Calculate emoji richness (diversity + frequency)
	 */
	private static calculateEmojiRichness(messages: MessageData[]): number {
		const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
		const uniqueEmojis = new Set<string>();
		let totalEmojis = 0;

		for (const msg of messages) {
			const emojis = msg.content.match(emojiRegex) || [];
			totalEmojis += emojis.length;
			emojis.forEach((emoji) => uniqueEmojis.add(emoji));
		}

		if (totalEmojis === 0) return 0;

		// Diversity score (unique / total, capped at 0.5)
		const diversity = Math.min(0.5, uniqueEmojis.size / totalEmojis);

		// Frequency score (emojis per message, normalized to 0-0.5)
		const frequency = Math.min(0.5, (totalEmojis / messages.length) * 0.2);

		return diversity + frequency; // Combined 0-1 score
	}

	/**
	 * Calculate question frequency
	 */
	private static calculateQuestionFrequency(messages: MessageData[]): number {
		const questionMarkers = /[?？]/g;
		let questionCount = 0;

		for (const msg of messages) {
			if (questionMarkers.test(msg.content)) {
				questionCount++;
			}
		}

		// Normalize to questions per 100 messages (capped at 1.0)
		return Math.min(1.0, (questionCount / messages.length) * 100);
	}

	/**
	 * Determine elaboration style based on message length patterns
	 */
	private static determineElaborationStyle(
		avgLength: number,
		stdDevLength: number
	): ElaborationStyle {
		// Brief: short messages, consistent length
		if (avgLength < 50 && stdDevLength < 30) {
			return "brief";
		}

		// Verbose: long messages
		if (avgLength > 150) {
			return "verbose";
		}

		// Balanced: moderate length
		return "balanced";
	}
}
