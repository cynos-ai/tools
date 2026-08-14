import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverVisionModels } from "../vision/runner";
import { discoverBrowserCandidates } from "../browser/launch";
import { readConfig, writeUserConfig, type BrowserConfig, type ToolsConfig } from "./store";

// /cynos-tools-config — interactive editor for ~/.pi/agent/cynos-tools.json.
// Edits Tools-owned preferences only: search API keys, vision model, browser launch options.

export function registerToolsConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cynos-tools-config", {
    description: "Configure Cynos Tools (search API keys, vision model, browser launch options).",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("cynos-tools-config requires an interactive TUI. Run it in the terminal.", "warning");
        return;
      }
      await configLoop(ctx);
    },
  });
}

type Ctx = Pick<ExtensionCommandContext, "ui" | "modelRegistry">;

const MENU_KEYS = {
  EXA_KEY: "exa",
  TAVILY_KEY: "tavily",
  VISION_MODEL: "vision",
  VISION_TIMEOUT: "vtimeout",
  BROWSER_CHANNEL: "bchannel",
  BROWSER_HEADLESS: "bheadless",
  BROWSER_EXECUTABLE: "bexe",
  BROWSER_TIMEOUT: "btimeout",
} as const;

const MENU_ITEMS: { key: string; label: string }[] = [
  { key: MENU_KEYS.EXA_KEY, label: "Exa API Key" },
  { key: MENU_KEYS.TAVILY_KEY, label: "Tavily API Key" },
  { key: MENU_KEYS.VISION_MODEL, label: "Vision model" },
  { key: MENU_KEYS.VISION_TIMEOUT, label: "Vision timeout" },
  { key: MENU_KEYS.BROWSER_CHANNEL, label: "Browser channel" },
  { key: MENU_KEYS.BROWSER_EXECUTABLE, label: "Browser executable" },
  { key: MENU_KEYS.BROWSER_HEADLESS, label: "Browser headless" },
  { key: MENU_KEYS.BROWSER_TIMEOUT, label: "Browser timeout" },
];
const LABEL_WIDTH = Math.max(...MENU_ITEMS.map((m) => m.label.length));

export function buildMenu(config: ToolsConfig): string[] {
  const browser: BrowserConfig = config.browser ?? {};
  const values = new Map<string, string>([
    [MENU_KEYS.EXA_KEY, maskApiKey(config.exaApiKey)],
    [MENU_KEYS.TAVILY_KEY, maskApiKey(config.tavilyApiKey)],
    [MENU_KEYS.VISION_MODEL, config.visionModel ?? "Not configured"],
    [MENU_KEYS.VISION_TIMEOUT, config.visionTimeoutMinutes ? `${config.visionTimeoutMinutes} min` : "15 min (default)"],
    [MENU_KEYS.BROWSER_CHANNEL, browser.channel ?? "auto-detect"],
    [MENU_KEYS.BROWSER_EXECUTABLE, browser.executablePath ?? "auto-detect"],
    [MENU_KEYS.BROWSER_HEADLESS, browser.headless === false ? "Off (show window)" : "On (default)"],
    [MENU_KEYS.BROWSER_TIMEOUT, browser.timeoutMs ? `${browser.timeoutMs} ms` : "30000 ms (default)"],
  ]);
  return MENU_ITEMS.map((item) => `${item.label.padEnd(LABEL_WIDTH + 2)} -> ${values.get(item.key)}`);
}

async function configLoop(ctx: Ctx): Promise<void> {
  let config = await readConfig();
  for (;;) {
    const choice = await ctx.ui.select("Cynos Tools Config", buildMenu(config));
    if (!choice) return;
    const item = MENU_ITEMS.find((m) => choice.startsWith(m.label));
    const key = item?.key;

    if (key === MENU_KEYS.EXA_KEY) config = await editApiKey(ctx, config, "exa");
    else if (key === MENU_KEYS.TAVILY_KEY) config = await editApiKey(ctx, config, "tavily");
    else if (key === MENU_KEYS.VISION_MODEL) config = await editVisionModel(ctx, config);
    else if (key === MENU_KEYS.VISION_TIMEOUT) config = await editNumber(ctx, config, "visionTimeoutMinutes", "Vision timeout in minutes (blank = default 15)");
    else if (key === MENU_KEYS.BROWSER_CHANNEL) config = await editBrowserChannel(ctx, config);
    else if (key === MENU_KEYS.BROWSER_EXECUTABLE) config = await editBrowserExecutable(ctx, config);
    else if (key === MENU_KEYS.BROWSER_HEADLESS) config = await editBrowserHeadless(ctx, config);
    else if (key === MENU_KEYS.BROWSER_TIMEOUT) config = await editNumber(ctx, config, ["browser", "timeoutMs"], "Browser timeout in ms (blank = default 30000)");
  }
}

function maskApiKey(key: string | undefined): string {
  if (!key) return "Not configured";
  if (key.length <= 8) return "Configured (****)";
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

async function save(ctx: Ctx, config: ToolsConfig): Promise<void> {
  await writeUserConfig(config);
}

async function editApiKey(ctx: Ctx, config: ToolsConfig, provider: "exa" | "tavily"): Promise<ToolsConfig> {
  const field = provider === "exa" ? "exaApiKey" : "tavilyApiKey";
  const current = config[field] as string | undefined;
  const input = await ctx.ui.input(`Enter ${provider} API Key (blank to clear). Current: ${maskApiKey(current)}`);
  if (input === undefined) return config;
  const value = input.trim() || undefined;
  const next = { ...config };
  if (value === undefined) {
    delete next[field];
  } else {
    (next as Record<string, unknown>)[field] = value;
  }
  await save(ctx, next);
  ctx.ui.notify(`${provider} API key ${value ? "updated" : "cleared"}`, "info");
  return next;
}

async function editVisionModel(ctx: Ctx, config: ToolsConfig): Promise<ToolsConfig> {
  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  const visionModels = discoverVisionModels(available);
  if (visionModels.length === 0) {
    const manual = await ctx.ui.input("No authenticated vision models found. Enter a model id (provider/model-id):");
    if (!manual?.trim()) return config;
    const next = { ...config, visionModel: manual.trim() };
    await save(ctx, next);
    ctx.ui.notify(`Vision model set to: ${manual.trim()}`, "info");
    return next;
  }
  const options = visionModels.map((m) => `${m.id}  (${m.name})`);
  options.push("Clear config");
  const choice = await ctx.ui.select("Choose vision model", options);
  if (!choice) return config;
  if (choice.startsWith("Clear")) {
    const next = { ...config };
    delete next.visionModel;
    await save(ctx, next);
    ctx.ui.notify("Vision model cleared", "info");
    return next;
  }
  const value = choice.split(/\s+/)[0];
  const next = { ...config, visionModel: value };
  await save(ctx, next);
  ctx.ui.notify(`Vision model set to: ${value}`, "info");
  return next;
}

async function editNumber(ctx: Ctx, config: ToolsConfig, path: "visionTimeoutMinutes" | ["browser", "timeoutMs"], prompt: string): Promise<ToolsConfig> {
  const input = await ctx.ui.input(prompt);
  if (input === undefined) return config;
  const trimmed = input.trim();
  const next = { ...config, browser: { ...config.browser } };
  if (!trimmed) {
    if (path === "visionTimeoutMinutes") delete next.visionTimeoutMinutes;
    else delete next.browser!.timeoutMs;
    await save(ctx, next);
    ctx.ui.notify("Restored default", "info");
    return next;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) {
    ctx.ui.notify("Invalid positive number. No changes made.", "warning");
    return config;
  }
  if (path === "visionTimeoutMinutes") next.visionTimeoutMinutes = Math.floor(n);
  else next.browser!.timeoutMs = Math.floor(n);
  await save(ctx, next);
  ctx.ui.notify("Saved", "info");
  return next;
}

async function editBrowserChannel(ctx: Ctx, config: ToolsConfig): Promise<ToolsConfig> {
  const options = ["auto-detect (clear)", "chrome", "chromium", "msedge"];
  const choice = await ctx.ui.select("Browser channel", options);
  if (!choice) return config;
  const next = { ...config, browser: { ...config.browser } };
  if (choice.startsWith("auto")) next.browser!.channel = null;
  else next.browser!.channel = choice as BrowserConfig["channel"];
  await save(ctx, next);
  ctx.ui.notify(`Browser channel: ${choice}`, "info");
  return next;
}

async function editBrowserExecutable(ctx: Ctx, config: ToolsConfig): Promise<ToolsConfig> {
  const input = await ctx.ui.input("Browser executable path (blank = auto-detect). You can also run /cynos-tools-browser-setup to probe.");
  if (input === undefined) return config;
  const next = { ...config, browser: { ...config.browser } };
  const value = input.trim() || null;
  next.browser!.executablePath = value;
  await save(ctx, next);
  ctx.ui.notify(value ? `Executable set to: ${value}` : "Executable cleared (auto-detect)", "info");
  return next;
}

async function editBrowserHeadless(ctx: Ctx, config: ToolsConfig): Promise<ToolsConfig> {
  const choice = await ctx.ui.select("Browser headless", ["On (default)", "Off (show window)"]);
  if (!choice) return config;
  const headless = choice.startsWith("On");
  const next = { ...config, browser: { ...config.browser, headless } };
  await save(ctx, next);
  ctx.ui.notify(`Headless ${headless ? "on" : "off"}`, "info");
  return next;
}

// Exported for the browser-setup command to reuse candidate display.
export { discoverBrowserCandidates };
