/**
 * UserPersonaService
 *
 * Builds and manages member personas the bot can speak as.
 *
 * Build pipeline (/persona init):
 * 1. Get the member's dossier (understanding/memberDossier.ts):
 *    - closeness and facts are computed on demand from messages
 *    - the dossier is reused unless missing or stale, then rewritten whole in one pass
 * 2. Gather the refreshed profile, recent messages, conversation summaries and top relationships
 * 3. Have the LLM write a character profile; keep real messages as voice examples
 * 4. Store in user_personas
 */

import { OmpRuntime } from "../../ai/runtime/OmpRuntime";
import type {
	DatabaseResult,
	PostgreSQLManager,
	UserPersonaData,
	UserProfileData,
} from "../../database/PostgreSQLManager";
import {
	type Connection,
	getConnections,
} from "../social-intelligence/facts/closeness";
import { describeMemberFacts } from "../social-intelligence/facts/memberFacts";
import {
	MIN_MESSAGES,
	isMemberStale,
	writeMemberDossier,
} from "../social-intelligence/understanding/memberDossier";
import {
	BIG_FIVE_TRAITS,
	type MemberDossier,
} from "../social-intelligence/understanding/types";
import { describeConnection } from "./personaContext";
import {
	PROFILE_WRITER_PERSONA,
	SLUR_PATTERN,
	buildProfileRequest,
} from "./personaPrompt";

const MESSAGE_FETCH_LIMIT = 600;
const DOSSIER_MESSAGE_LIMIT = 250;
const DOSSIER_MESSAGE_CHARS = 14000;
const STYLE_EXAMPLE_COUNT = 25;
const CONVERSATION_LIMIT = 15;
const RELATIONSHIP_LIMIT = 8;

export interface PersonaPipelineReport {
	relationships: number;
	dossierWritten: boolean;
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
	private building = new Set<string>();

	constructor(db: PostgreSQLManager) {
		this.db = db;
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

			// 1. Reuse the member's dossier unless it's missing or stale, then rewrite it whole
			await onProgress?.("Analyzing personality and conversations…");
			let profileResult = await this.db.getUserProfile(userId, guildId);
			let dossier = profileResult.success
				? profileResult.data?.dossier
				: undefined;
			let dossierWritten = false;
			if (!dossier || (await isMemberStale(this.db, guildId, userId))) {
				dossier = (await writeMemberDossier(this.db, guildId, userId)) ?? dossier;
				dossierWritten = true;
				profileResult = await this.db.getUserProfile(userId, guildId);
			}
			if (!dossier) {
				return {
					success: false,
					error: `Not enough activity to write a dossier for ${name}.`,
				};
			}

			// 2. Gather context
			await onProgress?.("Writing character profile…");
			const profile = profileResult.success ? profileResult.data : undefined;
			const conversations = await this.getConversations(guildId, userId);
			const interactions = await getConnections(
				this.db,
				guildId,
				userId,
				RELATIONSHIP_LIMIT,
			);

			// 3. Synthesize the character profile
			const dossierText = this.buildDossier(
				name,
				member,
				dossier,
				profile,
				messages,
				conversations,
				interactions,
				names.users,
			);
			const characterProfile = await this.writeCharacterProfile(name, dossierText);
			if (!characterProfile) {
				return {
					success: false,
					error: "The AI failed to write a character profile. Try again.",
				};
			}

			// 4. Store
			const report: PersonaPipelineReport = {
				relationships: interactions.length,
				dossierWritten,
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
		dossier: MemberDossier,
		profile: UserProfileData | undefined,
		messages: string[],
		conversations: ConversationRow[],
		interactions: Connection[],
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

		const sectionText: Array<[string, string | undefined]> = [
			["IDENTITY", dossier.identity],
			["VOICE", dossier.voice],
			["INTERESTS", dossier.interests.join("; ")],
			["PEOPLE", dossier.people],
			["RECENT", dossier.recent],
			["SOCIAL POSITION", dossier.social_position],
		];
		for (const [label, text] of sectionText) {
			if (text) sections.push(`${label}:\n${text}`);
		}

		const big5 = BIG_FIVE_TRAITS.map(
			(trait) =>
				`${trait} ${dossier.personality.big_five[trait].score.toFixed(1)}`,
		).join(", ");
		const mbti = dossier.personality.mbti;
		const mbtiText =
			mbti && mbti.confidence >= 0.35 && !mbti.type.includes("X")
				? `; MBTI estimate ${mbti.type}`
				: "";
		sections.push(`PERSONALITY (0-1, relative to the server): ${big5}${mbtiText}`);
		sections.push(
			`MEASURED FACTS:\n${describeMemberFacts(dossier.facts)
				.map((line) => `- ${line}`)
				.join("\n")}`,
		);

		if (interactions.length) {
			sections.push(
				`TALKS TO MOST (from their replies, direct mentions and shared conversations; who they're actually close to):\n${interactions
					.map(
						(connection) =>
							`- ${connection.name}: ${describeConnection(connection)}`,
					)
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

	private async writeCharacterProfile(
		name: string,
		dossier: string,
	): Promise<string | null> {
		const result = await OmpRuntime.get().generate({
			systemPrompt: PROFILE_WRITER_PERSONA,
			prompt: buildProfileRequest(name, dossier),
			label: "persona.profile",
		});

		if (result.success && result.content) {
			return result.content.trim();
		}
		console.error("🔸 Persona: profile generation failed:", result.error);
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
