/**
 * Profile Stale Users Script
 *
 * Profiles only users whose profiles are stale (50+ new messages OR 7+ days old).
 *
 * Usage:
 *   GUILD_ID=123456789 npm run profile:users:stale
 */

import { config } from "../../../../config/index.js";
import { PostgreSQLManager } from "../../../../database/PostgreSQLManager.js";
import { AIFactory } from "../../../../ai/core/AIFactory.js";
import { PsychologicalProfiler } from "../PsychologicalProfiler.js";

async function main() {
	const guildId = process.env.GUILD_ID;

	if (!guildId) {
		console.error("❌ Error: GUILD_ID environment variable is required");
		console.error("\nUsage:");
		console.error("  GUILD_ID=123456789 npm run profile:users:stale");
		process.exit(1);
	}

	console.log("🔄 Stale User Profile Detection & Update");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
	console.log(`Guild ID: ${guildId}\n`);

	// Initialize database
	const db = new PostgreSQLManager();
	await db.connect();

	// Initialize AI engine
	console.log("Initializing AI engine...");
	const { engine } = await AIFactory.create();

	// Initialize profiler
	const profiler = new PsychologicalProfiler(db, engine, {
		minMessagesForProfiling: 10,
		stalenessThreshold: 50,
		batchSize: 10,
		sleepBetweenBatchesMs: 1000,
	});

	// Detect stale profiles
	console.log("Detecting stale profiles...\n");
	const staleUserIds = await profiler.detectStaleProfiles(guildId);

	if (staleUserIds.length === 0) {
		console.log("🔹 No stale profiles found. All users are up to date!");
		await db.disconnect();
		process.exit(0);
	}

	console.log(`Found ${staleUserIds.length} stale user profiles:\n`);

	// Get user details
	const usersResult = await db.query(
		`
    SELECT user_id, display_name
    FROM members
    WHERE guild_id = $1 AND user_id = ANY($2::TEXT[])
    `,
		[guildId, staleUserIds]
	);

	if (usersResult.success && usersResult.data) {
		for (const user of usersResult.data.slice(0, 10)) {
			console.log(`   • ${user.display_name} (${user.user_id.slice(0, 8)}...)`);
		}

		if (usersResult.data.length > 10) {
			console.log(`   ... and ${usersResult.data.length - 10} more`);
		}
	}

	console.log("");

	// Profile stale users
	const successCount = await profiler.profileBatch(guildId, staleUserIds);

	// Print final stats
	const stats = profiler.getStats();
	const duration = stats.duration_seconds || 0;

	console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log("🔹 STALE PROFILE UPDATE COMPLETE");
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`   Success Rate: ${successCount}/${staleUserIds.length} users`);
	console.log(`   Duration: ${duration.toFixed(1)}s`);
	console.log(`   API Calls: ${stats.api_calls_made}`);
	console.log(`   Errors: ${stats.errors}`);
	console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

	// Show sample profile (first stale user)
	if (successCount > 0 && staleUserIds.length > 0) {
		const sampleUserId = staleUserIds[0];
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

			console.log("\n📋 SAMPLE UPDATED PROFILE:");
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
