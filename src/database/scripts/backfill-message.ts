/**
 * Backfill a specific message ID from Discord to the database
 * Useful for recovering messages that were missed during bot downtime
 */

import { PostgreSQLManager } from "../PostgreSQLManager";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "../../config";
import { EmbeddingService } from "../../features/social-intelligence/semantic-analysis/EmbeddingService";

const MESSAGE_ID = "1443628188629602525";

const db = new PostgreSQLManager();
const embeddingService = EmbeddingService.getInstance();

async function main() {
  console.log(`🔍 Backfilling message ID: ${MESSAGE_ID}\n`);
  console.log("=".repeat(80));

  // Connect to database
  const connected = await db.connect();
  if (!connected) {
    console.error("❌ Failed to connect to database");
    process.exit(1);
  }

  // Check if message already exists
  const existingResult = await db.query(
    `SELECT id FROM messages WHERE id = $1`,
    [MESSAGE_ID]
  );

  if (existingResult.success && existingResult.data && existingResult.data.length > 0) {
    console.log("🔹 Message already exists in database");
    await db.disconnect();
    return;
  }

  // Connect to Discord
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(config.botToken);

  // Wait for ready event
  await new Promise<void>((resolve) => {
    client.once(Events.ClientReady, () => {
      console.log(`🔹 Logged in as ${client.user?.tag}`);
      resolve();
    });
  });

  try {
    const guildId = config.guildId;
    if (!guildId) {
      console.error("❌ No guild ID configured");
      client.destroy();
      await db.disconnect();
      return;
    }

    const guild = await client.guilds.fetch(guildId);
    console.log(`🔍 Searching in guild: ${guild.name}`);

    // Search all text channels for the message
    const channels = guild.channels.cache.filter((ch: any) => ch.isTextBased());
    console.log(`   Checking ${channels.size} channels...`);

    let found = false;
    let message: any = null;
    let channelName = '';

    for (const [, channel] of channels) {
      try {
        const msg = await (channel as any).messages.fetch(MESSAGE_ID);
        if (msg) {
          found = true;
          message = msg;
          channelName = (channel as any).name;
          break;
        }
      } catch (error) {
        // Message not in this channel, continue
      }
    }

    if (!found || !message) {
      console.log("❌ Message NOT FOUND in Discord");
      console.log("   The message may have been deleted or is in an inaccessible channel");
      client.destroy();
      await db.disconnect();
      return;
    }

    console.log(`🔹 Message found in Discord`);
    console.log(`   Channel: #${channelName}`);
    console.log(`   Author: ${message.author.tag} (${message.author.id})`);
    console.log(`   Created: ${message.createdAt.toLocaleString()}`);
    console.log(`   Bot: ${message.author.bot ? 'Yes' : 'No'}`);

    // Ensure guild exists
    await db.upsertGuild({
      id: guild.id,
      name: guild.name,
      description: guild.description || undefined,
      icon: guild.icon || undefined,
      owner_id: guild.ownerId || "",
      member_count: guild.memberCount,
      active: true,
      created_at: guild.createdAt || new Date(),
    });

    // Ensure channel exists
    const channel = message.channel;
    if (channel && "name" in channel) {
      await db.upsertChannel({
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
    }

    // Generate embedding if message has content
    let embedding: number[] | undefined = undefined;
    if (message.content && message.content.trim().length > 0) {
      try {
        embedding = await embeddingService.generateEmbedding(message.content);
        console.log("   🔹 Generated embedding");
      } catch (error) {
        console.warn(`   ⚠️  Failed to generate embedding: ${error}`);
      }
    }

    // Save message to database
    console.log("\n💾 Saving message to database...");
    const result = await db.upsertMessage({
      id: message.id,
      guild_id: guildId,
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
      embedding: embedding,
      active: true,
    });

    if (result.success) {
      console.log("🔹 Message successfully backfilled to database!");
      
      // Update watermark if this is the newest message in the channel
      const watermarkResult = await db.getChannelWatermark(message.channel.id);
      const currentWatermark = watermarkResult.success && watermarkResult.data
        ? watermarkResult.data.last_message_id
        : null;

      if (!currentWatermark || BigInt(message.id) > BigInt(currentWatermark)) {
        await db.updateChannelLastMessage(message.channel.id, message.id);
        console.log("   🔹 Updated channel watermark");
      }
    } else {
      console.error(`❌ Failed to save message: ${result.error}`);
    }

  } catch (error) {
    console.error("❌ Error backfilling message:", error);
  }

  console.log("\n" + "=".repeat(80));
  console.log("🔹 Backfill complete\n");

  client.destroy();
  await db.disconnect();
}

main().catch(console.error);

