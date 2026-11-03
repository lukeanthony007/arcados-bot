import type {
	Client,
	MessageReaction,
	User,
	GuildMember,
	Role,
	VoiceState,
} from "discord.js";
import { Message } from "discord.js";
import type { SyncCoordinator } from "./SyncCoordinator";
import { PostgreSQLManager } from "../../database/PostgreSQLManager";
import { EmbeddingService } from "../social-intelligence/semantic-analysis/EmbeddingService";

/**
 * Real-time Discord event synchronization
 *
 * Responsibilities:
 * - Listen to Discord events (messageCreate, memberUpdate, etc.)
 * - Immediately sync state to PostgreSQL
 * - Conversations and closeness are derived from stored messages elsewhere (no state here)
 * - Manage watermarks for processed messages
 *
 * Priority: HIGH (real-time, user-facing)
 * Coordination: Uses SyncCoordinator to prevent conflicts with ReconciliationSync
 */
export class LiveEventSync {
	private client: Client;
	private db: PostgreSQLManager;
	private coordinator: SyncCoordinator;
	private verbose: boolean;
	private embeddingService: EmbeddingService;

	// Deduplication for Discord event retries
	private recentMessageIds: Map<string, number> = new Map(); // messageId -> timestamp
	private readonly MESSAGE_DEDUP_WINDOW = 5000; // 5 seconds
	private readonly MAX_RECENT_MESSAGES = 1000;

	// Statistics
	private stats = {
		messagesProcessed: 0,
		reactionsSynced: 0,
		membersSynced: 0,
		duplicatesSkipped: 0,
		voiceEventsProcessed: 0,
	};

	constructor(
		client: Client,
		db: PostgreSQLManager,
		coordinator: SyncCoordinator,
		verbose: boolean = false
	) {
		this.client = client;
		this.db = db;
		this.coordinator = coordinator;
		this.verbose = verbose;
		this.embeddingService = EmbeddingService.getInstance();
	}

	/**
	 * Start watching Discord events
	 */
	start(): void {
		console.log("🔹 LiveEventSync: Starting event listeners");

		this.client.on("messageCreate", (message) => {
			this.handleMessageCreate(message).catch((err) => {
				console.error("🔸 LiveEventSync: Error in messageCreate handler:", err);
			});
		});

		this.client.on("messageUpdate", (oldMessage, newMessage) => {
			if (newMessage instanceof Message && !newMessage.author?.bot) {
				this.handleMessageUpdate(newMessage).catch((err) => {
					console.error("🔸 LiveEventSync: Error in messageUpdate handler:", err);
				});
			}
		});

		this.client.on("messageDelete", (message) => {
			if (message instanceof Message && !message.author?.bot) {
				this.handleMessageDelete(message).catch((err) => {
					console.error("🔸 LiveEventSync: Error in messageDelete handler:", err);
				});
			}
		});

		this.client.on("messageReactionAdd", (reaction, user) => {
			if (user && !user.bot && !user.partial && !reaction.partial) {
				this.handleReactionAdd(reaction, user).catch((err) => {
					console.error("🔸 LiveEventSync: Error in reactionAdd handler:", err);
				});
			}
		});

		this.client.on("messageReactionRemove", (reaction, user) => {
			if (user && !user.bot && !user.partial && !reaction.partial) {
				this.handleReactionRemove(reaction, user).catch((err) => {
					console.error("🔸 LiveEventSync: Error in reactionRemove handler:", err);
				});
			}
		});

		this.client.on("guildMemberAdd", (member) => {
			this.handleGuildMemberAdd(member as GuildMember).catch(() => {});
		});

		this.client.on("guildMemberRemove", (member) => {
			this.handleGuildMemberRemove(member as GuildMember).catch(() => {});
		});

		// Voice state updates are now handled directly in Bot.ts via VoiceStateCoordinator
		// No need for LiveEventSync to handle voice events
	}

	/**
	 * Handle new message
	 */
	private async handleMessageCreate(message: Message): Promise<void> {
		// Deduplication check (Discord sometimes resends events)
		if (this.isMessageDuplicate(message.id)) {
			this.stats.duplicatesSkipped++;
			return;
		}

		if (!message.guildId) {
			return;
		}

		const guildId = message.guildId;
		const authorId = message.author.id;
		const timestamp = message.createdAt;

		try {
			// Ensure guild exists (foreign key constraint protection)
			const guild = message.guild;
			if (guild) {
				const releaseLock = await this.coordinator.acquireGuildLock(guild.id);
				try {
					await this.db.upsertGuild({
						id: guild.id,
						name: guild.name,
						description: guild.description || undefined,
						icon: guild.icon || undefined,
						owner_id: guild.ownerId || "",
						member_count: guild.memberCount,
						active: true,
						created_at: guild.createdAt || new Date(),
					});
				} finally {
					releaseLock();
				}
			}

			// Ensure channel exists (foreign key constraint protection)
			const channel = message.channel;
			if (channel && "name" in channel) {
				const releaseLock = await this.coordinator.acquireChannelLock(channel.id);
				try {
					await this.db.upsertChannel({
						id: channel.id,
						guild_id: guildId,
						name: (channel as any).name || "",
						type: channel.type,
						position: (channel as any).position || 0,
						topic: (channel as any).topic || undefined,
						nsfw: (channel as any).nsfw || false,
						parent_id: (channel as any).parentId || undefined,
						active: true,
					});
				} finally {
					releaseLock();
				}
			}

			// Generate embedding for message content (if it has meaningful text)
			let embedding: number[] | undefined = undefined;
			if (message.content && message.content.trim().length > 0) {
				try {
					embedding = await this.embeddingService.generateEmbedding(message.content);
				} catch (error) {
					if (this.verbose) {
						console.error(`🔸 LiveEventSync: Failed to generate embedding for message ${message.id}:`, error);
					}
					// Continue without embedding - will be backfilled later if needed
				}
			}

			// Save message to database (ALL messages, including bots)
			const result = await this.db.upsertMessage({
				id: message.id,
				guild_id: guildId,
				channel_id: message.channel.id,
				author_id: authorId,
				content: message.content || "",
				created_at: timestamp,
				edited_at: message.editedAt || undefined,
				attachments: Array.from(message.attachments.values()).map(
					(a: any) => a.url
				),
				embeds: message.embeds.map((e: any) => JSON.stringify(e.toJSON())),
				referenced_message_id: message.reference?.messageId || undefined,
				embedding: embedding,
				active: true,
			});

			if (!result.success) {
				console.error(`🔸 LiveEventSync: Failed to save message ${message.id}:`, result.error);
				return;
			}

			// Update watermark (LiveEventSync has priority for forward progress)
			await this.coordinator.tryUpdateWatermark(
				message.channel.id,
				message.id,
				"live"
			);

			this.stats.messagesProcessed++;
		} catch (error) {
			console.error(`🔸 LiveEventSync: Exception saving message ${message.id}:`, error);
			throw error;
		}
	}

	/**
	 * Handle message update
	 */
	private async handleMessageUpdate(message: Message): Promise<void> {
		if (!message.guildId || message.author.bot) return;

		try {
			await this.db.upsertMessage({
				id: message.id,
				guild_id: message.guildId,
				channel_id: message.channel.id,
				author_id: message.author.id,
				content: message.content || "",
				created_at: message.createdAt,
				edited_at: message.editedAt || undefined,
				attachments: Array.from(message.attachments.values()).map(
					(a: any) => a.url
				),
				embeds: message.embeds.map((e: any) => JSON.stringify(e.toJSON())),
				referenced_message_id: message.reference?.messageId || undefined,
				active: true,
			});
		} catch (error) {
			console.error(`🔸 LiveEventSync: Exception updating message ${message.id}:`, error);
		}
	}

	/**
	 * Handle message delete
	 */
	private async handleMessageDelete(message: Message): Promise<void> {
		if (!message.guildId || message.author.bot) return;

		await this.db.query("UPDATE messages SET active = false WHERE id = $1", [
			message.id,
		]);
	}

	/**
	 * Handle reaction add
	 */
	private async handleReactionAdd(
		reaction: MessageReaction,
		user: User
	): Promise<void> {
		if (!reaction.message.guildId || user.bot) return;

		let authorId: string | null = null;

		if (reaction.message.author) {
			authorId = reaction.message.author.id;
		} else {
			try {
				const message = await reaction.message.fetch();
				if (message.author) {
					authorId = message.author.id;
				}
			} catch (err) {
				return;
			}
		}

		if (!authorId || authorId === user.id) return;

		// Reactions are the one interaction messages don't carry; closeness counts them
		await this.db.query(
			`INSERT INTO message_reactions (guild_id, message_id, user_id, author_id, emoji, created_at)
			 VALUES ($1, $2, $3, $4, $5, NOW())
			 ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
			[reaction.message.guildId, reaction.message.id, user.id, authorId, reaction.emoji.toString()],
		);

		this.stats.reactionsSynced++;
	}

	/**
	 * Handle reaction remove
	 */
	private async handleReactionRemove(reaction: MessageReaction, user: User): Promise<void> {
		if (!reaction.message.guildId) return;
		await this.db.query(
			"DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
			[reaction.message.id, user.id, reaction.emoji.toString()],
		);
	}

	/**
	 * Handle member add (rejoin with role restoration)
	 */
	private async handleGuildMemberAdd(member: GuildMember): Promise<void> {
		try {
			const guildId = member.guild.id;
			const userId = member.user.id;

			const releaseLock = await this.coordinator.acquireMemberLock(`${guildId}_${userId}`);

			try {
				// Fetch last known roles from DB
				// Prioritize records with roles, then by most recent update
				const rolesResult = await this.db.query(
					`SELECT roles FROM members
					 WHERE guild_id = $1 AND user_id = $2
					 ORDER BY 
					   CASE WHEN array_length(roles, 1) IS NOT NULL THEN 0 ELSE 1 END,
					   updated_at DESC
					 LIMIT 1`,
					[guildId, userId]
				);

				const roles: string[] =
					rolesResult.success && rolesResult.data && rolesResult.data.length > 0
						? rolesResult.data[0].roles || []
						: [];

				// Filter out @everyone role (it's always present, not a real role)
				const filteredRoles = roles.filter((roleId: string) => roleId !== member.guild.id);

				// Restore roles if available
				if (filteredRoles.length > 0) {
					const me = member.guild.members.me;
					const assignableIds = filteredRoles.filter((roleId: string) => {
						const role: Role | undefined = member.guild.roles.cache.get(roleId);
						if (!role) {
							if (this.verbose) {
								console.log(`🔸 Role ${roleId} no longer exists in guild, skipping`);
							}
							return false;
						}
						if (role.managed) {
							if (this.verbose) {
								console.log(`🔸 Role ${role.name} is managed (bot/integration), skipping`);
							}
							return false;
						}
						if (!me) return false;
						if (me.roles.highest.position <= role.position) {
							if (this.verbose) {
								console.log(`🔸 Role ${role.name} is higher than bot's highest role, skipping`);
							}
							return false;
						}
						return true;
					});

					if (assignableIds.length > 0) {
						try {
							await member.roles.add(
								assignableIds,
								"Reapplying previous roles on rejoin"
							);
							console.log(
								`🔹 Restored ${assignableIds.length} role(s) for ${member.user.username} (${member.user.id})`
							);
						} catch (error) {
							console.error(
								`🔸 Failed to restore roles for ${member.user.username}:`,
								error
							);
						}
					} else if (filteredRoles.length > 0) {
						if (this.verbose) {
							console.log(
								`🔸 User ${member.user.username} had ${filteredRoles.length} role(s) but none were assignable`
							);
						}
					}
				}

				// Upsert member as active
				await this.db.upsertMember({
					id: `${guildId}_${userId}`,
					guild_id: guildId,
					user_id: userId,
					username: member.user.username,
					display_name: member.displayName,
					global_name: member.user.globalName || undefined,
					avatar: member.user.avatar || undefined,
					avatar_decoration: member.user.avatarDecoration || undefined,
					banner: member.user.banner || undefined,
					accent_color: member.user.accentColor || undefined,
					discriminator: member.user.discriminator,
					bio: undefined,
					flags: member.user.flags?.bitfield || undefined,
					premium_type: undefined,
					public_flags: member.user.flags?.bitfield || undefined,
					bot: member.user.bot,
					system: member.user.system || undefined,
					nick: member.nickname || undefined,
					joined_at: member.joinedAt || new Date(),
					roles: Array.from(member.roles.cache.keys()),
					permissions: member.permissions.bitfield.toString(),
					communication_disabled_until:
						member.communicationDisabledUntil || undefined,
					pending: member.pending || undefined,
					premium_since: member.premiumSince || undefined,
					timeout: undefined,
					active: true,
					created_at: member.user.createdAt || new Date(),
					updated_at: new Date(),
				});

				this.stats.membersSynced++;
			} finally {
				releaseLock();
			}
		} catch (error) {
			// Silent failure
		}
	}

	/**
	 * Handle member remove (mark inactive and preserve roles)
	 */
	private async handleGuildMemberRemove(member: GuildMember): Promise<void> {
		try {
			const guildId = member.guild.id;
			const userId = member.user.id;

			const releaseLock = await this.coordinator.acquireMemberLock(`${guildId}_${userId}`);

			try {
				// Save current roles before marking inactive
				// This ensures we have the latest roles when they rejoin
				const currentRoles = Array.from(member.roles.cache.keys()).filter(
					(roleId) => roleId !== guildId // Exclude @everyone role
				);

				await this.db.query(
					`UPDATE members 
					 SET active = false, 
					     roles = $3,
					     updated_at = NOW()
					 WHERE guild_id = $1 AND user_id = $2`,
					[guildId, userId, currentRoles]
				);

				if (this.verbose && currentRoles.length > 0) {
					console.log(
						`🔹 Saved ${currentRoles.length} role(s) for ${member.user.username} before they left`
					);
				}
			} finally {
				releaseLock();
			}
		} catch (error) {
			// Silent failure
		}
	}


	/**
	 * Check if message was already processed (deduplication)
	 */
	private isMessageDuplicate(messageId: string): boolean {
		const now = Date.now();
		const lastSeen = this.recentMessageIds.get(messageId);

		if (!lastSeen) {
			this.recentMessageIds.set(messageId, now);
			this.cleanupOldMessages(now);
			return false;
		}

		if (now - lastSeen < this.MESSAGE_DEDUP_WINDOW) {
			return true;
		}

		this.recentMessageIds.set(messageId, now);
		return false;
	}

	/**
	 * Clean up old message IDs to prevent unbounded memory growth
	 */
	private cleanupOldMessages(now: number): void {
		if (this.recentMessageIds.size > this.MAX_RECENT_MESSAGES) {
			const entriesToRemove = this.recentMessageIds.size - this.MAX_RECENT_MESSAGES;
			let removed = 0;

			for (const [messageId, timestamp] of this.recentMessageIds.entries()) {
				if (now - timestamp > this.MESSAGE_DEDUP_WINDOW) {
					this.recentMessageIds.delete(messageId);
					removed++;
					if (removed >= entriesToRemove) break;
				}
			}
		}
	}

	/**
	 * Stop watching (cleanup)
	 */
	async stop(): Promise<void> {
		console.log("🔹 LiveEventSync stopped");
	}

	/**
	 * Get statistics
	 */
	getStats(): {
		messagesProcessed: number;
		reactionsSynced: number;
		membersSynced: number;
	} {
		return {
			messagesProcessed: this.stats.messagesProcessed,
			reactionsSynced: this.stats.reactionsSynced,
			membersSynced: this.stats.membersSynced,
		};
	}
}
