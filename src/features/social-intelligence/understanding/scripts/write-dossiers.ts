#!/usr/bin/env bun
/**
 * Write dossiers on demand (the bot does this on its own as things go stale).
 *
 *   bun run dossier:member <id or name>      write and print one member's dossier
 *   bun run dossier:pair <a> <b>             write and print a pair's dossier
 *   bun run dossier:server                   write and print the server dossier
 *   bun run dossier:stale [--dry-run]        write everything the staleness sweep finds
 */

import { resolveUserId } from "../../../../ai/tools/registry/DatabaseTools";
import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import {
	findStaleMembers,
	renderMemberDossier,
	writeMemberDossier,
} from "../memberDossier";
import {
	findStalePairs,
	renderPairDossier,
	writePairDossier,
} from "../pairDossier";
import {
	isServerDossierStale,
	renderServerDossier,
	writeServerDossier,
} from "../serverDossier";

async function main() {
	const [mode, ...rest] = process.argv.slice(2);
	const guildId = config.guildId;
	if (!guildId) throw new Error("GUILD_ID is not configured");
	const db = new PostgreSQLManager();
	if (!(await db.connect())) throw new Error("Failed to connect to database");

	const resolve = async (ref: string | undefined) => {
		if (!ref) throw new Error("Expected a user id or name");
		const resolved = await resolveUserId(ref, guildId, db);
		if (!resolved.success || !resolved.userId)
			throw new Error(resolved.error ?? `Unknown user ${ref}`);
		return resolved.userId;
	};
	const nameOf = async (userId: string) => {
		const result = await db.query(
			"SELECT COALESCE(nick, display_name, global_name, username, user_id) AS name FROM members WHERE guild_id = $1 AND user_id = $2",
			[guildId, userId],
		);
		return (result.data?.[0]?.name as string | undefined) ?? userId;
	};

	switch (mode) {
		case "--member": {
			const userId = await resolve(rest[0]);
			const dossier = await writeMemberDossier(db, guildId, userId);
			console.log(
				dossier
					? renderMemberDossier(dossier)
					: "Not enough messages for a dossier.",
			);
			break;
		}
		case "--pair": {
			const [a, b] = await Promise.all([resolve(rest[0]), resolve(rest[1])]);
			const dossier = await writePairDossier(db, guildId, a, b);
			console.log(
				dossier
					? renderPairDossier(dossier, await nameOf(a), await nameOf(b))
					: "Not enough shared conversations for a dossier.",
			);
			break;
		}
		case "--server": {
			const dossier = await writeServerDossier(db, guildId);
			console.log(
				dossier
					? renderServerDossier(dossier)
					: "Not enough summarized conversations.",
			);
			break;
		}
		case "--stale": {
			const dryRun = rest.includes("--dry-run");
			const [members, pairs, server] = await Promise.all([
				findStaleMembers(db, guildId, 1000),
				findStalePairs(db, guildId, 1000),
				isServerDossierStale(db, guildId),
			]);
			console.log(
				`Stale: ${members.length} members, ${pairs.length} pairs${server ? ", server" : ""}`,
			);
			if (!dryRun) {
				for (const userId of members) {
					const written = await writeMemberDossier(db, guildId, userId);
					console.log(
						`  member ${await nameOf(userId)}: ${written ? "written" : "skipped"}`,
					);
				}
				for (const [a, b] of pairs) {
					const written = await writePairDossier(db, guildId, a, b);
					console.log(
						`  pair ${await nameOf(a)} & ${await nameOf(b)}: ${written ? "written" : "skipped"}`,
					);
				}
				if (server)
					console.log(
						`  server: ${(await writeServerDossier(db, guildId)) ? "written" : "skipped"}`,
					);
			}
			break;
		}
		default:
			console.log(
				"Usage: --member <id|name> | --pair <a> <b> | --server | --stale [--dry-run]",
			);
	}

	await db.disconnect();
	process.exit(0);
}

main().catch((error) => {
	console.error("❌", error);
	process.exit(1);
});
