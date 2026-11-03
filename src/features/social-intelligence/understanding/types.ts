/**
 * Dossiers: what the system understands about a member, a pair, and the server.
 *
 * Each is written in one pass by the model from facts + conversation summaries + real
 * messages, stored as JSON sections (so tools can quote a specific part) plus a rendered
 * text, and regenerated whole when stale. Nothing is appended to.
 */

import type { AttentionEdge, AttentionProfile } from "../facts/attention";
import type { PairFacts } from "../facts/closeness";
import type { MemberFacts } from "../facts/memberFacts";

export const BIG_FIVE_TRAITS = [
	"openness",
	"conscientiousness",
	"extraversion",
	"agreeableness",
	"neuroticism",
] as const;
export type BigFiveTrait = (typeof BIG_FIVE_TRAITS)[number];

export interface TraitEstimate {
	/** 0-1, the model's read of this member on this trait */
	score: number;
	/** 0-1, how much evidence supports it */
	confidence: number;
	/** One sentence citing what in the messages supports the score */
	evidence: string;
}

export interface MbtiEstimate {
	/** Four letters; `X` in any position the server-relative evidence doesn't separate */
	type: string;
	confidence: number;
	/** Standard scores of each trait against the server's other dossiers, used for the letters */
	z_scores: Record<BigFiveTrait, number>;
}

export interface MemberDossier {
	/** Who they are in this community, 2-4 sentences */
	identity: string;
	/** How they write and talk, with concrete tics quoted */
	voice: string;
	/** Specific things they care about, each a short phrase */
	interests: string[];
	/** Who they're close to and how, grounded in the connection facts */
	people: string;
	/** What they've been up to lately, with rough dates */
	recent: string;
	/**
	 * Where their attention goes and comes from, who they pursue and who pursues them, how often
	 * their bids land, their part in groups, warmth given and received
	 */
	social_position: string;
	personality: {
		big_five: Record<BigFiveTrait, TraitEstimate>;
		/** Derived from big_five relative to the server; null until enough dossiers exist */
		mbti: MbtiEstimate | null;
	};
	/** Snapshot of the measurements the write-up was based on */
	facts: MemberFacts;
	evidence: {
		messages: number;
		conversations: number;
		sampled_messages: number;
		/** Summarized conversations where they drove, responded, or were ignored */
		roles: { driver: number; responder: number; ignored: number };
		/** Measured attention profile the social_position section was written from */
		attention: AttentionProfile | null;
	};
	written_at: string;
}

export interface PairDossier {
	/** How the two relate: what they do together, who drives it, 2-4 sentences */
	dynamic: string;
	/** Notable shared history, dated where possible */
	history: string;
	/** The tone between them (teasing, supportive, prickly...), with evidence */
	tone: string;
	facts: PairFacts;
	evidence: {
		shared_conversations: number;
		sampled_messages: number;
		/** Tone counts from the summarizer's directed exchanges, per direction (a = lower id) */
		exchanges: {
			a_to_b: Record<string, number>;
			b_to_a: Record<string, number>;
		};
		/** Measured attention between the two (null when they share no episodes) */
		attention: AttentionEdge | null;
	};
	written_at: string;
}

export interface ServerDossier {
	/** What this server is, 3-5 sentences, for a newcomer */
	overview: string;
	/** Norms, humour, what's welcome and what isn't */
	culture: string;
	/** Recurring subjects, each with a short detail line */
	topics: Array<{ topic: string; detail: string }>;
	/**
	 * Who attention gathers around, tight circles and who reaches out without much return,
	 * from the measured attention network
	 */
	structure: {
		ranking: Array<{ name: string; standing: number }>;
		cliques: string[][];
		periphery: string[];
	};
	/** What has been happening in the last few weeks */
	recent: string;
	evidence: {
		conversations: number;
		members: number;
	};
	written_at: string;
}
