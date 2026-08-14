// /cynos-tools-browser-setup — probe system browsers; optionally install Chromium via playwright-core.
// Never auto-downloads without explicit user confirmation.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverSystemCandidates, probeCandidate, spawnPlaywrightCli, resolvePlaywrightCliPath } from "./launch";
import { readConfig, writeUserConfig } from "../config/store";

export function registerBrowserSetupCommand(pi: ExtensionAPI): void {
  pi.registerCommand("cynos-tools-browser-setup", {
    description: "Probe for a usable browser and configure it; optionally install Chromium via playwright-core.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("cynos-tools-browser-setup requires an interactive TUI.", "warning");
        return;
      }
      await setupLoop(ctx);
    },
  });
}

type Ctx = Pick<ExtensionCommandContext, "ui" | "cwd">;

async function setupLoop(ctx: Ctx): Promise<void> {
  const config = await readConfig();
  ctx.ui.setStatus("cynos-tools-browser", "Probing system browsers...");

  const candidates = discoverSystemCandidates();
  const working: string[] = [];

  for (const c of candidates) {
    const ok = await probeCandidate(c).catch(() => false);
    if (ok) working.push(c.label);
  }

  ctx.ui.setStatus("cynos-tools-browser", undefined);

  if (working.length > 0) {
    const choice = await ctx.ui.select(
      "Working browsers found. Pick one to save as the launch source:",
      [...working, "Keep auto-detect (don't pin)"],
    );
    if (!choice) return;
    if (choice.startsWith("Keep")) {
      ctx.ui.notify("Keeping auto-detect. Browser tools will use the first working browser.", "info");
      return;
    }
    const picked = candidates.find((c) => c.label === choice);
    const next = {
      ...config,
      browser: {
        ...(config.browser ?? {}),
        channel: picked?.channel ?? config.browser?.channel ?? null,
        executablePath: picked?.executablePath ?? null,
      },
    };
    await writeUserConfig(next);
    ctx.ui.notify(`Saved: ${choice}`, "info");
    return;
  }

  // No working browser found.
  const cli = resolvePlaywrightCliPath();
  const wantInstall = await ctx.ui.confirm(
    "No usable browser found.",
    cli
      ? "Install Chromium now via playwright-core? (~150 MB download)"
      : "Cannot resolve playwright-core CLI. Set browser.executablePath in ~/.pi/agent/cynos-tools.json manually.",
  );
  if (!wantInstall || !cli) return;

  ctx.ui.setStatus("cynos-tools-browser", "Installing Chromium...");
  const result = await spawnPlaywrightCli(["install", "chromium"], { cwd: ctx.cwd });
  ctx.ui.setStatus("cynos-tools-browser", undefined);

  if (result.code !== 0) {
    ctx.ui.notify(`Chromium install failed (exit ${result.code}). stderr: ${result.stderr.slice(0, 300)}`, "error");
    return;
  }

  // Probe again to confirm.
  const reCandidates = discoverSystemCandidates();
  const stillWorking = await Promise.all(reCandidates.map(async (c) => ({ c, ok: await probeCandidate(c).catch(() => false) })));
  const anyOk = stillWorking.some((x) => x.ok);
  if (anyOk) {
    ctx.ui.notify("Chromium installed and verified. Browser tools are ready.", "info");
  } else {
    ctx.ui.notify("Chromium install completed but probe failed. System libraries may be missing.", "warning");
  }
}
