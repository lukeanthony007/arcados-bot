import { Pool, PoolClient, QueryResult } from "pg";
import pgvector from "pgvector/pg";
import { config } from "../config/index.js";
import type { ConversationEntry } from "../features/social-intelligence/types";

// Export pgvector for use in other modules
export { pgvector };

export interface DatabaseResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface GuildData {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  owner_id: string;
  created_at: Date;
  member_count: number;
  active: boolean;
}

export interface ChannelData {
  id: string;
  guild_id: string;
  name: string;
  type: number;
  position?: number;
  topic?: string;
  nsfw?: boolean;
  parent_id?: string;
  active: boolean;
}

export interface MemberData {
  // Primary identifiers
  id: string; // Composite key: guild_id-user_id
  guild_id: string;
  user_id: string;

  // User profile data (from member.user)
  username: string;
  display_name: string; // member.displayName
  global_name?: string; // member.user.globalName
  avatar?: string; // member.user.avatar
  avatar_decoration?: string; // member.user.avatarDecoration
  banner?: string; // member.user.banner
  accent_color?: number; // member.user.accentColor
  discriminator: string; // member.user.discriminator
  bio?: string; // member.user.bio
  flags?: number; // member.user.flags
  premium_type?: number; // member.user.premiumType
  public_flags?: number; // member.user.publicFlags
  bot: boolean; // member.user.bot
  system?: boolean; // member.user.system

  // Guild-specific member data
  nick?: string; // member.nickname
  joined_at: Date; // member.joinedAt
  roles: string[]; // member.roles.cache.map(role => role.id)
  permissions: string; // member.permissions.bitfield.toString()
  communication_disabled_until?: Date; // member.communicationDisabledUntil
  pending?: boolean; // member.pending
  premium_since?: Date; // member.premiumSince
  timeout?: Date; // member.timeout

  // Activity and presence (if available)
  status?: string; // member.presence?.status
  activities?: string; // JSON string of activities
  client_status?: string; // JSON string of client status

  // Metadata
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RelationshipEntry {
  user_id: string;
  affinity_percentage: number; // 0-100, percentage of user's total interactions
  interaction_count: number;
  last_interaction: Date;
  summary?: string;
  emojis?: string[];
  notes?: string[];
  conversations?: ConversationEntry[];
  // Additional fields for display and analysis
  display_name?: string;
  username?: string;
  raw_points?: number;
  total_messages?: number;
}

export interface UserProfileData {
  guild_id: string;
  user_id: string;

  // AI profile data
  summary?: string;
  keywords?: string[];
  emojis?: string[];
  notes?: string[];
  aliases?: string[];
  relationship_network?: RelationshipEntry[];

  // Psychological profiling
  psych_profile?: any; // JSONB - Big 5, MBTI, etc.
  behavior_patterns?: any; // JSONB
  temporal_profile?: any; // JSONB

  // Incremental enrichment tracking (UserProfileEnrichmentPipeline)
  last_enriched_conversation_count?: number;
  last_enriched_conversation_id?: string;
  profile_version?: number;
  enrichment_history?: unknown; // JSONB, parsed by IncrementalEnrichment.parseHistory

  // Metadata
  created_at: Date;
  updated_at: Date;
}

export interface UserPersonaData {
  guild_id: string;
  user_id: string;
  display_name: string;
  character_profile: string; // AI-written character sheet (voice, personality, interests)
  style_examples: string[]; // Real messages used as few-shot voice samples
  source_stats: Record<string, unknown>; // What the profile was built from
  created_by?: string;
  created_at: Date;
  updated_at: Date;
}

type UserPersonaRow = Omit<UserPersonaData, "style_examples" | "source_stats" | "created_by"> & {
  style_examples: string[] | null;
  source_stats: Record<string, unknown> | null;
  created_by: string | null;
};

export interface RoleData {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  mentionable: boolean;
  hoist: boolean;
  active: boolean;
}

export interface MessageData {
  id: string;
  guild_id: string;
  channel_id: string;
  author_id: string;
  content: string;
  created_at: Date;
  edited_at?: Date;
  attachments?: string[];
  embeds?: string[];
  referenced_message_id?: string;
  embedding?: number[];
  active: boolean;
}

export class PostgreSQLManager {
  private pool: Pool | null = null;
  private isConnectedFlag = false;
  private vectorExtensionAvailable = false;

  constructor() {
    if (!config.postgresUrl) {
      console.warn(
        "🔸 PostgreSQL URL not configured. Database features will be unavailable."
      );
    }
  }

  async connect(): Promise<boolean> {
    if (!config.postgresUrl) {
      console.log("🔸 PostgreSQL URL not configured");
      return false;
    }

    try {
      this.pool = new Pool({
        connectionString: config.postgresUrl,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000, // Increased from 2s to 10s
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });

      // Register pgvector types for every client from the pool
      // Only register if extension is available (will be set during schema init)
      this.pool.on("connect", async (client) => {
        try {
          await pgvector.registerType(client);
        } catch (error: any) {
          // Silently fail if vector extension isn't available
          // The flag will be set correctly during schema initialization
        }
      });

      // Test the connection
      const client = await this.pool.connect();
      await client.query("SELECT 1");
      client.release();

      this.isConnectedFlag = true;

      // Initialize schema
      await this.initializeSchema();

      return true;
    } catch (error) {
      console.error("🔸 Failed to connect to PostgreSQL:", error);
      this.isConnectedFlag = false;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isConnectedFlag = false;
      console.log("🔹 Disconnected from PostgreSQL");
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag && this.pool !== null;
  }

  private async initializeSchema(): Promise<void> {
    if (!this.isConnected()) return;

    const client = await this.pool!.connect();
    try {
      // Enable pgvector extension for embeddings
      // Gracefully handle if extension is not installed on the server
      try {
        await client.query(`
          CREATE EXTENSION IF NOT EXISTS vector;
        `);
        this.vectorExtensionAvailable = true;
      } catch (extError: any) {
        if (extError?.code === '58P01' || extError?.message?.includes('vector')) {
          console.warn(
            "⚠️  pgvector extension not available on PostgreSQL server. " +
            "Vector operations will be disabled. " +
            "To enable: install pgvector on your PostgreSQL server " +
            "(e.g., 'apt-get install postgresql-XX-pgvector' or compile from source)"
          );
          this.vectorExtensionAvailable = false;

          // If tables already have vector columns, we need to handle them
          // Check and potentially drop vector columns if extension isn't available
          try {
            const hasVectorCol = await client.query(`
              SELECT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'conversation_segments' 
                AND column_name = 'embedding'
                AND data_type = 'USER-DEFINED'
              ) as has_embedding
            `);
            if (hasVectorCol.rows[0]?.has_embedding) {
              console.warn(
                "⚠️  Table 'conversation_segments' has vector column but extension unavailable. " +
                "Queries may fail. Consider dropping the column or installing pgvector."
              );
            }
          } catch (checkError) {
            // Ignore check errors
          }
        } else {
          throw extError; // Re-throw if it's a different error
        }
      }

      // Create tables if they don't exist
      await client.query(`
				CREATE TABLE IF NOT EXISTS guilds (
					id VARCHAR(20) PRIMARY KEY,
					name VARCHAR(100) NOT NULL,
					description TEXT,
					icon VARCHAR(100),
					owner_id VARCHAR(20) NOT NULL,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					member_count INTEGER DEFAULT 0,
					active BOOLEAN DEFAULT true,
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
				)
			`);

      await client.query(`
				CREATE TABLE IF NOT EXISTS channels (
					id VARCHAR(20) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					name VARCHAR(100) NOT NULL,
					type INTEGER NOT NULL,
					position INTEGER,
					topic TEXT,
					nsfw BOOLEAN DEFAULT false,
					parent_id VARCHAR(20),
					active BOOLEAN DEFAULT true,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
				)
			`);

      await client.query(`
				CREATE TABLE IF NOT EXISTS roles (
					id VARCHAR(20) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					name VARCHAR(100) NOT NULL,
					color INTEGER DEFAULT 0,
					position INTEGER DEFAULT 0,
					permissions VARCHAR(20) DEFAULT '0',
					mentionable BOOLEAN DEFAULT false,
					hoist BOOLEAN DEFAULT false,
					active BOOLEAN DEFAULT true,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
				)
			`);

      await client.query(`
				CREATE TABLE IF NOT EXISTS members (
					id VARCHAR(50) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					
					-- User profile data
					username VARCHAR(100) NOT NULL,
					display_name VARCHAR(100) NOT NULL,
					global_name VARCHAR(100),
					avatar VARCHAR(100),
					avatar_decoration VARCHAR(100),
					banner VARCHAR(100),
					accent_color INTEGER,
					discriminator VARCHAR(10) NOT NULL,
					bio TEXT,
					flags INTEGER,
					premium_type INTEGER,
					public_flags INTEGER,
					bot BOOLEAN DEFAULT false,
					system BOOLEAN DEFAULT false,
					
					-- Guild-specific member data
					nick VARCHAR(100),
					joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					roles TEXT[] DEFAULT '{}',
					permissions VARCHAR(20) DEFAULT '0',
					communication_disabled_until TIMESTAMP WITH TIME ZONE,
					pending BOOLEAN DEFAULT false,
					premium_since TIMESTAMP WITH TIME ZONE,
					timeout TIMESTAMP WITH TIME ZONE,
					
					-- Activity and presence
					status VARCHAR(20),
					activities TEXT,
					client_status TEXT,
					
					-- Metadata
					active BOOLEAN DEFAULT true,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					UNIQUE(guild_id, user_id)
				)
			`);

      // User profiles - centralized AI-focused user data
      await client.query(`
				CREATE TABLE IF NOT EXISTS user_profiles (
					guild_id VARCHAR(20) NOT NULL,
					user_id VARCHAR(20) NOT NULL,
					
					-- AI profile data
					summary TEXT,
					keywords TEXT[] DEFAULT '{}',
					emojis TEXT[] DEFAULT '{}',
					notes TEXT[] DEFAULT '{}',
					aliases TEXT[] DEFAULT '{}',
					relationship_network JSONB DEFAULT '[]',
					
					-- Psychological profiling
					psych_profile JSONB DEFAULT '{}',
					behavior_patterns JSONB DEFAULT '{}',
					temporal_profile JSONB DEFAULT '{}',
					
					-- Metadata
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					
					PRIMARY KEY (guild_id, user_id),
					FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE
				)
			`);

      // Incremental enrichment tracking used by UserProfileEnrichmentPipeline
      await client.query(`
				ALTER TABLE user_profiles
				ADD COLUMN IF NOT EXISTS last_enriched_conversation_count INTEGER DEFAULT 0,
				ADD COLUMN IF NOT EXISTS last_enriched_conversation_id VARCHAR(50),
				ADD COLUMN IF NOT EXISTS profile_version INTEGER DEFAULT 1,
				ADD COLUMN IF NOT EXISTS enrichment_history JSONB DEFAULT '[]'::jsonb,
				ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMP WITH TIME ZONE
			`);

      await client.query(`
				CREATE TABLE IF NOT EXISTS messages (
					id VARCHAR(20) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					channel_id VARCHAR(20) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
					author_id VARCHAR(20) NOT NULL,
					content TEXT NOT NULL,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					edited_at TIMESTAMP WITH TIME ZONE,
					attachments TEXT[],
					embeds TEXT[],
					referenced_message_id VARCHAR(20),
					active BOOLEAN DEFAULT true
				)
			`);

      // Add referenced_message_id column if it doesn't exist (migration for existing databases)
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'messages' AND column_name = 'referenced_message_id'
          ) THEN
            ALTER TABLE messages ADD COLUMN referenced_message_id VARCHAR(20);
          END IF;
        END $$;
      `);

      // Add embedding column if it doesn't exist (migration for existing databases)
      // Only add if vector extension is available
      if (this.vectorExtensionAvailable) {
        await client.query(`
          DO $$ 
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM information_schema.columns 
              WHERE table_name = 'messages' AND column_name = 'embedding'
            ) THEN
              ALTER TABLE messages ADD COLUMN embedding vector(768);
            END IF;
          END $$;
        `);
      }

      // Relationship edges - directed dyads for realtime updates
      await client.query(`
				CREATE TABLE IF NOT EXISTS relationship_edges (
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_a VARCHAR(20) NOT NULL,
					user_b VARCHAR(20) NOT NULL,
					last_interaction TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					msg_a_to_b INTEGER DEFAULT 0,
					msg_b_to_a INTEGER DEFAULT 0,
					mentions INTEGER DEFAULT 0,
					replies INTEGER DEFAULT 0,
					reactions INTEGER DEFAULT 0,
					rolling_7d INTEGER DEFAULT 0,
					rolling_30d INTEGER DEFAULT 0,
					total INTEGER DEFAULT 0,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					PRIMARY KEY (guild_id, user_a, user_b)
				)
			`);

      // Conversation segments - multi-participant conversations
      await client.query(`
				CREATE TABLE IF NOT EXISTS conversation_segments (
					id VARCHAR(50) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					channel_id VARCHAR(20) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
					participants TEXT[] NOT NULL,
					start_time TIMESTAMP WITH TIME ZONE NOT NULL,
					end_time TIMESTAMP WITH TIME ZONE NOT NULL,
					message_ids TEXT[] NOT NULL,
					message_count INTEGER NOT NULL,
					features JSONB DEFAULT '{}',
					summary TEXT,
					status VARCHAR(20) DEFAULT 'finalized',
					last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					is_voice_conversation BOOLEAN DEFAULT FALSE,
					voice_channel_id VARCHAR(20),
					voice_participants TEXT[],
					transcription_data JSONB
				)
			`);

      // Add status and last_activity_at columns if they don't exist (migration)
      await client.query(`
				ALTER TABLE conversation_segments
				ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'finalized',
				ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
			`);

      // Add topic drift detection columns (migration)
      await client.query(`
				ALTER TABLE conversation_segments
				ADD COLUMN IF NOT EXISTS topic_label TEXT,
				ADD COLUMN IF NOT EXISTS topic_confidence FLOAT,
				ADD COLUMN IF NOT EXISTS parent_segment_id VARCHAR(50),
				ADD COLUMN IF NOT EXISTS split_reason TEXT
			`);

      // Add voice conversation columns (migration)
      await client.query(`
				ALTER TABLE conversation_segments
				ADD COLUMN IF NOT EXISTS is_voice_conversation BOOLEAN DEFAULT FALSE,
				ADD COLUMN IF NOT EXISTS voice_channel_id VARCHAR(20),
				ADD COLUMN IF NOT EXISTS voice_participants TEXT[],
				ADD COLUMN IF NOT EXISTS transcription_data JSONB
			`);

      // Add embedding column for semantic search (migration)
      // Only add if vector extension is available
      if (this.vectorExtensionAvailable) {
        await client.query(`
					ALTER TABLE conversation_segments
					ADD COLUMN IF NOT EXISTS embedding vector(768)
				`);
      }

      // Relationship pairs - optional cache for quick undirected reads
      await client.query(`
				CREATE TABLE IF NOT EXISTS relationship_pairs (
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					u_min VARCHAR(20) NOT NULL,
					u_max VARCHAR(20) NOT NULL,
					last_interaction TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					total_interactions INTEGER DEFAULT 0,
					segment_ids TEXT[] DEFAULT '{}',
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					PRIMARY KEY (guild_id, u_min, u_max),
					CHECK (u_min < u_max)
				)
			`);

      // Guild vocabulary - TF-IDF vocabulary for keyword extraction
      await client.query(`
				CREATE TABLE IF NOT EXISTS guild_vocabulary (
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					term VARCHAR(100) NOT NULL,
					idf_score FLOAT NOT NULL,
					document_frequency INTEGER NOT NULL,
					total_documents INTEGER NOT NULL,
					is_stopword BOOLEAN DEFAULT false,
					last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					PRIMARY KEY (guild_id, term)
				)
			`);

      // Add last_message_id to channels for watermark tracking
      await client.query(`
				ALTER TABLE channels
				ADD COLUMN IF NOT EXISTS last_message_id VARCHAR(20),
				ADD COLUMN IF NOT EXISTS last_message_sync TIMESTAMP WITH TIME ZONE,
				ADD COLUMN IF NOT EXISTS last_full_sync TIMESTAMP WITH TIME ZONE
			`);

      // Add voice channel ownership columns
      await client.query(`
				ALTER TABLE channels
				ADD COLUMN IF NOT EXISTS is_user_channel BOOLEAN DEFAULT false,
				ADD COLUMN IF NOT EXISTS current_owner_id VARCHAR(20)
			`);

      // Add server-wide summary column for guilds
      await client.query(`
        ALTER TABLE guilds
        ADD COLUMN IF NOT EXISTS server_summary TEXT
      `);

      // Voice channel preferences - user preferences for voice channels
      await client.query(`
				CREATE TABLE IF NOT EXISTS voice_channel_preferences (
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					channel_name VARCHAR(100),
					default_user_limit INTEGER,
					privacy_mode VARCHAR(20) DEFAULT 'public',
					hidden BOOLEAN DEFAULT false,
					whitelist TEXT[] DEFAULT '{}',
					blacklist TEXT[] DEFAULT '{}',
					muted_users TEXT[] DEFAULT '{}',
					deafened_users TEXT[] DEFAULT '{}',
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					PRIMARY KEY (guild_id, user_id)
				)
			`);
			
			// Add hidden column if it doesn't exist (migration)
			await client.query(`
				ALTER TABLE voice_channel_preferences
				ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false
			`);

			// Add blocked_users column if it doesn't exist (migration; used by voice-state /block)
			await client.query(`
				ALTER TABLE voice_channel_preferences
				ADD COLUMN IF NOT EXISTS blocked_users TEXT[] DEFAULT '{}'
			`);
			
			// Migrate banned_users to blacklist and add whitelist column
			await client.query(`
				ALTER TABLE voice_channel_preferences
				ADD COLUMN IF NOT EXISTS whitelist TEXT[] DEFAULT '{}'
			`);
			await client.query(`
				ALTER TABLE voice_channel_preferences
				ADD COLUMN IF NOT EXISTS blacklist TEXT[] DEFAULT '{}'
			`);
			// Migrate data from banned_users to blacklist if blacklist is empty
			// (only when the legacy column exists, e.g. databases created before this migration)
			await client.query(`
				DO $$
				BEGIN
					IF EXISTS (
						SELECT 1 FROM information_schema.columns
						WHERE table_name = 'voice_channel_preferences' AND column_name = 'banned_users'
					) THEN
						UPDATE voice_channel_preferences
						SET blacklist = banned_users
						WHERE (blacklist IS NULL OR blacklist = '{}')
						AND banned_users IS NOT NULL AND banned_users != '{}';
					END IF;
				END
				$$;
			`);

      // Voice channel ownership history - track ownership changes
      await client.query(`
				CREATE TABLE IF NOT EXISTS voice_channel_ownership (
					id VARCHAR(50) PRIMARY KEY DEFAULT gen_random_uuid()::text,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					channel_id VARCHAR(20) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					owned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					relinquished_at TIMESTAMP WITH TIME ZONE
				)
			`);

      // Voice sessions - tracks user voice channel sessions
      await client.query(`
				CREATE TABLE IF NOT EXISTS voice_sessions (
					id VARCHAR(50) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					channel_id VARCHAR(20) NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
					joined_at TIMESTAMP WITH TIME ZONE NOT NULL,
					left_at TIMESTAMP WITH TIME ZONE,
					duration INTEGER DEFAULT 0,
					time_muted INTEGER DEFAULT 0,
					time_deafened INTEGER DEFAULT 0,
					time_streaming INTEGER DEFAULT 0,
					owner_at_join VARCHAR(20) DEFAULT NULL,
					is_grandfathered BOOLEAN DEFAULT false,
					applied_moderation JSONB DEFAULT '{}',
					active BOOLEAN DEFAULT true,
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
				)
			`);

      // Voice states - current voice state of users
      await client.query(`
				CREATE TABLE IF NOT EXISTS voice_states (
					id VARCHAR(50) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					channel_id VARCHAR(20) REFERENCES channels(id) ON DELETE CASCADE,
					session_id VARCHAR(50) REFERENCES voice_sessions(id) ON DELETE SET NULL,
					self_mute BOOLEAN DEFAULT false,
					self_deaf BOOLEAN DEFAULT false,
					server_mute BOOLEAN DEFAULT false,
					server_deaf BOOLEAN DEFAULT false,
					streaming BOOLEAN DEFAULT false,
					self_video BOOLEAN DEFAULT false,
					joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					UNIQUE(guild_id, user_id)
				)
			`);

      // Voice history - historical events for voice state changes
      await client.query(`
				CREATE TABLE IF NOT EXISTS voice_history (
					id VARCHAR(50) PRIMARY KEY,
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					channel_id VARCHAR(20) REFERENCES channels(id) ON DELETE CASCADE,
					event_type VARCHAR(20) NOT NULL,
					from_channel_id VARCHAR(20),
					to_channel_id VARCHAR(20),
					session_id VARCHAR(50),
					self_mute BOOLEAN DEFAULT false,
					self_deaf BOOLEAN DEFAULT false,
					server_mute BOOLEAN DEFAULT false,
					server_deaf BOOLEAN DEFAULT false,
					streaming BOOLEAN DEFAULT false,
					self_video BOOLEAN DEFAULT false,
					timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
				)
			`);

      // Member personas the bot can speak as (built by /persona init)
      await client.query(`
				CREATE TABLE IF NOT EXISTS user_personas (
					guild_id VARCHAR(20) NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					display_name TEXT NOT NULL,
					character_profile TEXT NOT NULL,
					style_examples TEXT[] DEFAULT '{}',
					source_stats JSONB DEFAULT '{}',
					created_by VARCHAR(20),
					created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					PRIMARY KEY (guild_id, user_id)
				)
			`);

      // Which member persona the bot currently speaks as, per guild (set by /persona change)
      await client.query(`
				CREATE TABLE IF NOT EXISTS guild_active_personas (
					guild_id VARCHAR(20) PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
					user_id VARCHAR(20) NOT NULL,
					activated_by VARCHAR(20),
					activated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
					FOREIGN KEY (guild_id, user_id) REFERENCES user_personas(guild_id, user_id) ON DELETE CASCADE
				)
			`);

      // Create indexes for better performance
      await client.query(`
				CREATE INDEX IF NOT EXISTS idx_channels_guild_id ON channels(guild_id);
				CREATE INDEX IF NOT EXISTS idx_roles_guild_id ON roles(guild_id);
				CREATE INDEX IF NOT EXISTS idx_members_guild_id ON members(guild_id);
				CREATE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id);
				CREATE INDEX IF NOT EXISTS idx_messages_guild_id ON messages(guild_id);
				CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
				CREATE INDEX IF NOT EXISTS idx_messages_author_id ON messages(author_id);
				CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
				CREATE INDEX IF NOT EXISTS idx_relationship_edges_guild ON relationship_edges(guild_id);
				CREATE INDEX IF NOT EXISTS idx_relationship_edges_user_a ON relationship_edges(user_a);
				CREATE INDEX IF NOT EXISTS idx_relationship_edges_user_b ON relationship_edges(user_b);
				CREATE INDEX IF NOT EXISTS idx_relationship_edges_last_interaction ON relationship_edges(last_interaction);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_guild ON conversation_segments(guild_id);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_channel ON conversation_segments(channel_id);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_participants ON conversation_segments USING GIN(participants);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_start_time ON conversation_segments(start_time);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_status ON conversation_segments(status);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_last_activity ON conversation_segments(last_activity_at DESC);
				CREATE INDEX IF NOT EXISTS idx_conversation_segments_active_users ON conversation_segments(guild_id, status) WHERE status = 'active';
				CREATE INDEX IF NOT EXISTS idx_relationship_pairs_guild ON relationship_pairs(guild_id);
				CREATE INDEX IF NOT EXISTS idx_relationship_pairs_users ON relationship_pairs(u_min, u_max);
				CREATE INDEX IF NOT EXISTS idx_guild_vocabulary_guild ON guild_vocabulary(guild_id);
				CREATE INDEX IF NOT EXISTS idx_guild_vocabulary_term ON guild_vocabulary(term);
				CREATE INDEX IF NOT EXISTS idx_guild_vocabulary_idf ON guild_vocabulary(guild_id, idf_score DESC);
				${this.vectorExtensionAvailable ? `
				CREATE INDEX IF NOT EXISTS messages_embedding_idx
					ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
					WHERE embedding IS NOT NULL;
				CREATE INDEX IF NOT EXISTS conversation_segments_embedding_idx
					ON conversation_segments USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
					WHERE embedding IS NOT NULL;
				` : ''}
				CREATE INDEX IF NOT EXISTS idx_voice_sessions_guild_id ON voice_sessions(guild_id);
				CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_id ON voice_sessions(user_id);
				CREATE INDEX IF NOT EXISTS idx_voice_sessions_channel_id ON voice_sessions(channel_id);
				CREATE INDEX IF NOT EXISTS idx_voice_sessions_active ON voice_sessions(active) WHERE active = true;
				CREATE INDEX IF NOT EXISTS idx_voice_states_guild_id ON voice_states(guild_id);
				CREATE INDEX IF NOT EXISTS idx_voice_states_user_id ON voice_states(user_id);
				CREATE INDEX IF NOT EXISTS idx_voice_states_channel_id ON voice_states(channel_id);
				CREATE INDEX IF NOT EXISTS idx_voice_history_guild_id ON voice_history(guild_id);
				CREATE INDEX IF NOT EXISTS idx_voice_history_user_id ON voice_history(user_id);
				CREATE INDEX IF NOT EXISTS idx_voice_history_timestamp ON voice_history(timestamp DESC);
				CREATE INDEX IF NOT EXISTS idx_channels_is_user_channel ON channels(is_user_channel) WHERE is_user_channel = true;
				CREATE INDEX IF NOT EXISTS idx_channels_current_owner_id ON channels(current_owner_id);
				CREATE INDEX IF NOT EXISTS idx_voice_channel_preferences_guild_user ON voice_channel_preferences(guild_id, user_id);
				CREATE INDEX IF NOT EXISTS idx_voice_channel_ownership_channel ON voice_channel_ownership(channel_id);
				CREATE INDEX IF NOT EXISTS idx_voice_channel_ownership_user ON voice_channel_ownership(user_id);
				
				-- User profiles indexes for AI retrieval
				CREATE INDEX IF NOT EXISTS idx_user_profiles_guild_id ON user_profiles(guild_id);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_relationship_network ON user_profiles USING GIN (relationship_network);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_psych_profile ON user_profiles USING GIN (psych_profile);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_behavior_patterns ON user_profiles USING GIN (behavior_patterns);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_temporal_profile ON user_profiles USING GIN (temporal_profile);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_psych_profile_metadata ON user_profiles USING GIN ((psych_profile->'profile_metadata'));
				CREATE INDEX IF NOT EXISTS idx_user_profiles_psych_profile_last_updated ON user_profiles ((psych_profile->'profile_metadata'->>'last_updated'));
				CREATE INDEX IF NOT EXISTS idx_user_profiles_keywords ON user_profiles USING GIN (keywords);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_emojis ON user_profiles USING GIN (emojis);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_notes ON user_profiles USING GIN (notes);
				CREATE INDEX IF NOT EXISTS idx_user_profiles_aliases ON user_profiles USING GIN (aliases);
			`);
    } catch (error: any) {
      // Only log as error if it's not a vector extension issue (which we already handled)
      if (!(error?.code === '58P01' || error?.message?.includes('vector'))) {
        console.error("🔸 Failed to initialize PostgreSQL schema:", error);
      }
    } finally {
      client.release();
    }
  }

  // Guild operations
  async upsertGuild(guildData: GuildData): Promise<DatabaseResult<GuildData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				INSERT INTO guilds (id, name, description, icon, owner_id, member_count, active, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
				ON CONFLICT (id) DO UPDATE SET
					name = EXCLUDED.name,
					description = EXCLUDED.description,
					icon = EXCLUDED.icon,
					owner_id = EXCLUDED.owner_id,
					member_count = EXCLUDED.member_count,
					active = EXCLUDED.active,
					updated_at = NOW()
				RETURNING *
			`;

      const values = [
        guildData.id,
        guildData.name,
        guildData.description,
        guildData.icon,
        guildData.owner_id,
        guildData.member_count,
        guildData.active,
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to upsert guild:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // Channel operations
  async upsertChannel(
    channelData: ChannelData
  ): Promise<DatabaseResult<ChannelData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				INSERT INTO channels (id, guild_id, name, type, position, topic, nsfw, parent_id, active, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
				ON CONFLICT (id) DO UPDATE SET
					name = EXCLUDED.name,
					type = EXCLUDED.type,
					position = EXCLUDED.position,
					topic = EXCLUDED.topic,
					nsfw = EXCLUDED.nsfw,
					parent_id = EXCLUDED.parent_id,
					active = EXCLUDED.active,
					updated_at = NOW(),
					-- Preserve voice channel ownership fields if already set
					is_user_channel = COALESCE(channels.is_user_channel, false),
					current_owner_id = channels.current_owner_id
				RETURNING *
			`;

      const values = [
        channelData.id,
        channelData.guild_id,
        channelData.name,
        channelData.type,
        channelData.position,
        channelData.topic,
        channelData.nsfw,
        channelData.parent_id,
        channelData.active,
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to upsert channel:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // Role operations
  async upsertRole(roleData: RoleData): Promise<DatabaseResult<RoleData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				INSERT INTO roles (id, guild_id, name, color, position, permissions, mentionable, hoist, active, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
				ON CONFLICT (id) DO UPDATE SET
					name = EXCLUDED.name,
					color = EXCLUDED.color,
					position = EXCLUDED.position,
					permissions = EXCLUDED.permissions,
					mentionable = EXCLUDED.mentionable,
					hoist = EXCLUDED.hoist,
					active = EXCLUDED.active,
					updated_at = NOW()
				RETURNING *
			`;

      const values = [
        roleData.id,
        roleData.guild_id,
        roleData.name,
        roleData.color,
        roleData.position,
        roleData.permissions,
        roleData.mentionable,
        roleData.hoist,
        roleData.active,
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to upsert role:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // Member operations
  async upsertMember(
    memberData: MemberData
  ): Promise<DatabaseResult<MemberData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      // Check if member exists and get old values for alias tracking
      const existingResult = await client.query(
        `SELECT username, display_name, nick FROM members WHERE guild_id = $1 AND user_id = $2`,
        [memberData.guild_id, memberData.user_id]
      );

      const existing = existingResult.rows[0];
      const nameChanged = existing && (
        existing.username !== memberData.username ||
        existing.display_name !== memberData.display_name ||
        existing.nick !== (memberData.nick || null)
      );

      const query = `
				INSERT INTO members (
					id, guild_id, user_id, username, display_name, global_name, avatar, avatar_decoration,
					banner, accent_color, discriminator, bio, flags, premium_type, public_flags,
					bot, system, nick, joined_at, roles, permissions, communication_disabled_until,
					pending, premium_since, timeout, status, activities, client_status, active, updated_at
				)
				VALUES (
					$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW()
				)
				ON CONFLICT (guild_id, user_id) DO UPDATE SET
					username = EXCLUDED.username,
					display_name = EXCLUDED.display_name,
					global_name = EXCLUDED.global_name,
					avatar = EXCLUDED.avatar,
					avatar_decoration = EXCLUDED.avatar_decoration,
					banner = EXCLUDED.banner,
					accent_color = EXCLUDED.accent_color,
					discriminator = EXCLUDED.discriminator,
					bio = EXCLUDED.bio,
					flags = EXCLUDED.flags,
					premium_type = EXCLUDED.premium_type,
					public_flags = EXCLUDED.public_flags,
					bot = EXCLUDED.bot,
					system = EXCLUDED.system,
					nick = EXCLUDED.nick,
					joined_at = EXCLUDED.joined_at,
					roles = EXCLUDED.roles,
					permissions = EXCLUDED.permissions,
					communication_disabled_until = EXCLUDED.communication_disabled_until,
					pending = EXCLUDED.pending,
					premium_since = EXCLUDED.premium_since,
					timeout = EXCLUDED.timeout,
					status = EXCLUDED.status,
					activities = EXCLUDED.activities,
					client_status = EXCLUDED.client_status,
					active = EXCLUDED.active,
					updated_at = NOW()
				RETURNING *
			`;

      const values = [
        memberData.id,
        memberData.guild_id,
        memberData.user_id,
        memberData.username,
        memberData.display_name,
        memberData.global_name,
        memberData.avatar,
        memberData.avatar_decoration,
        memberData.banner,
        memberData.accent_color,
        memberData.discriminator,
        memberData.bio,
        memberData.flags,
        memberData.premium_type,
        memberData.public_flags,
        memberData.bot,
        memberData.system,
        memberData.nick,
        memberData.joined_at,
        memberData.roles,
        memberData.permissions,
        memberData.communication_disabled_until,
        memberData.pending,
        memberData.premium_since,
        memberData.timeout,
        memberData.status,
        memberData.activities,
        memberData.client_status,
        memberData.active,
      ];

      const result = await client.query(query, values);

      // Update aliases if name changed or if this is a new member
      if (existing) {
        // Existing member - update aliases if name changed
        if (nameChanged) {
          await this.updateAliasesFromNameChange(
            memberData.user_id,
            memberData.guild_id,
            existing,
            {
              username: memberData.username,
              display_name: memberData.display_name,
              nick: memberData.nick || null,
            }
          );
        }
      } else {
        // New member - add current names to aliases
        await this.updateAliasesFromNameChange(
          memberData.user_id,
          memberData.guild_id,
          {},
          {
            username: memberData.username,
            display_name: memberData.display_name,
            nick: memberData.nick || null,
          }
        );
      }

      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to upsert member:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update aliases in user_profiles when user changes display_name, username, or nick
   * Adds both old values (that changed) and current values to the aliases array
   */
  private async updateAliasesFromNameChange(
    userId: string,
    guildId: string,
    oldNames: { username?: string; display_name?: string; nick?: string | null },
    newNames: { username: string; display_name: string; nick?: string | null }
  ): Promise<void> {
    try {
      // Get current aliases
      const profileResult = await this.getUserProfile(userId, guildId);
      const currentAliases = profileResult.success && profileResult.data
        ? (profileResult.data.aliases || [])
        : [];

      const aliasesSet = new Set<string>(currentAliases);

      // Add old values to aliases if they changed and are not empty
      // Track the old values that were replaced
      if (oldNames.username && oldNames.username !== newNames.username && oldNames.username.trim()) {
        aliasesSet.add(oldNames.username);
      }
      if (oldNames.display_name && oldNames.display_name !== newNames.display_name && oldNames.display_name.trim()) {
        aliasesSet.add(oldNames.display_name);
      }
      if (oldNames.nick && oldNames.nick !== (newNames.nick || null) && oldNames.nick.trim()) {
        aliasesSet.add(oldNames.nick);
      }

      // Also add current values to aliases (for search/retrieval)
      if (newNames.username && newNames.username.trim()) {
        aliasesSet.add(newNames.username);
      }
      if (newNames.display_name && newNames.display_name.trim()) {
        aliasesSet.add(newNames.display_name);
      }
      if (newNames.nick && newNames.nick.trim()) {
        aliasesSet.add(newNames.nick);
      }

      // Update aliases in user_profiles if we added any
      if (aliasesSet.size > currentAliases.length) {
        const updatedAliases = Array.from(aliasesSet);
        await this.updateUserProfileField(userId, guildId, 'aliases', updatedAliases);
      }
    } catch (error) {
      console.error("🔸 Failed to update aliases from name change:", error);
      // Don't throw - alias update failure shouldn't break member upsert
    }
  }

  // Message operations
  async upsertMessage(
    messageData: MessageData
  ): Promise<DatabaseResult<MessageData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      // Allow referenced_message_id to reference messages that don't exist yet
      // This handles out-of-order message sync (reply synced before parent message)
      const referencedMessageId = messageData.referenced_message_id || null;

      const query = `
				INSERT INTO messages (id, guild_id, channel_id, author_id, content, created_at, edited_at, attachments, embeds, referenced_message_id, embedding, active)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12)
				ON CONFLICT (id) DO UPDATE SET
					content = EXCLUDED.content,
					edited_at = EXCLUDED.edited_at,
					attachments = EXCLUDED.attachments,
					embeds = EXCLUDED.embeds,
					referenced_message_id = EXCLUDED.referenced_message_id,
					embedding = EXCLUDED.embedding,
					active = EXCLUDED.active
				RETURNING *
			`;

      // Format embedding as string for pgvector: '[1,2,3]'
      const embeddingValue = messageData.embedding
        ? `[${messageData.embedding.join(",")}]`
        : null;

      const values = [
        messageData.id,
        messageData.guild_id,
        messageData.channel_id,
        messageData.author_id,
        messageData.content,
        messageData.created_at,
        messageData.edited_at,
        messageData.attachments,
        messageData.embeds,
        referencedMessageId,
        embeddingValue,
        messageData.active,
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to upsert message:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // Query operations
  async query(
    text: string,
    params?: any[]
  ): Promise<DatabaseResult<any[] & { rowCount?: number }>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    let retries = 3;
    let lastError: Error | null = null;

    while (retries > 0) {
      const client = await this.pool!.connect().catch((err) => {
        lastError = err;
        return null;
      });

      if (!client) {
        retries--;
        if (retries > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * (4 - retries))
          ); // Exponential backoff
          continue;
        }
        return {
          success: false,
          error: lastError?.message || "Failed to acquire connection",
        };
      }

      try {
        const result = await client.query(text, params);
        // Include rowCount for DELETE/UPDATE queries by attaching it to the array
        const data = result.rows as any[];
        if (data && Array.isArray(data)) {
          Object.defineProperty(data, "rowCount", {
            value: result.rowCount,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        }
        return { success: true, data };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isConnectionError =
          lastError.message.includes("Connection terminated") ||
          lastError.message.includes("timeout") ||
          lastError.message.includes("ECONNRESET");

        if (isConnectionError && retries > 1) {
          retries--;
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * (4 - retries))
          );
          continue;
        }

        // Non-retryable error or out of retries
        console.error("🔸 Query failed:", lastError.message);
        return {
          success: false,
          error: lastError.message,
        };
      } finally {
        client.release();
      }
    }

    return {
      success: false,
      error: lastError?.message || "Query failed after retries",
    };
  }

  // Get guild statistics
  async getGuildStats(guildId: string): Promise<DatabaseResult<any>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				SELECT 
					g.name as guild_name,
					g.member_count,
					COUNT(DISTINCT c.id) as channel_count,
					COUNT(DISTINCT r.id) as role_count,
					COUNT(DISTINCT m.id) as member_count_db,
					COUNT(DISTINCT msg.id) as message_count
				FROM guilds g
				LEFT JOIN channels c ON g.id = c.guild_id AND c.active = true
				LEFT JOIN roles r ON g.id = r.guild_id AND r.active = true
				LEFT JOIN members m ON g.id = m.guild_id AND m.active = true
				LEFT JOIN messages msg ON g.id = msg.guild_id AND msg.active = true
				WHERE g.id = $1 AND g.active = true
				GROUP BY g.id, g.name, g.member_count
			`;

      const result = await client.query(query, [guildId]);
      return { success: true, data: result.rows[0] || null };
    } catch (error) {
      console.error("🔸 Failed to get guild stats:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // Relationship Network Operations
  async getMembersByGuild(
    guildId: string
  ): Promise<DatabaseResult<MemberData[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				SELECT * FROM members 
				WHERE guild_id = $1 AND active = true
				ORDER BY username
			`;

      const result = await client.query(query, [guildId]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get guild members:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async getMember(memberId: string): Promise<DatabaseResult<MemberData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `SELECT * FROM members WHERE id = $1`;
      const result = await client.query(query, [memberId]);
      return { success: true, data: result.rows[0] || null };
    } catch (error) {
      console.error("🔸 Failed to get member:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async getMemberRelationshipNetwork(
    userId: string,
    guildId: string
  ): Promise<DatabaseResult<RelationshipEntry[]>> {
    // Delegate to user_profiles table
    const profileResult = await this.getUserProfile(userId, guildId);

    if (!profileResult.success) {
      return {
        success: false,
        error: profileResult.error,
      };
    }

    if (!profileResult.data) {
      return { success: true, data: [] };
    }

    return {
      success: true,
      data: (profileResult.data.relationship_network || []) as RelationshipEntry[],
    };
  }

  async updateMemberRelationshipNetwork(
    memberId: string,
    relationships: RelationshipEntry[]
  ): Promise<DatabaseResult<void>> {
    // Extract guild_id and user_id from memberId (format: guild_id_user_id)
    const parts = memberId.split('_');
    if (parts.length < 2) {
      return {
        success: false,
        error: `Invalid memberId format: ${memberId}. Expected format: guild_id_user_id`,
      };
    }

    const guildId = parts[0]!;
    const userId = parts.slice(1).join('_'); // Handle cases where user_id might contain underscores

    // Delegate to user_profiles table
    return this.updateUserProfileRelationships(userId, guildId, relationships);
  }

  // User profile operations
  async upsertUserProfile(
    profileData: UserProfileData
  ): Promise<DatabaseResult<UserProfileData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				INSERT INTO user_profiles (
					guild_id, user_id, summary, keywords, emojis, notes, aliases,
					relationship_network, psych_profile, behavior_patterns, temporal_profile,
					updated_at
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
				ON CONFLICT (guild_id, user_id) DO UPDATE SET
					summary = EXCLUDED.summary,
					keywords = EXCLUDED.keywords,
					emojis = EXCLUDED.emojis,
					notes = EXCLUDED.notes,
					aliases = EXCLUDED.aliases,
					relationship_network = EXCLUDED.relationship_network,
					psych_profile = EXCLUDED.psych_profile,
					behavior_patterns = EXCLUDED.behavior_patterns,
					temporal_profile = EXCLUDED.temporal_profile,
					updated_at = NOW()
				RETURNING *
			`;

      const values = [
        profileData.guild_id,
        profileData.user_id,
        profileData.summary || null,
        profileData.keywords || [],
        profileData.emojis || [],
        profileData.notes || [],
        profileData.aliases || [],
        profileData.relationship_network ? JSON.stringify(profileData.relationship_network) : '[]',
        profileData.psych_profile ? JSON.stringify(profileData.psych_profile) : '{}',
        profileData.behavior_patterns ? JSON.stringify(profileData.behavior_patterns) : '{}',
        profileData.temporal_profile ? JSON.stringify(profileData.temporal_profile) : '{}',
      ];

      const result = await client.query(query, values);
      const row = result.rows[0];

      return {
        success: true,
        data: {
          guild_id: row.guild_id,
          user_id: row.user_id,
          summary: row.summary,
          keywords: row.keywords || [],
          emojis: row.emojis || [],
          notes: row.notes || [],
          aliases: row.aliases || [],
          relationship_network: row.relationship_network || [],
          psych_profile: row.psych_profile || {},
          behavior_patterns: row.behavior_patterns || {},
          temporal_profile: row.temporal_profile || {},
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
      };
    } catch (error) {
      console.error("🔸 Failed to upsert user profile:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async getUserProfile(
    userId: string,
    guildId: string
  ): Promise<DatabaseResult<UserProfileData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				SELECT * FROM user_profiles
				WHERE user_id = $1 AND guild_id = $2
			`;

      const result = await client.query(query, [userId, guildId]);

      if (result.rows.length === 0) {
        return { success: true, data: undefined };
      }

      const row = result.rows[0];
      return {
        success: true,
        data: {
          guild_id: row.guild_id,
          user_id: row.user_id,
          summary: row.summary,
          keywords: row.keywords || [],
          emojis: row.emojis || [],
          notes: row.notes || [],
          aliases: row.aliases || [],
          relationship_network: row.relationship_network || [],
          psych_profile: row.psych_profile || {},
          behavior_patterns: row.behavior_patterns || {},
          temporal_profile: row.temporal_profile || {},
          last_enriched_conversation_count: row.last_enriched_conversation_count ?? 0,
          last_enriched_conversation_id: row.last_enriched_conversation_id ?? undefined,
          profile_version: row.profile_version ?? undefined,
          enrichment_history: row.enrichment_history ?? undefined,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
      };
    } catch (error) {
      console.error("🔸 Failed to get user profile:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async updateUserProfileField(
    userId: string,
    guildId: string,
    field: 'summary' | 'keywords' | 'emojis' | 'notes' | 'aliases',
    value: string | string[]
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				UPDATE user_profiles
				SET ${field} = $1, updated_at = NOW()
				WHERE user_id = $2 AND guild_id = $3
			`;

      const result = await client.query(query, [value, userId, guildId]);

      if (result.rowCount === 0) {
        // Create profile if it doesn't exist
        const now = new Date();
        await this.upsertUserProfile({
          guild_id: guildId,
          user_id: userId,
          [field]: value,
          created_at: now,
          updated_at: now,
        } as UserProfileData);
      }

      return { success: true };
    } catch (error) {
      console.error(`🔸 Failed to update user profile field ${field}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async updateUserProfilePsych(
    userId: string,
    guildId: string,
    psychProfile: any,
    behaviorPatterns?: any,
    temporalProfile?: any
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const updates: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (psychProfile !== undefined) {
        // Replace the profile, but keep the previous AI estimates when this run produced none
        updates.push(`psych_profile = jsonb_strip_nulls(jsonb_build_object(
          'big_five_proxies', psych_profile->'big_five_proxies',
          'mbti_type', psych_profile->'mbti_type'
        )) || $${paramCount}::jsonb`);
        values.push(JSON.stringify(psychProfile));
        paramCount++;
      }

      if (behaviorPatterns !== undefined) {
        updates.push(`behavior_patterns = $${paramCount}`);
        values.push(JSON.stringify(behaviorPatterns));
        paramCount++;
      }

      if (temporalProfile !== undefined) {
        updates.push(`temporal_profile = $${paramCount}`);
        values.push(JSON.stringify(temporalProfile));
        paramCount++;
      }

      if (updates.length === 0) {
        return { success: false, error: "No fields to update" };
      }

      values.push(userId, guildId);
      const query = `
				UPDATE user_profiles
				SET ${updates.join(', ')}, updated_at = NOW()
				WHERE user_id = $${paramCount} AND guild_id = $${paramCount + 1}
			`;

      const result = await client.query(query, values);

      if (result.rowCount === 0) {
        // Create profile if it doesn't exist
        await this.upsertUserProfile({
          guild_id: guildId,
          user_id: userId,
          psych_profile: psychProfile,
          behavior_patterns: behaviorPatterns,
          temporal_profile: temporalProfile,
        } as UserProfileData);
      }

      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update user profile psych:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async updateUserProfileRelationships(
    userId: string,
    guildId: string,
    relationships: RelationshipEntry[]
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
				UPDATE user_profiles
				SET relationship_network = $1, updated_at = NOW()
				WHERE user_id = $2 AND guild_id = $3
			`;

      const result = await client.query(query, [
        JSON.stringify(relationships),
        userId,
        guildId,
      ]);

      if (result.rowCount === 0) {
        // Create profile if it doesn't exist
        await this.upsertUserProfile({
          guild_id: guildId,
          user_id: userId,
          relationship_network: relationships,
        } as UserProfileData);
      } else {
        return { success: true };
      }

      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update user profile relationships:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // User persona operations
  async upsertUserPersona(
    persona: Omit<UserPersonaData, "created_at" | "updated_at">
  ): Promise<DatabaseResult<UserPersonaData>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const result = await client.query<UserPersonaRow>(
        `
				INSERT INTO user_personas (guild_id, user_id, display_name, character_profile, style_examples, source_stats, created_by, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
				ON CONFLICT (guild_id, user_id) DO UPDATE SET
					display_name = EXCLUDED.display_name,
					character_profile = EXCLUDED.character_profile,
					style_examples = EXCLUDED.style_examples,
					source_stats = EXCLUDED.source_stats,
					created_by = EXCLUDED.created_by,
					updated_at = NOW()
				RETURNING *
			`,
        [
          persona.guild_id,
          persona.user_id,
          persona.display_name,
          persona.character_profile,
          persona.style_examples,
          JSON.stringify(persona.source_stats),
          persona.created_by ?? null,
        ]
      );
      const row = result.rows[0];
      if (!row) {
        return { success: false, error: "Persona upsert returned no row" };
      }
      return { success: true, data: this.mapUserPersonaRow(row) };
    } catch (error) {
      console.error("🔸 Failed to upsert user persona:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async getUserPersona(
    guildId: string,
    userId: string
  ): Promise<DatabaseResult<UserPersonaData | undefined>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const result = await client.query<UserPersonaRow>(
        `SELECT * FROM user_personas WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );
      const row = result.rows[0];
      return { success: true, data: row ? this.mapUserPersonaRow(row) : undefined };
    } catch (error) {
      console.error("🔸 Failed to get user persona:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  async setActivePersona(
    guildId: string,
    userId: string,
    activatedBy: string
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      await client.query(
        `
				INSERT INTO guild_active_personas (guild_id, user_id, activated_by, activated_at)
				VALUES ($1, $2, $3, NOW())
				ON CONFLICT (guild_id) DO UPDATE SET
					user_id = EXCLUDED.user_id,
					activated_by = EXCLUDED.activated_by,
					activated_at = NOW()
			`,
        [guildId, userId, activatedBy]
      );
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to set active persona:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get the persona the bot currently speaks as in a guild (undefined = default persona)
   */
  async getActivePersona(
    guildId: string
  ): Promise<DatabaseResult<UserPersonaData | undefined>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const result = await client.query<UserPersonaRow>(
        `
				SELECT p.* FROM guild_active_personas a
				JOIN user_personas p ON p.guild_id = a.guild_id AND p.user_id = a.user_id
				WHERE a.guild_id = $1
			`,
        [guildId]
      );
      const row = result.rows[0];
      return { success: true, data: row ? this.mapUserPersonaRow(row) : undefined };
    } catch (error) {
      console.error("🔸 Failed to get active persona:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Revert a guild to the default persona. Returns whether a persona was active.
   */
  async clearActivePersona(guildId: string): Promise<DatabaseResult<boolean>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const result = await client.query(
        `DELETE FROM guild_active_personas WHERE guild_id = $1`,
        [guildId]
      );
      return { success: true, data: (result.rowCount ?? 0) > 0 };
    } catch (error) {
      console.error("🔸 Failed to clear active persona:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  private mapUserPersonaRow(row: UserPersonaRow): UserPersonaData {
    return {
      guild_id: row.guild_id,
      user_id: row.user_id,
      display_name: row.display_name,
      character_profile: row.character_profile,
      style_examples: row.style_examples ?? [],
      source_stats: row.source_stats ?? {},
      created_by: row.created_by ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async getMessageInteractions(
    user1Id: string,
    user2Id: string,
    guildId: string,
    timeWindowMinutes: number = 5
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      // Get messages from both users in the guild
      const query = `
				SELECT 
					id,
					channel_id,
					author_id,
					content,
					created_at,
					edited_at
				FROM messages 
				WHERE guild_id = $1 
					AND author_id IN ($2, $3)
					AND active = true
				ORDER BY created_at ASC
			`;

      const result = await client.query(query, [guildId, user1Id, user2Id]);
      const messages = result.rows;

      // Process messages to find interactions
      const interactions: any[] = [];
      const timeWindowMs = timeWindowMinutes * 60 * 1000;

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const messageTime = new Date(message.created_at).getTime();

        // Check for mentions
        const mentionPattern = new RegExp(
          `<@!?${user1Id === message.author_id ? user2Id : user1Id}>`,
          "g"
        );
        if (mentionPattern.test(message.content)) {
          interactions.push({
            interaction_type: "mention",
            timestamp: new Date(message.created_at),
            channel_id: message.channel_id,
            message_id: message.id,
            other_user_id: user1Id === message.author_id ? user2Id : user1Id,
            points: 2,
          });
        }

        // Check for same-channel interactions within time window
        if (i > 0) {
          const prevMessage = messages[i - 1];
          const prevTime = new Date(prevMessage.created_at).getTime();

          if (
            message.channel_id === prevMessage.channel_id &&
            message.author_id !== prevMessage.author_id &&
            Math.abs(messageTime - prevTime) <= timeWindowMs
          ) {
            interactions.push({
              interaction_type: "same_channel",
              timestamp: new Date(message.created_at),
              channel_id: message.channel_id,
              message_id: message.id,
              other_user_id: prevMessage.author_id,
              points: 1,
            });
          }
        }
      }

      return { success: true, data: interactions };
    } catch (error) {
      console.error("🔸 Failed to get message interactions:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get all messages between two users for conversation detection (excluding bot messages)
   */
  async getMessagesBetweenUsers(
    user1Id: string,
    user2Id: string,
    guildId: string
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT 
          m.id,
          m.channel_id,
          m.author_id,
          m.content,
          m.created_at,
          m.edited_at,
          m.attachments,
          m.embeds
        FROM messages m
        JOIN members mem ON m.author_id = mem.user_id AND m.guild_id = mem.guild_id
        WHERE m.guild_id = $1 
          AND m.author_id IN ($2, $3)
          AND m.active = true
          AND mem.bot = false
        ORDER BY m.created_at ASC
      `;

      const result = await client.query(query, [guildId, user1Id, user2Id]);

      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get messages between users:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get all names (current + historical) for a user in a guild
   */
  async getUserNames(
    userId: string,
    guildId: string
  ): Promise<DatabaseResult<string[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT DISTINCT
          username,
          display_name,
          global_name,
          nick
        FROM members 
        WHERE user_id = $1 AND guild_id = $2 AND active = true
        UNION
        SELECT DISTINCT
          username,
          display_name,
          global_name,
          nick
        FROM members 
        WHERE user_id = $1 AND guild_id = $2 AND active = false
        ORDER BY username
      `;

      const result = await client.query(query, [userId, guildId]);

      // Collect all unique names
      const names = new Set<string>();
      result.rows.forEach((row) => {
        if (row.username) names.add(row.username);
        if (row.display_name) names.add(row.display_name);
        if (row.global_name) names.add(row.global_name);
        if (row.nick) names.add(row.nick);
      });

      return { success: true, data: Array.from(names) };
    } catch (error) {
      console.error("🔸 Failed to get user names:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Relationship Edges - Realtime Incremental Updates
  // ============================================================================

  /**
   * Upsert relationship edge counters (O(1) update for realtime)
   */
  async upsertEdgeCounters(
    guildId: string,
    userA: string,
    userB: string,
    delta: {
      msg_a_to_b?: number;
      msg_b_to_a?: number;
      mentions?: number;
      replies?: number;
      reactions?: number;
      total?: number;
    }
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        INSERT INTO relationship_edges (
          guild_id, user_a, user_b, 
          last_interaction, msg_a_to_b, msg_b_to_a, mentions, replies, reactions, total
        )
        VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9)
        ON CONFLICT (guild_id, user_a, user_b) DO UPDATE SET
          msg_a_to_b = relationship_edges.msg_a_to_b + EXCLUDED.msg_a_to_b,
          msg_b_to_a = relationship_edges.msg_b_to_a + EXCLUDED.msg_b_to_a,
          mentions = relationship_edges.mentions + EXCLUDED.mentions,
          replies = relationship_edges.replies + EXCLUDED.replies,
          reactions = relationship_edges.reactions + EXCLUDED.reactions,
          total = relationship_edges.total + EXCLUDED.total,
          last_interaction = GREATEST(relationship_edges.last_interaction, EXCLUDED.last_interaction),
          updated_at = NOW()
      `;

      const values = [
        guildId,
        userA,
        userB,
        delta.msg_a_to_b || 0,
        delta.msg_b_to_a || 0,
        delta.mentions || 0,
        delta.replies || 0,
        delta.reactions || 0,
        delta.total || 0,
      ];

      await client.query(query, values);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to upsert edge counters:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get edge for a specific pair
   */
  async getEdgeForPair(
    guildId: string,
    userA: string,
    userB: string
  ): Promise<DatabaseResult<any>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM relationship_edges
        WHERE guild_id = $1 AND user_a = $2 AND user_b = $3
      `;
      const result = await client.query(query, [guildId, userA, userB]);
      return {
        success: true,
        data: result.rows[0] || null,
      };
    } catch (error) {
      console.error("🔸 Failed to get edge:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get all edges for a user (both directions)
   */
  async getEdgesForUser(
    guildId: string,
    userId: string,
    limit: number = 50
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM relationship_edges
        WHERE guild_id = $1 AND (user_a = $2 OR user_b = $2)
        ORDER BY last_interaction DESC, total DESC
        LIMIT $3
      `;
      const result = await client.query(query, [guildId, userId, limit]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get edges for user:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update rolling windows (7d, 30d) for edges
   */
  async updateEdgeRollingWindows(
    guildId: string,
    cutoff7d: Date,
    cutoff30d: Date
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      // Reset rolling windows and recalculate from interactions in the windows
      const query = `
        UPDATE relationship_edges
        SET 
          rolling_7d = CASE 
            WHEN last_interaction >= $2 THEN total
            ELSE 0
          END,
          rolling_30d = CASE
            WHEN last_interaction >= $3 THEN total
            ELSE 0
          END,
          updated_at = NOW()
        WHERE guild_id = $1
      `;
      await client.query(query, [guildId, cutoff7d, cutoff30d]);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update rolling windows:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Conversation Segments - Multi-participant Conversations
  // ============================================================================

  /**
   * Upsert conversation segment
   */
  async upsertConversationSegment(segment: {
    id: string;
    guildId: string;
    channelId: string;
    participants: string[];
    startTime: Date;
    endTime: Date;
    messageIds: string[];
    messageCount: number;
    features?: Record<string, any>;
    summary?: string;
    status?: "active" | "paused" | "finalized";
  }): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        INSERT INTO conversation_segments (
          id, guild_id, channel_id, participants, start_time, end_time,
          message_ids, message_count, features, summary, status, last_activity_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          end_time = EXCLUDED.end_time,
          message_ids = EXCLUDED.message_ids,
          message_count = EXCLUDED.message_count,
          features = EXCLUDED.features,
          summary = EXCLUDED.summary,
          status = EXCLUDED.status,
          last_activity_at = EXCLUDED.last_activity_at
      `;

      const values = [
        segment.id,
        segment.guildId,
        segment.channelId,
        segment.participants,
        segment.startTime,
        segment.endTime,
        segment.messageIds,
        segment.messageCount,
        JSON.stringify(segment.features || {}),
        segment.summary || null,
        segment.status || "finalized",
        segment.endTime,
      ];

      await client.query(query, values);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to upsert conversation segment:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Remove conversation segments that don't meet minimum participant requirements
   */
  async removeSingleParticipantSegments(
    guildId: string
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      await client.query(
        `DELETE FROM conversation_segments
         WHERE guild_id = $1
           AND (participants IS NULL OR array_length(participants, 1) <= 1)`,
        [guildId]
      );
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to remove single-participant segments:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get segments for participants (overlapping or exact match)
   */
  async getSegmentsForParticipants(
    guildId: string,
    participantIds: string[],
    limit: number = 10,
    since?: Date
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      // Find segments where participants array contains any of the given participant IDs
      const query = `
        SELECT * FROM conversation_segments
        WHERE guild_id = $1
          AND participants && $2::TEXT[]
          ${since ? "AND start_time >= $4" : ""}
        ORDER BY start_time DESC
        LIMIT $3
      `;
      const params: any[] = [guildId, participantIds, limit];
      if (since) params.push(since);

      const result = await client.query(query, params);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get segments for participants:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get segments for a channel
   */
  async getSegmentsForChannel(
    guildId: string,
    channelId: string,
    limit: number = 20
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM conversation_segments
        WHERE guild_id = $1 AND channel_id = $2
        ORDER BY start_time DESC
        LIMIT $3
      `;
      const result = await client.query(query, [guildId, channelId, limit]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get segments for channel:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get active conversations for a user (real-time)
   */
  async getActiveConversationsForUser(
    userId: string,
    guildId: string,
    limit: number = 20
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM conversation_segments
        WHERE guild_id = $1
          AND participants @> $2::TEXT[]
          AND status = 'active'
        ORDER BY last_activity_at DESC
        LIMIT $3
      `;
      const result = await client.query(query, [guildId, [userId], limit]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get active conversations for user:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get active conversations in a channel (real-time)
   */
  async getActiveConversationsInChannel(
    channelId: string,
    guildId: string,
    limit: number = 20
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM conversation_segments
        WHERE guild_id = $1 AND channel_id = $2
          AND status = 'active'
        ORDER BY last_activity_at DESC
        LIMIT $3
      `;
      const result = await client.query(query, [guildId, channelId, limit]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get active conversations in channel:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get conversation history for a user with pagination
   */
  async getUserConversationHistory(
    userId: string,
    guildId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM conversation_segments
        WHERE guild_id = $1
          AND participants @> $2::TEXT[]
        ORDER BY last_activity_at DESC
        LIMIT $3 OFFSET $4
      `;
      const result = await client.query(query, [
        guildId,
        [userId],
        limit,
        offset,
      ]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get user conversation history:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update conversation status (active/paused/finalized)
   */
  async updateConversationStatus(
    segmentId: string,
    status: "active" | "paused" | "finalized"
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        UPDATE conversation_segments
        SET status = $1, last_activity_at = NOW()
        WHERE id = $2
      `;
      await client.query(query, [status, segmentId]);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update conversation status:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Load active conversations from database (called on bot startup)
   */
  async loadActiveConversations(
    guildId: string
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      // Always exclude embedding column to avoid vector extension errors
      // Even if we don't select it, PostgreSQL may try to load the extension
      // if the table has a vector column
      const query = `
        SELECT 
          id, guild_id, channel_id, participants, start_time, end_time,
          message_ids, message_count, features, summary, status, 
          last_activity_at, created_at, is_voice_conversation, 
          voice_channel_id, voice_participants, transcription_data,
          topic_label, topic_confidence, parent_segment_id, split_reason
        FROM conversation_segments
        WHERE guild_id = $1 AND status = 'active'
        ORDER BY last_activity_at DESC
      `;
      const result = await client.query(query, [guildId]);
      return { success: true, data: result.rows };
    } catch (error: any) {
      // If error is related to vector extension, the table likely has a vector column
      // but the extension isn't available. Try using a subquery or different approach.
      if (error?.code === '58P01' || error?.message?.includes('vector')) {
        // Mark extension as unavailable for future queries
        this.vectorExtensionAvailable = false;

        // Try using information_schema to get column list and exclude vector columns
        try {
          // Use a more defensive query that avoids vector type resolution
          const query = `
            SELECT 
              id::text, guild_id::text, channel_id::text, 
              participants, start_time, end_time,
              message_ids, message_count, features, summary, status, 
              last_activity_at, created_at, is_voice_conversation, 
              voice_channel_id::text, voice_participants, transcription_data,
              topic_label, topic_confidence, parent_segment_id::text, split_reason
            FROM conversation_segments
            WHERE guild_id = $1 AND status = 'active'
            ORDER BY last_activity_at DESC
          `;
          const result = await client.query(query, [guildId]);
          return { success: true, data: result.rows };
        } catch (retryError: any) {
          // If that still fails, try the simplest possible query
          try {
            const simpleQuery = `
              SELECT id, guild_id, channel_id, participants, start_time, end_time,
                     message_ids, message_count, features, summary, status, 
                     last_activity_at, created_at
              FROM conversation_segments
              WHERE guild_id = $1 AND status = 'active'
              ORDER BY last_activity_at DESC
            `;
            const result = await client.query(simpleQuery, [guildId]);
            return { success: true, data: result.rows };
          } catch (simpleError) {
            // Last resort: return empty array with success
            console.warn("⚠️  Could not load active conversations due to vector extension issues. Returning empty list.");
            return { success: true, data: [] };
          }
        }
      }
      console.error("🔸 Failed to load active conversations:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Relationship Pairs - Undirected Cache
  // ============================================================================

  /**
   * Upsert relationship pair (undirected, cached for quick reads)
   */
  async upsertPair(
    guildId: string,
    user1: string,
    user2: string,
    segmentId?: string
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const [uMin, uMax] = user1 < user2 ? [user1, user2] : [user2, user1];

      const query = segmentId
        ? `
          INSERT INTO relationship_pairs (
            guild_id, u_min, u_max, last_interaction, total_interactions, segment_ids
          )
          VALUES ($1, $2, $3, NOW(), 1, ARRAY[$4]::TEXT[])
          ON CONFLICT (guild_id, u_min, u_max) DO UPDATE SET
            last_interaction = NOW(),
            total_interactions = relationship_pairs.total_interactions + 1,
            segment_ids = (
              SELECT array_agg(elem)
              FROM (
                SELECT DISTINCT elem
                FROM unnest(relationship_pairs.segment_ids || ARRAY[$4]::TEXT[]) AS elem
                ORDER BY elem DESC
                LIMIT 20
              ) subq
            ),
            updated_at = NOW()
        `
        : `
          INSERT INTO relationship_pairs (
            guild_id, u_min, u_max, last_interaction, total_interactions
          )
          VALUES ($1, $2, $3, NOW(), 1)
          ON CONFLICT (guild_id, u_min, u_max) DO UPDATE SET
            last_interaction = NOW(),
            total_interactions = relationship_pairs.total_interactions + 1,
            updated_at = NOW()
        `;

      const params = segmentId
        ? [guildId, uMin, uMax, segmentId]
        : [guildId, uMin, uMax];

      await client.query(query, params);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to upsert pair:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get pairs for a user
   */
  async getPairsForUser(
    guildId: string,
    userId: string,
    limit: number = 50
  ): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM relationship_pairs
        WHERE guild_id = $1 AND (u_min = $2 OR u_max = $2)
        ORDER BY last_interaction DESC, total_interactions DESC
        LIMIT $3
      `;
      const result = await client.query(query, [guildId, userId, limit]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get pairs for user:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Channel Watermark Tracking
  // ============================================================================

  /**
   * Update channel's last message watermark
   */
  async updateChannelLastMessage(
    channelId: string,
    messageId: string | null
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = messageId
        ? `
          UPDATE channels
          SET last_message_id = $1, last_message_sync = NOW()
          WHERE id = $2
        `
        : `
          UPDATE channels
          SET last_message_id = NULL, last_message_sync = NULL
          WHERE id = $1
        `;
      await client.query(
        query,
        messageId ? [messageId, channelId] : [channelId]
      );
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update channel last message:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get channel watermark
   */
  async getChannelWatermark(channelId: string): Promise<
    DatabaseResult<{
      last_message_id: string | null;
      last_message_sync: Date | null;
    }>
  > {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT last_message_id, last_message_sync
        FROM channels
        WHERE id = $1
      `;
      const result = await client.query(query, [channelId]);
      return {
        success: true,
        data: result.rows[0] || {
          last_message_id: null,
          last_message_sync: null,
        },
      };
    } catch (error) {
      console.error("🔸 Failed to get channel watermark:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Embedding Operations
  // ============================================================================

  /**
   * Get messages without embeddings for batch processing
   */
  async getMessagesForEmbedding(
    guildId: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<
    DatabaseResult<
      Array<{
        id: string;
        content: string;
        created_at: Date;
      }>
    >
  > {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT id, content, created_at
        FROM messages
        WHERE guild_id = $1
          AND active = true
          AND embedding IS NULL
          AND content IS NOT NULL
          AND content != ''
          AND LENGTH(content) >= 3
        ORDER BY created_at ASC
        LIMIT $2 OFFSET $3
      `;

      const result = await client.query(query, [guildId, limit, offset]);
      return {
        success: true,
        data: result.rows.map((row) => ({
          id: row.id,
          content: row.content,
          created_at: new Date(row.created_at),
        })),
      };
    } catch (error) {
      console.error("🔸 Failed to get messages for embedding:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update single message embedding
   */
  async updateMessageEmbedding(
    messageId: string,
    embedding: number[]
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const embeddingStr = `[${embedding.join(",")}]`;
      const query = `
        UPDATE messages
        SET embedding = $1::vector
        WHERE id = $2
      `;

      await client.query(query, [embeddingStr, messageId]);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update message embedding:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Batch update multiple message embeddings
   */
  async updateMessageEmbeddingsBatch(
    updates: Array<{ messageId: string; embedding: number[] }>
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    if (updates.length === 0) {
      return { success: true };
    }

    const client = await this.pool!.connect();
    try {
      // Use a transaction for batch update
      await client.query("BEGIN");

      for (const update of updates) {
        const embeddingStr = `[${update.embedding.join(",")}]`;
        await client.query(
          `
          UPDATE messages
          SET embedding = $1::vector
          WHERE id = $2
        `,
          [embeddingStr, update.messageId]
        );
      }

      await client.query("COMMIT");
      return { success: true };
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("🔸 Failed to batch update message embeddings:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Check if messages have embeddings
   */
  async checkEmbeddingsExist(
    messageIds: string[]
  ): Promise<DatabaseResult<Map<string, boolean>>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    if (messageIds.length === 0) {
      return { success: true, data: new Map() };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT id, embedding IS NOT NULL as has_embedding
        FROM messages
        WHERE id = ANY($1::text[])
      `;

      const result = await client.query(query, [messageIds]);
      const embeddingMap = new Map<string, boolean>();

      for (const row of result.rows) {
        embeddingMap.set(row.id, row.has_embedding);
      }

      // Ensure all requested IDs are in map (default to false)
      for (const id of messageIds) {
        if (!embeddingMap.has(id)) {
          embeddingMap.set(id, false);
        }
      }

      return { success: true, data: embeddingMap };
    } catch (error) {
      console.error("🔸 Failed to check embeddings exist:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Voice Session Operations
  // ============================================================================

  /**
   * Create a new voice session
   */
  async createVoiceSession(
    sessionData: Record<string, unknown>
  ): Promise<DatabaseResult<any>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        INSERT INTO voice_sessions (
          id, guild_id, user_id, channel_id, joined_at, left_at,
          duration, time_muted, time_deafened, time_streaming,
          owner_at_join, is_grandfathered, applied_moderation, active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *
      `;

      const values = [
        sessionData.id,
        sessionData.guild_id,
        sessionData.user_id,
        sessionData.channel_id,
        sessionData.joined_at,
        sessionData.left_at || null,
        sessionData.duration || 0,
        sessionData.time_muted || 0,
        sessionData.time_deafened || 0,
        sessionData.time_streaming || 0,
        sessionData.owner_at_join || null,
        sessionData.is_grandfathered || false,
        JSON.stringify(sessionData.applied_moderation || {}),
        sessionData.active !== undefined ? sessionData.active : true,
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to create voice session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get active voice session for a user in a guild
   */
  async getActiveVoiceSession(
    userId: string,
    guildId: string
  ): Promise<DatabaseResult<any>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM voice_sessions
        WHERE user_id = $1 AND guild_id = $2 AND active = true
        ORDER BY joined_at DESC
        LIMIT 1
      `;

      const result = await client.query(query, [userId, guildId]);
      return {
        success: true,
        data: result.rows[0] || null,
      };
    } catch (error) {
      console.error("🔸 Failed to get active voice session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Update voice session
   */
  async updateVoiceSession(
    sessionId: string,
    updates: Record<string, unknown>
  ): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const updateFields: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        if (key === "applied_moderation" && typeof value === "object") {
          updateFields.push(`${key} = $${paramIndex}::jsonb`);
          values.push(JSON.stringify(value));
        } else {
          updateFields.push(`${key} = $${paramIndex}`);
          values.push(value);
        }
        paramIndex++;
      }

      if (updateFields.length === 0) {
        return { success: true };
      }

      updateFields.push(`updated_at = NOW()`);
      values.push(sessionId);

      const query = `
        UPDATE voice_sessions
        SET ${updateFields.join(", ")}
        WHERE id = $${paramIndex}
      `;

      await client.query(query, values);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to update voice session:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Upsert voice state
   */
  async upsertVoiceState(
    voiceStateData: Record<string, unknown>
  ): Promise<DatabaseResult<any>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        INSERT INTO voice_states (
          id, guild_id, user_id, channel_id, session_id,
          self_mute, self_deaf, server_mute, server_deaf,
          streaming, self_video, joined_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          session_id = EXCLUDED.session_id,
          self_mute = EXCLUDED.self_mute,
          self_deaf = EXCLUDED.self_deaf,
          server_mute = EXCLUDED.server_mute,
          server_deaf = EXCLUDED.server_deaf,
          streaming = EXCLUDED.streaming,
          self_video = EXCLUDED.self_video,
          joined_at = EXCLUDED.joined_at,
          updated_at = NOW()
        RETURNING *
      `;

      const values = [
        voiceStateData.id,
        voiceStateData.guild_id,
        voiceStateData.user_id,
        voiceStateData.channel_id || null,
        voiceStateData.session_id || null,
        voiceStateData.self_mute || false,
        voiceStateData.self_deaf || false,
        voiceStateData.server_mute || false,
        voiceStateData.server_deaf || false,
        voiceStateData.streaming || false,
        voiceStateData.self_video || false,
        voiceStateData.joined_at || new Date(),
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to upsert voice state:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Delete voice state
   */
  async deleteVoiceState(voiceStateId: string): Promise<DatabaseResult<void>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `DELETE FROM voice_states WHERE id = $1`;
      await client.query(query, [voiceStateId]);
      return { success: true };
    } catch (error) {
      console.error("🔸 Failed to delete voice state:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get active voice states for a guild
   */
  async getActiveVoiceStates(guildId: string): Promise<DatabaseResult<any[]>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        SELECT * FROM voice_states
        WHERE guild_id = $1 AND channel_id IS NOT NULL
        ORDER BY joined_at DESC
      `;

      const result = await client.query(query, [guildId]);
      return { success: true, data: result.rows };
    } catch (error) {
      console.error("🔸 Failed to get active voice states:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }

  /**
   * Create voice history entry
   */
  async createVoiceHistory(
    historyData: Record<string, unknown>
  ): Promise<DatabaseResult<any>> {
    if (!this.isConnected()) {
      return { success: false, error: "Database not connected" };
    }

    const client = await this.pool!.connect();
    try {
      const query = `
        INSERT INTO voice_history (
          id, guild_id, user_id, channel_id, event_type,
          from_channel_id, to_channel_id, session_id,
          self_mute, self_deaf, server_mute, server_deaf,
          streaming, self_video, timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
      `;

      const values = [
        historyData.id,
        historyData.guild_id,
        historyData.user_id,
        historyData.channel_id || null,
        historyData.event_type,
        historyData.from_channel_id || null,
        historyData.to_channel_id || null,
        historyData.session_id || null,
        historyData.self_mute || false,
        historyData.self_deaf || false,
        historyData.server_mute || false,
        historyData.server_deaf || false,
        historyData.streaming || false,
        historyData.self_video || false,
        historyData.timestamp || new Date(),
      ];

      const result = await client.query(query, values);
      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error("🔸 Failed to create voice history:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      client.release();
    }
  }
}
