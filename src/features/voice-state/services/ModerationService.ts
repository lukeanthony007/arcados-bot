/**
 * Moderation Service
 *
 * Handles voice channel moderation operations:
 * - Apply/remove mute/deafen
 * - Validate permissions
 * - Record moderation audit trail
 * - Handle moderation errors gracefully
 *
 * Key improvements from legacy VoiceStateManager:
 * - FIXED: Consolidated 4 duplicate moderation methods (160+ lines) into single implementation (~100 lines)
 * - Uses common applyModeration() helper to eliminate duplication
 * - Clear error handling with ModerationError
 * - Repository-based audit logging
 */

import {
	AuditLogEvent,
	type Client,
	type GuildMember,
	type VoiceChannel,
} from "discord.js";
import type { VoiceDataRepository } from "../repositories/VoiceDataRepository";
import type { ModerationEvent } from "../types/index";
import { ModerationError } from "../types/index";
import { PermissionOverrideHelper } from "./helpers/PermissionOverrideHelper";
import { VoiceLogger } from "./helpers/VoiceLogger";

export class ModerationService {
	constructor(
		private client: Client,
		private repository: VoiceDataRepository,
	) {}

	/**
	 * Mute a user in a voice channel
	 */
	async mute(
		channelId: string,
		userId: string,
		moderatorId: string,
	): Promise<void> {
		await this.applyModeration(channelId, userId, "mute", moderatorId);
	}

	/**
	 * Unmute a user in a voice channel
	 */
	async unmute(
		channelId: string,
		userId: string,
		moderatorId: string,
	): Promise<void> {
		await this.applyModeration(channelId, userId, "unmute", moderatorId);
	}

	/**
	 * Deafen a user in a voice channel
	 */
	async deafen(
		channelId: string,
		userId: string,
		moderatorId: string,
	): Promise<void> {
		await this.applyModeration(channelId, userId, "deafen", moderatorId);
	}

	/**
	 * Undeafen a user in a voice channel
	 */
	async undeafen(
		channelId: string,
		userId: string,
		moderatorId: string,
	): Promise<void> {
		await this.applyModeration(channelId, userId, "undeafen", moderatorId);
	}

	/**
	 * Get audit log for a channel
	 */
	async getAuditLog(channelId: string, limit = 50): Promise<ModerationEvent[]> {
		return this.repository.getModerationHistory(channelId, limit);
	}

	/**
	 * Apply channel owner's moderation preferences to a user
	 * Called when users join or switch channels to enforce owner preferences
	 */
	async applyChannelPreferences(
		channelId: string,
		userId: string,
		guildId: string,
	): Promise<void> {
		try {
			// Get channel owner
			const ownerId = await this.repository.getCurrentOwner(channelId);
			if (!ownerId) {
				// No owner = not a user channel, ensure user is unmuted
				await this.clearModeration(channelId, userId);
				return;
			}

			// Don't apply preferences to the owner themselves
			// Clear any existing moderation from when they were in another user's channel
			if (ownerId === userId) {
				await this.clearModeration(channelId, userId);
				return;
			}

			// Check if user is grandfathered (from ownership transfer)
			// Grandfathered users keep their current moderation state
			const session = await this.repository.getActiveSession(userId, guildId);
			if (session?.is_grandfathered) {
				console.log(
					`🔹 [MODERATION] User ${userId} is grandfathered - skipping moderation preferences`,
				);
				return;
			}

			// Load owner's preferences
			const prefs = await this.repository.getUserPreferences(ownerId, guildId);

			// Check if user should be muted
			const shouldBeMuted = (prefs.muted_users || []).includes(userId);
			const shouldBeDeafened = (prefs.deafened_users || []).includes(userId);

			// Apply state
			const channel = await this.getVoiceChannel(channelId);
			const member = channel.members.get(userId);

			if (!member) {
				return; // User not in channel
			}

			// Apply mute state; only lift mutes the bot applied (a moderator's mute persists)
			if (shouldBeMuted && !member.voice.serverMute) {
				await member.voice.setMute(true);
			} else if (!shouldBeMuted && member.voice.serverMute) {
				await this.releaseIfOurs(member, "mute");
			}

			// Apply deafen state
			if (shouldBeDeafened && !member.voice.serverDeaf) {
				await member.voice.setDeaf(true);
			} else if (!shouldBeDeafened && member.voice.serverDeaf) {
				await this.releaseIfOurs(member, "deaf");
			}
		} catch (error) {
			console.error("🔸 [MODERATION] Failed to apply preferences:", error);
		}
	}

	/**
	 * Lift mute/deafen the bot applied (an owner's channel moderation) when a user moves on.
	 * Moderators' server mutes and deafens are left alone.
	 */
	private async clearModeration(
		channelId: string,
		userId: string,
	): Promise<void> {
		try {
			const channel = await this.getVoiceChannel(channelId);
			const member = channel.members.get(userId);

			if (!member) return;

			if (member.voice.serverMute) await this.releaseIfOurs(member, "mute");
			if (member.voice.serverDeaf) await this.releaseIfOurs(member, "deaf");
		} catch (error) {
			console.error("🔸 [MODERATION] Failed to clear moderation:", error);
		}
	}

	/**
	 * Undo a server mute/deafen only when the bot applied it. Server mutes follow a user across
	 * channels, so the bot lifts its own (channel-owner moderation) when they move on; but a
	 * mute or deafen a moderator applied in Discord must persist. Who applied it comes from the
	 * audit log, so it holds across restarts. If that can't be determined, leave it in place.
	 */
	private async releaseIfOurs(
		member: GuildMember,
		key: "mute" | "deaf",
	): Promise<void> {
		const botId = this.client.user?.id;
		let executorId: string | null = null;
		try {
			const log = await member.guild.fetchAuditLogs({
				type: AuditLogEvent.MemberUpdate,
				limit: 100,
			});
			const entry = log.entries.find(
				(e) =>
					e.targetId === member.id &&
					e.changes.some((c) => c.key === key && c.new === true),
			);
			executorId = entry?.executorId ?? null;
		} catch (error) {
			console.error(
				"🔸 [MODERATION] Could not read the audit log; leaving moderation in place:",
				error,
			);
			return;
		}
		if (!botId || executorId !== botId) {
			VoiceLogger.moderation(
				`Keeping ${key} on ${member.displayName}: applied by ${executorId ? `<@${executorId}>` : "someone other than the bot"}`,
			);
			return;
		}
		if (key === "mute") await member.voice.setMute(false);
		else await member.voice.setDeaf(false);
	}

	/**
	 * Apply blacklist permission to a user across all channels owned by the moderator
	 * Uses Discord's permission overrides to hide the channel and prevent the user from connecting
	 */
	async applyBlacklistPermissions(
		userId: string,
		moderatorId: string,
		guildId: string,
	): Promise<void> {
		try {
			// Get all channels owned by the moderator
			const channelData = await this.repository.getChannelsByOwner(
				guildId,
				moderatorId,
			);

			// Resolve channel objects
			const channels: VoiceChannel[] = [];
			for (const data of channelData) {
				try {
					const channel = await this.getVoiceChannel(data.id);
					channels.push(channel);
				} catch (error) {
					console.error(
						`🔸 [MODERATION] Could not find channel ${data.id}:`,
						error,
					);
				}
			}

			// Apply permissions using helper - deny both Connect and ViewChannel
			await PermissionOverrideHelper.applyToChannels(
				channels,
				userId,
				{ Connect: false, ViewChannel: false },
				"MODERATION",
			);
		} catch (error) {
			VoiceLogger.error(
				"MODERATION",
				"Failed to apply blacklist permissions",
				error,
			);
		}
	}

	/**
	 * Remove blacklist permission from a user across all channels owned by the moderator
	 */
	async removeBlacklistPermissions(
		userId: string,
		moderatorId: string,
		guildId: string,
	): Promise<void> {
		try {
			// Get all channels owned by the moderator
			const channelData = await this.repository.getChannelsByOwner(
				guildId,
				moderatorId,
			);

			// Resolve channel objects, filtering out deleted channels
			const channels: VoiceChannel[] = [];
			for (const data of channelData) {
				try {
					const channel = await this.getVoiceChannel(data.id);
					if (channel) {
						channels.push(channel);
					}
				} catch (error) {
					// Channel was deleted, skip silently
				}
			}

			// Remove permissions using helper
			await PermissionOverrideHelper.removeFromChannels(
				channels,
				userId,
				"MODERATION",
			);
		} catch (error) {
			VoiceLogger.error(
				"MODERATION",
				"Failed to remove blacklist permissions",
				error,
			);
		}
	}

	/**
	 * Apply whitelist permission to a user across all channels owned by the moderator
	 * Uses Discord's permission overrides to allow the user to connect
	 */
	async applyWhitelistPermissions(
		userId: string,
		moderatorId: string,
		guildId: string,
	): Promise<void> {
		try {
			// Get all channels owned by the moderator
			const channelData = await this.repository.getChannelsByOwner(
				guildId,
				moderatorId,
			);

			// Resolve channel objects
			const channels: VoiceChannel[] = [];
			for (const data of channelData) {
				try {
					const channel = await this.getVoiceChannel(data.id);
					channels.push(channel);
				} catch (error) {
					console.error(
						`🔸 [MODERATION] Could not find channel ${data.id}:`,
						error,
					);
				}
			}

			// Apply permissions using helper - allow Connect and ViewChannel
			await PermissionOverrideHelper.applyToChannels(
				channels,
				userId,
				{ Connect: true, ViewChannel: true },
				"MODERATION",
			);
		} catch (error) {
			VoiceLogger.error(
				"MODERATION",
				"Failed to apply whitelist permissions",
				error,
			);
		}
	}

	/**
	 * Remove whitelist permission from a user across all channels owned by the moderator
	 */
	async removeWhitelistPermissions(
		userId: string,
		moderatorId: string,
		guildId: string,
	): Promise<void> {
		try {
			// Get all channels owned by the moderator
			const channelData = await this.repository.getChannelsByOwner(
				guildId,
				moderatorId,
			);

			// Resolve channel objects, filtering out deleted channels
			const channels: VoiceChannel[] = [];
			for (const data of channelData) {
				try {
					const channel = await this.getVoiceChannel(data.id);
					if (channel) {
						channels.push(channel);
					}
				} catch (error) {
					// Channel was deleted, skip silently
				}
			}

			// Remove permissions using helper
			await PermissionOverrideHelper.removeFromChannels(
				channels,
				userId,
				"MODERATION",
			);
		} catch (error) {
			VoiceLogger.error(
				"MODERATION",
				"Failed to remove whitelist permissions",
				error,
			);
		}
	}

	/**
	 * Sync moderation permissions for a new channel created by an owner
	 * Applies all the owner's blacklist and whitelist to the new channel
	 */
	async syncModerationsForNewChannel(
		channelId: string,
		ownerId: string,
		guildId: string,
	): Promise<void> {
		try {
			// Load owner's preferences
			const prefs = await this.repository.getUserPreferences(ownerId, guildId);
			const blacklistedUsers = (prefs.blacklist as string[]) || [];
			const whitelistedUsers = (prefs.whitelist as string[]) || [];

			const channel = await this.getVoiceChannel(channelId);

			// Apply blacklist permissions (deny Connect and ViewChannel)
			if (blacklistedUsers.length > 0) {
				await PermissionOverrideHelper.applyToUsers(
					channel,
					blacklistedUsers,
					{ Connect: false, ViewChannel: false },
					"MODERATION",
				);
			}

			// Apply whitelist permissions (allow Connect and ViewChannel)
			if (whitelistedUsers.length > 0) {
				await PermissionOverrideHelper.applyToUsers(
					channel,
					whitelistedUsers,
					{ Connect: true, ViewChannel: true },
					"MODERATION",
				);
			}
		} catch (error) {
			VoiceLogger.error(
				"MODERATION",
				"Failed to sync moderation permissions for new channel",
				error,
			);
		}
	}

	/**
	 * Apply moderation action (CONSOLIDATED)
	 *
	 * This replaces 4 near-identical methods in the legacy VoiceStateManager,
	 * reducing 160+ lines of duplicate code to a single implementation.
	 */
	private async applyModeration(
		channelId: string,
		userId: string,
		action: "mute" | "unmute" | "deafen" | "undeafen",
		moderatorId: string,
	): Promise<void> {
		// Get voice channel
		const channel = await this.getVoiceChannel(channelId);

		// Get member in channel
		const member = channel.members.get(userId);
		if (!member) {
			throw new ModerationError(
				`User ${userId} not found in channel ${channelId}`,
			);
		}

		try {
			// Apply Discord API change
			switch (action) {
				case "mute":
					await member.voice.setMute(true);
					break;
				case "unmute":
					await member.voice.setMute(false);
					break;
				case "deafen":
					await member.voice.setDeaf(true);
					break;
				case "undeafen":
					await member.voice.setDeaf(false);
					break;
			}

			// Record in audit log
			await this.repository.recordModerationEvent({
				action,
				channel_id: channelId,
				user_id: userId,
				moderator_id: moderatorId,
				timestamp: new Date(),
			});

			const userName = member.displayName || userId;
			const channelName = channel.name || channelId;
			VoiceLogger.moderation(
				`Applied ${action} to ${userName} in ${channelName}`,
			);
		} catch (error) {
			throw new ModerationError(`Failed to ${action} user`, error);
		}
	}

	/**
	 * Get voice channel by ID
	 */
	private async getVoiceChannel(channelId: string): Promise<VoiceChannel> {
		const channel = this.client.channels.cache.get(channelId);

		if (!channel) {
			throw new ModerationError("Channel not found");
		}

		if (!channel.isVoiceBased()) {
			throw new ModerationError("Channel is not a voice channel");
		}

		return channel as VoiceChannel;
	}
}
