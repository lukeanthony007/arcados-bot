/**
 * Response Pattern Analyzer
 *
 * Analyzes how users respond in conversations:
 * - Response latency (time to reply to other people's messages)
 * - Question answering rate
 * - Turn-taking balance
 * - Conversation initiation rate
 *
 * Each metric is only reported when the data behind it exists; nothing is defaulted.
 */

import type {
	AnalyzerResult,
	ResponsePatterns,
	MessageData,
	ConversationData,
	ResponseInteractionData,
} from "../types";

export class ResponsePatternAnalyzer {
	/**
	 * Analyze response patterns from user messages and conversations.
	 *
	 * `interactions` carries reply latencies and questions-to-the-user, which live in other
	 * people's messages and therefore cannot be derived from `messages`. Without it, the
	 * latency and question-answer metrics are omitted.
	 */
	static async analyze(
		userId: string,
		messages: MessageData[],
		conversations: ConversationData[],
		interactions?: ResponseInteractionData
	): Promise<AnalyzerResult<ResponsePatterns>> {
		try {
			if (messages.length < 5) {
				return {
					success: false,
					error: "Insufficient messages for response pattern analysis (need >= 5)",
					confidence: 0,
				};
			}

			const patterns: ResponsePatterns = {};

			const latency = this.calculateResponseLatency(interactions);
			if (latency !== undefined) patterns.avg_response_latency_minutes = latency;

			const answerRate = this.calculateQuestionAnswerRate(interactions);
			if (answerRate !== undefined) patterns.question_answer_rate = answerRate;

			const balance = this.calculateTurnTakingBalance(conversations);
			if (balance !== undefined) patterns.turn_taking_balance = balance;

			const initiation = this.calculateInitiationRate(userId, conversations);
			if (initiation !== undefined) patterns.conversation_initiation_rate = initiation;

			// Calculate confidence
			const confidence = Math.min(
				0.9,
				0.4 + (messages.length / 100) * 0.5
			);

			return {
				success: true,
				data: patterns,
				confidence,
			};
		} catch (error) {
			return {
				success: false,
				error: `Response pattern analysis failed: ${error}`,
				confidence: 0,
			};
		}
	}

	/**
	 * Median minutes between someone else's message and the user's reply to it
	 */
	private static calculateResponseLatency(
		interactions?: ResponseInteractionData
	): number | undefined {
		const times = interactions?.reply_latencies_minutes;
		if (!times || times.length === 0) return undefined;

		// Median is more robust than mean for latency
		const sorted = [...times].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		const upper = sorted[mid];
		const lower = sorted[mid - 1];
		if (upper === undefined) return undefined;
		return sorted.length % 2 === 0 && lower !== undefined
			? (lower + upper) / 2
			: upper;
	}

	/**
	 * Share of questions mentioning the user that they answered within an hour
	 */
	private static calculateQuestionAnswerRate(
		interactions?: ResponseInteractionData
	): number | undefined {
		if (!interactions || interactions.questions_received === 0) return undefined;
		return interactions.questions_answered / interactions.questions_received;
	}

	/**
	 * Turn-taking balance: how close the user's message share is to an equal share
	 * (1 = exactly 1/participants of the messages, 0 = share is at least double/zero).
	 */
	private static calculateTurnTakingBalance(
		conversations: ConversationData[]
	): number | undefined {
		const balanceScores: number[] = [];

		for (const conv of conversations) {
			const participantCount = conv.participants.length;
			if (
				participantCount < 2 ||
				conv.user_message_count === undefined ||
				conv.message_count <= 0
			) {
				continue;
			}

			const idealShare = 1 / participantCount;
			const userShare = conv.user_message_count / conv.message_count;
			balanceScores.push(1 - Math.min(1, Math.abs(userShare - idealShare) / idealShare));
		}

		if (balanceScores.length === 0) return undefined;

		return balanceScores.reduce((sum, score) => sum + score, 0) / balanceScores.length;
	}

	/**
	 * Share of the user's conversations whose first message the user sent
	 */
	private static calculateInitiationRate(
		userId: string,
		conversations: ConversationData[]
	): number | undefined {
		const known = conversations.filter(
			(conv) => conv.first_author_id !== undefined && conv.participants.includes(userId)
		);
		if (known.length === 0) return undefined;

		return known.filter((conv) => conv.first_author_id === userId).length / known.length;
	}
}
