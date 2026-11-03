/**
 * Keeps `conversation_segments` current: every INTERVAL_MS, re-segment the tail of every
 * channel that had messages since the last pass (or still has an open conversation), and
 * queue newly finalized conversations for a summary. No in-memory state survives a pass, so
 * a crash costs nothing; the next pass recomputes.
 */

import type { PostgreSQLManager } from "../../../database/PostgreSQLManager";
import { EnrichmentPipelineOrchestrator } from "../enrichment-pipeline/EnrichmentPipelineOrchestrator";
import { type Segment, isSignificant } from "./segmenter";
import { channelsToSegment, segmentChannelTail } from "./store";

const INTERVAL_MS = 2 * 60_000;

export class ConversationSegmenter {
	private timer: NodeJS.Timeout | null = null;
	private lastPass: Date;
	private running = false;

	constructor(private readonly db: PostgreSQLManager) {
		this.lastPass = new Date(Date.now() - 24 * 3_600_000);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.pass(), INTERVAL_MS);
		void this.pass();
	}

	async stop(): Promise<void> {
		clearInterval(this.timer ?? undefined);
		this.timer = null;
		await this.pass();
	}

	/** One pass over every guild; safe to call at any time */
	async pass(): Promise<void> {
		if (this.running) return;
		this.running = true;
		const started = new Date();
		try {
			const guilds = await this.db.query("SELECT id FROM guilds");
			for (const { id: guildId } of (guilds.data ?? []) as Array<{
				id: string;
			}>) {
				for (const channelId of await channelsToSegment(
					this.db,
					guildId,
					this.lastPass,
				)) {
					try {
						const result = await segmentChannelTail(
							this.db,
							guildId,
							channelId,
							started,
						);
						this.queueSummaries(guildId, result.finalized);
					} catch (error) {
						console.error(`🔸 Segmenting channel ${channelId} failed:`, error);
					}
				}
			}
			this.lastPass = started;
		} finally {
			this.running = false;
		}
	}

	private queueSummaries(guildId: string, finalized: Segment[]): void {
		const orchestrator = EnrichmentPipelineOrchestrator.getInstance();
		for (const seg of finalized) {
			if (!isSignificant(seg)) continue;
			const significance =
				seg.participants.length >= 5
					? "high"
					: seg.participants.length >= 3
						? "medium"
						: "low";
			orchestrator.enqueueConversation(seg.id, guildId, significance);
		}
	}
}
