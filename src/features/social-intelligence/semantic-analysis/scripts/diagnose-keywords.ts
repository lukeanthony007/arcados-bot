/**
 * Diagnose Keyword Extraction Issues
 * 
 * This script investigates why some conversations don't have keywords extracted.
 * It checks message content, embeddings, and attempts keyword extraction to identify failures.
 */

import { PostgreSQLManager } from "../../../../database/PostgreSQLManager";
import { KeywordExtractor } from "../KeywordExtractor";
import { config } from "../../../../config";

interface ConversationSegment {
  id: string;
  message_ids: string[];
  message_count: number;
  features: any;
  start_time: Date;
  end_time: Date;
}

interface Message {
  id: string;
  content: string;
  author_id: string;
  embedding: any;
  created_at: Date;
  content_length: number;
}

function parseEmbedding(embeddingData: unknown): number[] | undefined {
  if (!embeddingData) return undefined;
  if (Array.isArray(embeddingData)) return embeddingData;
  if (typeof embeddingData === "string") {
    try {
      return JSON.parse(embeddingData);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const db = new PostgreSQLManager();

async function main() {
  console.log("🔍 Diagnosing keyword extraction issues\n");
  console.log("=".repeat(80));

  const connected = await db.connect();
  if (!connected) {
    console.error("❌ Failed to connect to database");
    process.exit(1);
  }

  const guildId = config.guildId;
  if (!guildId) {
    console.error("❌ No guild ID configured");
    await db.disconnect();
    process.exit(1);
  }

  // Find segments without keywords
  const segmentsResult = await db.query(
    `
    SELECT 
      id, 
      message_ids, 
      message_count,
      features,
      start_time,
      end_time,
      EXTRACT(EPOCH FROM (end_time - start_time))/60 as duration_minutes
    FROM conversation_segments
    WHERE guild_id = $1
      AND status = 'finalized'
      AND start_time > NOW() - INTERVAL '24 hours'
      AND (
        features IS NULL
        OR NOT (COALESCE(features, '{}'::jsonb) ? 'keywords')
        OR jsonb_array_length(
          COALESCE(features->'keywords'->'terms', '[]'::jsonb)
        ) = 0
      )
    ORDER BY end_time DESC
    `,
    [guildId]
  );

  if (!segmentsResult.success || !segmentsResult.data) {
    console.log("🔹 No segments missing keywords!");
    await db.disconnect();
    return;
  }

  const segments: ConversationSegment[] = segmentsResult.data;
  console.log(`\n📊 Found ${segments.length} segments without keywords\n`);

  const keywordExtractor = new KeywordExtractor(db);

  for (const segment of segments) {
    console.log("─".repeat(80));
    console.log(`\n🔍 Analyzing Segment: ${segment.id}`);
    console.log(`   Time: ${segment.start_time.toLocaleString()} - ${segment.end_time.toLocaleString()}`);
    console.log(`   Message IDs: ${segment.message_ids.length} total`);

    // Check if message_ids is valid
    if (!Array.isArray(segment.message_ids) || segment.message_ids.length === 0) {
      console.log("   ❌ ISSUE: message_ids is empty or not an array");
      continue;
    }

    // Fetch the messages
    const messagesResult = await db.query(
      `
      SELECT 
        id, 
        content, 
        author_id, 
        embedding,
        created_at,
        LENGTH(TRIM(content)) as content_length
      FROM messages
      WHERE id = ANY($1)
      ORDER BY created_at ASC
      `,
      [segment.message_ids]
    );

    if (!messagesResult.success || !messagesResult.data) {
      console.log("   ❌ ISSUE: Failed to fetch messages from database");
      continue;
    }

    const allMessages: Message[] = messagesResult.data;
    console.log(`   📝 Fetched ${allMessages.length} messages`);

    // Filter messages with content
    const messagesWithContent = allMessages.filter(
      (m: any) => m.content && m.content.trim().length > 0
    );
    console.log(`   📝 Messages with content: ${messagesWithContent.length}`);

    if (messagesWithContent.length === 0) {
      console.log("   ❌ ISSUE: No messages with non-empty content");
      continue;
    }

    // Check messages without content
    const messagesWithoutContent = allMessages.filter(
      (m: any) => !m.content || m.content.trim().length === 0
    );
    if (messagesWithoutContent.length > 0) {
      console.log(`   ⚠️  ${messagesWithoutContent.length} messages have empty content`);
    }

    // Check embeddings
    const messagesWithEmbeddings = messagesWithContent.filter(
      (m: any) => m.embedding
    );
    console.log(`   🧠 Messages with embeddings: ${messagesWithEmbeddings.length}/${messagesWithContent.length}`);

    // Show sample of messages
    console.log(`\n   📋 Sample messages (first 3):`);
    for (let i = 0; i < Math.min(3, messagesWithContent.length); i++) {
      const msg = messagesWithContent[i];
      if (!msg) continue;
      const preview = msg.content.substring(0, 80).replace(/\n/g, " ");
      console.log(`      ${i + 1}. [${msg.content_length} chars] ${preview}${msg.content.length > 80 ? "..." : ""}`);
      console.log(`         Has embedding: ${msg.embedding ? "🔹" : "❌"}`);
    }

    // Attempt keyword extraction
    console.log(`\n   🧪 Attempting keyword extraction...`);
    try {
      const keywordMessages = messagesWithContent.map((msg: Message) => ({
        id: msg.id,
        content: msg.content,
        author_id: msg.author_id,
        embedding: parseEmbedding(msg.embedding),
      }));

      const keywords = await keywordExtractor.extractKeywords(
        keywordMessages,
        guildId,
        { topN: 10, method: "hybrid" }
      );

      if (!keywords || !keywords.terms || keywords.terms.length === 0) {
        console.log("   ❌ ISSUE: Keyword extraction returned empty results");
        console.log("   Result:", JSON.stringify(keywords, null, 2));
      } else {
        console.log(`   🔹 Successfully extracted ${keywords.terms.length} keywords!`);
        console.log("   Top keywords:");
        keywords.terms.slice(0, 5).forEach((kw: any) => {
          console.log(`      - ${kw.word} (${Math.round(kw.score * 100)}%)`);
        });
        console.log("\n   💡 Keywords CAN be extracted - check if ReconciliationSync is running");
      }
    } catch (error) {
      console.log("   ❌ ISSUE: Keyword extraction threw an error");
      console.log("   Error:", error);
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log("🔹 Diagnosis complete\n");

  await db.disconnect();
}

main().catch(console.error);

