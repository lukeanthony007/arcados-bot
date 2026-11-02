import { CartesiaClient } from "@cartesia/cartesia-js";
import { config } from "../../../../config/index.js";
import type { TTSChunk } from "../../types.js";
import {
  TTS_CONSTANTS,
  CARTESIA_CONSTANTS,
  AUDIO_CONSTANTS,
} from "../../constants.js";
import { AudioProcessor } from "./AudioProcessor.js";
import { APICostTracker } from "../../../../utils/APICostTracker.js";

/**
 * Retry a function with exponential backoff
 * @param fn Function to retry
 * @param maxRetries Maximum number of retries
 * @param baseDelay Base delay in milliseconds
 * @returns Result of the function
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 2,
  baseDelay: number = 500
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        // Exponential backoff: 500ms, 1000ms, 2000ms
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(
          `[Cartesia Retry] Attempt ${
            attempt + 1
          } failed, retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Simple LRU cache for TTS audio
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recent)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete if exists to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Add new entry
    this.cache.set(key, value);

    // Evict oldest if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Rate limiter using token bucket algorithm
 */
class RateLimiter {
  private queue: Array<() => void> = [];
  private activeRequests = 0;
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async limit<T>(fn: () => Promise<T>): Promise<T> {
    // Wait until we have capacity
    await this.waitForCapacity();

    this.activeRequests++;

    try {
      return await fn();
    } finally {
      this.activeRequests--;
      this.processQueue();
    }
  }

  private waitForCapacity(): Promise<void> {
    if (this.activeRequests < this.maxConcurrent) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const resolve = this.queue.shift();
      if (resolve) {
        resolve();
      }
    }
  }
}

/**
 * Cartesia Text-to-Speech service
 * Converts text to audio using Cartesia's Sonic API with WebSocket support
 *
 * Features:
 * - WebSocket-based for lowest latency (~200ms faster than HTTP)
 * - Native 48kHz support (Discord-compatible)
 * - High-quality Sonic 3 model with 50+ emotions
 * - Automatic mono→stereo conversion for Discord
 */
export class CartesiaTTSService {
  private static instance: CartesiaTTSService;
  private readonly client: CartesiaClient | null;
  private readonly voiceId: string;
  private readonly model: string;
  private websocket: any = null;
  private wsConnectPromise: Promise<void> | null = null;

  // LRU cache for synthesized audio
  private audioCache = new LRUCache<string, Buffer>(TTS_CONSTANTS.CACHE_SIZE);

  // Rate limiter
  private rateLimiter = new RateLimiter(TTS_CONSTANTS.MAX_CONCURRENT_REQUESTS);

  // Audio processor for resampling
  private audioProcessor = AudioProcessor.getInstance();

  private constructor() {
    const apiKey = config.cartesiaApiKey;

    if (!apiKey) {
      console.warn(
        "[CartesiaTTS] No API key configured, service will be unavailable"
      );
      this.client = null;
      this.voiceId = CARTESIA_CONSTANTS.DEFAULT_VOICE_ID;
      this.model = CARTESIA_CONSTANTS.MODEL;
      return;
    }

    this.client = new CartesiaClient({
      apiKey: apiKey,
    });

    this.voiceId =
      config.cartesiaVoiceId || CARTESIA_CONSTANTS.DEFAULT_VOICE_ID;
    this.model = config.cartesiaModel || CARTESIA_CONSTANTS.MODEL;
  }

  public static getInstance(): CartesiaTTSService {
    if (!CartesiaTTSService.instance) {
      CartesiaTTSService.instance = new CartesiaTTSService();
    }
    return CartesiaTTSService.instance;
  }

  /**
   * Reset WebSocket connection (force reconnect on next use)
   */
  private resetWebSocket(): void {
    if (this.websocket) {
      // Safely close the websocket if it has a close method
      try {
        if (typeof this.websocket.close === 'function') {
          this.websocket.close().catch(() => {
            // Ignore errors during close
          });
        } else if (typeof this.websocket.destroy === 'function') {
          // Some websocket implementations use destroy instead
          this.websocket.destroy();
        }
      } catch (error) {
        // Ignore errors during close
      }
    }
    this.websocket = null;
    this.wsConnectPromise = null;
  }

  /**
   * Initialize WebSocket connection
   * Connects in advance to save ~200ms latency on first request
   */
  private async ensureWebSocketConnected(): Promise<void> {
    if (!this.client) {
      throw new Error("Cartesia client not initialized (missing API key)");
    }

    // If already connected, return immediately
    if (this.websocket) {
      return;
    }

    // If connection is in progress, wait for it
    if (this.wsConnectPromise) {
      return this.wsConnectPromise;
    }

    // Store client reference for closure
    const client = this.client;

    // Start new connection
    this.wsConnectPromise = (async () => {
      try {
        this.websocket = client.tts.websocket({
          container: CARTESIA_CONSTANTS.OUTPUT_FORMAT.container,
          encoding: CARTESIA_CONSTANTS.OUTPUT_FORMAT.encoding,
          sampleRate: CARTESIA_CONSTANTS.OUTPUT_FORMAT.sampleRate,
        });

        await this.websocket.connect();
      } catch (error) {
        console.error("[CartesiaTTS] WebSocket connection failed:", error);
        this.websocket = null;
        this.wsConnectPromise = null;
        throw error;
      }
    })();

    await this.wsConnectPromise;
    this.wsConnectPromise = null;
  }

  /**
   * Synthesize text to audio
   *
   * @param text Text to synthesize
   * @returns PCM audio buffer (48kHz stereo 16-bit)
   */
  public async synthesize(text: string): Promise<Buffer> {
    if (!this.client) {
      throw new Error("Cartesia TTS not configured (missing API key)");
    }

    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error("Cannot synthesize empty text");
    }

    // Check cache first
    const cacheKey = `${this.voiceId}:${normalizedText}`;
    const cachedAudio = this.audioCache.get(cacheKey);
    if (cachedAudio) {
      // Cache hit - no API call, no cost
      return cachedAudio;
    }

    const startTime = Date.now();
    const tracker = APICostTracker.getInstance();
    const characterCount = normalizedText.length;

    // Use rate limiter for WebSocket requests
    return this.rateLimiter.limit(async () => {
      // Check cache again in case another request synthesized it while we were waiting
      const recheck = this.audioCache.get(cacheKey);
      if (recheck) {
        return recheck;
      }

      // Retry synthesis with exponential backoff
      const audioBuffer = await retryWithBackoff(
        async () => {
          await this.ensureWebSocketConnected();

          // Verify WebSocket is still connected
          if (!this.websocket) {
            throw new Error("WebSocket connection lost, reconnecting...");
          }

          // Send TTS request via WebSocket with timeout
          // SDK expects camelCase (converts to snake_case internally for API)
          // contextId is required for WebSocket requests
          const contextId = `tts-${Date.now()}-${Math.random()
            .toString(36)
            .substring(7)}`;
          const responsePromise = this.websocket.send({
            modelId: this.model,
            voice: {
              mode: "id",
              id: this.voiceId,
            },
            transcript: normalizedText,
            outputFormat: {
              container: CARTESIA_CONSTANTS.OUTPUT_FORMAT.container,
              encoding: CARTESIA_CONSTANTS.OUTPUT_FORMAT.encoding,
              sampleRate: CARTESIA_CONSTANTS.OUTPUT_FORMAT.sampleRate,
            },
            language: CARTESIA_CONSTANTS.LANGUAGE,
            contextId: contextId,
          });

          // Add timeout for the entire synthesis (30 seconds)
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error("Cartesia TTS synthesis timeout (30s)"));
            }, 30000);
          });

          const response = await Promise.race([
            responsePromise,
            timeoutPromise,
          ]);

          // Collect audio chunks
          const chunks: Buffer[] = [];
          let errorMessage: string | null = null;
          let receivedDone = false;

          // Process events - Cartesia WebSocket returns JSON strings with base64-encoded audio
          try {
            for await (const event of response.events("message")) {
              let parsedEvent: any = event;

              // If event is a string, parse it as JSON
              if (typeof event === "string") {
                try {
                  parsedEvent = JSON.parse(event);
                } catch {
                  // Not JSON, might be raw binary - skip
                  continue;
                }
              }

              // Handle JSON objects with base64-encoded data
              if (
                parsedEvent &&
                typeof parsedEvent === "object" &&
                !Array.isArray(parsedEvent)
              ) {
                // Extract base64-encoded audio data
                if (parsedEvent.data && typeof parsedEvent.data === "string") {
                  try {
                    const audioData = Buffer.from(parsedEvent.data, "base64");
                    if (audioData.length > 0) {
                      chunks.push(audioData);
                    }
                  } catch (decodeError) {
                    console.error(
                      "[CartesiaTTS] Failed to decode base64 data:",
                      decodeError
                    );
                  }
                }
                // Handle binary data field (if already decoded)
                else if (
                  parsedEvent.data &&
                  (parsedEvent.data instanceof ArrayBuffer ||
                    parsedEvent.data instanceof Uint8Array)
                ) {
                  const audioData = Buffer.from(parsedEvent.data);
                  if (audioData.length > 0) {
                    chunks.push(audioData);
                  }
                }

                // Check for completion
                if (
                  parsedEvent.done === true ||
                  parsedEvent.type === "done" ||
                  parsedEvent.type === "complete" ||
                  parsedEvent.type === "end"
                ) {
                  receivedDone = true;
                  break;
                }

                // Check for errors
                if (
                  parsedEvent.type === "error" ||
                  parsedEvent.error ||
                  (parsedEvent.status_code && parsedEvent.status_code >= 400)
                ) {
                  errorMessage =
                    parsedEvent.error?.message ||
                    parsedEvent.message ||
                    parsedEvent.error ||
                    `Status ${parsedEvent.status_code}`;
                  console.error("[CartesiaTTS] Received error:", errorMessage);
                  break;
                }
              }
              // Handle raw binary buffers (if SDK decodes them)
              else if (
                event &&
                (event instanceof Buffer ||
                  event instanceof Uint8Array ||
                  event instanceof ArrayBuffer)
              ) {
                const audioData =
                  event instanceof ArrayBuffer
                    ? Buffer.from(event)
                    : Buffer.from(event.buffer, event.byteOffset, event.byteLength);
                if (audioData.length > 0) {
                  chunks.push(audioData);
                }
              }
            }
          } catch (eventError) {
            console.error("[CartesiaTTS] Error processing events:", eventError);
            // If we have some chunks, continue; otherwise throw
            if (chunks.length === 0) {
              throw new Error(
                `Cartesia event processing error: ${
                  eventError instanceof Error
                    ? eventError.message
                    : String(eventError)
                }`
              );
            }
          }

          // Check for errors first
          if (errorMessage) {
            // Reset connection on error to force reconnect
            this.resetWebSocket();
            throw new Error(`Cartesia TTS error: ${errorMessage}`);
          }

          // Check if we received any chunks
          if (chunks.length === 0) {
            // Reset connection on failure to force reconnect
            this.resetWebSocket();
            // If we got a done event but no chunks, the text might be empty or invalid
            if (receivedDone) {
              throw new Error(
                "Cartesia returned no audio chunks (synthesis completed but no audio data)"
              );
            }
            throw new Error("Cartesia returned no audio chunks");
          }

          // Combine all chunks
          const monoAudio = Buffer.concat(chunks);

          // Use proper interpolation resampling (better quality than simple duplication)
          // Resample from source rate to 48000 Hz (Discord requirement)
          const resampledMono = this.audioProcessor.resample(
            monoAudio,
            CARTESIA_CONSTANTS.OUTPUT_FORMAT.sampleRate,
            AUDIO_CONSTANTS.SAMPLE_RATE
          );

          // Convert mono to stereo (Discord requires stereo)
          // Match tone generator format: 48kHz stereo 16-bit PCM little-endian
          const stereoAudio = this.monoToStereo(resampledMono);

          // Add WAV header like tone generator does (for proper format detection)
          return this.addWavHeader(stereoAudio, AUDIO_CONSTANTS.SAMPLE_RATE, 2);
        },
        2,
        500
      );

      // Cache the result
      this.audioCache.set(cacheKey, audioBuffer);

      const latency = Date.now() - startTime;

      // Track successful synthesis
      tracker.trackRequest("cartesia", {
        endpoint: "synthesize",
        success: true,
        characters: characterCount,
        latency,
        additionalMetadata: {
          voiceId: this.voiceId,
          model: this.model,
          cached: false,
        },
      });

      return audioBuffer;
    }).catch((error) => {
      const latency = Date.now() - startTime;
      const tracker = APICostTracker.getInstance();
      tracker.trackRequest("cartesia", {
        endpoint: "synthesize",
        success: false,
        error: error instanceof Error ? error.message : String(error),
        characters: characterCount,
        latency,
        additionalMetadata: {
          voiceId: this.voiceId,
          model: this.model,
        },
      });
      throw error;
    });
  }

  /**
   * Convert mono PCM to stereo PCM
   * Discord requires stereo audio
   *
   * @param monoBuffer Mono PCM buffer (16-bit little-endian)
   * @returns Stereo PCM buffer (16-bit little-endian, duplicated channels)
   */
  private monoToStereo(monoBuffer: Buffer): Buffer {
    // Ensure buffer length is even (16-bit samples = 2 bytes each)
    const sampleCount = Math.floor(monoBuffer.length / 2);
    const stereoBuffer = Buffer.alloc(sampleCount * 4); // 2 bytes per channel * 2 channels

    for (let i = 0; i < sampleCount; i++) {
      // Read 16-bit mono sample (little-endian)
      const sample = monoBuffer.readInt16LE(i * 2);

      // Write to both left and right channels
      stereoBuffer.writeInt16LE(sample, i * 4); // Left channel
      stereoBuffer.writeInt16LE(sample, i * 4 + 2); // Right channel
    }

    return stereoBuffer;
  }

  /**
   * Add WAV header to PCM audio data
   * Matches the format used by AudioToneGenerator for proper Discord playback
   *
   * @param pcmData Raw PCM audio data (48kHz stereo 16-bit)
   * @param sampleRate Sample rate (48000)
   * @param channels Number of channels (2 for stereo)
   * @returns WAV file buffer with header
   */
  private addWavHeader(
    pcmData: Buffer,
    sampleRate: number,
    channels: number
  ): Buffer {
    const bitsPerSample = 16;
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);

    // "RIFF" chunk descriptor
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataSize, 4); // File size - 8
    header.write("WAVE", 8);

    // "fmt " sub-chunk
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // "data" sub-chunk
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    // Combine header and PCM data
    return Buffer.concat([header, pcmData]);
  }

  /**
   * Split text into natural speech chunks for streaming
   * Uses length-aware splitting with target chunk size of 100-150 chars
   * Splits on sentence boundaries (. ! ?) and commas for minimal latency
   *
   * @param text Full text to split
   * @returns Array of text chunks
   */
  public splitIntoChunks(text: string): string[] {
    const TARGET_CHUNK_SIZE = 125; // Target 125 chars (middle of 100-150 range)
    const MIN_CHUNK_SIZE = 50; // Don't create tiny chunks
    const MAX_CHUNK_SIZE = 200; // Hard limit to prevent very long chunks

    const chunks: string[] = [];

    // First split by sentence endings (. ! ?)
    const sentences = text.split(/([.!?]\s+)/);

    let currentChunk = "";

    for (const part of sentences) {
      // If it's a sentence ending, add to current chunk
      if (/^[.!?]\s+$/.test(part)) {
        currentChunk += part.trim();

        // Flush if we've reached target size or if chunk is already large
        if (
          currentChunk.length >= TARGET_CHUNK_SIZE ||
          currentChunk.length > MAX_CHUNK_SIZE
        ) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
          }
        }
      } else {
        // For longer sentences, split on commas
        const commaParts = part.split(/,\s+/);

        for (let i = 0; i < commaParts.length; i++) {
          const commaPart = commaParts[i];

          if (!commaPart) continue; // Skip empty parts

          // Add comma back except for last part
          const textToAdd =
            i < commaParts.length - 1 ? commaPart + "," : commaPart;

          // Check if adding this would exceed max chunk size
          if (currentChunk.length + textToAdd.length > MAX_CHUNK_SIZE) {
            // Flush current chunk if it's not too small
            if (currentChunk.length >= MIN_CHUNK_SIZE) {
              chunks.push(currentChunk.trim());
              currentChunk = textToAdd;
            } else {
              // Chunk too small, keep adding
              currentChunk += (currentChunk.length > 0 ? " " : "") + textToAdd;
            }
          } else if (
            currentChunk.length + textToAdd.length >= TARGET_CHUNK_SIZE &&
            i < commaParts.length - 1
          ) {
            // At a good break point (comma) and near target size
            currentChunk += (currentChunk.length > 0 ? " " : "") + textToAdd;
            chunks.push(currentChunk.trim());
            currentChunk = "";
          } else {
            // Keep building chunk
            currentChunk += (currentChunk.length > 0 ? " " : "") + textToAdd;
          }
        }
      }
    }

    // Flush any remaining text
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }

  /**
   * Kick off synthesis for all chunks immediately so playback can start
   * as soon as the first chunk is ready while remaining chunks continue
   * processing in parallel.
   *
   * @param text Full text to synthesize
   * @returns Total chunk count with synthesis promises
   */
  public createChunkSynthesisQueue(text: string): {
    chunkCount: number;
    chunkPromises: Array<Promise<TTSChunk | null>>;
  } {
    const textChunks = this.splitIntoChunks(text);
    const chunkCount = textChunks.length;

    const chunkPromises = textChunks.map((chunkText, index) => {
      return this.synthesize(chunkText)
        .then((audioBuffer): TTSChunk => {
          return {
            audio: audioBuffer,
            text: chunkText,
            sequence: index,
            isFinal: index === textChunks.length - 1,
          };
        })
        .catch((error) => {
          console.error(
            `[CartesiaTTS] Failed to synthesize chunk ${
              index + 1
            }/${chunkCount}:`,
            error
          );
          return null; // Return null for failed chunks
        });
    });

    return {
      chunkCount,
      chunkPromises,
    };
  }

  /**
   * Check if Cartesia TTS is configured and available
   */
  public isConfigured(): boolean {
    return !!this.client;
  }

  /**
   * Close WebSocket connection
   * Automatically called after 5 minutes of inactivity by Cartesia
   */
  public async disconnect(): Promise<void> {
    if (this.websocket) {
      try {
        await this.websocket.close();
        console.log("[CartesiaTTS] WebSocket disconnected");
      } catch (error) {
        console.error("[CartesiaTTS] Error disconnecting WebSocket:", error);
      } finally {
        this.websocket = null;
        this.wsConnectPromise = null;
      }
    }
  }

  /**
   * Clear the audio cache
   */
  public clearCache(): void {
    this.audioCache.clear();
  }
}
