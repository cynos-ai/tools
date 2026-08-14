// Browser discovery and launching. Uses playwright-core (no bundled Chromium).
// Priority: configured executablePath > configured channel > system Chrome/Chromium/Edge.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBrowserConfig, type BrowserConfig } from "../config/store";
import {
  consoleMessageToEvent,
  getExistingSession,
  networkEventFromRequestFailure,
  networkEventFromResponse,
  pushConsole,
  pushNetwork,
  setSession,
  closeAllSessions,
  type ManagedBrowserSession,
} from "./manager";

export interface BrowserCandidate {
  label: string;
  channel?: "chrome" | "chromium" | "msedge";
  executablePath?: string;
}

// Plausible system browser locations. Probed in order. Cross-platform best-effort.
const SYSTEM_CANDIDATES: BrowserCandidate[] = [
  // Linux
  { label: "Google Chrome (Linux)", channel: "chrome", executablePath: "/usr/bin/google-chrome" },
  { label: "Google Chrome stable (Linux)", channel: "chrome", executablePath: "/usr/bin/google-chrome-stable" },
  { label: "Chromium (Linux)", channel: "chromium", executablePath: "/usr/bin/chromium" },
  { label: "Chromium browser (Linux)", channel: "chromium", executablePath: "/usr/bin/chromium-browser" },
  { label: "Microsoft Edge (Linux)", channel: "msedge", executablePath: "/usr/bin/microsoft-edge" },
  // macOS
  { label: "Google Chrome (macOS)", channel: "chrome", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  { label: "Chromium (macOS)", channel: "chromium", executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
  { label: "Microsoft Edge (macOS)", channel: "msedge", executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
];

export function discoverSystemCandidates(): BrowserCandidate[] {
  return SYSTEM_CANDIDATES.filter((c) => c.executablePath && existsSync(c.executablePath));
}

export function discoverConfiguredCandidates(config: BrowserConfig): BrowserCandidate[] {
  const out: BrowserCandidate[] = [];
  if (config.executablePath) out.push({ label: `Configured executable: ${config.executablePath}`, executablePath: config.executablePath });
  if (config.channel) out.push({ label: `Configured channel: ${config.channel}`, channel: config.channel });
  return out;
}

export function discoverBrowserCandidates(): BrowserCandidate[] {
  // Used by the config menu to show options. Order: configured > system.
  return [...discoverConfiguredCandidates(readBrowserConfigSync()), ...discoverSystemCandidates()];
}

// Avoid async import cycle in the sync menu helper.
function readBrowserConfigSync(): BrowserConfig {
  // Best-effort sync read; config command only uses this for display.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    const os = require("node:os");
    const p = path.join(process.env.CYNOS_HOME ?? os.homedir(), ".pi", "agent", "cynos-tools.json");
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    return json.browser ?? {};
  } catch {
    return {};
  }
}

async function tryLaunch(opts: { executablePath?: string; channel?: "chrome" | "chromium" | "msedge"; headless: boolean; timeoutMs: number }): Promise<Browser> {
  const launchOpts: Record<string, unknown> = {
    headless: opts.headless,
    timeout: opts.timeoutMs,
  };
  if (opts.executablePath) launchOpts.executablePath = opts.executablePath;
  else if (opts.channel) launchOpts.channel = opts.channel;

  return chromium.launch(launchOpts);
}

// Quick headless probe to verify a candidate actually launches.
export async function probeCandidate(candidate: BrowserCandidate, headless = true, timeoutMs = 10_000): Promise<boolean> {
  try {
    const browser = await tryLaunch({ executablePath: candidate.executablePath, channel: candidate.channel, headless, timeoutMs });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    await context.close();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

export interface EnsureSessionOptions {
  cwd: string;
  sessionId?: string;
  onConsole?: (text: string) => void;
}

// Get-or-create a managed session for this pi session. Throws BrowserUnavailableError
// when no browser can be launched (does NOT auto-install).
export async function ensureSession(options: EnsureSessionOptions): Promise<ManagedBrowserSession> {
  const { cwd, sessionId } = options;
  const existing = getExistingSession(cwd, sessionId);
  if (existing) return existing;

  const config = await getBrowserConfig();
  const candidates = discoverConfiguredCandidates(config);
  if (config.channel) {
    // channel without explicit executable: rely on playwright-core's channel resolution.
    candidates.push({ label: `channel: ${config.channel}`, channel: config.channel });
  }
  for (const c of discoverSystemCandidates()) {
    if (!candidates.some((x) => x.executablePath === c.executablePath)) candidates.push(c);
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const browser = await tryLaunch({
        executablePath: candidate.executablePath,
        channel: candidate.channel,
        headless: config.headless,
        timeoutMs: config.timeoutMs,
      });
      const context = await browser.newContext({
        // Isolated, ephemeral context. No persistent profile, no user cookies.
        viewport: null,
        ignoreHTTPSErrors: false,
      });
      const page = await context.newPage();
      const consoleEvents: ManagedBrowserSession["consoleEvents"] = [];
      const networkEvents: ManagedBrowserSession["networkEvents"] = [];

      page.on("console", (msg) => {
        pushConsole(consoleEvents, consoleMessageToEvent(msg));
      });
      page.on("pageerror", (err) => {
        pushConsole(consoleEvents, { type: "error", text: String(err && err.message ? err.message : err).slice(0, 1000), at: new Date().toISOString() });
      });
      page.on("response", (response) => {
        pushNetwork(networkEvents, networkEventFromResponse(response));
      });
      page.on("requestfailed", (req) => {
        pushNetwork(networkEvents, networkEventFromRequestFailure(req));
      });

      const session: ManagedBrowserSession = {
        browser,
        context,
        page,
        consoleEvents,
        networkEvents,
        refs: new Map(),
        currentUrl: page.url(),
        currentTitle: "",
      };
      setSession(cwd, sessionId, session);
      return session;
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new BrowserUnavailableError(
    `No usable browser found. Run /cynos-tools-browser-setup to probe or install Chromium, or set browser.executablePath / browser.channel in ~/.pi/agent/cynos-tools.json.${detail}`,
  );
}

// Helper used by tools to fetch the current page and refresh session metadata.
export async function getPage(options: EnsureSessionOptions): Promise<{ session: ManagedBrowserSession; page: Page }> {
  const session = await ensureSession(options);
  try {
    session.currentTitle = await session.page.title();
  } catch {
    session.currentTitle = "";
  }
  session.currentUrl = session.page.url();
  return { session, page: session.page };
}

// Register a session_shutdown hook that closes any browser we started for this pi runtime.
export function registerBrowserShutdown(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async () => {
    await closeAllSessions();
  });
}

// Exported for the setup command so it can locate the playwright-core CLI for installs.
export function resolvePlaywrightCliPath(): string | undefined {
  try {
    // Resolve the playwright-core package directory, then look for its bundled CLI.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pwPkg = require.resolve("playwright-core/package.json");
    const dir = path.dirname(pwPkg);
    const candidates = [path.join(dir, "cli.js"), path.join(dir, "lib", "cli", "cli.js"), path.join(dir, "bin", "cli.js")];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// Spawn the playwright-core CLI (used by setup to install Chromium). Resolves with exit code.
export function spawnPlaywrightCli(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  const cli = resolvePlaywrightCliPath();
  if (!cli) {
    return Promise.resolve({ code: 127, stdout: "", stderr: "playwright-core CLI not found." });
  }
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}
