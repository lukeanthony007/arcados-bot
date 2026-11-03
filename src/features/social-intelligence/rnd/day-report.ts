#!/usr/bin/env bun
/**
 * R&D harness: run the current grouping rule and the current summarizer on one day of one
 * channel, writing NOTHING to the database, and produce a Markdown report to read against
 * the transcript:
 *
 *   for each conversation   transcript · summary · topic · dynamics (note, roles, exchanges)
 *   for the day             who addressed whom (rule turns + model exchanges with tones),
 *                           roles per person, loose messages
 *
 *   bun run rnd:day 2025-10-15                # busiest channel, grouping only (free)
 *   bun run rnd:day 2025-10-15 chat --model   # also run the summarizer (~$0.0005 / conversation)
 *
 * Reports go to rnd/out/<date>-<channel>[-model].md (gitignored). Change a rule or a prompt,
 * re-run, diff.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "../../../config/index.js";
import { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { SLUR_PATTERN } from "../../user-personas/personaPrompt";
import { inferTurns } from "../conversations/addressing";
import {
	type ConversationDynamics,
	toStoredDynamics,
} from "../conversations/dynamics";
import {
	type Segment,
	type SegmentMessage,
	segment,
} from "../conversations/segmenter";
import {
	type StorylineEpisode,
	buildStorylines,
} from "../conversations/storylines";
import {
	ConversationEnrichmentPipeline,
	type GeneratedSummary,
} from "../enrichment-pipeline/layers/ConversationEnrichmentPipeline";
import { FACTS_TIME_ZONE } from "../facts/memberFacts";

interface Row {
	id: string;
	author_id: string;
	created_at: Date;
	referenced_message_id: string | null;
	content: string;
	attachments: string[] | null;
	embeds: string[] | null;
	name: string;
}

const SLURS = new RegExp(SLUR_PATTERN.source, "gi");

async function main() {
	const [day, channelArg, ...flags] = process.argv.slice(2);
	if (!day) throw new Error("Usage: rnd:day <YYYY-MM-DD> [channel] [--model]");
	const useModel = flags.includes("--model") || flags.includes("--reuse");
	const guildId = config.guildId;
	if (!guildId) throw new Error("GUILD_ID is not configured");
	const db = new PostgreSQLManager();
	if (!(await db.connect())) throw new Error("Failed to connect to database");

	const channel = (
		await db.query(
			`SELECT m.channel_id, c.name, COUNT(*)::int AS n
			 FROM messages m JOIN channels c ON c.id = m.channel_id
			 JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
			 WHERE m.guild_id = $1 AND (m.created_at AT TIME ZONE $2)::date = $3::date
			   AND ($4::text IS NULL OR c.name = $4)
			 GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`,
			[guildId, FACTS_TIME_ZONE, day, channelArg ?? null],
		)
	).data?.[0] as { channel_id: string; name: string } | undefined;
	if (!channel) throw new Error("No messages that day");

	const rows = (
		await db.query(
			`SELECT m.id, m.author_id, m.created_at, m.referenced_message_id, m.content, m.attachments, m.embeds,
				COALESCE(x.nick, x.display_name, x.username) AS name
			 FROM messages m JOIN members x ON x.guild_id = m.guild_id AND x.user_id = m.author_id AND x.bot = false
			 WHERE m.guild_id = $1 AND m.channel_id = $2 AND m.active
			   AND m.created_at >= ($3::date::timestamp AT TIME ZONE $4) - INTERVAL '6 hours'
			   AND m.created_at < ($3::date::timestamp AT TIME ZONE $4) + INTERVAL '30 hours'
			   AND m.content !~* '^\\s*(m!|!|\\$|/)[a-z]'
			 ORDER BY m.created_at, m.id`,
			[guildId, channel.channel_id, day, FACTS_TIME_ZONE],
		)
	).data as Row[];
	const byId = new Map(rows.map((r) => [r.id, r]));
	const names = new Map(rows.map((r) => [r.author_id, r.name]));
	const idByName = new Map(rows.map((r) => [r.name, r.author_id]));
	const authors = new Set(rows.map((r) => r.author_id));
	const messages: SegmentMessage[] = rows.map((r) => {
		const mentioned = [...r.content.matchAll(/<@!?(\d+)>/g)].map(
			(m) => m[1] as string,
		);
		return {
			id: r.id,
			author_id: r.author_id,
			created_at: new Date(r.created_at),
			referenced_message_id: r.referenced_message_id,
			mentions:
				mentioned.length > 3
					? []
					: [...new Set(mentioned)].filter(
							(id) => id !== r.author_id && authors.has(id),
						),
		};
	});
	const clock = (d: Date) =>
		d.toLocaleTimeString("en-GB", {
			timeZone: FACTS_TIME_ZONE,
			hour: "2-digit",
			minute: "2-digit",
		});
	const inDay = (d: Date) =>
		d.toLocaleDateString("en-CA", { timeZone: FACTS_TIME_ZONE }) === day;
	const nameOf = (id: string) => names.get(id) ?? id;
	const clean = (text: string) =>
		text
			.replace(/\s+/g, " ")
			.replace(/<@!?(\d+)>/g, (_, id: string) => `@${nameOf(id)}`)
			.replace(SLURS, "[slur]")
			.trim();

	const conversations = segment(channel.channel_id, messages).filter(
		(s) => inDay(s.start) || inDay(s.end),
	);
	const dayMessages = messages.filter((m) => inDay(m.created_at));
	const covered = new Set(
		conversations.flatMap((s) => s.messages.map((m) => m.id)),
	);
	const pipeline = new ConversationEnrichmentPipeline(db);

	const out: string[] = [
		`# #${channel.name} on ${day}`,
		"",
		`${dayMessages.length} messages · ${conversations.length} conversations in ${new Set(conversations.map((s) => s.session_id)).size} sessions · ${dayMessages.filter((m) => !covered.has(m.id)).length} loose${useModel ? " · summarizer run" : ""}`,
		"",
	];
	const turnTotals = new Map<string, number>();
	const modelExchanges: Array<{
		conv: Segment;
		from: string;
		to: string;
		tone: string;
		note: string;
	}> = [];
	const roleCounts = new Map<
		string,
		{ driver: number; responder: number; ignored: number }
	>();
	const role = (id: string) =>
		roleCounts.get(id) ??
		roleCounts.set(id, { driver: 0, responder: 0, ignored: 0 }).get(id)!;

	let session = "";
	let episodeNumber = 0;
	let sessionNumber = 0;
	const storylineInput: StorylineEpisode[] = [];
	// Summaries from a previous run, so iterating on later steps doesn't re-run the summarizer
	const cacheFile = `rnd/out/${day}-${channel.name.replace(/[^\w-]+/g, "_")}.describe.json`;
	const cache = new Map<string, GeneratedSummary>(
		flags.includes("--reuse") && existsSync(cacheFile)
			? Object.entries(
					JSON.parse(readFileSync(cacheFile, "utf8")) as Record<
						string,
						GeneratedSummary
					>,
				)
			: [],
	);
	mkdirSync("rnd/out", { recursive: true });
	for (const conv of conversations) {
		episodeNumber++;
		if (conv.session_id !== session) {
			session = conv.session_id;
			sessionNumber++;
			out.push(`## Session ${clock(conv.start)}`, "");
		}
		out.push(
			`### E${episodeNumber} · ${clock(conv.start)}–${clock(conv.end)} · ${conv.messages.length} messages · ${conv.participants.map(nameOf).join(", ")}`,
			"",
		);
		for (const m of conv.messages) {
			const row = byId.get(m.id) as Row;
			const reply = m.referenced_message_id
				? ` ↩${nameOf(byId.get(m.referenced_message_id)?.author_id ?? "")}`
				: "";
			const media =
				row.attachments?.length || row.embeds?.length ? " [media]" : "";
			out.push(
				`    ${clock(m.created_at)} ${row.name}${reply}: ${clean(row.content)}${media}`,
			);
		}
		out.push("");

		const turns = inferTurns(conv.messages);
		for (const t of turns)
			turnTotals.set(
				`${t.from}>${t.to}`,
				(turnTotals.get(`${t.from}>${t.to}`) ?? 0) + t.turns,
			);
		out.push(
			`**Inferred turns:** ${turns.map((t) => `${nameOf(t.from)}→${nameOf(t.to)} ${t.turns}`).join(", ") || "none"}`,
			"",
		);

		if (useModel) {
			const previews = conv.messages.map((m) => {
				const row = byId.get(m.id) as Row;
				return {
					author_id: m.author_id,
					content: row.content,
					attachments: row.attachments,
					embeds: row.embeds,
				};
			});
			const cacheKey = `${conv.id}:${conv.messages.length}`;
			const generated =
				cache.get(cacheKey) ??
				(await pipeline.describe(previews, names, conv.participants.length));
			if (generated) cache.set(cacheKey, generated);
			if (!generated) {
				out.push("**Summarizer:** failed", "");
				continue;
			}
			const d: ConversationDynamics = toStoredDynamics(
				generated.dynamics,
				idByName,
			);
			out.push(
				`**Topic:** ${generated.topicLabel}`,
				"",
				`**Summary:** ${clean(generated.summary)}`,
				"",
				`**Dynamics:** ${clean(d.note)}`,
				"",
				`**Bits:** ${d.bits.map(clean).join(" · ") || "none"}`,
				"",
			);
			storylineInput.push({
				index: episodeNumber,
				session: sessionNumber,
				start: conv.start,
				end: conv.end,
				participants: conv.participants.map(nameOf),
				topic: generated.topicLabel,
				summary: clean(generated.summary),
				dynamics: clean(d.note),
				exchanges: d.exchanges.map(
					(x) =>
						`${nameOf(x.from)} → ${nameOf(x.to)} [${x.tone}]: ${clean(x.note)}`,
				),
				bits: d.bits.map(clean),
			});
			out.push(
				`- drivers: ${d.roles.drivers.map(nameOf).join(", ") || "—"} · responders: ${d.roles.responders.map(nameOf).join(", ") || "—"} · ignored: ${d.roles.ignored.map(nameOf).join(", ") || "—"}`,
			);
			for (const x of d.exchanges) {
				out.push(
					`- ${nameOf(x.from)} → ${nameOf(x.to)} [${x.tone}]: ${clean(x.note)}`,
				);
				modelExchanges.push({
					conv,
					from: x.from,
					to: x.to,
					tone: x.tone,
					note: x.note,
				});
			}
			for (const id of d.roles.drivers) role(id).driver++;
			for (const id of d.roles.responders) role(id).responder++;
			for (const id of d.roles.ignored) role(id).ignored++;
			out.push("");
		}
	}

	if (useModel && storylineInput.length >= 2) {
		out.push("## Storylines", "");
		const built = await buildStorylines(
			storylineInput,
			idByName,
			FACTS_TIME_ZONE,
		);
		if (!built) out.push("Storyline linker failed.", "");
		else if (!built.storylines.length)
			out.push("None: every conversation stood alone.", "");
		if (built?.continuations.length) {
			out.push(
				`Continuations across episode cuts (likely one conversation): ${built.continuations
					.sort((a, b) => a.from - b.from)
					.map((c) => `E${c.to}+E${c.from} ${Math.round(c.agreement * 100)}%`)
					.join(", ")}`,
				"",
			);
		}
		if (built?.links.length) {
			out.push(
				`Agreed pairs: ${built.links.length}; weakest: ${built.links
					.sort((a, b) => a.from - b.from)
					.filter((l) => l.agreement < 1)
					.map(
						(l) =>
							`E${l.to}+E${l.from} ${l.kind} ${Math.round(l.agreement * 100)}%`,
					)
					.join(", ")}`,
				"",
			);
		}
		for (const s of built?.storylines ?? []) {
			const spans = s.episodes
				.map((i) => storylineInput.find((e) => e.index === i))
				.filter((e): e is StorylineEpisode => !!e)
				.map((e) => `E${e.index} ${clock(e.start)}`);
			out.push(
				`### ${s.kind === "bit" ? "Bit" : "Thread"}: ${s.title}${s.open ? " (open)" : ""}`,
				"",
				`${spans.join(" → ")}`,
				"",
				clean(s.arc),
				"",
				...s.people.map((p) => `- ${nameOf(p.user_id)}: ${clean(p.part)}`),
				"",
			);
		}
	}
	if (useModel)
		writeFileSync(
			cacheFile,
			JSON.stringify(Object.fromEntries(cache), null, 1),
		);
	out.push("## Day map", "");
	out.push("### Who addressed whom (inferred turns, all conversations)", "");
	for (const [key, n] of [...turnTotals]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)) {
		const [from, to] = key.split(">") as [string, string];
		out.push(`- ${nameOf(from)} → ${nameOf(to)}: ${n}`);
	}
	if (useModel) {
		out.push("", "### How they treated each other (summarizer exchanges)", "");
		const byPair = new Map<string, Map<string, number>>();
		for (const x of modelExchanges) {
			const key = `${nameOf(x.from)} → ${nameOf(x.to)}`;
			const tones = byPair.get(key) ?? byPair.set(key, new Map()).get(key)!;
			tones.set(x.tone, (tones.get(x.tone) ?? 0) + 1);
		}
		for (const [pair, tones] of [...byPair].sort(
			(a, b) => sum(b[1]) - sum(a[1]),
		)) {
			out.push(
				`- ${pair}: ${[...tones]
					.sort((a, b) => b[1] - a[1])
					.map(([t, n]) => `${t} ${n}`)
					.join(", ")}`,
			);
		}
		out.push(
			"",
			"### Roles (conversations as driver / responder / ignored)",
			"",
		);
		for (const [id, r] of [...roleCounts].sort(
			(a, b) => b[1].driver - a[1].driver,
		)) {
			out.push(`- ${nameOf(id)}: ${r.driver} / ${r.responder} / ${r.ignored}`);
		}
	}
	const loose = dayMessages.filter((m) => !covered.has(m.id));
	if (loose.length) {
		out.push("", "### Loose (no conversation)", "");
		for (const m of loose)
			out.push(
				`    ${clock(m.created_at)} ${nameOf(m.author_id)}: ${clean((byId.get(m.id) as Row).content)}`,
			);
	}

	mkdirSync("rnd/out", { recursive: true });
	const file = `rnd/out/${day}-${channel.name.replace(/[^\w-]+/g, "_")}${useModel ? "-model" : ""}.md`;
	writeFileSync(file, `${out.join("\n")}\n`);
	console.log(
		`wrote ${file} (${conversations.length} conversations${useModel ? ", summarizer run" : ""})`,
	);
	await db.disconnect();
	process.exit(0);
}

function sum(tones: Map<string, number>): number {
	let total = 0;
	for (const n of tones.values()) total += n;
	return total;
}

main().catch((error) => {
	console.error("❌", error);
	process.exit(1);
});
