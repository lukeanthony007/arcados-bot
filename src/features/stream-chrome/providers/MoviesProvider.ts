import { BaseProvider } from "./BaseProvider.js";
import type { Page } from "puppeteer";
import type { SearchResult } from "../types.js";
import { STREAM_CONSTANTS, SELECTORS } from "../constants.js";

/**
 * Provider for 123movies streaming site
 * Implements scraping logic for https://ww7.123moviesfree.net/
 */
export class MoviesProvider extends BaseProvider {
	constructor() {
		super("123movies", STREAM_CONSTANTS.MOVIES_BASE_URL, ["movie", "tv"]);
		// 123movies supports all playback controls except nextEpisode
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
	 * Search for content on 123movies
	 */
	async searchContent(query: string, page: Page): Promise<SearchResult[]> {
		try {
			const searchUrl = `${this.baseUrl}${STREAM_CONSTANTS.MOVIES_SEARCH_PATH}?q=${encodeURIComponent(query)}`;
			
			await page.goto(searchUrl, {
				waitUntil: "networkidle2",
				timeout: STREAM_CONSTANTS.SEARCH_TIMEOUT,
			});

			// Wait for search results to load
			// The actual structure uses #resdata or .list-movie as container
			await page.waitForSelector("#resdata, .list-movie", {
				timeout: STREAM_CONSTANTS.SEARCH_TIMEOUT,
			}).catch(() => {
				console.warn("[MoviesProvider] Search results container not found");
			});

			// Extract search results from page
			const results = await page.evaluate((baseUrl) => {
				const searchResults: SearchResult[] = [];

				// The actual structure: #resdata > .col > .card > a.poster
				// Each .col contains one result card
				const resultCards = Array.from(document.querySelectorAll("#resdata .col, .list-movie .col"));

				for (const card of resultCards.slice(0, 10)) {
					// Find the link (a.poster)
					const linkElement = card.querySelector("a.poster, a[href*='/movie/'], a[href*='/tv/']");
					if (!linkElement) continue;

					const href = linkElement.getAttribute("href");
					if (!href) continue;

					const url = href.startsWith("http") ? href : `${baseUrl}${href}`;

					// Extract title from h2.card-title inside the link
					const titleElement = linkElement.querySelector("h2.card-title, h2, .card-title");
					const title = titleElement?.textContent?.trim() || "";

					if (!title) continue;

					// Extract year if available (might be in title or separate element)
					const yearMatch = title.match(/\((\d{4})\)/);
					const year = yearMatch ? parseInt(yearMatch[1] ?? "0", 10) : undefined;

					// Determine type (movie or tv)
					const type = href.includes("/tv/") || href.includes("/tv-series/") || href.includes("/show/") ? "tv" : "movie";

					// Extract thumbnail if available
					const imgElement = linkElement.querySelector("img");
					const thumbnailUrl = imgElement?.getAttribute("src") || imgElement?.getAttribute("data-src") || undefined;

					searchResults.push({
						title,
						year,
						type,
						url,
						thumbnailUrl,
					});
				}

				return searchResults;
			}, this.baseUrl);

			if (results.length === 0) {
				console.warn(`[MoviesProvider] No search results found for query: ${query}`);
			}

			return results;
		} catch (error) {
			console.error(`[MoviesProvider] Search failed for query "${query}":`, error);
			throw error;
		}
	}

	/**
	 * Navigate to content page
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

			// Click on the main film image/frame to start playback
			console.log("[MoviesProvider] Looking for film image/frame to click...");
			const imageClicked = await page.evaluate(() => {
				// Look for the main film image with class "card-img-top" or "lazy"
				const imageSelectors = [
					'img.card-img-top',
					'img.lazy',
					'img[class*="card-img"]',
					'picture img',
					'img[alt*="Apocalypse"]', // Fallback: look for alt text containing film name
				];

				for (const selector of imageSelectors) {
					const img = document.querySelector(selector) as HTMLElement;
					if (img && img.offsetParent !== null) { // Check if visible
						img.click();
						console.log(`Clicked image with selector: ${selector}`);
						return true;
					}
				}

				// Also try clicking on the picture element itself
				const picture = document.querySelector('picture');
				if (picture) {
					picture.click();
					console.log('Clicked picture element');
					return true;
				}

				return false;
			});

			if (imageClicked) {
				console.log("[MoviesProvider] Successfully clicked film image/frame");
				// Wait a bit for the click to register
				await new Promise((resolve) => setTimeout(resolve, 2000));
			} else {
				console.warn("[MoviesProvider] Could not find film image/frame to click, continuing anyway...");
			}

			return page;
		} catch (error) {
			console.error(`[MoviesProvider] Failed to navigate to ${result.url}:`, error);
			throw error;
		}
	}

	/**
	 * Wait for video player to be ready
	 */
	async waitForPlayer(page: Page): Promise<void> {
		try {
			console.log("[MoviesProvider] Waiting for video player to appear...");
			
			// Wait a bit for page to fully load
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// Try multiple selectors for video element
			const videoSelectors = [
				"video",
				"iframe[src*='player']",
				"iframe[src*='video']",
				"[id*='player']",
				"[class*='player']",
			];

			let videoFound = false;
			for (const selector of videoSelectors) {
				try {
					await page.waitForSelector(selector, {
						timeout: 5000,
					});
					console.log(`[MoviesProvider] Found video element with selector: ${selector}`);
					videoFound = true;
					break;
				} catch (e) {
					// Try next selector
					continue;
				}
			}

			if (!videoFound) {
				console.warn("[MoviesProvider] Video element not found with standard selectors, checking page content...");
				// Check if page has loaded
				const hasVideo = await page.evaluate(() => {
					return !!document.querySelector("video") || !!document.querySelector("iframe");
				});
				
				if (!hasVideo) {
					console.warn("[MoviesProvider] No video element found, but continuing anyway...");
					// Don't throw error, just continue - the clickPlay method will handle it
				}
			}

			// Wait a bit more for any dynamic content to load
			await new Promise((resolve) => setTimeout(resolve, 2000));
		} catch (error) {
			console.error("[MoviesProvider] Failed to wait for player:", error);
			// Don't throw - continue anyway, clickPlay will try to find and play video
		}
	}

	/**
	 * Click play button or video element to start playback
	 * Retries until video actually starts playing, closing popups continuously
	 */
	async clickPlay(page: Page): Promise<void> {
		try {
			console.log("[MoviesProvider] Attempting to start video playback...");
			
			const maxAttempts = 20; // Try up to 20 times
			let attempts = 0;
			let isPlaying = false;

			while (attempts < maxAttempts && !isPlaying) {
				attempts++;
				console.log(`[MoviesProvider] Play attempt ${attempts}/${maxAttempts}...`);

				// Close popups first
				await this.closePopups(page);
				
				// Wait a bit for page to settle
				await new Promise((resolve) => setTimeout(resolve, 1500));

				// Try to find and click the main video player
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

					// Try to find play buttons
					const playSelectors = [
						"button[aria-label*='play' i]",
						".play-button",
						"[class*='play'][class*='button']",
						"[id*='play']",
						"button:has-text('Play')",
					];

					for (const selector of playSelectors) {
						try {
							const element = document.querySelector(selector) as HTMLElement;
							if (element && element.offsetParent !== null) { // Check if visible
								element.click();
								return { success: true, method: `button-${selector}`, isPlaying: false };
							}
						} catch (e) {
							continue;
						}
					}

					// Try clicking on iframe players
					const iframes = document.querySelectorAll("iframe");
					for (const iframe of Array.from(iframes)) {
						try {
							if ((iframe as HTMLElement).offsetParent !== null) {
								(iframe as HTMLElement).click();
								return { success: true, method: "iframe-click", isPlaying: false };
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

				console.log(`[MoviesProvider] Play attempt ${attempts} result:`, playResult);

				// Wait a bit for playback to start
				await new Promise((resolve) => setTimeout(resolve, 2000));
				
				// Verify video is actually playing
				isPlaying = await page.evaluate(() => {
					const video = document.querySelector("video") as HTMLVideoElement;
					if (video) {
						// Check if video is playing and has loaded enough data
						return !video.paused && video.readyState >= 2 && video.currentTime > 0;
					}
					return false;
				});

				if (isPlaying) {
					console.log("[MoviesProvider] 🔹 Video is playing successfully!");
					break;
				} else {
					console.log(`[MoviesProvider] Video not playing yet, will retry... (attempt ${attempts}/${maxAttempts})`);
				}
			}

			if (!isPlaying) {
				console.warn("[MoviesProvider] ⚠️ Could not confirm video playback after all attempts, but continuing...");
			}
		} catch (error) {
			console.error("[MoviesProvider] Failed to click play:", error);
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
			console.warn("[MoviesProvider] Failed to enter fullscreen:", error);
			// Not critical, continue anyway
		}
	}

	/**
	 * Close popups and ads
	 * Aggressively closes all popups, modals, and overlays
	 */
	async closePopups(page: Page): Promise<void> {
		try {
			// Wait a bit for popups to appear
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Try to close popups multiple times (they can reappear)
			for (let i = 0; i < 3; i++) {
				await page.evaluate((selectors) => {
					// Close buttons
					const closeSelectors = [
						selectors.POPUP_CLOSE,
						selectors.AD_CLOSE,
						".close",
						".modal-close",
						"[class*='close']",
						"[class*='popup-close']",
						"[id*='close']",
						"[aria-label*='close' i]",
						"button:has-text('Close')",
						"button:has-text('×')",
						"button:has-text('X')",
						"[class*='dismiss']",
						"[class*='cancel']",
						"[class*='ad'][class*='close']",
					];

					// Close all close buttons
					for (const selector of closeSelectors) {
						try {
							const elements = document.querySelectorAll(selector);
							for (const element of Array.from(elements)) {
								const el = element as HTMLElement;
								if (el.offsetParent !== null) { // Check if visible
									el.click();
								}
							}
						} catch (e) {
							continue;
						}
					}

					// Close modals and overlays by clicking outside or finding close buttons
					const modals = document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="popup"], [role="dialog"], [class*="dialog"]');
					for (const modal of Array.from(modals)) {
						const modalEl = modal as HTMLElement;
						// Check if modal is visible
						if (modalEl.offsetParent !== null) {
							// Try to find close button in modal
							const closeBtn = modalEl.querySelector('button[class*="close"], [aria-label*="close"], button:has-text("×"), button:has-text("X"), [class*="dismiss"]');
							if (closeBtn) {
								(closeBtn as HTMLElement).click();
							} else {
								// Click outside modal (on backdrop) if it exists
								const backdrop = modalEl.querySelector('[class*="backdrop"], [class*="overlay"]');
								if (backdrop) {
									(backdrop as HTMLElement).click();
								}
							}
						}
					}

					// Press Escape key to close any open dialogs
					document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
					document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', keyCode: 27, bubbles: true }));
				}, SELECTORS);

				// Also try pressing Escape key via Puppeteer
				await page.keyboard.press('Escape');
				
				// Wait a bit between attempts
				await new Promise((resolve) => setTimeout(resolve, 500));
			}

			console.log("[MoviesProvider] Popup closing attempt completed");
		} catch (error) {
			console.warn("[MoviesProvider] Error closing popups:", error);
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

				const audio = document.querySelector("audio") as HTMLAudioElement;
				if (audio) {
					return audio.ended;
				}

				return false;
			});
		} catch (error) {
			console.error("[MoviesProvider] Error checking if content ended:", error);
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

				const audio = document.querySelector("audio") as HTMLAudioElement;
				if (audio && audio.duration > 0) {
					return audio.currentTime / audio.duration;
				}

				return 0;
			});
		} catch (error) {
			console.error("[MoviesProvider] Error getting playback position:", error);
			return 0;
		}
	}
}

