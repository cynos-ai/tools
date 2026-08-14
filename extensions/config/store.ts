import { ensureDir, readJsonFile, writeJsonAtomic, writeJsonAtomicIfAbsent } from "../infra/fs-utils";
import { userConfigPath } from "./paths";
import * as path from "node:path";

export interface BrowserConfig {
  channel?: "chrome" | "chromium" | "msedge" | null;
  executablePath?: string | null;
  headless?: boolean;
  timeoutMs?: number;
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

export async function getBrowserConfig(): Promise<Required<Pick<BrowserConfig, "headless" | "timeoutMs">> & BrowserConfig> {
  const config = await readConfig();
  const browser = config.browser ?? {};
  return {
    channel: browser.channel ?? null,
    executablePath: browser.executablePath ?? null,
    headless: browser.headless !== false,
    timeoutMs: typeof browser.timeoutMs === "number" && browser.timeoutMs > 0 ? browser.timeoutMs : DEFAULT_BROWSER_TIMEOUT_MS,
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
