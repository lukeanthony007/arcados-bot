import type { MediaTrack } from "./types.js";
import { LoopMode } from "./types.js";

/**
 * Manages the audio queue for media playback
 */
export class AudioQueue {
	private queue: MediaTrack[] = [];
	private currentIndex: number = -1;
	private shuffleOrder: number[] = [];
	private loopMode: LoopMode = LoopMode.OFF;

	/**
	 * Add a track to the queue
	 */
	add(track: MediaTrack): void {
		this.queue.push(track);
		this.updateShuffleOrder();
	}

	/**
	 * Add multiple tracks to the queue
	 */
	addMany(tracks: MediaTrack[]): void {
		this.queue.push(...tracks);
		this.updateShuffleOrder();
	}

	/**
	 * Remove a track from the queue by ID
	 */
	remove(trackId: string): boolean {
		const index = this.queue.findIndex((t) => t.id === trackId);
		if (index === -1) return false;

		this.queue.splice(index, 1);
		this.updateShuffleOrder();

		// Adjust current index if needed
		if (this.currentIndex >= index && this.currentIndex > 0) {
			this.currentIndex--;
		}

		return true;
	}

	/**
	 * Clear the entire queue
	 */
	clear(): void {
		this.queue = [];
		this.currentIndex = -1;
		this.shuffleOrder = [];
	}

	/**
	 * Get the next track in queue
	 */
	getNext(): MediaTrack | null {
		if (this.queue.length === 0) return null;

		// Loop ONE: repeat current track
		if (this.loopMode === LoopMode.ONE && this.currentIndex !== -1) {
			return this.queue[this.currentIndex] || null;
		}

		if (this.shuffleOrder.length > 0) {
			// Use shuffle order
			this.currentIndex = this.shuffleOrder.shift() ?? this.currentIndex;

			// If shuffle order is exhausted and loop ALL is enabled, regenerate
			if (this.shuffleOrder.length === 0 && this.loopMode === LoopMode.ALL) {
				this.updateShuffleOrder();
			}

			return this.queue[this.currentIndex] || null;
		}

		// Normal order
		this.currentIndex++;
		if (this.currentIndex >= this.queue.length) {
			// Loop ALL: restart queue
			if (this.loopMode === LoopMode.ALL) {
				this.currentIndex = 0;
				return this.queue[this.currentIndex] || null;
			}
			return null; // End of queue
		}

		return this.queue[this.currentIndex] || null;
	}

	/**
	 * Get the previous track
	 */
	getPrevious(): MediaTrack | null {
		if (this.queue.length === 0 || this.currentIndex <= 0) return null;

		this.currentIndex--;
		return this.queue[this.currentIndex] || null;
	}

	/**
	 * Get current track
	 */
	getCurrent(): MediaTrack | null {
		if (this.currentIndex === -1 || this.currentIndex >= this.queue.length) {
			return null;
		}
		return this.queue[this.currentIndex] ?? null;
	}

	/**
	 * Get all tracks in queue
	 */
	getAll(): MediaTrack[] {
		return [...this.queue];
	}

	/**
	 * Get queue length
	 */
	getLength(): number {
		return this.queue.length;
	}

	/**
	 * Check if queue is empty
	 */
	isEmpty(): boolean {
		return this.queue.length === 0;
	}

	/**
	 * Shuffle the queue
	 */
	shuffle(): void {
		this.updateShuffleOrder();
	}

	/**
	 * Update shuffle order array
	 */
	private updateShuffleOrder(): void {
		if (this.queue.length === 0) {
			this.shuffleOrder = [];
			return;
		}

		// Create array of indices
		const indices = Array.from({ length: this.queue.length }, (_, i) => i);

		// Fisher-Yates shuffle
		for (let i = indices.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const tmp = indices[i] as number;
			indices[i] = indices[j] as number;
			indices[j] = tmp;
		}

		this.shuffleOrder = indices;
	}

	/**
	 * Get position in queue
	 */
	getPosition(): number {
		return this.currentIndex;
	}

	/**
	 * Skip to a specific position in queue
	 */
	skipTo(position: number): MediaTrack | null {
		if (position < 0 || position >= this.queue.length) {
			return null;
		}

		this.currentIndex = position;
		return this.queue[this.currentIndex] || null;
	}

	/**
	 * Set loop mode
	 */
	setLoopMode(mode: LoopMode): void {
		this.loopMode = mode;
	}

	/**
	 * Get current loop mode
	 */
	getLoopMode(): LoopMode {
		return this.loopMode;
	}

	/**
	 * Toggle loop mode (cycles through OFF -> ALL -> ONE -> OFF)
	 */
	toggleLoopMode(): LoopMode {
		switch (this.loopMode) {
			case LoopMode.OFF:
				this.loopMode = LoopMode.ALL;
				break;
			case LoopMode.ALL:
				this.loopMode = LoopMode.ONE;
				break;
			case LoopMode.ONE:
				this.loopMode = LoopMode.OFF;
				break;
		}
		return this.loopMode;
	}
}

