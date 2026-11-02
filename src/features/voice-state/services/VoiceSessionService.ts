/**
 * Voice Session Service
 *
 * Manages individual user voice session lifecycle:
 * - Create new sessions on voice join
 * - Update session state (channel switches, state changes)
 * - Finalize sessions on voice leave
 * - Calculate session analytics (duration, mute/deaf times)
 * - Record session history events
 *
 * Key improvements from legacy VoiceStateManager:
 * - FIXED: Debounced analytics race condition (fetches fresh state from DB)
 * - Clear separation of concerns (session-only, no spawn channel logic)
 * - Uses repository for all database operations
 */

import type { VoiceState, Client, VoiceChannel } from "discord.js";
import { v4 as uuidv4 } from "uuid";
import type { VoiceDataRepository } from "../repositories/VoiceDataRepository";
import type {
	VoiceSessionData,
	SessionSummary,
	SessionUpdate,
	StateChangeEvent,
} from "../types/index";
import { VoiceStateError } from "../types/index";

export class VoiceSessionService {
	// Track session start times for analytics
	private sessionStartTimes = new Map<string, Date>(); // userId:guildId -> Date

	// Track state change timers (debounced analytics)
	private stateChangeTimers = new Map<string, NodeJS.Timeout>(); // userId:guildId -> Timer

	constructor(
		private repository: VoiceDataRepository,
		private client?: Client,
	) {}

	/**
	 * Start a new voice session
	 *
	 * Creates session record, syncs voice state, records history event
	 */
	async startSession(
		userId: string,
		guildId: string,
		channelId: string,
		voiceState: VoiceState,
	): Promise<string> {
		const sessionId = uuidv4();
		const key = `${userId}:${guildId}`;

		// Get current channel owner (if any)
		const currentOwner = await this.repository.getCurrentOwner(channelId);

		// Create session record
		const sessionData: VoiceSessionData = {
			id: sessionId,
			guild_id: guildId,
			user_id: userId,
			channel_id: channelId,
			joined_at: new Date(),
			duration: 0,
			time_muted: 0,
			time_deafened: 0,
			time_streaming: 0,
			owner_at_join: currentOwner || undefined,
			is_grandfathered: false,
			applied_moderation: {},
			active: true,
		};

		await this.repository.createSession(sessionData);

		// Track session start time for analytics
		this.sessionStartTimes.set(key, new Date());

		// Sync voice state
		await this.repository.upsertVoiceState({
			id: `${guildId}_${userId}`,
			guild_id: guildId,
			user_id: userId,
			channel_id: channelId,
			session_id: sessionId,
			self_mute: voiceState.selfMute || false,
			self_deaf: voiceState.selfDeaf || false,
			server_mute: voiceState.mute || false,
			server_deaf: voiceState.deaf || false,
			streaming: voiceState.streaming || false,
			self_video: voiceState.selfVideo || false,
		});

		// Record history event
		await this.repository.recordHistory({
			guild_id: guildId,
			user_id: userId,
			channel_id: channelId,
			event_type: "join",
			session_id: sessionId,
			self_mute: voiceState.selfMute || false,
			self_deaf: voiceState.selfDeaf || false,
			server_mute: voiceState.mute || false,
			server_deaf: voiceState.deaf || false,
			streaming: voiceState.streaming || false,
			self_video: voiceState.selfVideo || false,
			timestamp: new Date(),
		});

		const displayName = voiceState.member?.displayName || "Unknown";
		const channelName = voiceState.channel?.name || "Unknown";
		console.log(`🔹 [SESSION] ${displayName} joined ${channelName}`);

		return sessionId;
	}

	/**
	 * Ensure channel exists in database before creating session
	 *
	 * Preserves existing ownership and user_channel flags if channel already exists.
	 * Called before session creation to prevent foreign key constraint violations.
	 */
	async ensureChannelExists(
		channel: VoiceChannel,
		guildId: string,
	): Promise<void> {
		const isUserChannel = await this.repository.isUserChannel(channel.id);
		const existingOwner = await this.repository.getCurrentOwner(channel.id);

		await this.repository.insertChannel({
			id: channel.id,
			guild_id: guildId,
			name: channel.name,
			type: channel.type,
			parent_id: channel.parentId,
			position: channel.position,
			is_user_channel: isUserChannel,
			current_owner_id: existingOwner,
		});
	}

	/**
	 * Update session with new data
	 *
	 * Used for channel switches or analytics updates
	 */
	async updateSession(sessionId: string, updates: SessionUpdate): Promise<void> {
		await this.repository.updateSession(sessionId, updates);
	}

	/**
	 * Finalize session on voice leave
	 *
	 * Calculates final analytics and marks session as inactive
	 */
	async finalizeSession(userId: string, guildId: string): Promise<SessionSummary | null> {
		const key = `${userId}:${guildId}`;
		const session = await this.repository.getActiveSession(userId, guildId);

		if (!session) {
			// No active session (may have been spawn channel join that was interrupted)
			console.log(`⚠️  [SESSION] No active session to finalize for ${userId}`);

			// Cleanup tracking anyway
			this.sessionStartTimes.delete(key);
			this.clearStateChangeTimer(key);

			return null;
		}

		// Calculate final analytics
		const startTime = new Date(session.joined_at).getTime();
		const endTime = Date.now();
		const duration = Math.floor((endTime - startTime) / 1000);

		const summary: SessionSummary = {
			duration,
			time_muted: session.time_muted,
			time_deafened: session.time_deafened,
			time_streaming: session.time_streaming,
			channels_visited: [session.channel_id],
		};

		// Finalize in database
		await this.repository.finalizeSession(session.id, summary);

		// Record leave event in history
		await this.repository.recordHistory({
			guild_id: guildId,
			user_id: userId,
			channel_id: session.channel_id,
			event_type: "leave",
			session_id: session.id,
			timestamp: new Date(),
		});

		// Delete voice state
		await this.repository.deleteVoiceState(`${guildId}_${userId}`);

		// Cleanup tracking
		this.sessionStartTimes.delete(key);
		this.clearStateChangeTimer(key);

		// Get user and channel names for better logging
		let displayName = "Unknown";
		let channelName = "Unknown";

		if (this.client) {
			try {
				const guild = this.client.guilds.cache.get(guildId);
				if (guild) {
					const member = await guild.members.fetch(userId).catch(() => null);
					if (member) {
						displayName = member.displayName;
					}

					const channel = guild.channels.cache.get(session.channel_id);
					if (channel && "name" in channel) {
						channelName = channel.name || "Unknown";
					}
				}
			} catch {
				// Fallback to IDs if fetch fails
			}
		}

		console.log(
			`🔹 [SESSION] ${displayName} left ${channelName} (${duration}s)`,
		);

		return summary;
	}

	/**
	 * Record state change event (FIXED: debounced analytics race condition)
	 *
	 * Previous implementation captured VoiceState in closure, which could be stale.
	 * New implementation fetches fresh session from database when timer fires.
	 */
	async recordStateChange(
		userId: string,
		guildId: string,
		voiceState: VoiceState,
	): Promise<void> {
		const key = `${userId}:${guildId}`;

		// Clear existing timer
		this.clearStateChangeTimer(key);

		// Set new timer - fetch fresh state when timer fires
		const timer = setTimeout(async () => {
			try {
				// FIXED: Fetch current session from DB, not from captured closure
				const session = await this.repository.getActiveSession(userId, guildId);
				if (session) {
					await this.updateSessionAnalytics(session, voiceState);
				}
			} catch (error) {
				console.error("🔸 Failed to update session analytics:", error);
			} finally {
				this.stateChangeTimers.delete(key);
			}
		}, 5000); // 5 second debounce

		this.stateChangeTimers.set(key, timer);
	}

	/**
	 * Record channel switch event
	 */
	async recordChannelSwitch(
		userId: string,
		guildId: string,
		fromChannelId: string,
		toChannelId: string,
		sessionId: string,
	): Promise<void> {
		// Update session with new channel
		await this.repository.updateSession(sessionId, {
			channel_id: toChannelId,
		});

		// Record history event
		await this.repository.recordHistory({
			guild_id: guildId,
			user_id: userId,
			event_type: "switch",
			from_channel_id: fromChannelId,
			to_channel_id: toChannelId,
			session_id: sessionId,
			timestamp: new Date(),
		});

		// Get human-readable names for logging
		const guild = this.client?.guilds.cache.get(guildId);
		if (guild) {
			const member = guild.members.cache.get(userId);
			const fromChannel = guild.channels.cache.get(fromChannelId);
			const toChannel = guild.channels.cache.get(toChannelId);

			const displayName = member?.displayName || userId;
			const fromName = fromChannel?.name || fromChannelId;
			const toName = toChannel?.name || toChannelId;

			console.log(
				`🔹 [SESSION] ${displayName} switched from ${fromName} to ${toName}`,
			);
		} else {
			console.log(
				`🔹 [SESSION] User ${userId} switched from ${fromChannelId} to ${toChannelId}`,
			);
		}
	}

	/**
	 * Get active session for a user
	 */
	async getActiveSession(
		userId: string,
		guildId: string,
	): Promise<VoiceSessionData | null> {
		return this.repository.getActiveSession(userId, guildId);
	}

	/**
	 * Update session analytics based on current voice state
	 *
	 * Calculates time spent muted, deafened, streaming
	 */
	private async updateSessionAnalytics(
		session: VoiceSessionData,
		voiceState: VoiceState,
	): Promise<void> {
		const now = Date.now();
		const startTime = new Date(session.joined_at).getTime();
		const elapsed = Math.floor((now - startTime) / 1000);

		// Calculate analytics based on current state
		const updates: SessionUpdate = {};

		// Track mute time (estimate based on current state)
		if (voiceState.selfMute || voiceState.mute) {
			updates.time_muted = Math.max(session.time_muted, elapsed);
		}

		// Track deaf time
		if (voiceState.selfDeaf || voiceState.deaf) {
			updates.time_deafened = Math.max(session.time_deafened, elapsed);
		}

		// Track streaming time
		if (voiceState.streaming) {
			updates.time_streaming = Math.max(session.time_streaming, elapsed);
		}

		// Only update if there are changes
		if (Object.keys(updates).length > 0) {
			await this.repository.updateSession(session.id, updates);
		}

		// Update voice state
		await this.repository.upsertVoiceState({
			id: `${session.guild_id}_${session.user_id}`,
			guild_id: session.guild_id,
			user_id: session.user_id,
			channel_id: session.channel_id,
			session_id: session.id,
			self_mute: voiceState.selfMute || false,
			self_deaf: voiceState.selfDeaf || false,
			server_mute: voiceState.mute || false,
			server_deaf: voiceState.deaf || false,
			streaming: voiceState.streaming || false,
			self_video: voiceState.selfVideo || false,
		});

		// Record state change in history
		await this.repository.recordHistory({
			guild_id: session.guild_id,
			user_id: session.user_id,
			channel_id: session.channel_id,
			event_type: "state_change",
			session_id: session.id,
			self_mute: voiceState.selfMute || false,
			self_deaf: voiceState.selfDeaf || false,
			server_mute: voiceState.mute || false,
			server_deaf: voiceState.deaf || false,
			streaming: voiceState.streaming || false,
			self_video: voiceState.selfVideo || false,
			timestamp: new Date(),
		});
	}

	/**
	 * Clear state change timer
	 */
	private clearStateChangeTimer(key: string): void {
		const timer = this.stateChangeTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.stateChangeTimers.delete(key);
		}
	}

	/**
	 * Cleanup on shutdown
	 */
	async cleanup(): Promise<void> {
		// Clear all timers
		for (const timer of this.stateChangeTimers.values()) {
			clearTimeout(timer);
		}
		this.stateChangeTimers.clear();
		this.sessionStartTimes.clear();

		console.log("🔹 [SESSION] Cleaned up session service");
	}
}
