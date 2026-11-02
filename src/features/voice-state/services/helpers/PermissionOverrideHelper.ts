/**
 * Permission Override Helper
 *
 * Centralized utility for managing Discord permission overrides on voice channels.
 * Consolidates duplicate permission application/removal logic from ModerationService
 * and BlockEnforcementService.
 *
 * This helper provides:
 * - Consistent error handling for permission operations
 * - Standardized logging format
 * - Batch operations for multiple channels/users
 * - Testable permission management in isolation
 */

import type { PermissionOverwriteOptions, VoiceChannel, Guild } from "discord.js";
import { VoiceLogger } from "./VoiceLogger";

export interface PermissionResult {
	success: number;
	failed: number;
	errors: Array<{ id: string; error: any }>;
}

export class PermissionOverrideHelper {
	/**
	 * Get user display name from guild
	 */
	private static getUserDisplayName(guild: Guild | undefined, userId: string): string {
		if (!guild) return userId;
		const member = guild.members.cache.get(userId);
		return member?.displayName || userId;
	}

	/**
	 * Apply permission overrides to multiple channels for a single user
	 *
	 * Use case: When a user is banned/blocked and needs to be locked out of all their channels
	 *
	 * @param channels - Array of voice channels to apply permissions to
	 * @param userId - User ID to apply permissions for
	 * @param permissions - Permission overrides to apply (e.g., { Connect: false })
	 * @param logContext - Context string for logging (e.g., "BAN", "BLOCK")
	 * @returns Result with success/failure counts
	 */
	static async applyToChannels(
		channels: VoiceChannel[],
		userId: string,
		permissions: PermissionOverwriteOptions,
		logContext: string,
	): Promise<PermissionResult> {
		const result: PermissionResult = {
			success: 0,
			failed: 0,
			errors: [],
		};

		for (const channel of channels) {
			try {
				// Validate user ID format (Discord snowflake)
				if (!userId || typeof userId !== "string" || userId.length < 17) {
					VoiceLogger.warn(logContext, `Invalid user ID format: ${userId}`);
					result.failed++;
					result.errors.push({ id: channel.id, error: new Error("Invalid user ID format") });
					continue;
				}

				// Try to resolve user ID to a User object (required by Discord.js)
				let user = channel.guild.members.cache.get(userId)?.user;
				if (!user) {
					// User not in cache, try to fetch
					try {
						const member = await channel.guild.members.fetch(userId).catch(() => null);
						user = member?.user;
					} catch {
						// User doesn't exist or can't be fetched
					}
				}

				// If we still can't resolve the user, skip this permission override
				if (!user) {
					// User doesn't exist in this guild, skip silently
					result.failed++;
					result.errors.push({ id: channel.id, error: new Error("User not found in guild") });
					continue;
				}

				// Apply permissions using the resolved User object
				await channel.permissionOverwrites.edit(user, permissions);
				result.success++;
				// Only log for non-BLOCK contexts to reduce log spam
				// Block permissions are applied frequently and don't need individual logs
				if (logContext !== "BLOCK") {
					const userName = this.getUserDisplayName(channel.guild, userId);
					const channelName = channel.name || channel.id;
					if (logContext === "BAN" || logContext === "MODERATION") {
						VoiceLogger.moderation(`Applied permissions to ${channelName} for ${userName}`);
					} else {
						VoiceLogger.info(logContext, `Applied permissions to ${channelName} for ${userName}`);
					}
				}
			} catch (error: any) {
				result.failed++;
				result.errors.push({ id: channel.id, error });
				// Only log if it's not a common Discord error (like channel/user not found, invalid type)
				if (error?.code !== 10003 && error?.code !== 10013 && error?.code !== 50035 && error?.code !== "InvalidType") {
					const channelName = channel.name || channel.id;
					VoiceLogger.error(logContext, `Failed to apply permissions to channel ${channelName}`, error);
				}
			}
		}

		return result;
	}

	/**
	 * Apply permission overrides to a single channel for multiple users
	 *
	 * Use case: When a channel is created and owner's ban/block list needs to be applied
	 *
	 * @param channel - Voice channel to apply permissions to
	 * @param userIds - Array of user IDs to apply permissions for
	 * @param permissions - Permission overrides to apply (e.g., { Connect: false })
	 * @param logContext - Context string for logging (e.g., "BAN", "BLOCK")
	 * @returns Result with success/failure counts
	 */
	static async applyToUsers(
		channel: VoiceChannel,
		userIds: string[],
		permissions: PermissionOverwriteOptions,
		logContext: string,
	): Promise<PermissionResult> {
		const result: PermissionResult = {
			success: 0,
			failed: 0,
			errors: [],
		};

		for (const userId of userIds) {
			try {
				// Validate user ID format (Discord snowflake)
				if (!userId || typeof userId !== "string" || userId.length < 17) {
					VoiceLogger.warn(logContext, `Invalid user ID format: ${userId}`);
					result.failed++;
					result.errors.push({ id: userId, error: new Error("Invalid user ID format") });
					continue;
				}

				// Try to resolve user ID to a User object (required by Discord.js)
				// First try from guild members cache, then try fetching
				let user = channel.guild.members.cache.get(userId)?.user;
				if (!user) {
					// User not in cache, try to fetch
					try {
						const member = await channel.guild.members.fetch(userId).catch(() => null);
						user = member?.user;
					} catch {
						// User doesn't exist or can't be fetched
					}
				}

				// If we still can't resolve the user, skip this permission override
				if (!user) {
					// User doesn't exist in this guild, skip silently
					result.failed++;
					result.errors.push({ id: userId, error: new Error("User not found in guild") });
					continue;
				}

				// Apply permissions using the resolved User object
				await channel.permissionOverwrites.edit(user, permissions);
				result.success++;
				// Only log for non-BLOCK contexts to reduce log spam
				// Block permissions are applied frequently and don't need individual logs
				if (logContext !== "BLOCK") {
					const userName = this.getUserDisplayName(channel.guild, userId);
					const channelName = channel.name || channel.id;
					if (logContext === "BAN" || logContext === "MODERATION") {
						VoiceLogger.moderation(`Applied permissions to ${channelName} for ${userName}`);
					} else {
						VoiceLogger.info(logContext, `Applied permissions to ${channelName} for ${userName}`);
					}
				}
			} catch (error: any) {
				result.failed++;
				result.errors.push({ id: userId, error });
				// Only log if it's not a common Discord error (like user not found, invalid type)
				if (error?.code !== 10013 && error?.code !== 50035 && error?.code !== "InvalidType") {
					const userName = this.getUserDisplayName(channel.guild, userId);
					VoiceLogger.error(logContext, `Failed to apply permissions for ${userName}`, error);
				}
			}
		}

		return result;
	}

	/**
	 * Remove permission overrides from multiple channels for a single user
	 *
	 * Use case: When a user is unbanned/unblocked and should regain access to channels
	 *
	 * @param channels - Array of voice channels to remove permissions from
	 * @param userId - User ID to remove permissions for
	 * @param logContext - Context string for logging (e.g., "BAN", "BLOCK")
	 */
	static async removeFromChannels(
		channels: VoiceChannel[],
		userId: string,
		logContext: string,
	): Promise<PermissionResult> {
		const result: PermissionResult = {
			success: 0,
			failed: 0,
			errors: [],
		};

		for (const channel of channels) {
			try {
				await channel.permissionOverwrites.delete(userId);
				result.success++;
				// Only log for non-BLOCK contexts to reduce log spam
				if (logContext !== "BLOCK") {
					const userName = this.getUserDisplayName(channel.guild, userId);
					const channelName = channel.name || channel.id;
					if (logContext === "BAN" || logContext === "MODERATION") {
						VoiceLogger.moderation(`Removed permissions from ${channelName} for ${userName}`);
					} else {
						VoiceLogger.info(logContext, `Removed permissions from ${channelName} for ${userName}`);
					}
				}
			} catch (error: any) {
				result.failed++;
				result.errors.push({ id: channel.id, error });
				// Only log errors for non-BLOCK contexts or non-common errors
				const errorCode =
					typeof error === "object" && error !== null && "code" in error
						? error.code
						: undefined;
				if (logContext !== "BLOCK" || (errorCode !== 10013 && errorCode !== 50035 && errorCode !== "InvalidType")) {
					const channelName = channel.name || channel.id;
					VoiceLogger.error(logContext, `Failed to remove permissions from channel ${channelName}`, error);
				}
			}
		}

		return result;
	}

	/**
	 * Remove permission overrides from a single channel for multiple users
	 *
	 * Use case: When cleaning up permissions on channel deletion or owner change
	 *
	 * @param channel - Voice channel to remove permissions from
	 * @param userIds - Array of user IDs to remove permissions for
	 * @param logContext - Context string for logging (e.g., "BAN", "BLOCK")
	 */
	static async removeFromUsers(
		channel: VoiceChannel,
		userIds: string[],
		logContext: string,
	): Promise<PermissionResult> {
		const result: PermissionResult = {
			success: 0,
			failed: 0,
			errors: [],
		};

		for (const userId of userIds) {
			try {
				await channel.permissionOverwrites.delete(userId);
				result.success++;
				// Only log for non-BLOCK contexts to reduce log spam
				if (logContext !== "BLOCK") {
					const userName = this.getUserDisplayName(channel.guild, userId);
					const channelName = channel.name || channel.id;
					if (logContext === "BAN" || logContext === "MODERATION") {
						VoiceLogger.moderation(`Removed permissions from ${channelName} for ${userName}`);
					} else {
						VoiceLogger.info(logContext, `Removed permissions from ${channelName} for ${userName}`);
					}
				}
			} catch (error) {
				result.failed++;
				result.errors.push({ id: userId, error });
				// Only log errors for non-BLOCK contexts or non-common errors
				const errorCode =
					typeof error === "object" && error !== null && "code" in error
						? error.code
						: undefined;
				if (logContext !== "BLOCK" || (errorCode !== 10013 && errorCode !== 50035 && errorCode !== "InvalidType")) {
					VoiceLogger.error(logContext, `Failed to remove permissions for user ${userId}`, error);
				}
			}
		}

		return result;
	}

	/**
	 * Apply a single permission override (convenience method)
	 *
	 * Use case: Quick single-channel, single-user permission update
	 *
	 * @param channel - Voice channel to apply permissions to
	 * @param userId - User ID to apply permissions for
	 * @param permissions - Permission overrides to apply
	 * @param logContext - Context string for logging
	 * @returns True if successful, false otherwise
	 */
	static async applySingle(
		channel: VoiceChannel,
		userId: string,
		permissions: PermissionOverwriteOptions,
		logContext: string,
	): Promise<boolean> {
		try {
			// Try to resolve user ID to a User object
			let user = channel.guild.members.cache.get(userId)?.user;
			if (!user) {
				try {
					const member = await channel.guild.members.fetch(userId).catch(() => null);
					user = member?.user;
				} catch {
					// User doesn't exist
				}
			}

			if (!user) {
				// User not found in guild, can't apply permissions
				return false;
			}

			await channel.permissionOverwrites.edit(user, permissions);
			// Only log for non-BLOCK contexts to reduce log spam
			if (logContext !== "BLOCK") {
				const userName = this.getUserDisplayName(channel.guild, userId);
				const channelName = channel.name || channel.id;
				if (logContext === "BAN" || logContext === "MODERATION") {
					VoiceLogger.moderation(`Applied permissions to ${channelName} for ${userName}`);
				} else {
					VoiceLogger.info(logContext, `Applied permissions to ${channelName} for ${userName}`);
				}
			}
			return true;
		} catch (error: any) {
			// Only log if it's not a common Discord error
			if (error?.code !== 10013 && error?.code !== 50035 && error?.code !== "InvalidType") {
				const userName = this.getUserDisplayName(channel.guild, userId);
				const channelName = channel.name || channel.id;
				VoiceLogger.error(logContext, `Failed to apply permissions to ${channelName} for ${userName}`, error);
			}
			return false;
		}
	}

	/**
	 * Remove a single permission override (convenience method)
	 *
	 * Use case: Quick single-channel, single-user permission removal
	 *
	 * @param channel - Voice channel to remove permissions from
	 * @param userId - User ID to remove permissions for
	 * @param logContext - Context string for logging
	 * @returns True if successful, false otherwise
	 */
	static async removeSingle(
		channel: VoiceChannel,
		userId: string,
		logContext: string,
	): Promise<boolean> {
		try {
			await channel.permissionOverwrites.delete(userId);
			// Only log for non-BLOCK contexts to reduce log spam
			if (logContext !== "BLOCK") {
				const userName = this.getUserDisplayName(channel.guild, userId);
				const channelName = channel.name || channel.id;
				if (logContext === "BAN" || logContext === "MODERATION") {
					VoiceLogger.moderation(`Removed permissions from ${channelName} for ${userName}`);
				} else {
					VoiceLogger.info(logContext, `Removed permissions from ${channelName} for ${userName}`);
				}
			}
			return true;
		} catch (error) {
			const userName = this.getUserDisplayName(channel.guild, userId);
			const channelName = channel.name || channel.id;
			VoiceLogger.error(logContext, `Failed to remove permissions from ${channelName} for ${userName}`, error);
			return false;
		}
	}
}
