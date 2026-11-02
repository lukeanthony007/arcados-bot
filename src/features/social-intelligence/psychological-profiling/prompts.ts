/**
 * AI Prompts for Psychological Profiling
 *
 * Prompts used by BigFiveEstimator and MBTIEstimator to generate personality trait estimates.
 */

import type { MBTIType, UserAnalysisData } from "./types";

export const BIG_FIVE_ANALYSIS_PROMPT = `Analyze this Discord user's personality traits based on their communication patterns.

You will receive statistical metrics about their communication style, along with recent message samples. Use this data to estimate their Big Five personality traits.

**IMPORTANT**: Provide scores as decimals between 0 and 1 (e.g., 0.7, not 70). Format your response as valid JSON.

**Big Five Traits:**

1. **Extraversion** (sociability, activity level, positive emotions, enthusiasm)
   - High (0.7-1.0): Very social, talkative, seeks interaction frequently
   - Medium (0.4-0.6): Balanced social engagement
   - Low (0.0-0.3): Reserved, prefers solo activity, infrequent interaction

2. **Agreeableness** (cooperation, empathy, conflict avoidance, kindness)
   - High (0.7-1.0): Cooperative, supportive, avoids conflict, positive sentiment
   - Medium (0.4-0.6): Balanced cooperation and independence
   - Low (0.0-0.3): Direct, argumentative, challenges others

3. **Conscientiousness** (organization, consistency, reliability, planning)
   - High (0.7-1.0): Consistent timing, follows through, organized thought
   - Medium (0.4-0.6): Somewhat consistent patterns
   - Low (0.0-0.3): Erratic activity, irregular patterns, spontaneous

4. **Neuroticism** (emotional stability, volatility, stress response, anxiety)
   - High (0.7-1.0): Volatile sentiment, emotional language, anxiety indicators
   - Medium (0.4-0.6): Moderate emotional expression
   - Low (0.0-0.3): Stable sentiment, calm language, consistent mood

5. **Openness** (curiosity, creativity, topic diversity, intellectual engagement)
   - High (0.7-1.0): Diverse topics, creative expression, intellectual curiosity
   - Medium (0.4-0.6): Some topic variety
   - Low (0.0-0.3): Narrow topics, conventional expression

**Analysis Guidelines:**

- **Confidence Levels**: Base confidence on data quality
  - 0.8-0.9: 100+ messages, diverse contexts
  - 0.6-0.7: 50-99 messages
  - 0.4-0.5: 20-49 messages
  - <0.4: <20 messages (insufficient data)

- **Indicators**: Provide 2-3 concrete behavioral indicators for each trait
  - Use observable patterns (e.g., "high_message_rate", "many_questions")
  - Avoid psychological jargon or clinical language
  - Be specific to the data provided

**Response Format (JSON only, no markdown):**

{
  "extraversion": {
    "score": 0.7,
    "confidence": 0.6,
    "indicators": ["high_message_rate", "many_mentions", "frequent_emoji_use"]
  },
  "agreeableness": {
    "score": 0.5,
    "confidence": 0.7,
    "indicators": ["neutral_sentiment", "balanced_interactions", "some_disagreements"]
  },
  "conscientiousness": {
    "score": 0.6,
    "confidence": 0.5,
    "indicators": ["consistent_timing", "regular_activity", "completes_conversations"]
  },
  "neuroticism": {
    "score": 0.3,
    "confidence": 0.6,
    "indicators": ["stable_sentiment", "calm_language", "low_emotional_volatility"]
  },
  "openness": {
    "score": 0.8,
    "confidence": 0.7,
    "indicators": ["diverse_topics", "creative_emoji", "asks_questions"]
  }
}`;

export function buildBigFivePrompt(data: {
	messageCount: number;
	communicationStyle: string;
	emojiUsage: string;
	responsePatterns: string;
	topKeywords: string[];
	topRelationships: string[];
	messageSamples: string[];
}): string {
	return `${BIG_FIVE_ANALYSIS_PROMPT}

---

**USER DATA:**

**Total Messages:** ${data.messageCount}

**Communication Style:**
${data.communicationStyle}

**Emoji Usage:**
${data.emojiUsage}

**Response Patterns:**
${data.responsePatterns}

**Topic Interests (Top Keywords):**
${data.topKeywords.slice(0, 10).join(", ") || "No keywords available"}

**Top Relationships:**
${data.topRelationships.slice(0, 5).join(", ") || "No relationships available"}

**Recent Message Samples (up to 15):**
${data.messageSamples.slice(0, 15).join("\n") || "No messages available"}

---

Analyze the above data and provide Big Five trait estimates in valid JSON format (no markdown).`;
}

// ============================================================================
// MBTI Validation Prompt
// ============================================================================

export const MBTI_VALIDATION_PROMPT = `Validate this user's MBTI type estimate based on their Discord communication patterns.

**MBTI DICHOTOMIES:**

1. **E/I (Extraversion/Introversion)**: Energy direction
   - E (Extraversion): Outgoing, frequent interaction, group-oriented, energized by social engagement
   - I (Introversion): Reflective, selective interaction, one-on-one oriented, energized by alone time

2. **S/N (Sensing/Intuition)**: Information processing
   - S (Sensing): Concrete, practical, detail-focused, factual, present-oriented
   - N (Intuition): Abstract, conceptual, big-picture, theoretical, future-oriented

3. **T/F (Thinking/Feeling)**: Decision-making
   - T (Thinking): Logical, objective, analytical, critique-oriented, task-focused
   - F (Feeling): Empathetic, subjective, values-oriented, harmony-seeking, people-focused

4. **J/P (Judging/Perceiving)**: Lifestyle approach
   - J (Judging): Structured, planned, decisive, closure-seeking, organized
   - P (Perceiving): Flexible, spontaneous, exploratory, open-ended, adaptable

**IMPORTANT**: Provide scores as decimals between -1.0 and 1.0 (e.g., -0.6 for I, 0.7 for N). Format your response as valid JSON.

**Score interpretation (always pick the leaning letter; use confidence to express how weak the lean is):**
- Positive score (>= 0.1): E, N, F or P
- Negative score (<= -0.1): I, S, T or J
- Score between -0.1 and 0.1: no lean at all (X)

**Response Format (JSON only, no markdown):**

{
  "E_I": {
    "score": -0.6,
    "preference": "I",
    "confidence": 0.75,
    "indicators": ["thoughtful_responses", "selective_interaction", "low_message_rate"]
  },
  "S_N": {
    "score": 0.7,
    "preference": "N",
    "confidence": 0.70,
    "indicators": ["abstract_topics", "conceptual_language", "asks_questions"]
  },
  "T_F": {
    "score": -0.5,
    "preference": "T",
    "confidence": 0.65,
    "indicators": ["analytical_tone", "logic_focus", "objective_language"]
  },
  "J_P": {
    "score": -0.4,
    "preference": "J",
    "confidence": 0.68,
    "indicators": ["structured_messages", "consistent_timing", "organized_thought"]
  }
}`;

export function buildMBTIValidationPrompt(
	mbtiType: MBTIType,
	data: UserAnalysisData
): string {
	// Callers load messages newest-first; order chronologically so "last 15" and the
	// activity span are correct regardless of input order
	const chronological = [...data.messages].sort(
		(a, b) => a.created_at.getTime() - b.created_at.getTime()
	);
	const messageSamples = chronological
		.slice(-15)
		.map((m) => {
			const content = m.content.trim().substring(0, 200);
			return content || "(empty message)";
		});

	// Calculate basic metrics
	const messageCount = data.messages.length;
	const avgMessageLength =
		data.messages.reduce((sum, m) => sum + m.content.length, 0) / messageCount;
	const firstMessage = chronological[0];
	const lastMessage = chronological[chronological.length - 1];
	const totalDuration =
		firstMessage && lastMessage && chronological.length > 1
			? lastMessage.created_at.getTime() - firstMessage.created_at.getTime()
			: 0;
	const daysActive = totalDuration / (1000 * 60 * 60 * 24);
	const messagesPerDay = daysActive > 0 ? messageCount / daysActive : 0;

	return `${MBTI_VALIDATION_PROMPT}

---

**CURRENT ESTIMATE:** ${mbtiType.type} (confidence: ${(mbtiType.confidence * 100).toFixed(0)}%)

**BEHAVIORAL DATA:**

**Total Messages:** ${messageCount}
**Average Message Length:** ${avgMessageLength.toFixed(0)} characters
**Messages Per Day:** ${messagesPerDay.toFixed(1)}
**Active Days:** ${daysActive.toFixed(0)}
**Conversations Participated:** ${data.conversations.length}
**Top Keywords:** ${data.keywords?.slice(0, 10).join(", ") || "No keywords available"}

**MESSAGE SAMPLES (up to 15):**
${messageSamples.slice(0, 15).join("\n") || "No messages available"}

---

Analyze the above data and validate the MBTI type estimate. Provide scores for each dichotomy in valid JSON format (no markdown).`;
}
