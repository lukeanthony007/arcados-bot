#!/usr/bin/env bun
/**
 * Generate Server Summary Script
 *
 * Builds a concise, reusable summary of the Discord server from recent
 * conversation segment summaries and stores it on the guild row.
 */

import { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { OmpRuntime } from "../../../ai/runtime/OmpRuntime";
import { config } from "../../../config/index.js";

const db = new PostgreSQLManager();

async function main() {
  console.log("🤖 Generating Server Summary");
  console.log("=".repeat(80));

  const args = process.argv.slice(2);
  const hoursBack = args[0] ? Number.parseInt(args[0], 10) : 0; // 0 = lifetime
  const dryRun = args.includes("--dry-run");

  if (hoursBack > 0) {
    console.log(`Time window: Past ${hoursBack} hours`);
  } else {
    console.log("Time window: Lifetime (all conversation segments)");
  }
  console.log(
    `Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will update guilds.server_summary)"}`
  );
  console.log("=".repeat(80));

  const connected = await db.connect();
  if (!connected) {
    console.error("❌ Failed to connect to database");
    console.error("💡 Make sure POSTGRES_URL is set in your .env file");
    process.exit(1);
  }

  const guildId = config.guildId;
  if (!guildId) {
    console.error("❌ No guild ID configured");
    console.error("💡 Set GUILD_ID in your .env file");
    await db.disconnect();
    process.exit(1);
  }

  try {
    // Load guild name (optional, for nicer prompts)
    const guildResult = await db.query(
      `
      SELECT name, server_summary
      FROM guilds
      WHERE id = $1
      `,
      [guildId]
    );

    const guildRow =
      guildResult.success && guildResult.data && guildResult.data[0]
        ? guildResult.data[0]
        : null;

    const guildName = guildRow?.name || guildId;

    // Identify hub users based on relationship_pairs (most socially central members)
    const hubResult = await db.query(
      `
      SELECT user_id, SUM(total_interactions) AS hub_score
      FROM (
        SELECT guild_id, u_min AS user_id, total_interactions
        FROM relationship_pairs
        WHERE guild_id = $1
        UNION ALL
        SELECT guild_id, u_max AS user_id, total_interactions
        FROM relationship_pairs
        WHERE guild_id = $1
      ) t
      GROUP BY user_id
      ORDER BY hub_score DESC
      LIMIT 15
      `,
      [guildId]
    );

    const hubUsers: string[] =
      hubResult.success && hubResult.data
        ? hubResult.data.map((row: any) => String(row.user_id))
        : [];

    // Fetch finalized conversation segments with summaries (lifetime, capped),
    // biased toward conversations involving hub users, plus a smaller sample
    // of other conversations for diversity.
    let segments: any[] = [];

    if (hubUsers.length > 0) {
      const hubSegmentsResult = await db.query(
        `
        SELECT
          cs.id,
          cs.channel_id,
          cs.summary,
          cs.message_count,
          cs.start_time,
          cs.end_time,
          c.name as channel_name
        FROM conversation_segments cs
        LEFT JOIN channels c ON cs.channel_id = c.id
        WHERE cs.guild_id = $1
          AND cs.summary IS NOT NULL
          AND cs.summary <> ''
          AND cs.status = 'finalized'
          AND cs.participants && $2::text[]
        ORDER BY cs.end_time DESC, cs.message_count DESC
        LIMIT 90
        `,
        [guildId, hubUsers]
      );

      const otherSegmentsResult = await db.query(
        `
        SELECT
          cs.id,
          cs.channel_id,
          cs.summary,
          cs.message_count,
          cs.start_time,
          cs.end_time,
          c.name as channel_name
        FROM conversation_segments cs
        LEFT JOIN channels c ON cs.channel_id = c.id
        WHERE cs.guild_id = $1
          AND cs.summary IS NOT NULL
          AND cs.summary <> ''
          AND cs.status = 'finalized'
          AND NOT (cs.participants && $2::text[])
        ORDER BY cs.end_time DESC, cs.message_count DESC
        LIMIT 40
        `,
        [guildId, hubUsers]
      );

      const merged: Map<string, any> = new Map();

      if (hubSegmentsResult.success && hubSegmentsResult.data) {
        for (const row of hubSegmentsResult.data) {
          merged.set(row.id, row);
        }
      }
      if (otherSegmentsResult.success && otherSegmentsResult.data) {
        for (const row of otherSegmentsResult.data) {
          if (!merged.has(row.id)) {
            merged.set(row.id, row);
          }
        }
      }

      segments = Array.from(merged.values());
    } else {
      const segmentsQuery = `
        SELECT
          cs.id,
          cs.channel_id,
          cs.summary,
          cs.message_count,
          cs.start_time,
          cs.end_time,
          c.name as channel_name
        FROM conversation_segments cs
        LEFT JOIN channels c ON cs.channel_id = c.id
        WHERE cs.guild_id = $1
          AND cs.summary IS NOT NULL
          AND cs.summary <> ''
          AND cs.status = 'finalized'
        ORDER BY cs.end_time DESC, cs.message_count DESC
        LIMIT 120
      `;

      const segmentsResult = await db.query(segmentsQuery, [guildId]);

      if (segmentsResult.success && segmentsResult.data) {
        segments = segmentsResult.data;
      }
    }

    if (!segments || segments.length === 0) {
      console.error(
        "❌ No conversation segments with summaries found. Run generate-summaries first."
      );
      await db.disconnect();
      process.exit(1);
    }

    console.log(
      `Found ${segments.length} summarized segments (hub-biased sampling: ${hubUsers.length > 0 ? `${hubUsers.length} hub users` : "no hub data"
      }).\n`
    );

    // ==================== Active channels overview ====================
    const channelsResult = await db.query(
      `
      SELECT id, name, topic
      FROM channels
      WHERE guild_id = $1 AND active = true
      ORDER BY COALESCE(last_message_sync, created_at) DESC
      LIMIT 12
      `,
      [guildId]
    );

    let channelOverview = "";
    if (channelsResult.success && channelsResult.data && channelsResult.data.length > 0) {
      const channelLines: string[] = [];
      for (const ch of channelsResult.data) {
        const name = ch.name || ch.id;
        const raw = (ch.topic as string) || "no summary yet";
        const trimmed =
          raw.length > 160 ? raw.slice(0, 157).trimEnd() + "..." : raw;
        channelLines.push(`#${name}: ${trimmed}`);
      }
      channelOverview = channelLines.join("\n");
    }

    // ==================== Core members overview (hub users) ====================
    let memberOverview = "";
    if (hubUsers.length > 0) {
      const membersResult = await db.query(
        `
        SELECT user_id, display_name, username, summary
        FROM members
        WHERE guild_id = $1
          AND user_id = ANY($2::text[])
          AND active = true
        `,
        [guildId, hubUsers]
      );

      if (membersResult.success && membersResult.data && membersResult.data.length > 0) {
        const memberLines: string[] = [];
        for (const m of membersResult.data) {
          const name = m.display_name || m.username || m.user_id;
          const raw = (m.summary as string) || "no persona summary yet";
          const trimmed =
            raw.length > 160 ? raw.slice(0, 157).trimEnd() + "..." : raw;
          memberLines.push(`${name}: ${trimmed}`);
        }
        memberOverview = memberLines.join("\n");
      }
    }

    // ==================== Conversation summaries overview ====================
    const convoLines: string[] = [];
    for (const seg of segments) {
      const channelName = seg.channel_name || seg.channel_id || "unknown-channel";
      const summary: string = seg.summary || "";
      const trimmed =
        summary.length > 180 ? summary.slice(0, 177).trimEnd() + "..." : summary;
      convoLines.push(`#${channelName}: ${trimmed}`);
    }
    const conversationOverview = convoLines.join("\n");

    // ==================== Prompt construction ====================
    const sections: string[] = [];

    sections.push(`Server name: "${guildName}"`);

    if (channelOverview) {
      sections.push(
        `\nActive channels and their vibe (each line is a channel):\n${channelOverview}`
      );
    }

    if (memberOverview) {
      sections.push(
        `\nCore members (social hubs) and who they seem to be here:\n${memberOverview}`
      );
    }

    sections.push(
      `\nConversation summaries across the server (biased toward hub users and high-activity threads):\n${conversationOverview}`
    );

    const structuredContext = sections.join("\n");

    const prompt = `You are summarizing a Discord server for an AI assistant.

The following structured context describes the environment:

${structuredContext}

TASK:
- Ignore the fine-grain details of individual events; read between the lines.
- Infer what this server fundamentally *is* to its members: what they come here for, how they treat each other, and what kind of people stay.
- Capture the **social contract**: the tone (e.g. brutal honesty vs soft support), tolerance for dark humor, and expectations around vulnerability.
- Generalize specific topics (cars, work, health, drama) into broader themes like mutual venting, life logistics, shared chaos, flirting, etc.
- Write 2–3 tight sentences that would help a new member decide if this space fits them, focusing on values, vibe, and typical emotional energy.
- Do NOT list example incidents or micro-topics; describe the overarching patterns, not the anecdotes.
- Avoid meta commentary like "this summary is about"; just describe the server directly.
- Do NOT mention message counts, timestamps, or technical details.

Server summary:`;

    const response = await OmpRuntime.get().generate({
      systemPrompt:
        "You write concise descriptions of Discord communities for an AI assistant. " +
        "Follow the task instructions exactly, including the sentence count, and output only the description.",
      prompt,
      label: "server-lore.summary",
    });

    if (!response.success || !response.content) {
      console.error("❌ Failed to generate server summary:", response.error);
      await db.disconnect();
      process.exit(1);
    }

    const serverSummary = response.content.trim();


    console.log("Generated server summary:\n");
    console.log(serverSummary);
    console.log("\n" + "-".repeat(80) + "\n");

    if (dryRun) {
      console.log("DRY RUN: not writing summary to database.");
      await db.disconnect();
      process.exit(0);
    }

    const updateResult = await db.query(
      `
      UPDATE guilds
      SET server_summary = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [guildId, serverSummary]
    );

    if (!updateResult.success) {
      console.error("❌ Failed to update guilds.server_summary:", updateResult.error);
      await db.disconnect();
      process.exit(1);
    }

    console.log("🔹 Server summary saved to guilds.server_summary\n");
    await db.disconnect();
    console.log("🔹 Disconnected from PostgreSQL");
  } catch (error) {
    console.error("❌ Server summary generation failed:", error);
    await db.disconnect();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});


