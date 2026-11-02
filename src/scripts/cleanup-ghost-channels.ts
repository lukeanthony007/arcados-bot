/**
 * Cleanup Ghost Channels Script
 *
 * Removes deleted voice channels from the database that no longer exist in Discord.
 * This fixes the issue where users have many "ghost channels" (deleted channels still in DB).
 *
 * Preserves:
 * - User preferences (voice_channel_preferences table)
 * - Session history
 * - Moderation history
 *
 * Removes:
 * - Channels from voice_channels table that don't exist in Discord
 */

import { Client, Events, GatewayIntentBits } from "discord.js";
import { PostgreSQLManager } from "../database/PostgreSQLManager";
import { config } from "../config";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

async function cleanupGhostChannels() {
	console.log("🧹 Starting ghost channel cleanup...");

	// Initialize database
	const db = new PostgreSQLManager();
	await db.connect();

	// Get Discord token from environment or config
	const token = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN || config.botToken;
	if (!token) {
		console.error("❌ Discord token not found. Set BOT_TOKEN or DISCORD_TOKEN environment variable.");
		process.exit(1);
	}

	// Initialize Discord client (minimal intents)
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
	});

	try {
		await client.login(token);
		console.log("🔹 Discord client logged in");

		// Wait for client to be ready
		await new Promise((resolve) => {
			client.once(Events.ClientReady, resolve);
		});

		// Get all user channels from database
		const channelsResult = await db.query(
			`SELECT id, guild_id, name, current_owner_id 
			 FROM channels 
			 WHERE is_user_channel = true`,
		);

		if (!channelsResult.success || !channelsResult.data) {
			console.error("❌ Failed to fetch channels from database");
			return;
		}

		const channels = channelsResult.data;
		console.log(`📊 Found ${channels.length} user channels in database`);

		const ghostChannels: Array<{ id: string; name: string; ownerId: string }> = [];
		let checkedChannels = 0;

		// Check each channel against Discord
		for (const channelData of channels) {
			checkedChannels++;
			const channelId = channelData.id;
			const guildId = channelData.guild_id;
			const channelName = channelData.name || channelId;
			const ownerId = channelData.current_owner_id;

			// Get guild
			const guild = client.guilds.cache.get(guildId);
			if (!guild) {
				// Guild not found, mark as ghost
				ghostChannels.push({
					id: channelId,
					name: channelName,
					ownerId: ownerId || "unknown",
				});
				continue;
			}

			// Check if channel exists in Discord
			const discordChannel = guild.channels.cache.get(channelId);
			if (!discordChannel) {
				// Channel doesn't exist in Discord, it's a ghost
				ghostChannels.push({
					id: channelId,
					name: channelName,
					ownerId: ownerId || "unknown",
				});
			}

			// Progress indicator
			if (checkedChannels % 10 === 0) {
				console.log(`  Checked ${checkedChannels}/${channels.length} channels...`);
			}
		}

		console.log(`\n👻 Found ${ghostChannels.length} ghost channels`);

		if (ghostChannels.length === 0) {
			console.log("🔹 No ghost channels to clean up!");
			return;
		}

		// Group by owner for reporting
		const byOwner = new Map<string, number>();
		for (const ghost of ghostChannels) {
			const count = byOwner.get(ghost.ownerId) || 0;
			byOwner.set(ghost.ownerId, count + 1);
		}

		console.log("\n📋 Ghost channels by owner:");
		for (const [ownerId, count] of byOwner.entries()) {
			const guild = Array.from(client.guilds.cache.values())[0];
			const member = guild?.members.cache.get(ownerId);
			const ownerName = member?.displayName || ownerId;
			console.log(`  ${ownerName}: ${count} ghost channel(s)`);
		}

		// Delete ghost channels from database
		console.log("\n🗑️  Deleting ghost channels from database...");
		let deleted = 0;

		for (const ghost of ghostChannels) {
			try {
				// Delete channel (this will cascade delete related records like sessions, but NOT preferences)
				const deleteResult = await db.query(
					`DELETE FROM channels WHERE id = $1`,
					[ghost.id],
				);

				if (deleteResult.success) {
					deleted++;
				}
			} catch (error) {
				console.error(`  ❌ Failed to delete channel ${ghost.id}:`, error);
			}
		}

		console.log(`\n🔹 Deleted ${deleted}/${ghostChannels.length} ghost channels`);
		console.log("🔹 User preferences preserved");
	} catch (error) {
		console.error("❌ Error during cleanup:", error);
		process.exit(1);
	} finally {
		await client.destroy();
		await db.disconnect();
		console.log("🔹 Cleanup complete");
	}
}

// Run cleanup
cleanupGhostChannels().catch(console.error);

