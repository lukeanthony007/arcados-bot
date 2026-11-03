/**
 * Server dossier: one-pass write-up of what the server is, from the closeness graph and
 * summarized conversations. Stored as JSON sections plus a rendered text in
 * `guilds.server_summary`, which chat and voice prepend to the first turn of a conversation.
 */

import {
	type JsonObjectSchema,
	OmpRuntime,
} from "../../../ai/runtime/OmpRuntime";
import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { SLUR_PATTERN } from "../../user-personas/personaPrompt";
import { type GraphSummary, summarizeGraph } from "../facts/graph";
import type { ServerDossier } from "./types";

export const STALE_AFTER_CONVERSATIONS = 20;
export const STALE_AFTER_DAYS = 7;

const MIN_CONVERSATIONS = 10;
const RECENT_CONVERSATIONS = 60;
const LARGEST_CONVERSATIONS = 20;
const LARGEST_WINDOW_DAYS = 180;
const MAX_SUMMARY_CHARS = 380;
const MAX_CHANNELS = 25;
const EVIDENCE_BUDGET = 9000;

const SLURS = new RegExp(SLUR_PATTERN.source, "gi");
const maskSlurs = (text: string): string => text.replace(SLURS, "[slur]");

/** Render budget: the whole text is prepended to the first turn of every conversation */
const RENDER_LIMITS = {
	overview: 500,
	culture: 420,
	detail: 130,
	recent: 360,
} as const;
const MAX_RENDER_TOPICS = 10;

interface ConversationRow {
	id: string;
	channel_id: string;
	participants: string[] | null;
	summary: string;
	start_time: Date;
}

interface StructuredServer {
	overview: string;
	culture: string;
	topics: Array<{ topic: string; detail: string }>;
	recent: string;
}

const SYSTEM_PROMPT = `You write private reference notes about a Discord server for the server's assistant bot. The bot reads them before chatting with members so it understands the place it lives in. They are never shown to members.

Rules:
- Be specific and concrete. Name real recurring subjects, running jokes, games, places, people (by display name), and quote short real phrases from the summaries where they carry flavour.
- Use only what the conversation summaries, graph and channel data show. If evidence for a section is thin, say so plainly in that section instead of inventing.
- No filler ("members enjoy engaging discussions"), no moralizing, no generic community-speak that would fit any server.
- Never write user IDs. Refer to people by display name only.
- Keep slurs and slurs-as-jokes out of the text; describe the register instead ("crude, insult-heavy banter").
- Topics must come from what was actually discussed in the summaries, one distinct subject each, not a keyword list.
- Be tight: the notes are length-limited, so every sentence must carry information.`;

const SCHEMA: JsonObjectSchema = {
	type: "object",
	properties: {
		overview: {
			type: "string",
			description:
				"What this server is, for a newcomer: what kind of place it is, what people do together, the general vibe, how long it has been going. 3-4 sentences of prose, at most 500 characters. Do not list member names or counts here (who's who is stored separately).",
		},
		culture: {
			type: "string",
			description:
				"Norms and humour: how people talk, running jokes, what is welcome and what falls flat. 2-3 sentences, at most 420 characters.",
		},
		topics: {
			type: "array",
			description:
				"6-10 recurring subjects actually discussed, most prominent first. Derived from the conversation summaries, not keywords.",
			items: {
				type: "object",
				properties: {
					topic: {
						type: "string",
						description: "Short name of the subject, 1-4 words",
					},
					detail: {
						type: "string",
						description:
							"One concrete line (at most 120 characters) on what is said or done about it, naming people where it helps",
					},
				},
				required: ["topic", "detail"],
			},
		},
		recent: {
			type: "string",
			description:
				"What has been happening in the last few weeks, with rough dates, judged from the most recent conversations. 2-3 sentences, at most 340 characters.",
		},
	},
	required: ["overview", "culture", "topics", "recent"],
};

function clip(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max - 1);
	const sentenceEnd = Math.max(
		cut.lastIndexOf(". "),
		cut.lastIndexOf("! "),
		cut.lastIndexOf("? "),
	);
	if (sentenceEnd > max * 0.5) return cut.slice(0, sentenceEnd + 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
}

export function renderServerDossier(d: ServerDossier): string {
	const lines: string[] = [];
	lines.push(`Overview: ${clip(d.overview, RENDER_LIMITS.overview)}`);
	lines.push(`Culture: ${clip(d.culture, RENDER_LIMITS.culture)}`);
	if (d.topics.length > 0) {
		lines.push("Topics:");
		for (const t of d.topics.slice(0, MAX_RENDER_TOPICS)) {
			lines.push(
				`- ${clip(t.topic, 40)}: ${clip(t.detail, RENDER_LIMITS.detail)}`,
			);
		}
	}
	const whos: string[] = [];
	if (d.hubs.length > 0) {
		whos.push(
			`Most connected: ${d.hubs
				.slice(0, 8)
				.map((h) => `${h.name} (${h.strength})`)
				.join(", ")}.`,
		);
	}
	d.communities.slice(0, 4).forEach((c, i) => {
		whos.push(`Group ${i + 1}: ${c.slice(0, 8).join(", ")}.`);
	});
	if (whos.length > 0) lines.push(`Who's who: ${whos.join(" ")}`);
	lines.push(`Recent: ${clip(d.recent, RENDER_LIMITS.recent)}`);
	return lines.join("\n");
}

/** Summarized conversations in the guild */
async function countSummarized(
	db: PostgreSQLManager,
	guildId: string,
): Promise<number> {
	const result = await db.query(
		"SELECT COUNT(*)::int AS n FROM conversation_segments WHERE guild_id = $1 AND summary IS NOT NULL",
		[guildId],
	);
	if (!result.success)
		throw new Error(`Conversation count failed: ${result.error}`);
	return Number(result.data?.[0]?.n ?? 0);
}

export async function isServerDossierStale(
	db: PostgreSQLManager,
	guildId: string,
): Promise<boolean> {
	const result = await db.query(
		`SELECT dossier IS NOT NULL AS has_dossier, dossier_written_at,
			COALESCE(dossier_conversation_count, 0) AS written_count
		 FROM guilds WHERE id = $1`,
		[guildId],
	);
	const row:
		| {
				has_dossier: boolean;
				dossier_written_at: Date | null;
				written_count: number;
		  }
		| undefined = result.success ? result.data?.[0] : undefined;
	if (!row?.has_dossier || !row.dossier_written_at) return true;
	const ageDays =
		(Date.now() - new Date(row.dossier_written_at).getTime()) / 86_400_000;
	if (ageDays > STALE_AFTER_DAYS) return true;
	const total = await countSummarized(db, guildId);
	return total - Number(row.written_count) >= STALE_AFTER_CONVERSATIONS;
}

function day(date: Date): string {
	return new Date(date).toISOString().slice(0, 10);
}

function describeGraph(graph: GraphSummary): string {
	const lines = [
		`${graph.members} active members, ${graph.connectedPairs} pairs who interact, ${graph.isolated} with no interactions.`,
		`Most connected members (interaction strength): ${
			graph.hubs.map((h) => `${h.name} (${h.strength})`).join(", ") || "none"
		}`,
		"Strongest pairs:",
		...graph.strongestPairs.map(
			(p) =>
				`- ${p.a.name} & ${p.b.name}: ${p.strength}, ${(p.reciprocity * 100).toFixed(0)}% reciprocal`,
		),
		"Friend groups (clusters of members who mostly interact with each other):",
		...graph.communities.map(
			(c, i) => `${i + 1}. ${c.map((m) => m.name).join(", ")}`,
		),
	];
	return lines.join("\n");
}

export async function writeServerDossier(
	db: PostgreSQLManager,
	guildId: string,
): Promise<ServerDossier | null> {
	const total = await countSummarized(db, guildId);
	if (total < MIN_CONVERSATIONS) return null;

	const [
		recentResult,
		largestResult,
		channelsResult,
		namesResult,
		activityResult,
	] = await Promise.all([
		db.query(
			`SELECT id, channel_id, participants, summary, start_time
				 FROM conversation_segments
				 WHERE guild_id = $1 AND summary IS NOT NULL
				 ORDER BY start_time DESC LIMIT $2`,
			[guildId, RECENT_CONVERSATIONS],
		),
		db.query(
			`SELECT id, channel_id, participants, summary, start_time
				 FROM conversation_segments
				 WHERE guild_id = $1 AND summary IS NOT NULL
				   AND start_time > NOW() - make_interval(days => $3)
				 ORDER BY COALESCE(array_length(participants, 1), 0) DESC, message_count DESC
				 LIMIT $2`,
			[guildId, LARGEST_CONVERSATIONS, LARGEST_WINDOW_DAYS],
		),
		db.query(
			`SELECT c.name, COUNT(*)::int AS n
				 FROM messages m JOIN channels c ON c.id = m.channel_id
				 WHERE m.guild_id = $1 AND m.created_at > NOW() - INTERVAL '30 days'
				   AND c.name !~* '(^|[^a-z])(log|logs)([^a-z]|$)'
				 GROUP BY c.name ORDER BY n DESC LIMIT $2`,
			[guildId, MAX_CHANNELS],
		),
		db.query(
			`SELECT user_id, COALESCE(nick, display_name, global_name, username) AS name
				 FROM members WHERE guild_id = $1`,
			[guildId],
		),
		db.query(
			`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS messages,
				MIN(created_at) AS since
				 FROM messages
				 WHERE guild_id = $1`,
			[guildId],
		),
	]);
	for (const r of [
		recentResult,
		largestResult,
		channelsResult,
		namesResult,
		activityResult,
	]) {
		if (!r.success) throw new Error(`Server dossier query failed: ${r.error}`);
	}

	const graph = await summarizeGraph(db, guildId);

	const recent: ConversationRow[] = recentResult.data ?? [];
	const largest: ConversationRow[] = largestResult.data ?? [];
	const channelRows: Array<{ id?: string; name: string; n: number }> =
		channelsResult.data ?? [];
	const names = new Map<string, string>(
		(namesResult.data as Array<{ user_id: string; name: string | null }>).map(
			(m) => [m.user_id, m.name ?? m.user_id],
		),
	);

	// Channel names for conversation rows
	const channelIds = [
		...new Set([...recent, ...largest].map((c) => c.channel_id)),
	];
	const channelNames = new Map<string, string>();
	if (channelIds.length > 0) {
		const r = await db.query(
			"SELECT id, name FROM channels WHERE id = ANY($1)",
			[channelIds],
		);
		if (!r.success) throw new Error(`Channel lookup failed: ${r.error}`);
		for (const row of (r.data ?? []) as Array<{ id: string; name: string }>) {
			channelNames.set(row.id, row.name);
		}
	}

	const formatConversation = (c: ConversationRow): string => {
		const who = (c.participants ?? [])
			.map((id) => names.get(id) ?? "someone")
			.slice(0, 8);
		return `${day(c.start_time)} #${channelNames.get(c.channel_id) ?? "unknown"} [${who.join(", ")}]: ${maskSlurs(clip(c.summary, MAX_SUMMARY_CHARS))}`;
	};

	// Evidence blocks, trimmed to budget: recent first (kept whole-ish), largest fill the rest
	const recentIds = new Set(recent.map((c) => c.id));
	const recentLines = recent.map(formatConversation);
	const largestLines = largest
		.filter((c) => !recentIds.has(c.id))
		.map(formatConversation);
	const takeWithin = (lines: string[], budget: number): string[] => {
		const out: string[] = [];
		let used = 0;
		for (const line of lines) {
			if (used + line.length > budget) break;
			out.push(line);
			used += line.length + 1;
		}
		return out;
	};
	const recentBlock = takeWithin(recentLines, EVIDENCE_BUDGET * 0.6);
	const largestBlock = takeWithin(largestLines, EVIDENCE_BUDGET * 0.4);

	const messages30d = Number(activityResult.data?.[0]?.messages ?? 0);
	const since = activityResult.data?.[0]?.since ? day(activityResult.data[0].since) : "unknown";
	const prompt = [
		`Write the server notes. Active since ${since}. Members: ${graph.members} active. Messages in the last 30 days: ${messages30d}. Summarized conversations on record: ${total}. Today: ${day(new Date())}.`,
		"",
		"Social graph (from real replies, mentions and shared conversations):",
		describeGraph(graph),
		"",
		"Channels by messages in the last 30 days:",
		channelRows.map((c) => `#${c.name} (${c.n})`).join(", ") || "none",
		"",
		`The ${recentBlock.length} most recent conversations (newest first; date #channel [participants]: summary):`,
		recentBlock.join("\n"),
		"",
		`Largest conversations by participants in the last ${LARGEST_WINDOW_DAYS} days:`,
		largestBlock.join("\n") || "(none beyond those above)",
	].join("\n");

	const generated = await OmpRuntime.get().generateStructured<StructuredServer>(
		{
			systemPrompt: SYSTEM_PROMPT,
			prompt,
			schema: SCHEMA,
			label: "understanding.server",
		},
	);
	if (!generated)
		throw new Error("Server dossier generation returned no result");

	const topics = (Array.isArray(generated.topics) ? generated.topics : [])
		.filter(
			(t) => t && typeof t.topic === "string" && typeof t.detail === "string",
		)
		.slice(0, MAX_RENDER_TOPICS)
		.map((t) => ({
			topic: maskSlurs(t.topic.trim()),
			detail: maskSlurs(t.detail.trim()),
		}));

	const dossier: ServerDossier = {
		overview: maskSlurs(String(generated.overview ?? "").trim()),
		culture: maskSlurs(String(generated.culture ?? "").trim()),
		topics,
		hubs: graph.hubs.map((h) => ({ name: h.name, strength: h.strength })),
		communities: graph.communities.map((c) => c.map((m) => m.name)),
		recent: maskSlurs(String(generated.recent ?? "").trim()),
		evidence: { conversations: total, members: graph.members },
		written_at: new Date().toISOString(),
	};
	if (!dossier.overview)
		throw new Error("Server dossier generation returned an empty overview");

	const rendered = renderServerDossier(dossier);
	const update = await db.query(
		`UPDATE guilds
		 SET server_summary = $1, dossier = $2, dossier_written_at = NOW(), dossier_conversation_count = $3
		 WHERE id = $4`,
		[rendered, JSON.stringify(dossier), total, guildId],
	);
	if (!update.success)
		throw new Error(`Failed to store server dossier: ${update.error}`);
	return dossier;
}
