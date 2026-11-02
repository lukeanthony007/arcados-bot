/**
 * Profile Users Script
 *
 * Batch-processes all active users in a guild to generate psychological profiles.
 *
 * Usage:
 *   GUILD_ID=123456789 npm run profile:users
 *   GUILD_ID=123456789 USER_LIMIT=50 npm run profile:users
 *   GUILD_ID=123456789 USER_ID=987654321 npm run profile:users   (single user)
 */

import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager.js";
import { AIFactory } from "../../../../ai/core/AIFactory.js";
import { PsychologicalProfiler } from "../PsychologicalProfiler.js";

async function main() {
	const guildId = process.env.GUILD_ID;
	const userLimit = process.env.USER_LIMIT
		? Number.parseInt(process.env.USER_LIMIT, 10)
		: undefined;
	const targetUserId = process.env.USER_ID;

	if (!guildId) {
		console.error("❌ Error: GUILD_ID environment variable is required");
		console.error("\nUsage:");
		console.error("  GUILD_ID=123456789 npm run profile:users");
		console.error("  GUILD_ID=123456789 USER_LIMIT=50 npm run profile:users");
		process.exit(1);
	}

	console.log("🧠 User Psychological Profiling");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	console.log(`Guild ID: ${guildId}`);
	if (targetUserId) {
		console.log(`User ID: ${targetUserId}`);
	}
	if (userLimit) {
		console.log(`User Limit: ${userLimit}`);
	}
	console.log("");

	// Initialize database
	const db = new PostgreSQLManager();
	await db.connect();

	// Check if guild exists
	const guildResult = await db.query(
		"SELECT name FROM guilds WHERE id = $1",
		[guildId]
	);

	if (!guildResult.success || !guildResult.data || guildResult.data.length === 0) {
		console.error(`❌ Error: Guild ${guildId} not found in database`);
		await db.disconnect();
		process.exit(1);
	}

	const guildName = guildResult.data[0].name;
	console.log(`Guild: ${guildName}\n`);

	// Get active users
	const userParams: (string | number)[] = [guildId];
	let userFilter = "";
	if (targetUserId) {
		userParams.push(targetUserId);
		userFilter = `AND m.user_id = $${userParams.length}`;
	}
	let limitClause = "";
	if (userLimit) {
		userParams.push(userLimit);
		limitClause = `LIMIT $${userParams.length}`;
	}

	const usersResult = await db.query(
		`
    SELECT m.user_id, m.display_name, COUNT(msg.id) as message_count
    FROM members m
    LEFT JOIN messages msg ON msg.author_id = m.user_id AND msg.guild_id = m.guild_id
    WHERE m.guild_id = $1
      AND m.bot = false
      AND m.active = true
      ${userFilter}
    GROUP BY m.user_id, m.display_name
    HAVING COUNT(msg.id) >= 10
    ORDER BY COUNT(msg.id) DESC
    ${limitClause}
    `,
		userParams
	);

	if (!usersResult.success || !usersResult.data || usersResult.data.length === 0) {
		console.error("❌ No users found for profiling (minimum 10 messages required)");
		await db.disconnect();
		process.exit(0);
	}

	const users = usersResult.data;
	console.log(`Found ${users.length} users to profile:\n`);

	for (const user of users.slice(0, 10)) {
		console.log(
			`   • ${user.display_name} (${user.user_id.slice(0, 8)}...) - ${user.message_count} messages`
		);
	}

	if (users.length > 10) {
		console.log(`   ... and ${users.length - 10} more`);
	}

	console.log("");

	// Initialize AI engine
	console.log("Initializing AI engine...");
	const { engine } = await AIFactory.create();

	// Initialize profiler
	const profiler = new PsychologicalProfiler(db, engine, {
		minMessagesForProfiling: 10,
		batchSize: 10,
		sleepBetweenBatchesMs: 1000, // 1 second between batches (Grok)
	});

	// Profile users
	const userIds = users.map((u: any) => u.user_id);
	const successCount = await profiler.profileBatch(guildId, userIds);

	// Print final stats
	const stats = profiler.getStats();
	const duration = stats.duration_seconds || 0;

	console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log("🔹 PROFILING COMPLETE");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`   Success Rate: ${successCount}/${users.length} users`);
	console.log(`   Duration: ${duration.toFixed(1)}s`);
	console.log(`   API Calls: ${stats.api_calls_made}`);
	console.log(`   Errors: ${stats.errors}`);
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

	// Show sample profile (first user)
	if (successCount > 0 && users.length > 0) {
		const sampleUserId = users[0].user_id;
		const sampleProfile = await db.query(
			`
			SELECT m.display_name, up.psych_profile
			FROM members m
			JOIN user_profiles up ON up.guild_id = m.guild_id AND up.user_id = m.user_id
			WHERE m.guild_id = $1 AND m.user_id = $2
			`,
			[guildId, sampleUserId]
		);

		if (sampleProfile.success && sampleProfile.data && sampleProfile.data.length > 0) {
			const profile = sampleProfile.data[0];
			const psychProfile = profile.psych_profile;

			console.log("\n📋 SAMPLE PROFILE:");
			console.log(`   User: ${profile.display_name}`);

			if (psychProfile.mbti_type) {
				console.log(
					`   MBTI Type: ${psychProfile.mbti_type.type} (${(psychProfile.mbti_type.confidence * 100).toFixed(0)}% confidence)`
				);
				console.log(
					`   Descriptors: ${psychProfile.mbti_type.descriptors.join(", ")}`
				);
			}

			if (psychProfile.big_five_proxies) {
				console.log("   Big Five:");
				console.log(
					`      Extraversion: ${(psychProfile.big_five_proxies.extraversion.score * 100).toFixed(0)}%`
				);
				console.log(
					`      Agreeableness: ${(psychProfile.big_five_proxies.agreeableness.score * 100).toFixed(0)}%`
				);
				console.log(
					`      Conscientiousness: ${(psychProfile.big_five_proxies.conscientiousness.score * 100).toFixed(0)}%`
				);
				console.log(
					`      Neuroticism: ${(psychProfile.big_five_proxies.neuroticism.score * 100).toFixed(0)}%`
				);
				console.log(
					`      Openness: ${(psychProfile.big_five_proxies.openness.score * 100).toFixed(0)}%`
				);
			}
		}
	}

	console.log("");

	await db.disconnect();
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});
