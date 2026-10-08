// /annotate command + cynos_browser_annotate tool — element annotation in the
// tools-managed browser.
//
// Unlike the standalone pi-annotate package (browser extension + native
// messaging host + unix socket), this runs entirely inside the tools-managed
// Playwright session: the overlay script is injected with page.evaluate and
// the payload returns through an exposeBinding callback. No user-side setup.
//
// Two entry points share one flow (runAnnotateFlow):
//   - /annotate command: human-invoked; the report is delivered as a user
//     message that starts a new agent turn.
//   - cynos_browser_annotate tool: agent-invoked when the user asks in natural
//     language ("用 /annotate 标注这个页面"); the report is the tool result, so
//     the agent acts on it in the same turn. The call blocks while the user
//     annotates in the headed browser window.

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Page } from "playwright-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import overlaySource from "./annotate-overlay.js?raw";
import { checkBrowserUrl } from "./security";
import { ensureSession, BrowserUnavailableError, type EnsureSessionOptions } from "./launch";
import { closeSession, getExistingSession } from "./manager";
import { getBrowserConfig } from "../config/store";
import { BROWSER_ANNOTATE_TIMEOUT_MS, BROWSER_DEFAULT_TIMEOUT_MS } from "../infra/limits";
import { formatAnnotateReport, normalizeAnnotatePayload, type AnnotatePayload } from "./annotate-report";

const BINDING_NAME = "__cynosAnnotateSubmit";

// Overlay UI language: explicit config (zh/en/auto) > system locale > zh.
function resolveUiLanguage(configured: string): "zh" | "en" {
  if (configured === "zh" || configured === "en") return configured;
  const locale = `${process.env.LC_ALL ?? ""} ${process.env.LC_MESSAGES ?? ""} ${process.env.LANG ?? ""}`.toLowerCase();
  if (locale.includes("zh")) return "zh";
  return locale.trim() ? "en" : "zh";
}

// exposeBinding can only be registered once per name per context; keep a
// per-context dispatcher so every annotate round receives fresh payloads.
const boundContexts = new WeakSet<import("playwright-core").BrowserContext>();
const payloadDispatchers = new WeakMap<Page, (payload: unknown) => void>();

function exposeSubmitBinding(page: Page): void {
  const context = page.context();
  if (!boundContexts.has(context)) {
    void context.exposeBinding(BINDING_NAME, (source, payload: unknown) => {
      const dispatch = payloadDispatchers.get((source as { page?: Page }).page as Page);
      dispatch?.(payload);
    });
    boundContexts.add(context);
  }
  payloadDispatchers.set(page, () => {});
}

function waitForSubmit(page: Page): Promise<unknown> {
  return new Promise((resolve) => {
    payloadDispatchers.set(page, resolve);
  });
}

// ============================================================
// Shared annotate flow
// ============================================================

export interface AnnotateFlowOptions {
  cwd: string;
  sessionId?: string;
  /** Target URL. Optional when a browser session already has a page open. */
  url?: string;
  /** Overrides for browser.annotate config. */
  timeoutMs?: number;
  screenshots?: boolean;
  /** Progress callbacks: status line updates (undefined clears). */
  onStatus?: (status: string | undefined) => void;
  /** Progress callbacks: partial progress text (tool onUpdate). */
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

export type AnnotateFlowResult =
  | {
      ok: true;
      report: string;
      evidenceDir: string;
      payload: AnnotatePayload;
      noteCount: number;
    }
  | { ok: false; error: string; cancelled?: boolean; timedOut?: boolean; aborted?: boolean };

interface OverlayState {
  count: number;
  annotating: boolean;
  mode: string;
  submitted: boolean;
  lastActivity?: number;
}

async function readOverlayState(page: Page): Promise<OverlayState | undefined> {
  try {
    const state = (await page.evaluate("window.__cynosAnnotate && window.__cynosAnnotate.state ? window.__cynosAnnotate.state() : null")) as OverlayState | null;
    return state && typeof state.count === "number" ? state : undefined;
  } catch {
    return undefined;
  }
}

async function teardownOverlay(page: Page): Promise<void> {
  try {
    await page.evaluate("window.__cynosAnnotate && window.__cynosAnnotate.teardown && window.__cynosAnnotate.teardown()");
  } catch {
    // Page may have navigated or closed; nothing to clean up.
  }
}

async function captureElementShot(page: Page, selector: string, nth: number, outPath: string): Promise<string | undefined> {
  try {
    const locator = page.locator(selector).nth(Math.max(0, nth));
    if ((await locator.count()) === 0) return undefined;
    await locator.screenshot({ path: outPath, timeout: BROWSER_DEFAULT_TIMEOUT_MS, type: "png" });
    return outPath;
  } catch {
    return undefined;
  }
}

// Crop the drawn rectangle from the full-page render. clip coordinates are
// document-space; guard against degenerate / oversized regions.
async function captureRegionShot(page: Page, rect: { docX: number; docY: number; docWidth?: number; docHeight?: number; width?: number; height?: number }, outPath: string): Promise<string | undefined> {
  const width = Math.max(1, Math.min(Math.round(rect.docWidth ?? rect.width ?? 0), 20_000));
  const height = Math.max(1, Math.min(Math.round(rect.docHeight ?? rect.height ?? 0), 20_000));
  if (!Number.isFinite(rect.docX) || !Number.isFinite(rect.docY)) return undefined;
  try {
    await page.screenshot({
      path: outPath,
      fullPage: true,
      clip: { x: rect.docX, y: rect.docY, width, height },
      timeout: BROWSER_DEFAULT_TIMEOUT_MS,
      type: "png",
    });
    return outPath;
  } catch {
    return undefined;
  }
}

const NO_PAYLOAD = Symbol("no-payload-yet");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runAnnotateFlow(opts: AnnotateFlowOptions): Promise<AnnotateFlowResult> {
  const status = (s: string | undefined) => opts.onStatus?.(s);
  const sessionOpts: EnsureSessionOptions = { cwd: opts.cwd, sessionId: opts.sessionId };

  // Resolve target URL: explicit arg > current session page. Never auto-open a
  // browser without a destination.
  let targetUrl = opts.url?.trim() ?? "";
  if (!targetUrl) {
    const existing = getExistingSession(opts.cwd, opts.sessionId);
    targetUrl = existing?.currentUrl ?? "";
  }
  if (!targetUrl) {
    return { ok: false, error: "No URL given and no browser session is open. Pass a url (e.g. http://localhost:5173)." };
  }
  const check = checkBrowserUrl(targetUrl);
  if (!check.ok) {
    return { ok: false, error: `Blocked URL: ${check.reason}` };
  }

  // Annotations need a visible window. Relaunch headless sessions headed.
  const existing = getExistingSession(opts.cwd, opts.sessionId);
  if (existing?.headless) {
    status("Relaunching browser in headed mode...");
    await closeSession(opts.cwd, opts.sessionId);
  }

  status("Opening browser...");
  let page: Page;
  try {
    const session = await ensureSession({ ...sessionOpts, headlessOverride: false });
    page = session.page;
  } catch (error) {
    status(undefined);
    return {
      ok: false,
      error: error instanceof BrowserUnavailableError ? error.message : `Browser unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const config = await getBrowserConfig();
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : config.annotate.timeoutMs;
  const screenshots = opts.screenshots ?? config.annotate.screenshots;

  try {
    if (opts.url?.trim()) {
      await page.goto(opts.url.trim(), { waitUntil: "load", timeout: BROWSER_DEFAULT_TIMEOUT_MS });
      const finalCheck = checkBrowserUrl(page.url());
      if (!finalCheck.ok) {
        status(undefined);
        return { ok: false, error: `Navigation redirected to a blocked URL: ${finalCheck.reason}` };
      }
    }

    exposeSubmitBinding(page);
    await page.evaluate(overlaySource);
    const uiLang = resolveUiLanguage(config.annotate.uiLanguage);
    await page.evaluate(`window.__cynosAnnotate && window.__cynosAnnotate.install && window.__cynosAnnotate.install({ uiLang: ${JSON.stringify(uiLang)} })`);
  } catch (error) {
    status(undefined);
    return { ok: false, error: `Could not start annotation: ${error instanceof Error ? error.message : String(error)}` };
  }

  status("Annotating — click elements in the browser, Submit when done");

  // Wait for the binding payload. The deadline is an IDLE timeout: any user
  // interaction inside the overlay (reported via state.lastActivity) extends it.
  const deadline = { value: Date.now() + timeoutMs };
  let lastSeenActivity = -1;
  let payload: unknown;
  let timedOut = false;
  let overlayLostTicks = 0;
  let aborted = false;
  const onAbort = () => { aborted = true; };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (aborted) break;
      payload = await Promise.race([waitForSubmit(page), sleep(1200).then(() => NO_PAYLOAD)]);
      if (payload !== NO_PAYLOAD) break;
      if (aborted) break;
      if (Date.now() > deadline.value) {
        timedOut = true;
        break;
      }
      const state = await readOverlayState(page);
      if (!state) {
        overlayLostTicks++;
        if (overlayLostTicks >= 3) {
          status(undefined);
          return {
            ok: false,
            error: "Annotation ended: the page navigated or was closed. Notes do not survive navigation — rerun annotate.",
          };
        }
      } else {
        overlayLostTicks = 0;
        if (typeof state.lastActivity === "number" && state.lastActivity !== lastSeenActivity) {
          lastSeenActivity = state.lastActivity;
          deadline.value = Date.now() + timeoutMs; // active user → keep waiting
        }
        const line = `Annotating: ${state.count} note${state.count === 1 ? "" : "s"} — Submit in the browser when done`;
        status(line);
        opts.onProgress?.(line);
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (aborted) {
    await teardownOverlay(page);
    status(undefined);
    return { ok: false, error: "Annotation aborted.", cancelled: true, aborted: true };
  }

  if (timedOut) {
    await teardownOverlay(page);
    status(undefined);
    return { ok: false, error: `Annotation timed out after ${Math.round(timeoutMs / 60000)} min.`, timedOut: true };
  }

  const normalized = normalizeAnnotatePayload(payload);
  if (normalized.payload.cancelled) {
    await teardownOverlay(page);
    status(undefined);
    return { ok: false, error: "Annotation cancelled by the user.", cancelled: true };
  }

  // Capture evidence while the overlay badges are still rendered.
  const evidenceDir = path.join(opts.cwd, ".cynos", `annotate-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fs.mkdir(evidenceDir, { recursive: true });
  const rel = (file: string) => path.relative(opts.cwd, file);

  let viewportShot: string | undefined;
  try {
    viewportShot = path.join(evidenceDir, "viewport.png");
    await page.screenshot({ path: viewportShot, fullPage: false, timeout: BROWSER_DEFAULT_TIMEOUT_MS, type: "png" });
  } catch {
    viewportShot = undefined;
  }

  await teardownOverlay(page);

  let overviewShot: string | undefined;
  try {
    overviewShot = path.join(evidenceDir, "page.png");
    await page.screenshot({ path: overviewShot, fullPage: true, timeout: BROWSER_DEFAULT_TIMEOUT_MS, type: "png" });
  } catch {
    overviewShot = undefined;
  }

  // Per-note screenshots: regions crop their drawn rectangle from the full page;
  // element notes screenshot via the stored selector + nth index.
  const noteShots: (string | undefined)[] = [];
  for (let i = 0; i < normalized.payload.notes.length; i++) {
    const note = normalized.payload.notes[i];
    let shotPath: string | undefined;
    if (screenshots) {
      if (note.kind === "region" && note.rect) {
        shotPath = await captureRegionShot(page, note.rect, path.join(evidenceDir, `note-${note.n}.png`));
      } else if (note.selector && !note.removed) {
        shotPath = await captureElementShot(page, note.selector, note.nth, path.join(evidenceDir, `note-${note.n}.png`));
      }
    }
    noteShots.push(shotPath ? rel(shotPath) : undefined);
  }

  const report = formatAnnotateReport(normalized.payload, {
    dir: rel(evidenceDir),
    viewportScreenshot: viewportShot ? rel(viewportShot) : undefined,
    overviewScreenshot: overviewShot ? rel(overviewShot) : undefined,
    noteScreenshots: noteShots,
  });

  status(undefined);
  if (normalized.droppedNotes > 0) {
    opts.onProgress?.(`${normalized.droppedNotes} note(s) were dropped as invalid.`);
  }

  return { ok: true, report, evidenceDir, payload: normalized.payload, noteCount: normalized.payload.notes.length };
}

// ============================================================
// Command: /annotate
// ============================================================

export function registerAnnotateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("annotate", {
    description: "Annotate page elements in a headed browser window and send the report to the agent.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/annotate requires an interactive TUI.", "warning");
        return;
      }
      const result = await runAnnotateFlow({
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager?.getSessionId?.(),
        url: args || undefined,
        onStatus: (s) => ctx.ui.setStatus("annotate", s),
      });
      if (!result.ok) {
        if (!result.cancelled) ctx.ui.notify(result.error, result.timedOut ? "warning" : "error");
        else ctx.ui.notify(result.error, "info");
        return;
      }
      // Deliver as a real user message so the agent acts on it immediately.
      try {
        if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
          pi.sendUserMessage(result.report, { deliverAs: "followUp" });
        } else {
          pi.sendUserMessage(result.report);
        }
        ctx.ui.notify(`Annotation report sent (${result.noteCount} note${result.noteCount === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not send report: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

// ============================================================
// Tool: cynos_browser_annotate — lets the agent start annotation on request.
// ============================================================

export function registerAnnotateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "cynos_browser_annotate",
    label: "Cynos Browser Annotate",
    description:
      "Open a headed browser window on the user's desktop where the USER picks page elements and writes comments, then return the annotation report. " +
      "Use it when the user asks to annotate / review / mark up a page visually (e.g. '用 /annotate 标注这个页面', 'let me mark up the issues'). " +
      "BLOCKS until the user clicks Submit in that window or the timeout (default 10 min) — the user is working in the browser meanwhile. " +
      "When the report returns, act on every note (selectors, comments, screenshots are evidence), fix the code, then re-verify with cynos_browser_navigate + cynos_browser_inspect(screenshot).",
    promptSnippet: "Let the user annotate page elements in a headed browser; returns the report",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Page to annotate. Optional if a browser session already has a page open (defaults to it). localhost dev servers allowed.",
        },
        timeoutMs: { type: "number", description: "Max time to wait for the user to submit. Default 600000 (10 min)." },
      },
      additionalProperties: false,
    } as any,

    async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      const url = typeof params.url === "string" ? params.url.trim() : undefined;
      const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : undefined;

      onUpdate?.({ content: [{ type: "text" as const, text: `Opening annotate window${url ? ` for ${url}` : ""}...` }], details: {} as any });

      const result = await runAnnotateFlow({
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager?.getSessionId?.(),
        url,
        timeoutMs,
        onStatus: (s) => onUpdate?.({ content: [{ type: "text" as const, text: s ?? "Annotate session ended." }], details: {} as any }),
        signal,
      });

      if (!result.ok) {
        return { content: [{ type: "text" as const, text: result.error }], details: { cancelled: result.cancelled ?? false, timedOut: result.timedOut ?? false } as any, isError: result.cancelled ? false : true };
      }
      return {
        content: [{ type: "text" as const, text: `The user annotated the page. Report:\n\n${result.report}` }],
        details: { noteCount: result.noteCount, evidenceDir: result.evidenceDir } as any,
      };
    },

    renderCall(args: any, theme: Theme): Text {
      const url = typeof args.url === "string" ? args.url : "(current page)";
      return new Text(theme.fg("toolTitle", theme.bold("Annotate ")) + theme.fg("accent", url.slice(0, 80)), 0, 0);
    },
    renderResult(result: any, { isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
      if (isPartial) return new Text(theme.fg("warning", "Waiting for the user to annotate..."), 0, 0);
      const isError = result.isError;
      const marker = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
      const count = result.details?.noteCount;
      const tail = typeof count === "number" ? ` ${count} note${count === 1 ? "" : "s"}` : "";
      return new Text(`${marker}${theme.fg("muted", tail)}`, 0, 0);
    },
  });
}

// Re-exported for tests / programmatic use.
export type { AnnotatePayload };
