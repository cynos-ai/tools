import { ensureDir, readJsonFile, writeJsonAtomic, writeJsonAtomicIfAbsent } from "../infra/fs-utils";
import { BROWSER_ANNOTATE_TIMEOUT_MS, BROWSER_DEFAULT_TIMEOUT_MS } from "../infra/limits";
import { userConfigPath } from "./paths";
import * as path from "node:path";

export interface BrowserConfig {
  channel?: "chrome" | "chromium" | "msedge" | null;
  executablePath?: string | null;
  headless?: boolean;
  timeoutMs?: number;
  /** Extra Chromium launch args (e.g. ["--ozone-platform=x11"]). */
  args?: string[] | null;
  annotate?: AnnotateConfig;
}

export interface AnnotateConfig {
  /** How long /annotate waits for the user to submit, in ms. */
  timeoutMs?: number;
  /** Capture per-note element screenshots. */
  screenshots?: boolean;
  /** Overlay UI language: auto follows the system locale (zh default). */
  uiLanguage?: "zh" | "en" | "auto";
}

export interface ToolsConfig {
  schemaVersion: 1;
  exaApiKey?: string;
  tavilyApiKey?: string;
  visionModel?: string;
  visionTimeoutMinutes?: number;
  maxImageBytes?: number;
  browser?: BrowserConfig;
}

export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;

export const DEFAULT_CONFIG: ToolsConfig = {
  schemaVersion: 1,
  browser: {
    channel: "chrome",
    executablePath: null,
    headless: true,
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
  },
};

export async function readConfig(): Promise<ToolsConfig> {
  return readJsonFile<ToolsConfig>(userConfigPath(), { schemaVersion: 1 });
}

export async function writeUserConfig(config: ToolsConfig): Promise<void> {
  const dir = path.dirname(userConfigPath());
  await ensureDir(dir);
  // Contains API keys — restrict to owner only.
  await writeJsonAtomic(userConfigPath(), config, { mode: 0o600 });
}

export async function mergeUserConfig(patch: Partial<ToolsConfig>): Promise<void> {
  const current = await readConfig();
  await writeUserConfig({ ...current, ...patch, schemaVersion: 1 });
}

// Lazy-init defaults. Only creates when the file does not exist; never overwrites existing config.
export async function ensureUserConfig(defaults: ToolsConfig = DEFAULT_CONFIG): Promise<void> {
  await writeJsonAtomicIfAbsent(userConfigPath(), defaults, { mode: 0o600 });
}

export async function getBrowserConfig(): Promise<
  Required<Pick<BrowserConfig, "headless" | "timeoutMs">> & BrowserConfig & { args: string[]; annotate: { timeoutMs: number; screenshots: boolean; uiLanguage: "zh" | "en" | "auto" } }
> {
  const config = await readConfig();
  const browser = config.browser ?? {};
  return {
    channel: browser.channel ?? null,
    executablePath: browser.executablePath ?? null,
    headless: browser.headless !== false,
    timeoutMs: typeof browser.timeoutMs === "number" && browser.timeoutMs > 0 ? browser.timeoutMs : DEFAULT_BROWSER_TIMEOUT_MS,
    args: Array.isArray(browser.args) ? browser.args.filter((a): a is string => typeof a === "string") : [],
    annotate: {
      timeoutMs:
        typeof browser.annotate?.timeoutMs === "number" && browser.annotate.timeoutMs > 0
          ? browser.annotate.timeoutMs
          : BROWSER_ANNOTATE_TIMEOUT_MS,
      screenshots: browser.annotate?.screenshots !== false,
      uiLanguage:
        browser.annotate?.uiLanguage === "zh" || browser.annotate?.uiLanguage === "en"
          ? browser.annotate.uiLanguage
          : "auto",
    },
  };
}

export async function getVisionModel(): Promise<string | undefined> {
  const config = await readConfig();
  return config.visionModel;
}

export async function resolveProviderKeys(): Promise<{ exaKey?: string; tavilyKey?: string }> {
  const config = await readConfig();
  return {
    exaKey: config.exaApiKey || process.env.EXA_API_KEY,
    tavilyKey: config.tavilyApiKey || process.env.TAVILY_API_KEY,
  };
}
