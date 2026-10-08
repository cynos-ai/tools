// /annotate command + cynos_browser_annotate tool — element annotation in the
// tools-managed browser.
//
// Unlike the standalone pi-annotate package (browser extension + native
// messaging host + unix socket), this runs entirely inside the tools-managed
// Playwright session: the overlay script is injected with page.evaluate and
// events return through an exposeBinding callback. No user-side setup.
//
// Session model (v4):
//   - The overlay is a persistent per-page component. Submitting ("一起发送")
//     does NOT tear it down: notes are cleared, the panel stays, and a
//     background watcher forwards every further submit to the conversation as
//     a user message — no need to rerun /annotate for the next round.
//   - The overlay + watcher are bound to the browser page of the pi session
//     that started them (sessions are isolated per cwd+sessionId), so with
//     several pi sessions each browser window routes its submits to its own
//     session. Concurrent annotate flows on the same page are rejected.
//   - Note screenshots are captured at note-creation time (the overlay hides
//     its shapes and awaits the host's ack), so SPA page switches can stash
//     the current page's notes without losing their crops. Stashed pages ride
//     along in the next submit payload.
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
import { BROWSER_ANNOTATE_MAX_NOTES, BROWSER_DEFAULT_TIMEOUT_MS } from "../infra/limits";
import {
  formatAnnotateReport,
  normalizeAnnotatePayload,
  normalizeAnnotatePages,
  type AnnotateNote,
  type AnnotatePage,
  type AnnotatePayload,
} from "./annotate-report";

const EVENT_BINDING = "__cynosAnnotateEvent";

// Overlay UI language: explicit config (zh/en/auto) > system locale > zh.
function resolveUiLanguage(configured: string): "zh" | "en" {
  if (configured === "zh" || configured === "en") return configured;
  const locale = `${process.env.LC_ALL ?? ""} ${process.env.LC_MESSAGES ?? ""} ${process.env.LANG ?? ""}`.toLowerCase();
  if (locale.includes("zh")) return "zh";
  return locale.trim() ? "en" : "zh";
}

// ============================================================
// Per-page annotate session state + event plumbing
// ============================================================

interface AnnotateSessionState {
  cwd: string;
  sessionId?: string;
  /** Evidence lives here for the whole annotate session (all rounds). */
  evidenceDir: string;
  screenshots: boolean;
  uiLang: "zh" | "en";
  /** Number of submit rounds delivered (names per-round viewport shots). */
  round: number;
  /** An annotate flow (command/tool) is currently waiting on this page. */
  flowActive: boolean;
  /** The background watcher loop is running. */
  watcherRunning: boolean;
  watcherStop: boolean;
  /** Note numbers whose creation-time screenshot is on disk. */
  capturedNotes: Set<number>;
  /** Server-side copy of overlay-stashed pages (hard-navigation resilience). */
  serverStash: AnnotatePage[];
}

const sessionStates = new WeakMap<Page, AnnotateSessionState>();
type AnnotateEvent = Record<string, unknown>;
const eventQueues = new WeakMap<Page, AnnotateEvent[]>();
const eventWaiters = new WeakMap<Page, ((ev: AnnotateEvent) => void)[]>();

// exposeBinding can only be registered once per name per context; keep a
// per-context flag so every annotate round reuses it.
const boundContexts = new WeakSet<import("playwright-core").BrowserContext>();

function exposeEventBinding(page: Page): void {
  const context = page.context();
  if (boundContexts.has(context)) return;
  void context.exposeBinding(EVENT_BINDING, (source, payload: AnnotateEvent) => {
    const boundPage = (source as { page?: Page }).page as Page | undefined;
    if (!boundPage) return;
    if (payload && payload.type === "note-added") {
      // The overlay awaits this call while its shapes are hidden: capture the
      // crop before resolving so screenshots never contain overlay chrome.
      return handleNoteAdded(boundPage, payload);
    }
    dispatchEvent(boundPage, payload ?? {});
    return undefined;
  });
  boundContexts.add(context);
}

function dispatchEvent(page: Page, ev: AnnotateEvent): void {
  const waiters = eventWaiters.get(page);
  if (waiters && waiters.length > 0) {
    const wake = waiters.shift()!;
    wake(ev);
    return;
  }
  let queue = eventQueues.get(page);
  if (!queue) {
    queue = [];
    eventQueues.set(page, queue);
  }
  if (queue.length < 64) queue.push(ev);
}

function dequeueEvent(page: Page): AnnotateEvent | undefined {
  const queue = eventQueues.get(page);
  return queue && queue.length > 0 ? queue.shift() : undefined;
}

function nextEvent(page: Page): Promise<AnnotateEvent> {
  const existing = dequeueEvent(page);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let waiters = eventWaiters.get(page);
    if (!waiters) {
      waiters = [];
      eventWaiters.set(page, waiters);
    }
    waiters.push(resolve);
  });
}

// Called (and awaited by the page) whenever the overlay adds or re-targets a
// note. Never throws: the overlay's UI must not wedge on a host hiccup.
async function handleNoteAdded(page: Page, payload: AnnotateEvent): Promise<void> {
  try {
    const state = sessionStates.get(page);
    if (!state || !state.screenshots) return;
    const note = payload.note as Record<string, unknown> | undefined;
    if (!note || typeof note !== "object") return;
    const n = Math.floor(Number(note.n));
    if (!Number.isFinite(n) || n < 1 || n > 1_000_000) return;
    const outPath = path.join(state.evidenceDir, `note-${n}.png`);
    let saved: string | undefined;
    if (note.kind === "region" && note.rect && typeof note.rect === "object") {
      const rect = note.rect as { docX?: unknown; docY?: unknown; docWidth?: unknown; docHeight?: unknown; width?: unknown; height?: unknown };
      saved = await captureRegionShot(
        page,
        {
          docX: Number(rect.docX),
          docY: Number(rect.docY),
          docWidth: rect.docWidth == null ? undefined : Number(rect.docWidth),
          docHeight: rect.docHeight == null ? undefined : Number(rect.docHeight),
          width: rect.width == null ? undefined : Number(rect.width),
          height: rect.height == null ? undefined : Number(rect.height),
        },
        outPath,
      );
    } else if (typeof note.selector === "string" && note.selector) {
      saved = await captureElementShot(page, note.selector, Math.max(0, Math.floor(Number(note.nth) || 0)), outPath);
    }
    if (saved) state.capturedNotes.add(n);
  } catch {
    // Page may have navigated mid-capture; the note simply has no crop.
  }
}

// ============================================================
// Overlay helpers
// ============================================================

interface OverlayState {
  version?: number;
  count: number;
  pages?: number;
  total?: number;
  annotating?: boolean;
  mode?: string;
  lastActivity?: number;
  url?: string;
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

async function captureViewportShot(page: Page, outPath: string): Promise<string | undefined> {
  try {
    await page.screenshot({ path: outPath, fullPage: false, timeout: BROWSER_DEFAULT_TIMEOUT_MS, type: "png" });
    return outPath;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noteShotFor(state: AnnotateSessionState, rel: (f: string) => string, note: AnnotateNote): string | undefined {
  return state.capturedNotes.has(note.n) ? rel(path.join(state.evidenceDir, `note-${note.n}.png`)) : undefined;
}

// Build a payload from the server-side stash (hard navigation interrupted the
// round before the overlay could submit).
function payloadFromStash(stash: AnnotatePage[], context = ""): AnnotatePayload {
  const notes = stash.flatMap((p) => p.notes).slice(0, BROWSER_ANNOTATE_MAX_NOTES);
  const last = stash[stash.length - 1];
  return {
    url: last?.url ?? "",
    title: last?.title,
    context,
    cancelled: false,
    notes,
    pages: stash,
  };
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
      /** True when a navigation ended the round and notes came from the stash. */
      navInterrupted?: boolean;
    }
  | { ok: false; error: string; cancelled?: boolean; timedOut?: boolean; aborted?: boolean };

export async function runAnnotateFlow(opts: AnnotateFlowOptions): Promise<AnnotateFlowResult> {
  const status = (s: string | undefined) => opts.onStatus?.(s);
  const sessionOpts: EnsureSessionOptions = { cwd: opts.cwd, sessionId: opts.sessionId };

  // Resolve target URL: explicit arg > current session page. Never auto-open a
  // browser without a destination.
  let targetUrl = opts.url?.trim() ?? "";
  if (!targetUrl) {
    const existingSession = getExistingSession(opts.cwd, opts.sessionId);
    targetUrl = existingSession?.currentUrl ?? "";
  }
  if (!targetUrl) {
    return { ok: false, error: "No URL given and no browser session is open. Pass a url (e.g. http://localhost:5173)." };
  }
  const check = checkBrowserUrl(targetUrl);
  if (!check.ok) {
    return { ok: false, error: `Blocked URL: ${check.reason}` };
  }

  // Annotations need a visible window. Relaunch headless sessions headed.
  const existingSession = getExistingSession(opts.cwd, opts.sessionId);
  if (existingSession?.headless) {
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

  // One annotate flow at a time per browser page: a second overlapping call
  // would otherwise steal the first one's submit events.
  const existingState = sessionStates.get(page);
  if (existingState?.flowActive) {
    status(undefined);
    return { ok: false, error: "An annotate session is already waiting on this browser page. Submit or close it first (one annotate window per pi session)." };
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

    exposeEventBinding(page);

    // Reuse a still-installed overlay (previous round) — re-injecting would
    // wipe its stashed pages and note numbering. Only re-install when the
    // overlay is gone (first run, or a hard navigation removed it).
    let overlay = await readOverlayState(page);
    if (!overlay) {
      await page.evaluate(overlaySource);
      const uiLang = resolveUiLanguage(config.annotate.uiLanguage);
      await page.evaluate(`window.__cynosAnnotate && window.__cynosAnnotate.install && window.__cynosAnnotate.install({ uiLang: ${JSON.stringify(uiLang)} })`);
      overlay = await readOverlayState(page);
    }
    let state = sessionStates.get(page);
    if (!state) {
      const evidenceDir = path.join(opts.cwd, ".cynos", `annotate-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await fs.mkdir(evidenceDir, { recursive: true });
      state = {
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        evidenceDir,
        screenshots,
        uiLang: resolveUiLanguage(config.annotate.uiLanguage),
        round: 0,
        flowActive: false,
        watcherRunning: false,
        watcherStop: false,
        capturedNotes: new Set<number>(),
        serverStash: [],
      };
      sessionStates.set(page, state);
    } else {
      state.screenshots = screenshots;
    }
    // A hard navigation may have wiped an overlay whose pages were only in the
    // server-side stash — restore them into the fresh overlay.
    if (!overlay && state.serverStash.length > 0) {
      await page.evaluate(`window.__cynosAnnotate && window.__cynosAnnotate.restoreStash && window.__cynosAnnotate.restoreStash(${JSON.stringify(state.serverStash)})`);
    }
    ensureWatcher(page);
  } catch (error) {
    status(undefined);
    return { ok: false, error: `Could not start annotation: ${error instanceof Error ? error.message : String(error)}` };
  }

  const state = sessionStates.get(page)!;
  status("Annotating — click elements in the browser, Submit when done");

  // Wait for submit/cancel/close events. The deadline is an IDLE timeout: any
  // user interaction inside the overlay (reported via state.lastActivity or an
  // incoming event) extends it.
  const deadline = { value: Date.now() + timeoutMs };
  let lastSeenActivity = -1;
  let timedOut = false;
  let overlayLostTicks = 0;
  let aborted = false;
  const onAbort = () => { aborted = true; };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let submitPayload: AnnotateEvent | undefined;
  let userCancelled = false;
  let userClosed = false;
  let overlayLost = false;

  state.flowActive = true;
  try {
    for (;;) {
      if (aborted) break;
      let ev: AnnotateEvent | undefined;
      try {
        ev = await Promise.race([nextEvent(page), sleep(1200).then(() => undefined)]);
      } catch {
        ev = undefined;
      }
      if (ev) {
        deadline.value = Date.now() + timeoutMs; // any event implies activity
        const type = ev.type;
        if (type === "submit") {
          submitPayload = ev;
          break;
        }
        if (type === "cancel") {
          userCancelled = true;
          break;
        }
        if (type === "close") {
          userClosed = true;
          break;
        }
        if (type === "page-stash") {
          state.serverStash = normalizeAnnotatePages(ev.pages).pages;
        }
        continue;
      }
      if (aborted) break;
      if (Date.now() > deadline.value) {
        timedOut = true;
        break;
      }
      const overlayState = await readOverlayState(page);
      if (!overlayState) {
        overlayLostTicks++;
        if (overlayLostTicks >= 3) {
          overlayLost = true;
          break;
        }
      } else {
        overlayLostTicks = 0;
        if (typeof overlayState.lastActivity === "number" && overlayState.lastActivity !== lastSeenActivity) {
          lastSeenActivity = overlayState.lastActivity;
          deadline.value = Date.now() + timeoutMs; // active user → keep waiting
        }
        const line = `Annotating: ${overlayState.total ?? overlayState.count} note(s)${overlayState.pages ? ` · ${overlayState.pages} page(s) stashed` : ""} — Submit in the browser when done`;
        status(line);
        opts.onProgress?.(line);
      }
    }
  } finally {
    state.flowActive = false;
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (aborted) {
    status(undefined);
    return { ok: false, error: "Annotation aborted.", cancelled: true, aborted: true };
  }

  if (userClosed) {
    state.serverStash = [];
    state.watcherStop = true;
    status(undefined);
    return { ok: false, error: "Annotation closed.", cancelled: true };
  }

  if (userCancelled) {
    state.serverStash = [];
    status(undefined);
    return { ok: false, error: "Annotation cancelled by the user.", cancelled: true };
  }

  const rel = (file: string) => path.relative(opts.cwd, file);

  // Navigation killed the overlay before a submit: deliver whatever pages the
  // overlay managed to stash server-side instead of losing everything.
  if (overlayLost && !submitPayload) {
    const stash = state.serverStash;
    state.serverStash = [];
    if (stash.length > 0) {
      const payload = normalizeAnnotatePayload({ ...payloadFromStash(stash), cancelled: false }).payload;
      const noteShots = payload.notes.map((n) => noteShotFor(state, rel, n));
      const report = "> The page navigated before the overlay could submit; notes below were auto-stashed from earlier pages.\n\n" +
        formatAnnotateReport(payload, { dir: rel(state.evidenceDir), noteScreenshots: noteShots });
      status(undefined);
      return { ok: true, report, evidenceDir: state.evidenceDir, payload, noteCount: payload.notes.length, navInterrupted: true };
    }
    status(undefined);
    return {
      ok: false,
      error: "Annotation ended: the page navigated or was closed before any note was stashed. Rerun annotate.",
    };
  }

  if (!submitPayload) {
    // Idle timeout: leave the overlay in place — the watcher keeps delivering
    // later submits as messages, so the round is never truly lost.
    status(undefined);
    return { ok: false, error: `Annotation timed out after ${Math.round(timeoutMs / 60000)} min. The overlay stays active — later submits are delivered automatically.`, timedOut: true };
  }

  // ---- submit round ----
  const normalized = normalizeAnnotatePayload(submitPayload);
  if (normalized.payload.cancelled) {
    state.serverStash = [];
    status(undefined);
    return { ok: false, error: "Annotation cancelled by the user.", cancelled: true };
  }

  state.round += 1;
  state.serverStash = []; // everything stashed is included in this payload

  // Submit-time viewport capture (badges visible). Note crops were taken at
  // note-creation time; no full-page overview anymore.
  let viewportShot: string | undefined;
  if (screenshots) {
    viewportShot = await captureViewportShot(page, path.join(state.evidenceDir, `viewport-r${state.round}.png`));
  }
  if (normalized.droppedNotes > 0) {
    opts.onProgress?.(`${normalized.droppedNotes} note(s) were dropped as invalid.`);
  }

  const report = formatAnnotateReport(normalized.payload, {
    dir: rel(state.evidenceDir),
    viewportScreenshot: viewportShot ? rel(viewportShot) : undefined,
    noteScreenshots: normalized.payload.notes.map((n) => noteShotFor(state, rel, n)),
  });

  status(undefined);
  return { ok: true, report, evidenceDir: state.evidenceDir, payload: normalized.payload, noteCount: normalized.payload.notes.length };
}

// ============================================================
// Background watcher — keeps a finished overlay useful
// ============================================================

const WATCHER_TICK_MS = 1500;
const WATCHER_IDLE_STOP_MS = 60 * 60 * 1000;

let piApi: ExtensionAPI | null = null;
let agentBusy = false;
let busyHooksInstalled = false;

function installBusyHooks(pi: ExtensionAPI): void {
  if (busyHooksInstalled) return;
  busyHooksInstalled = true;
  try {
    pi.on("agent_start", () => { agentBusy = true; });
    pi.on("agent_settled", () => { agentBusy = false; });
  } catch {
    // Event names unavailable in this host version: delivery falls back to
    // "followUp" (queued), which is safe either way.
    agentBusy = true;
  }
}

/** Start the per-page watcher (idempotent). Runs until the overlay is gone. */
function ensureWatcher(page: Page): void {
  const state = sessionStates.get(page);
  if (!state || state.watcherRunning) return;
  state.watcherRunning = true;
  state.watcherStop = false;
  void watcherLoop(page, state);
}

async function watcherLoop(page: Page, state: AnnotateSessionState): Promise<void> {
  let lastActivity = -1;
  let idleDeadline = Date.now() + WATCHER_IDLE_STOP_MS;
  let lostTicks = 0;
  try {
    while (!state.watcherStop) {
      await sleep(WATCHER_TICK_MS);
      if (state.flowActive) continue; // the active flow consumes events

      for (;;) {
        const ev = dequeueEvent(page);
        if (!ev) break;
        if (ev.type === "note-added") {
          await handleNoteAdded(page, ev);
        } else if (ev.type === "page-stash") {
          state.serverStash = normalizeAnnotatePages(ev.pages).pages;
          idleDeadline = Date.now() + WATCHER_IDLE_STOP_MS;
        } else if (ev.type === "cancel") {
          state.serverStash = [];
        } else if (ev.type === "close") {
          state.serverStash = [];
          state.watcherStop = true;
          break;
        } else if (ev.type === "submit") {
          await deliverWatcherRound(page, state, ev);
          idleDeadline = Date.now() + WATCHER_IDLE_STOP_MS;
        }
      }
      if (state.watcherStop) break;

      const overlayState = await readOverlayState(page);
      if (!overlayState) {
        lostTicks++;
        // Overlay gone (navigation/closed). Deliver a stash-only round if the
        // overlay managed to hand us pages before dying, then stop.
        if (lostTicks >= 4) {
          const stash = state.serverStash;
          state.serverStash = [];
          if (stash.length > 0) {
            const payload = normalizeAnnotatePayload({ ...payloadFromStash(stash), cancelled: false }).payload;
            const rel = (f: string) => path.relative(state.cwd, f);
            const report = "> The page navigated before the overlay could submit; notes below were auto-stashed from earlier pages.\n\n" +
              formatAnnotateReport(payload, { dir: rel(state.evidenceDir), noteScreenshots: payload.notes.map((n) => noteShotFor(state, rel, n)) });
            sendWatcherReport(report);
          }
          break;
        }
      } else {
        lostTicks = 0;
        if (typeof overlayState.lastActivity === "number" && overlayState.lastActivity !== lastActivity) {
          lastActivity = overlayState.lastActivity;
          idleDeadline = Date.now() + WATCHER_IDLE_STOP_MS;
        }
      }
      if (Date.now() > idleDeadline) {
        // Idle for an hour: remove the overlay so the page returns to normal.
        await teardownOverlay(page);
        break;
      }
    }
  } catch {
    // Page/context closed: nothing to do.
  } finally {
    state.watcherRunning = false;
  }
}

async function deliverWatcherRound(page: Page, state: AnnotateSessionState, ev: AnnotateEvent): Promise<void> {
  const normalized = normalizeAnnotatePayload(ev);
  if (normalized.payload.cancelled) return;
  state.round += 1;
  state.serverStash = []; // delivered

  let viewportShot: string | undefined;
  if (state.screenshots) {
    viewportShot = await captureViewportShot(page, path.join(state.evidenceDir, `viewport-r${state.round}.png`));
  }
  const rel = (f: string) => path.relative(state.cwd, f);
  const report = formatAnnotateReport(normalized.payload, {
    dir: rel(state.evidenceDir),
    viewportScreenshot: viewportShot ? rel(viewportShot) : undefined,
    noteScreenshots: normalized.payload.notes.map((n) => noteShotFor(state, rel, n)),
  });
  sendWatcherReport(report);
}

function sendWatcherReport(report: string): void {
  if (!piApi) return;
  try {
    if (agentBusy) piApi.sendUserMessage(report, { deliverAs: "followUp" });
    else piApi.sendUserMessage(report);
  } catch {
    // Host refused delivery; nothing more we can do here.
  }
}

// ============================================================
// Command: /annotate
// ============================================================

export function registerAnnotateCommand(pi: ExtensionAPI): void {
  piApi = pi;
  installBusyHooks(pi);
  pi.registerCommand("annotate", {
    description: "Annotate page elements in a headed browser window and send the report to the agent.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/annotate requires an interactive TUI.", "warning");
        return;
      }
      // pi awaits command handlers on the input path: a blocking flow would
      // freeze TUI input until submit/timeout. Run it in the background and
      // deliver the report via sendUserMessage when it completes.
      void runAnnotateFlow({
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager?.getSessionId?.(),
        url: args || undefined,
        onStatus: (s) => ctx.ui.setStatus("annotate", s),
      })
        .then((result) => {
          ctx.ui.setStatus("annotate", undefined);
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
            ctx.ui.notify(
              `Annotation report sent (${result.noteCount} note${result.noteCount === 1 ? "" : "s"}${result.navInterrupted ? ", recovered after navigation" : ""}). ` +
                "The window stays active — keep annotating and send again anytime.",
              "info",
            );
          } catch (error) {
            ctx.ui.notify(`Could not send report: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        })
        .catch((error) => {
          ctx.ui.setStatus("annotate", undefined);
          ctx.ui.notify(`Annotate failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        });
    },
  });
}

// ============================================================
// Tool: cynos_browser_annotate — lets the agent start annotation on request.
// ============================================================

export function registerAnnotateTool(pi: ExtensionAPI): void {
  piApi = pi;
  installBusyHooks(pi);
  pi.registerTool({
    name: "cynos_browser_annotate",
    label: "Cynos Browser Annotate",
    description:
      "Open a headed browser window on the user's desktop where the USER picks page elements and writes comments, then return the annotation report. " +
      "Use it when the user asks to annotate / review / mark up a page visually (e.g. '用 /annotate 标注这个页面', 'let me mark up the issues'). " +
      "BLOCKS until the user clicks Submit in that window or the timeout (default 10 min) — the user is working in the browser meanwhile. " +
      "The overlay stays installed after submit: later '一起发送' submits are auto-forwarded to the conversation as user messages, so do NOT call this " +
      "tool again just to collect another round. Each pi session has its own browser window; submits always route to the session that opened it, and " +
      "only one annotate flow can wait per session. " +
      "When the report returns, act on every note (selectors, comments, screenshots are evidence), then re-verify with cynos_browser_navigate + cynos_browser_inspect(screenshot).",
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
      const suffix = result.navInterrupted
        ? "\n\n(Note: the page navigated before submit; the report was recovered from auto-stashed pages.)"
        : "\n\n(The overlay stays active in the browser — the user can annotate more and submit again; further rounds arrive as user messages.)";
      return {
        content: [{ type: "text" as const, text: `The user annotated the page. Report:\n\n${result.report}${suffix}` }],
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
