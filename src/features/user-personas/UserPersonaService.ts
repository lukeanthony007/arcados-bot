/**
 * UserPersonaService
 *
 * Builds and manages member personas the bot can speak as.
 *
 * Build pipeline (/persona init):
 * 1. Refresh the member's social-intelligence profile:
 *    - RelationshipMapper.updateMemberRelationships → user_profiles.relationship_network
 *    - UserProfileEnrichmentPipeline.enrichUser → summary + Big Five/MBTI + behavior patterns
 *      (only runs once enough newly enriched conversations exist)
 *    - PsychologicalProfiler.profileUser → psych/behavior/temporal profile when enrichment skipped
 * 2. Gather the refreshed profile, recent messages, conversation summaries and top relationships
 * 3. Have the LLM write a character profile; keep real messages as voice examples
 * 4. Store in user_personas
 */

import { AIContextBuilder } from "../../ai/core/AIContext";
import type { AIEngine } from "../../ai/core/AIEngine";
import { AIFactory } from "../../ai/core/AIFactory";
import { AIRequestBuilder } from "../../ai/core/AIRequestBuilder";
import type {
	DatabaseResult,
	PostgreSQLManager,
	RelationshipEntry,
	UserPersonaData,
	UserProfileData,
} from "../../database/PostgreSQLManager";
import { UserProfileEnrichmentPipeline } from "../social-intelligence/enrichment-pipeline/layers/UserProfileEnrichmentPipeline";
import { PsychologicalProfiler } from "../social-intelligence/psychological-profiling/PsychologicalProfiler";
import type {
	BehaviorPatterns,
	PsychProfile,
	TemporalProfile,
} from "../social-intelligence/psychological-profiling/types";
import type { RelationshipMapper } from "../social-intelligence/relationship-mapping/RelationshipMapper";
import {
	PROFILE_WRITER_PERSONA,
	SLUR_PATTERN,
	buildProfileRequest,
} from "./personaPrompt";

const MIN_MESSAGES = 30;
const MESSAGE_FETCH_LIMIT = 600;
const DOSSIER_MESSAGE_LIMIT = 250;
const DOSSIER_MESSAGE_CHARS = 14000;
const STYLE_EXAMPLE_COUNT = 25;
const CONVERSATION_LIMIT = 15;
const RELATIONSHIP_LIMIT = 8;

export interface PersonaPipelineReport {
	relationships: number;
	enrichedProfileVersion: number | null;
	psychProfiled: boolean;
	messagesAnalyzed: number;
	conversationsAnalyzed: number;
}

export type PersonaBuildResult =
	| { success: true; persona: UserPersonaData; report: PersonaPipelineReport }
	| { success: false; error: string };

type ProgressCallback = (step: string) => Promise<void> | void;

interface MemberRow {
	user_id: string;
	username: string | null;
	display_name: string | null;
	global_name: string | null;
	nick: string | null;
	bot: boolean;
}

interface MessageRow {
	content: string;
	created_at: Date;
}

interface ConversationRow {
	summary: string | null;
	topic_label: string | null;
	participants: string[];
	start_time: Date;
}

interface NameRow {
	id: string;
	name: string;
}

export class UserPersonaService {
	private db: PostgreSQLManager;
	private relationshipMapper: RelationshipMapper;
	private enginePromise: Promise<AIEngine> | null = null;
	private building = new Set<string>();

	constructor(db: PostgreSQLManager, relationshipMapper: RelationshipMapper) {
		this.db = db;
		this.relationshipMapper = relationshipMapper;
	}

	isAvailable(): boolean {
		return this.db.isConnected();
	}

	getPersona(
		guildId: string,
		userId: string,
	): Promise<DatabaseResult<UserPersonaData | undefined>> {
		return this.db.getUserPersona(guildId, userId);
	}

	getActivePersona(
		guildId: string,
	): Promise<DatabaseResult<UserPersonaData | undefined>> {
		return this.db.getActivePersona(guildId);
	}

	activatePersona(
		guildId: string,
		userId: string,
		activatedBy: string,
	): Promise<DatabaseResult<void>> {
		return this.db.setActivePersona(guildId, userId, activatedBy);
	}

	clearActivePersona(guildId: string): Promise<DatabaseResult<boolean>> {
		return this.db.clearActivePersona(guildId);
	}

	/**
	 * Run the full profile pipeline for a member and store their persona.
	 */
	async buildPersona(
		guildId: string,
		userId: string,
		requestedBy: string,
		onProgress?: ProgressCallback,
	): Promise<PersonaBuildResult> {
		const key = `${guildId}:${userId}`;
		if (this.building.has(key)) {
			return {
				success: false,
				error: "A persona for this member is already being built.",
			};
		}
		this.building.add(key);

		try {
			const member = await this.getMember(guildId, userId);
			if (!member) {
				return {
					success: false,
					error: "That member isn't synced to the database yet.",
				};
			}
			if (member.bot) {
				return { success: false, error: "Bots can't have personas." };
			}
			const name =
				member.nick ||
				member.display_name ||
				member.global_name ||
				member.username ||
				userId;

			const names = await this.getNameMaps(guildId);
			const messages = await this.getMessages(guildId, userId, names);
			if (messages.length < MIN_MESSAGES) {
				return {
					success: false,
					error: `${name} only has ${messages.length} usable messages; at least ${MIN_MESSAGES} are needed.`,
				};
			}

			const engine = await this.getEngine();

			// 1. Refresh the social-intelligence profile
			await onProgress?.("Mapping relationships…");
			const relationshipResult =
				await this.relationshipMapper.updateMemberRelationships(
					userId,
					guildId,
				);
			if (!relationshipResult.success) {
				console.warn(
					`🔸 Persona: relationship refresh failed for ${userId}: ${relationshipResult.error}`,
				);
			}

			await onProgress?.("Analyzing personality and conversations…");
			const enrichedProfileVersion = await new UserProfileEnrichmentPipeline(
				this.db,
				engine,
			).enrichUser(userId, guildId);
			const psychProfiled =
				enrichedProfileVersion === null
					? await new PsychologicalProfiler(this.db, engine).profileUser(
							userId,
							guildId,
						)
					: false;

			// 2. Gather the refreshed profile and context
			await onProgress?.("Writing character profile…");
			const profileResult = await this.db.getUserProfile(userId, guildId);
			const profile = profileResult.success ? profileResult.data : undefined;
			const conversations = await this.getConversations(guildId, userId);

			// 3. Synthesize the character profile
			const dossier = this.buildDossier(
				name,
				member,
				profile,
				messages,
				conversations,
				names.users,
			);
			const characterProfile = await this.writeCharacterProfile(
				engine,
				guildId,
				name,
				dossier,
			);
			if (!characterProfile) {
				return {
					success: false,
					error: "The AI failed to write a character profile. Try again.",
				};
			}

			// 4. Store
			const report: PersonaPipelineReport = {
				relationships: profile?.relationship_network?.length ?? 0,
				enrichedProfileVersion,
				psychProfiled,
				messagesAnalyzed: Math.min(messages.length, DOSSIER_MESSAGE_LIMIT),
				conversationsAnalyzed: conversations.length,
			};
			const stored = await this.db.upsertUserPersona({
				guild_id: guildId,
				user_id: userId,
				display_name: name,
				character_profile: characterProfile,
				style_examples: this.pickStyleExamples(messages),
				source_stats: { ...report, built_at: new Date().toISOString() },
				created_by: requestedBy,
			});
			if (!stored.success || !stored.data) {
				return {
					success: false,
					error: stored.error || "Failed to save persona.",
				};
			}

			return { success: true, persona: stored.data, report };
		} catch (error) {
			console.error("🔸 Persona build failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		} finally {
			this.building.delete(key);
		}
	}

	private getEngine(): Promise<AIEngine> {
		if (!this.enginePromise) {
			this.enginePromise = AIFactory.create().then(({ engine }) => engine);
		}
		return this.enginePromise;
	}

	private async getMember(
		guildId: string,
		userId: string,
	): Promise<MemberRow | undefined> {
		const result = await this.db.query(
			`SELECT user_id, username, display_name, global_name, nick, bot
			FROM members WHERE guild_id = $1 AND user_id = $2`,
			[guildId, userId],
		);
		const rows: MemberRow[] = result.success && result.data ? result.data : [];
		return rows[0];
	}

	/**
	 * Display names for resolving <@id> / <#id> tokens in message text
	 */
	private async getNameMaps(
		guildId: string,
	): Promise<{ users: Map<string, string>; channels: Map<string, string> }> {
		const [usersResult, channelsResult] = await Promise.all([
			this.db.query(
				`SELECT user_id AS id, COALESCE(nick, display_name, global_name, username) AS name
				FROM members WHERE guild_id = $1`,
				[guildId],
			),
			this.db.query("SELECT id, name FROM channels WHERE guild_id = $1", [
				guildId,
			]),
		]);
		const userRows: NameRow[] =
			usersResult.success && usersResult.data ? usersResult.data : [];
		const channelRows: NameRow[] =
			channelsResult.success && channelsResult.data ? channelsResult.data : [];
		return {
			users: new Map(userRows.map((row) => [row.id, row.name])),
			channels: new Map(channelRows.map((row) => [row.id, row.name])),
		};
	}

	/**
	 * Recent messages with mentions resolved, oldest first; bot commands and bare links removed
	 */
	private async getMessages(
		guildId: string,
		userId: string,
		names: { users: Map<string, string>; channels: Map<string, string> },
	): Promise<string[]> {
		const result = await this.db.query(
			`SELECT content, created_at FROM messages
			WHERE guild_id = $1 AND author_id = $2 AND active = true AND length(trim(content)) > 0
			ORDER BY created_at DESC LIMIT $3`,
			[guildId, userId, MESSAGE_FETCH_LIMIT],
		);
		const rows: MessageRow[] = result.success && result.data ? result.data : [];

		return rows
			.reverse()
			.map((row) =>
				row.content
					.replace(
						/<@!?(\d+)>/g,
						(_, id: string) => `@${names.users.get(id) ?? "someone"}`,
					)
					.replace(
						/<#(\d+)>/g,
						(_, id: string) => `#${names.channels.get(id) ?? "channel"}`,
					)
					.replace(/<a?:(\w+):\d+>/g, ":$1:")
					.trim(),
			)
			.filter(
				(content) =>
					content.length > 0 &&
					!/^(m!|[!/.$-])\w/i.test(content) &&
					!/^<?https?:\/\/\S+>?$/.test(content),
			);
	}

	private async getConversations(
		guildId: string,
		userId: string,
	): Promise<ConversationRow[]> {
		const result = await this.db.query(
			`SELECT summary, topic_label, participants, start_time FROM conversation_segments
			WHERE guild_id = $1 AND $2 = ANY(participants) AND status = 'finalized'
			AND (summary IS NOT NULL OR topic_label IS NOT NULL)
			ORDER BY start_time DESC LIMIT $3`,
			[guildId, userId, CONVERSATION_LIMIT],
		);
		return result.success && result.data ? result.data : [];
	}

	private buildDossier(
		name: string,
		member: MemberRow,
		profile: UserProfileData | undefined,
		messages: string[],
		conversations: ConversationRow[],
		userNames: Map<string, string>,
	): string {
		const sections: string[] = [];

		const aliases = [
			member.username,
			member.global_name,
			member.display_name,
			member.nick,
			...(profile?.aliases ?? []),
		].filter((alias): alias is string => Boolean(alias) && alias !== name);
		sections.push(
			`NAME: ${name}${aliases.length ? ` (also known as: ${[...new Set(aliases)].join(", ")})` : ""}`,
		);

		if (profile?.summary) {
			sections.push(`EXISTING PROFILE SUMMARY:\n${profile.summary}`);
		}
		if (profile?.keywords?.length) {
			sections.push(`KEYWORDS: ${profile.keywords.slice(0, 25).join(", ")}`);
		}
		if (profile?.notes?.length) {
			sections.push(
				`NOTES:\n${profile.notes
					.slice(0, 10)
					.map((note) => `- ${note}`)
					.join("\n")}`,
			);
		}

		const signals = this.describeSignals(profile);
		if (signals) {
			sections.push(
				`BEHAVIORAL SIGNALS (statistical, may be noisy):\n${signals}`,
			);
		}

		const relationships: RelationshipEntry[] = (
			profile?.relationship_network ?? []
		).slice(0, RELATIONSHIP_LIMIT);
		if (relationships.length) {
			sections.push(
				`TALKS TO MOST:\n${relationships
					.map((rel) => {
						const relName =
							userNames.get(rel.user_id) ??
							rel.display_name ??
							rel.username ??
							rel.user_id;
						const summary = rel.summary ? `: ${rel.summary}` : "";
						return `- ${relName} (${rel.affinity_percentage.toFixed(0)}% of interactions)${summary}`;
					})
					.join("\n")}`,
			);
		}

		if (conversations.length) {
			sections.push(
				`RECENT CONVERSATIONS:\n${conversations
					.map((conv) => {
						const others = conv.participants
							.map((id) => userNames.get(id))
							.filter(
								(other): other is string => Boolean(other) && other !== name,
							)
							.slice(0, 5);
						const topic = conv.topic_label ? `[${conv.topic_label}] ` : "";
						const withWhom = others.length
							? ` (with ${others.join(", ")})`
							: "";
						return `- ${topic}${conv.summary ?? ""}${withWhom}`;
					})
					.join("\n")}`,
			);
		}

		// Most recent messages within the character budget, kept chronological
		const sample: string[] = [];
		let budget = DOSSIER_MESSAGE_CHARS;
		for (
			let i = messages.length - 1;
			i >= 0 && sample.length < DOSSIER_MESSAGE_LIMIT;
			i--
		) {
			const line = (messages[i] ?? "").replace(/\s+/g, " ").slice(0, 300);
			budget -= line.length + 1;
			if (budget < 0) break;
			sample.push(line);
		}
		sections.push(
			`THEIR MESSAGES (oldest to newest, verbatim):\n${sample.reverse().join("\n")}`,
		);

		return sections.join("\n\n");
	}

	private describeSignals(profile: UserProfileData | undefined): string {
		if (!profile) return "";
		const psych: PsychProfile = profile.psych_profile ?? {};
		const behavior: BehaviorPatterns = profile.behavior_patterns ?? {};
		const temporal: TemporalProfile = profile.temporal_profile ?? {};
		const lines: string[] = [];

		if (psych.big_five_proxies) {
			const traits = Object.entries(psych.big_five_proxies)
				.map(([trait, value]) => `${trait} ${value.score.toFixed(2)}`)
				.join(", ");
			lines.push(`- Big Five (0-1): ${traits}`);
		}
		if (psych.mbti_type && !psych.mbti_type.type.includes("X")) {
			lines.push(`- MBTI estimate: ${psych.mbti_type.type}`);
		}
		const style = psych.communication_style;
		if (style) {
			lines.push(
				`- Formality ${style.formality.toFixed(2)} (0 casual, 1 formal), verbosity ${style.verbosity.toFixed(2)}, emoji richness ${style.emoji_richness.toFixed(2)}`,
			);
		}
		const topEmojis = Object.keys(behavior.emoji_signature?.top_emojis ?? {});
		if (topEmojis.length) {
			lines.push(`- Top emojis: ${topEmojis.slice(0, 8).join(" ")}`);
		}
		const rhythm = temporal.circadian_rhythm;
		if (rhythm?.timezone_estimate) {
			lines.push(`- Likely timezone: ${rhythm.timezone_estimate}`);
		}

		return lines.join("\n");
	}

	private async writeCharacterProfile(
		engine: AIEngine,
		guildId: string,
		name: string,
		dossier: string,
	): Promise<string | null> {
		const context = new AIContextBuilder()
			.user("system-persona-builder")
			.guild(guildId)
			.build();
		const result = await new AIRequestBuilder(engine)
			.blocking()
			.mode("structured")
			.withContext(context)
			.provider("grok")
			.customPersona(PROFILE_WRITER_PERSONA)
			.withoutTools()
			.noWebSearch()
			.maxTokens(1500)
			.generate(buildProfileRequest(name, dossier));

		if (
			typeof result === "object" &&
			"success" in result &&
			result.success &&
			result.content
		) {
			return result.content.trim();
		}
		console.error(
			"🔸 Persona: profile generation failed:",
			"error" in result ? result.error : result,
		);
		return null;
	}

	/**
	 * Evenly spaced real messages of conversational length, used as few-shot voice samples.
	 * Link shares and bare mentions say little about voice, so they're skipped.
	 */
	private pickStyleExamples(messages: string[]): string[] {
		const candidates = [
			...new Set(
				messages
					.map((content) => content.replace(/\s+/g, " "))
					.filter(
						(content) =>
							content.length >= 12 &&
							content.length <= 220 &&
							!/https?:\/\//.test(content) &&
							!SLUR_PATTERN.test(content) &&
							content
								.split(" ")
								.filter((word) => !word.startsWith("@") && /\p{L}/u.test(word))
								.length >= 3,
					),
			),
		];
		if (candidates.length <= STYLE_EXAMPLE_COUNT) return candidates;

		const step = candidates.length / STYLE_EXAMPLE_COUNT;
		return Array.from(
			{ length: STYLE_EXAMPLE_COUNT },
			(_, i) => candidates[Math.floor(i * step)] ?? "",
		).filter(Boolean);
	}
}
