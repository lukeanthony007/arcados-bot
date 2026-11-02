/**
 * Discord Chat Handler - Public API
 *
 * Export the main components and utilities for Discord chat handling.
 * Note: Core AI logic lives in src/ai/
 */

export { MessageHandler } from "./MessageHandler";
export { generateChatResponse, type ChatResponseRequest } from "./chatResponse";
export * from "./ChatSessionManager";

