import { BaseProvider } from "./BaseProvider.js";
import type { Page } from "puppeteer";
import type { SearchResult } from "../types.js";
import { STREAM_CONSTANTS } from "../constants.js";

/**
 * Provider for YouTube streaming
 * Implements scraping logic for YouTube search and playback
 */
export class YouTubeProvider extends BaseProvider {
	constructor() {
		super("youtube", "https://www.youtube.com", ["unknown"]);
		// YouTube supports all playback controls except nextEpisode
		this.capabilities = {
			pause: true,
			resume: true,
			seek: true,
			skip: true,
			restart: true,
			nextEpisode: false,
		};
	}

	/**
	 * Search for videos on YouTube
	 */
	async searchContent(query: string, page: Page): Promise<SearchResult[]> {
		try {
			const searchUrl = `${this.baseUrl}/results?search_query=${encodeURIComponent(query)}`;
			
			await page.goto(searchUrl, {
				waitUntil: "networkidle2",
				timeout: STREAM_CONSTANTS.SEARCH_TIMEOUT,
			});

			// Wait for search results to load
			await page.waitForSelector("ytd-video-renderer, ytd-video-renderer a#video-title", {
				timeout: STREAM_CONSTANTS.SEARCH_TIMEOUT,
			}).catch(() => {
				console.warn("[YouTubeProvider] Search results container not found");
			});

			// Extract search results from page
			const results = await page.evaluate((baseUrl) => {
				const searchResults: SearchResult[] = [];

				// YouTube uses ytd-video-renderer for search results
				const resultElements = Array.from(document.querySelectorAll("ytd-video-renderer")).slice(0, 10);

				for (const element of resultElements) {
					// Find the video link
					const linkElement = element.querySelector("a#video-title") as HTMLAnchorElement;
					if (!linkElement) continue;

					const href = linkElement.getAttribute("href");
					if (!href) continue;

					const url = href.startsWith("http") ? href : `${baseUrl}${href}`;
					const title = linkElement.textContent?.trim() || "";
					
					if (!title) continue;

					// Extract video ID from URL
					const videoIdMatch = href.match(/[?&]v=([^&]+)/);
					const videoId = videoIdMatch ? videoIdMatch[1] : null;

					// Extract thumbnail
					let thumbnailUrl: string | undefined;
					const thumbnailElement = element.querySelector("img") as HTMLImageElement;
					if (thumbnailElement) {
						thumbnailUrl = thumbnailElement.getAttribute("src") || thumbnailElement.getAttribute("data-src") || undefined;
					}

					// Extract channel name
					const channelElement = element.querySelector("ytd-channel-name a, #channel-name a") as HTMLAnchorElement;
					const channelName = channelElement?.textContent?.trim();

					// Extract duration if available
					const durationElement = element.querySelector("span.style-scope.ytd-thumbnail-overlay-time-status-renderer");
					const durationText = durationElement?.textContent?.trim();

					// Extract view count and upload date for description
					const metadataElement = element.querySelector("ytd-video-meta-block");
					const metadataText = metadataElement?.textContent?.trim() || "";

					// Build description
					const descriptionParts: string[] = [];
					if (channelName) {
						descriptionParts.push(`Channel: ${channelName}`);
					}
					if (durationText) {
						descriptionParts.push(`Duration: ${durationText}`);
					}
					if (metadataText) {
						descriptionParts.push(metadataText);
					}

					searchResults.push({
						title,
						type: "unknown",
						url,
						thumbnailUrl: thumbnailUrl || (videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : undefined),
						description: descriptionParts.length > 0 ? descriptionParts.join(" • ") : undefined,
					});
				}

				return searchResults;
			}, this.baseUrl);

			if (results.length === 0) {
				console.warn(`[YouTubeProvider] No search results found for query: ${query}`);
			}

			return results;
		} catch (error) {
			console.error(`[YouTubeProvider] Search failed for query "${query}":`, error);
			throw error;
		}
	}

	/**
	 * Navigate to video page
	 */
	async navigateToContent(result: SearchResult, page: Page): Promise<Page> {
		try {
			await page.goto(result.url, {
				waitUntil: "networkidle2",
				timeout: STREAM_CONSTANTS.NAVIGATION_TIMEOUT,
			});

			// Close any popups/ads before proceeding
			await this.closePopups(page);

			// Wait a bit for page to fully load
			await new Promise((resolve) => setTimeout(resolve, 2000));

			return page;
		} catch (error) {
			console.error(`[YouTubeProvider] Failed to navigate to ${result.url}:`, error);
			throw error;
		}
	}

	/**
	 * Wait for video player to be ready
	 */
	async waitForPlayer(page: Page): Promise<void> {
		try {
			console.log("[YouTubeProvider] Waiting for video player to appear...");
			
			// Wait a bit for page to fully load
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// Wait for YouTube player
			await page.waitForSelector("video, #movie_player, ytd-player", {
				timeout: STREAM_CONSTANTS.PLAYER_DETECTION_TIMEOUT,
			}).catch(() => {
				console.warn("[YouTubeProvider] Video player element not found with standard selectors");
			});

			// Wait a bit more for any dynamic content to load
			await new Promise((resolve) => setTimeout(resolve, 2000));
		} catch (error) {
			console.error("[YouTubeProvider] Failed to wait for player:", error);
			// Don't throw - continue anyway, clickPlay will try to find and play video
		}
	}

	/**
	 * Click play button or video element to start playback
	 */
	async clickPlay(page: Page): Promise<void> {
		try {
			console.log("[YouTubeProvider] Attempting to start video playback...");
			
			const maxAttempts = 10;
			let attempts = 0;
			let isPlaying = false;

			while (attempts < maxAttempts && !isPlaying) {
				attempts++;
				console.log(`[YouTubeProvider] Play attempt ${attempts}/${maxAttempts}...`);

				// Close popups first
				await this.closePopups(page);
				
				// Wait a bit for page to settle
				await new Promise((resolve) => setTimeout(resolve, 1500));

				// Try to find and click the YouTube play button
				const playResult = await page.evaluate(() => {
					// First, try to find the main video element
					const video = document.querySelector("video") as HTMLVideoElement;
					
					if (video) {
						// Try clicking the video element first
						video.click();
						
						// Also try programmatic play
						video.play().catch(() => {
							video.click();
						});
						
						return { success: true, method: "video-click", isPlaying: !video.paused };
					}

					// Try to find YouTube's play button
					const playSelectors = [
						"button.ytp-play-button",
						"button[aria-label*='play' i]",
						".ytp-large-play-button",
						"#movie_player .ytp-play-button",
					];

					for (const selector of playSelectors) {
						try {
							const element = document.querySelector(selector) as HTMLElement;
							if (element && element.offsetParent !== null) {
								element.click();
								return { success: true, method: `button-${selector}`, isPlaying: false };
							}
						} catch (e) {
							continue;
						}
					}

					// Try clicking center of page (where video players usually are)
					const centerX = window.innerWidth / 2;
					const centerY = window.innerHeight / 2;
					const elementAtCenter = document.elementFromPoint(centerX, centerY);
					if (elementAtCenter) {
						(elementAtCenter as HTMLElement).click();
						return { success: true, method: "center-click", isPlaying: false };
					}

					return { success: false, method: "none", isPlaying: false };
				});

				console.log(`[YouTubeProvider] Play attempt ${attempts} result:`, playResult);

				// Wait a bit for playback to start
				await new Promise((resolve) => setTimeout(resolve, 2000));
				
				// Verify video is actually playing
				isPlaying = await page.evaluate(() => {
					const video = document.querySelector("video") as HTMLVideoElement;
					if (video) {
						return !video.paused && video.readyState >= 2 && video.currentTime > 0;
					}
					return false;
				});

				if (isPlaying) {
					console.log("[YouTubeProvider] 🔹 Video is playing successfully!");
					break;
				} else {
					console.log(`[YouTubeProvider] Video not playing yet, will retry... (attempt ${attempts}/${maxAttempts})`);
				}
			}

			if (!isPlaying) {
				console.warn("[YouTubeProvider] ⚠️ Could not confirm video playback after all attempts, but continuing...");
			}
		} catch (error) {
			console.error("[YouTubeProvider] Failed to click play:", error);
			// Don't throw - continue anyway, streaming might still work
		}
	}

	/**
	 * Enter fullscreen mode
	 */
	async enterFullscreen(page: Page): Promise<void> {
		try {
			await page.evaluate(() => {
				const video = document.querySelector("video") as HTMLVideoElement;
				if (video && video.requestFullscreen) {
					video.requestFullscreen().catch((err) => {
						console.warn("Failed to enter fullscreen:", err);
					});
				}
			});
		} catch (error) {
			console.warn("[YouTubeProvider] Failed to enter fullscreen:", error);
			// Not critical, continue anyway
		}
	}

	/**
	 * Close popups and ads
	 */
	async closePopups(page: Page): Promise<void> {
		try {
			// Wait a bit for popups to appear
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Try to close popups multiple times (they can reappear)
			for (let i = 0; i < 3; i++) {
				await page.evaluate(() => {
					// Close YouTube-specific popups
					const closeSelectors = [
						"button[aria-label*='close' i]",
						".ytp-ad-overlay-close-button",
						"#dismiss-button",
						"button.ytp-ad-skip-button",
						".ytp-ad-skip-button",
						"[class*='close']",
						"[class*='dismiss']",
					];

					// Close all close buttons
					for (const selector of closeSelectors) {
						try {
							const elements = document.querySelectorAll(selector);
							for (const element of Array.from(elements)) {
								const el = element as HTMLElement;
								if (el.offsetParent !== null) {
									el.click();
								}
							}
						} catch (e) {
							continue;
						}
					}

					// Press Escape key to close any open dialogs
					document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
					document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
				});

				// Also try pressing Escape key via Puppeteer
				await page.keyboard.press('Escape');
				
				// Wait a bit between attempts
				await new Promise((resolve) => setTimeout(resolve, 500));
			}

			console.log("[YouTubeProvider] Popup closing attempt completed");
		} catch (error) {
			console.warn("[YouTubeProvider] Error closing popups:", error);
			// Not critical, continue anyway
		}
	}

	/**
	 * Check if content has ended
	 */
	async isContentEnded(page: Page): Promise<boolean> {
		try {
			return await page.evaluate(() => {
				const video = document.querySelector("video") as HTMLVideoElement;
				if (video) {
					return video.ended;
				}
				return false;
			});
		} catch (error) {
			console.error("[YouTubeProvider] Error checking if content ended:", error);
			return false;
		}
	}

	/**
	 * Get current playback position (0-1)
	 */
	async getPlaybackPosition(page: Page): Promise<number> {
		try {
			return await page.evaluate(() => {
				const video = document.querySelector("video") as HTMLVideoElement;
				if (video && video.duration > 0) {
					return video.currentTime / video.duration;
				}
				return 0;
			});
		} catch (error) {
			console.error("[YouTubeProvider] Error getting playback position:", error);
			return 0;
		}
	}
}

