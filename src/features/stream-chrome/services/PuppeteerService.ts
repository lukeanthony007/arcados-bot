import puppeteer, {
  type Browser,
  type Page,
  type LaunchOptions,
} from "puppeteer";
import { config } from "../../../config/index.js";
import { STREAM_CONSTANTS } from "../constants.js";
import * as path from "path";
import * as fs from "fs";
import { spawn, exec, type ChildProcess } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Service for managing Puppeteer browser instances
 * Handles browser lifecycle, page creation, and cleanup
 * Runs browser in virtual display (Xvfb) to avoid showing windows on desktop
 */
export class PuppeteerService {
  private browser: Browser | null = null;
  private isInitialized = false;
  private xvfbProcess: ChildProcess | null = null;
  private virtualDisplay: string = "";

  /**
   * Start Xvfb virtual display server
   */
  private async startVirtualDisplay(): Promise<void> {
    // Save original DISPLAY if set (for logging)
    const originalDisplay = process.env.DISPLAY;
    if (originalDisplay && originalDisplay !== "") {
      console.log(
        `[PuppeteerService] Original DISPLAY was: ${originalDisplay} (will override with virtual display)`
      );
    }

    // Find an available display number (start from :99)
    let displayNum = 99;
    let display = `:${displayNum}`;

    // Check if display socket is already in use
    const socketPath = `/tmp/.X11-unix/X${displayNum}`;
    if (fs.existsSync(socketPath)) {
      displayNum++;
      display = `:${displayNum}`;
    }

    this.virtualDisplay = display;

    console.log(
      `[PuppeteerService] Starting Xvfb on display ${this.virtualDisplay}...`
    );

    return new Promise((resolve, reject) => {
      // Start Xvfb with screen resolution matching viewport
      this.xvfbProcess = spawn(
        "Xvfb",
        [
          this.virtualDisplay,
          "-screen",
          "0",
          `${STREAM_CONSTANTS.VIEWPORT_WIDTH}x${STREAM_CONSTANTS.VIEWPORT_HEIGHT}x24`,
          "-ac", // Disable access control
          "-nolisten",
          "tcp", // Don't listen on TCP
          "-dpi",
          "96", // Set DPI
        ],
        {
          stdio: ["ignore", "ignore", "pipe"], // Capture stderr only
        }
      );

      let started = false;

      this.xvfbProcess.on("error", (error: Error) => {
        if (!started) {
          if (error.message.includes("ENOENT")) {
            reject(
              new Error(
                "Xvfb is not installed. Please install it with: sudo pacman -S xorg-server-xvfb (Arch/CachyOS) or sudo apt-get install xvfb (Debian/Ubuntu)"
              )
            );
          } else {
            reject(new Error(`Failed to start Xvfb: ${error.message}`));
          }
        }
      });

      this.xvfbProcess.stderr?.on("data", (data) => {
        const output = data.toString();
        // Xvfb is ready when it stops outputting errors
        if (!started && !output.includes("error")) {
          started = true;
          // Set DISPLAY environment variable
          process.env.DISPLAY = this.virtualDisplay;
          console.log(
            `[PuppeteerService] ✓ Xvfb started on ${this.virtualDisplay}`
          );
          console.log(`[PuppeteerService] DISPLAY=${this.virtualDisplay}`);
          resolve();
        }
      });

      // Give Xvfb a moment to start and check if socket exists
      setTimeout(() => {
        if (!started) {
          // Check if process is still running and socket exists
          const displayNum = parseInt(this.virtualDisplay.replace(":", ""));
          const socketPath = `/tmp/.X11-unix/X${displayNum}`;
          if (
            this.xvfbProcess &&
            !this.xvfbProcess.killed &&
            fs.existsSync(socketPath)
          ) {
            started = true;
            process.env.DISPLAY = this.virtualDisplay;
            console.log(
              `[PuppeteerService] ✓ Xvfb started on ${this.virtualDisplay} (verified via socket)`
            );
            console.log(`[PuppeteerService] DISPLAY=${this.virtualDisplay}`);
            resolve();
          } else if (this.xvfbProcess && !this.xvfbProcess.killed) {
            // Process running but socket not found yet - give it more time
            setTimeout(() => {
              if (fs.existsSync(socketPath)) {
                started = true;
                process.env.DISPLAY = this.virtualDisplay;
                console.log(
                  `[PuppeteerService] ✓ Xvfb started on ${this.virtualDisplay} (delayed socket check)`
                );
                console.log(
                  `[PuppeteerService] DISPLAY=${this.virtualDisplay}`
                );
                resolve();
              } else {
                reject(
                  new Error(
                    "Xvfb process is running but display socket not found"
                  )
                );
              }
            }, 1000);
          } else {
            reject(new Error("Xvfb process died immediately after starting"));
          }
        }
      }, 2000);
    });
  }

  /**
   * Stop Xvfb virtual display server
   */
  private async stopVirtualDisplay(): Promise<void> {
    if (this.xvfbProcess) {
      console.log(
        `[PuppeteerService] Stopping Xvfb on ${this.virtualDisplay}...`
      );
      this.xvfbProcess.kill();
      this.xvfbProcess = null;
      this.virtualDisplay = "";
      console.log(`[PuppeteerService] ✓ Xvfb stopped`);
    }
  }

  /**
   * Close Chrome browser if it's already running
   */
  private async closeRunningChrome(userDataDir: string): Promise<void> {
    try {
      // Check for Chrome processes
      const chromeProcesses = [
        "chrome",
        "chromium",
        "google-chrome",
        "google-chrome-stable",
      ];

      let foundProcesses = false;

      for (const processName of chromeProcesses) {
        try {
          // Use pgrep to find processes (works on Linux)
          const { stdout } = await execAsync(
            `pgrep -f "${processName}" || true`
          );
          const pids = stdout.trim().split("\n").filter((pid) => pid.length > 0);

          if (pids.length > 0) {
            foundProcesses = true;
            console.log(
              `[PuppeteerService] Found ${processName} processes: ${pids.join(", ")}`
            );
            // Kill the processes
            for (const pid of pids) {
              try {
                await execAsync(`kill -TERM ${pid} 2>/dev/null || true`);
              } catch (error) {
                // Process might already be dead, try SIGKILL
                try {
                  await execAsync(`kill -KILL ${pid} 2>/dev/null || true`);
                } catch {
                  // Ignore errors if process is already gone
                }
              }
            }
          }
        } catch (error) {
          // pgrep might not be available or no processes found, continue
        }
      }

      // Also check for the lockfile that Puppeteer checks
      const lockfilePath = path.join(userDataDir, "lockfile");
      if (fs.existsSync(lockfilePath)) {
        console.log(
          `[PuppeteerService] Found Chrome lockfile at ${lockfilePath}`
        );
        foundProcesses = true;

        // Try to remove the lockfile (it should be removed when Chrome closes)
        // But first, try to kill any process that might be holding it
        try {
          // Use lsof to find process holding the lockfile
          const { stdout } = await execAsync(
            `lsof "${lockfilePath}" 2>/dev/null | awk 'NR>1 {print $2}' || true`
          );
          const holdingPids = stdout
            .trim()
            .split("\n")
            .filter((pid) => pid.length > 0);

          for (const pid of holdingPids) {
            try {
              await execAsync(`kill -TERM ${pid} 2>/dev/null || true`);
            } catch {
              try {
                await execAsync(`kill -KILL ${pid} 2>/dev/null || true`);
              } catch {
                // Ignore
              }
            }
          }
        } catch {
          // lsof might not be available, that's okay
        }
      }

      if (foundProcesses) {
        console.log(
          `[PuppeteerService] Waiting for Chrome processes to close...`
        );
        // Wait for processes to close and lockfile to be released
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Check if lockfile still exists
          if (!fs.existsSync(lockfilePath)) {
            console.log(
              `[PuppeteerService] ✓ Chrome lockfile removed after ${attempts + 1} attempts`
            );
            break;
          }

          attempts++;
        }

        if (fs.existsSync(lockfilePath)) {
          console.warn(
            `[PuppeteerService] ⚠ Chrome lockfile still exists after ${maxAttempts} attempts, but proceeding anyway`
          );
        } else {
          console.log(`[PuppeteerService] ✓ Chrome closed successfully`);
        }
      } else {
        console.log(`[PuppeteerService] No running Chrome instances found`);
      }
    } catch (error) {
      console.warn(
        `[PuppeteerService] Error checking/closing Chrome: ${error}`
      );
      // Don't throw - we'll let Puppeteer handle the error if Chrome is still running
    }
  }

  /**
   * Initialize the browser instance
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.browser) {
      return;
    }

    try {
      // TEMPORARILY DISABLED: Start virtual display first
      // await this.startVirtualDisplay();
      console.log(
        `[PuppeteerService] Virtual display DISABLED for debugging - using system display`
      );

      // Use system DISPLAY if available, otherwise default
      if (!process.env.DISPLAY) {
        process.env.DISPLAY = ":0"; // Default to main display
      }
      console.log(
        `[PuppeteerService] Using system DISPLAY: ${process.env.DISPLAY}`
      );

      // Ensure DISPLAY is set in process.env (Puppeteer will inherit it)
      // process.env.DISPLAY = this.virtualDisplay;

      // TEMPORARILY DISABLED: Wait a bit more to ensure Xvfb is fully ready
      // await new Promise((resolve) => setTimeout(resolve, 500));

      // TEMPORARILY DISABLED: Verify Xvfb is still running
      // if (!this.xvfbProcess || this.xvfbProcess.killed) {
      //   throw new Error("Xvfb process died before browser launch");
      // }

      // TEMPORARILY DISABLED: Verify display socket exists
      // const displayNum = parseInt(this.virtualDisplay.replace(":", ""));
      // const socketPath = `/tmp/.X11-unix/X${displayNum}`;
      // if (!fs.existsSync(socketPath)) {
      //   throw new Error(`Xvfb display socket not found at ${socketPath}`);
      // }

      // console.log(
      //   `[PuppeteerService] Verified Xvfb is ready on ${this.virtualDisplay}`
      // );

      // Use real Chrome profile (requires Chrome to be closed)
      const userDataDir = "/home/luke/.config/google-chrome";

      console.log(`[PuppeteerService] Using Chrome profile: ${userDataDir}`);

      // Close Chrome if it's already running
      await this.closeRunningChrome(userDataDir);

      // TEMPORARILY DISABLED: Force X11 by unsetting Wayland environment variables
      // On Wayland systems (like Hyprland), Chrome will try to use Wayland by default
      // We need to explicitly force it to use X11 via the virtual display
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ":0", // Use system DISPLAY instead of virtual
        // Unset/override Wayland variables to force X11
        WAYLAND_DISPLAY: undefined, // Remove Wayland display
        XDG_SESSION_TYPE: "x11", // Force X11 session type
        GDK_BACKEND: "x11", // Force GDK to use X11
        QT_QPA_PLATFORM: "xcb", // Force Qt to use X11
        // Ensure no other display is set
        XAUTHORITY: undefined, // Don't use system XAUTHORITY
      };

      // Remove undefined values (they'll be unset from environment)
      Object.keys(env).forEach((key) => {
        if (env[key] === undefined) {
          delete env[key];
        }
      });

      console.log(
        `[PuppeteerService] Launching Chrome with DISPLAY=${env.DISPLAY}, WAYLAND_DISPLAY unset`
      );

      const launchOptions: LaunchOptions = {
        headless: false, // Run in non-headless mode (but in virtual display, so it won't show on desktop)
        userDataDir,
        env,
        args: [
          // Force X11 backend (important for Wayland systems)
          // `--use-gl=swiftshader`, // Use software rendering (works better in virtual display)
          // `--disable-gpu`, // Disable GPU acceleration (not needed in virtual display)
          // Enable screen/tab capturing capabilities
          `--enable-usermedia-screen-capturing`,
          `--allow-http-screen-capture`,
          `--auto-select-desktop-capture-source=about:blank`,
          // Window management for virtual display
          `--window-size=${STREAM_CONSTANTS.VIEWPORT_WIDTH},${STREAM_CONSTANTS.VIEWPORT_HEIGHT}`,
          `--start-maximized`,
          // Note: We don't use --auto-select-desktop-capture-source or --auto-select-tab-capture-source-by-title
          // because Chrome flags are set at browser launch and can't be changed dynamically.
          // Instead, we rely on Discord's in-browser modal (in DiscordUserAccountService.selectStreamSource)
          // to select the correct browser tab by matching the tab title with the user's query.
          // The tab title will be set when we navigate to the video (e.g., "Charlie the Unicorn - YouTube").
          // "--use-fake-ui-for-media-stream", // Disabled - we want to use Discord's modal for selection
          // "--no-sandbox",
          // "--disable-setuid-sandbox",
          // "--disable-dev-shm-usage",
          // "--window-size=1920,1080",
          // "--disable-blink-features=AutomationControlled",
          // "--disable-default-apps", // Prevent Chrome from opening default windows
          // "--no-first-run", // Skip first run tasks
          // "--no-default-browser-check", // Skip default browser check
          // "--use-fake-ui-for-media-stream", // Auto-accept media stream requests (screen share)
          // "--enable-usermedia-screen-capturing", // Enable screen capturing
          // "--allow-http-screen-capture", // Allow screen capture for http/https
          // "--auto-select-desktop-capture-source=Entire screen", // Auto-select entire screen
        ],
        defaultViewport: {
          width: STREAM_CONSTANTS.VIEWPORT_WIDTH,
          height: STREAM_CONSTANTS.VIEWPORT_HEIGHT,
        },
      };

      this.browser = await puppeteer.launch(launchOptions);
      this.isInitialized = true;

      console.log(
        `[PuppeteerService] Browser initialized successfully with profile: ${userDataDir}`
      );
      console.log(
        `[PuppeteerService] Browser running on system display ${process.env.DISPLAY} (virtual display disabled for debugging)`
      );

      // Verify browser is using virtual display
      const browserProcess = this.browser.process();
      if (browserProcess) {
        console.log(
          `[PuppeteerService] Browser process PID: ${browserProcess.pid}`
        );
        console.log(
          `[PuppeteerService] DISPLAY environment: ${process.env.DISPLAY}`
        );

        // TEMPORARILY DISABLED: Check if Chrome process is actually using the virtual display
        // by verifying the display is accessible
        // try {
        //   // Try to verify by checking if we can connect to the display
        //   const { stdout } = await execAsync(
        //     `DISPLAY=${this.virtualDisplay} xdpyinfo -display ${this.virtualDisplay} 2>&1 || echo "FAIL"`
        //   );
        //   if (!stdout.includes("FAIL") && stdout.length > 0) {
        //     console.log(
        //       `[PuppeteerService] ✓ Verified virtual display ${this.virtualDisplay} is accessible`
        //     );
        //   } else {
        //     console.log(
        //       `[PuppeteerService] ⚠ Could not verify display with xdpyinfo (may not be installed or display not ready)`
        //     );
        //   }
        // } catch (error) {
        //   // xdpyinfo might not be installed, that's okay
        //   console.log(
        //     `[PuppeteerService] Note: Could not verify display with xdpyinfo (may not be installed)`
        //   );
        // }
      }

      // Handle browser crashes
      this.browser.on("disconnected", () => {
        console.warn("[PuppeteerService] Browser disconnected");
        // Don't automatically reset - let it be handled explicitly
        // This prevents accidental re-initialization
      });
    } catch (error) {
      console.error("[PuppeteerService] Failed to initialize browser:", error);
      // TEMPORARILY DISABLED: Clean up virtual display on error
      // await this.stopVirtualDisplay();
      throw error;
    }
  }

  /**
   * Get or create browser instance
   */
  async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.isInitialized) {
      await this.initialize();
    }

    if (!this.browser) {
      throw new Error("Failed to create browser instance");
    }

    return this.browser;
  }

  /**
   * Create a new page with optimized settings
   */
  async createPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    // Set user agent to avoid bot detection
    await page.setUserAgent(
      config.streamPlayerUserAgent || STREAM_CONSTANTS.DEFAULT_USER_AGENT
    );

    // Optimize page settings
    await page.setViewport({
      width: STREAM_CONSTANTS.VIEWPORT_WIDTH,
      height: STREAM_CONSTANTS.VIEWPORT_HEIGHT,
    });

    // Block images and other resources to speed up loading (optional)
    // Can be enabled if needed for performance
    // await page.setRequestInterception(true);
    // page.on('request', (req) => {
    //   if (req.resourceType() === 'image' || req.resourceType() === 'stylesheet') {
    //     req.abort();
    //   } else {
    //     req.continue();
    //   }
    // });

    // Set navigation timeout
    page.setDefaultNavigationTimeout(config.streamPlayerTimeout);

    return page;
  }

  /**
   * Navigate to a URL and wait for page load
   */
  async navigateToPage(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: config.streamPlayerTimeout,
      });
    } catch (error) {
      console.error(`[PuppeteerService] Failed to navigate to ${url}:`, error);
      throw error;
    }
  }

  /**
   * Close a page
   */
  async closePage(page: Page): Promise<void> {
    // Check if page is already closed or browser disconnected
    if (page.isClosed()) {
      return; // Already closed, nothing to do
    }

    // Check if browser is still connected
    if (this.browser && !this.browser.isConnected()) {
      console.warn("[PuppeteerService] Browser disconnected, cannot close page");
      return;
    }

    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      // Ignore errors if page is already closed or browser disconnected
      if (
        error instanceof Error &&
        (error.message.includes("detached") ||
          error.message.includes("Target closed") ||
          error.message.includes("Connection closed"))
      ) {
        console.warn("[PuppeteerService] Page already closed/detached, skipping close");
      } else {
        console.error("[PuppeteerService] Error closing page:", error);
      }
    }
  }

  /**
   * Shutdown browser and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        this.isInitialized = false;
        console.log("[PuppeteerService] Browser shutdown complete");
      } catch (error) {
        console.error("[PuppeteerService] Error during shutdown:", error);
      }
    }

    // Stop virtual display
    await this.stopVirtualDisplay();
  }

  /**
   * Check if browser is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.browser !== null;
  }
}
