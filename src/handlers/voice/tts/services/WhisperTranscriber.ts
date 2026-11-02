import { config } from "../../../../config/index.js";
import type { AudioChunk } from "../../types.js";
import { TRANSCRIPTION_CONSTANTS } from "../../constants.js";

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
				console.log(`[Retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError;
}

/**
 * Whisper speech-to-text transcription service
 * Supports local Whisper (preferred) with OpenAI API fallback
 */
export class WhisperTranscriber {
	private static instance: WhisperTranscriber;
	private readonly whisperUrl?: string;
	private readonly whisperApiKey?: string;
	private readonly openaiApiKey?: string;

	private constructor() {
		this.whisperUrl = config.whisperUrl;
		this.whisperApiKey = config.whisperApiKey;
		this.openaiApiKey = config.openaiApiKey;
	}

	public static getInstance(): WhisperTranscriber {
		if (!WhisperTranscriber.instance) {
			WhisperTranscriber.instance = new WhisperTranscriber();
		}
		return WhisperTranscriber.instance;
	}

	/**
	 * Transcribe audio chunk to text
	 *
	 * @param audioChunk Audio chunk with PCM data
	 * @returns Transcribed text
	 */
	public async transcribe(audioChunk: AudioChunk): Promise<string> {
		// Ensure at least one transcription service is configured
		if (!this.whisperUrl && !this.openaiApiKey) {
			throw new Error(
				"No Whisper transcription service configured. Set WHISPER_URL for local or OPENAI_API_KEY for cloud."
			);
		}

		let lastError: Error | undefined;

		// Try local Whisper first (free and fast) with retry
		if (this.whisperUrl) {
			try {
				return await retryWithBackoff(() => this.transcribeLocal(audioChunk), 2, 500);
			} catch (error: any) {
				console.error("[WhisperTranscriber] Local Whisper transcription failed after retries:", {
					message: error?.message,
					response: error?.response?.data,
					status: error?.response?.status,
				});
				lastError = error;

				// Fall back to OpenAI if available
				if (this.openaiApiKey) {
					console.log("[WhisperTranscriber] Falling back to OpenAI Whisper...");
				} else {
					throw error; // No fallback available
				}
			}
		}

		// Fallback to OpenAI Whisper API with retry
		if (this.openaiApiKey) {
			try {
				return await retryWithBackoff(() => this.transcribeOpenAI(audioChunk), 2, 500);
			} catch (error: any) {
				console.error("[WhisperTranscriber] OpenAI Whisper transcription failed:", error);

				// If both services failed, throw comprehensive error
				if (lastError) {
					throw new Error(
						`All transcription methods failed. Local: ${lastError.message}, OpenAI: ${error.message}`
					);
				}
				throw error;
			}
		}

		// Should never reach here due to earlier check, but TypeScript needs it
		throw new Error("No transcription service available");
	}

	/**
	 * Transcribe using local Whisper endpoint
	 * Supports whisper.cpp server
	 *
	 * @param audioChunk Audio chunk to transcribe
	 * @returns Transcribed text
	 */
	private async transcribeLocal(audioChunk: AudioChunk): Promise<string> {
		if (!this.whisperUrl) {
			throw new Error("Local Whisper URL not configured");
		}

		// Convert PCM to WAV format
		const wavBuffer = this.pcmToWav(audioChunk);

		// Create form data for multipart upload
		const formData = new FormData();
		const audioBlob = new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" });
		formData.append("file", audioBlob, "audio.wav");
		formData.append("temperature", TRANSCRIPTION_CONSTANTS.WHISPER_TEMPERATURE.toString());
		formData.append(
			"temperature_inc",
			TRANSCRIPTION_CONSTANTS.WHISPER_TEMPERATURE_INCREMENT.toString()
		);
		formData.append("response_format", "json");

		// Add initial prompt to improve recognition of proper nouns and context
		// This helps Whisper understand uncommon names and terms
		formData.append(
			"prompt",
			"Ariya is a voice assistant. Common topics: Oracle of Delphi, philosophy, AI, technology."
		);

		const headers: Record<string, string> = {};
		if (this.whisperApiKey) {
			headers.Authorization = `Bearer ${this.whisperApiKey}`;
		}

		// Use whisper.cpp /inference endpoint
		const response = await fetch(`${this.whisperUrl}/inference`, {
			method: "POST",
			headers,
			body: formData,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Local Whisper API error (${response.status}): ${errorText}`);
		}

		const result = (await response.json()) as { text?: string };

		if (!result.text) {
			throw new Error("Local Whisper API returned no transcription");
		}

		return result.text.trim();
	}

	/**
	 * Transcribe using OpenAI Whisper API
	 *
	 * @param audioChunk Audio chunk to transcribe
	 * @returns Transcribed text
	 */
	private async transcribeOpenAI(audioChunk: AudioChunk): Promise<string> {
		if (!this.openaiApiKey) {
			throw new Error("OpenAI API key not configured");
		}

		// Convert PCM to WAV format
		const wavBuffer = this.pcmToWav(audioChunk);

		// Create form data for multipart upload
		const formData = new FormData();
		const audioBlob = new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" });
		formData.append("file", audioBlob, "audio.wav");
		formData.append("model", "whisper-1");
		formData.append("language", "en");
		formData.append(
			"prompt",
			"Ariya is a voice assistant. Common topics: Oracle of Delphi, philosophy, AI, technology."
		);

		const response = await fetch(
			"https://api.openai.com/v1/audio/transcriptions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.openaiApiKey}`,
				},
				body: formData,
			}
		);

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI Whisper API error (${response.status}): ${errorText}`);
		}

		const result = (await response.json()) as { text?: string };

		if (!result.text) {
			throw new Error("OpenAI Whisper API returned no transcription");
		}

		return result.text.trim();
	}

	/**
	 * Convert PCM audio to WAV format
	 * Whisper API expects WAV, MP3, or other standard formats
	 *
	 * @param audioChunk Audio chunk with PCM data
	 * @returns WAV file buffer
	 */
	private pcmToWav(audioChunk: AudioChunk): Buffer {
		const { data, sampleRate, channels } = audioChunk;

		// WAV file header (44 bytes)
		const header = Buffer.alloc(44);

		// RIFF chunk descriptor
		header.write("RIFF", 0); // ChunkID
		header.writeUInt32LE(36 + data.length, 4); // ChunkSize
		header.write("WAVE", 8); // Format

		// fmt sub-chunk
		header.write("fmt ", 12); // Subchunk1ID
		header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
		header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
		header.writeUInt16LE(channels, 22); // NumChannels
		header.writeUInt32LE(sampleRate, 24); // SampleRate
		header.writeUInt32LE(sampleRate * channels * 2, 28); // ByteRate
		header.writeUInt16LE(channels * 2, 32); // BlockAlign
		header.writeUInt16LE(16, 34); // BitsPerSample

		// data sub-chunk
		header.write("data", 36); // Subchunk2ID
		header.writeUInt32LE(data.length, 40); // Subchunk2Size

		// Combine header and PCM data
		return Buffer.concat([header, data]);
	}

	/**
	 * Check if transcription service is configured
	 */
	public isConfigured(): boolean {
		return !!(this.whisperUrl || this.openaiApiKey);
	}

	/**
	 * Get configured transcription method
	 */
	public getTranscriptionMethod(): "local" | "openai" | "none" {
		if (this.whisperUrl) return "local";
		if (this.openaiApiKey) return "openai";
		return "none";
	}
}
