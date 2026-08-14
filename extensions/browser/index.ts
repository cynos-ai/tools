// cynos_browser_navigate / interact / inspect / close tool registration.

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as path from "node:path";
import { checkBrowserUrl } from "./security";
import { resolveTarget, type InteractionTarget } from "./targets";
import { ensureSession, getPage, BrowserUnavailableError, type EnsureSessionOptions } from "./launch";
import { formatSnapshot, snapshotPage, storeRefs } from "./inspect";
import { closeSession, getExistingSession } from "./manager";
import { BROWSER_DEFAULT_TIMEOUT_MS } from "../infra/limits";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../infra/output";

function sessionOpts(ctx: any): EnsureSessionOptions {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager?.getSessionId?.(),
  };
}

function resolveScreenshotPath(ctx: any, requested?: string): string {
  if (requested && typeof requested === "string") {
    return path.isAbsolute(requested) ? requested : path.resolve(ctx.cwd, requested);
  }
  return path.join(ctx.cwd, ".cynos", "browser-evidence", `screenshot-${Date.now()}.png`);
}

async function ensureDirFor(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await import("node:fs/promises").then((fsp) => fsp.mkdir(dir, { recursive: true }));
}

export function registerBrowserTools(pi: ExtensionAPI): void {
  // ---- cynos_browser_navigate ----
  pi.registerTool({
    name: "cynos_browser_navigate",
    label: "Cynos Browser Navigate",
    description:
      "Open a URL in the isolated browser session (creates the session if needed). Sets viewport and wait policy. " +
      "Only http/https allowed; localhost/127.0.0.1 are permitted for local dev verification. Cloud metadata, file://, data:, etc. are blocked.",
    promptSnippet: "Open a URL in the isolated browser and start a session",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http/https URL to open." },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
          description: "Optional viewport size in CSS pixels.",
        },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "Default 'load'." },
        timeoutMs: { type: "number", description: `Navigation timeout in ms. Default ${BROWSER_DEFAULT_TIMEOUT_MS}.` },
      },
      required: ["url"],
      additionalProperties: false,
    } as any,

    async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      const url = typeof params.url === "string" ? params.url.trim() : "";
      if (!url) {
        return { content: [{ type: "text" as const, text: "A url is required." }], details: {} as any, isError: true };
      }
      const check = checkBrowserUrl(url);
      if (!check.ok) {
        return { content: [{ type: "text" as const, text: `Blocked URL: ${check.reason}` }], details: { url }, isError: true };
      }

      onUpdate?.({ content: [{ type: "text" as const, text: `Navigating to ${url}...` }], details: {} as any });

      let session;
      try {
        ({ session } = await getPage(sessionOpts(ctx)));
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: browserUnavailableMessage(error) }],
          details: { url },
          isError: true,
        };
      }

      const waitUntil = (params.waitUntil === "domcontentloaded" || params.waitUntil === "networkidle" ? params.waitUntil : "load") as "load" | "domcontentloaded" | "networkidle";
      const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : BROWSER_DEFAULT_TIMEOUT_MS;

      if (params.viewport && typeof params.viewport.width === "number" && typeof params.viewport.height === "number") {
        try {
          await session.page.setViewportSize({ width: params.viewport.width, height: params.viewport.height });
        } catch { /* ignore */ }
      }

      try {
        await session.page.goto(url, { waitUntil, timeout: timeoutMs });
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Navigation failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { url, failure: error instanceof Error ? error.message : String(error) },
          isError: true,
        };
      }

      session.currentUrl = session.page.url();
      try {
        session.currentTitle = await session.page.title();
      } catch {
        session.currentTitle = "";
      }
      // Redirect safety: re-check the final URL.
      const finalCheck = checkBrowserUrl(session.currentUrl);
      if (!finalCheck.ok) {
        return {
          content: [{ type: "text" as const, text: `Navigation redirected to a blocked URL: ${finalCheck.reason}` }],
          details: { url, finalUrl: session.currentUrl },
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Navigated to ${session.currentUrl}${session.currentTitle ? `\nTitle: ${session.currentTitle}` : ""}` }],
        details: { url, finalUrl: session.currentUrl, title: session.currentTitle },
      };
    },

    renderCall(args: any, theme: Theme): Text {
      const url = typeof args.url === "string" ? args.url : "?";
      return new Text(theme.fg("toolTitle", theme.bold("Browser ")) + theme.fg("accent", `→ ${url.slice(0, 80)}`), 0, 0);
    },
    renderResult(result: any, { isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
      if (isPartial) return new Text(theme.fg("warning", "Navigating..."), 0, 0);
      const isError = result.isError;
      const details = result.details as any;
      const url = details?.finalUrl ?? details?.url ?? "?";
      const marker = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
      return new Text(`${marker} ${theme.fg("muted", url.slice(0, 80))}`, 0, 0);
    },
  });

  // ---- cynos_browser_interact ----
  pi.registerTool({
    name: "cynos_browser_interact",
    label: "Cynos Browser Interact",
    description:
      "Interact with the current page: click, fill, press, select, hover, scroll, wait. " +
      "Target precedence: ref (from the latest snapshot) > role+name > selector > text. Prefer refs from a fresh snapshot; refs are invalidated by navigation.",
    promptSnippet: "Click/fill/press/select on the current browser page",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "fill", "press", "select", "hover", "scroll", "wait"], description: "Interaction type." },
        target: {
          type: "object",
          description: "Element target. Omit for 'wait'/'scroll'.",
          properties: {
            ref: { type: "string" },
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            text: { type: "string" },
          },
          additionalProperties: false,
        },
        value: { type: "string", description: "Value for fill/select (option text)." },
        key: { type: "string", description: "Key for press (e.g. 'Enter', 'ArrowDown')." },
        timeoutMs: { type: "number", description: `Per-action timeout in ms. Default ${BROWSER_DEFAULT_TIMEOUT_MS}.` },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,

    async execute(_toolCallId: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const action = typeof params.action === "string" ? params.action : "";
      if (!action) {
        return { content: [{ type: "text" as const, text: "An action is required." }], details: {}, isError: true };
      }
      const target: InteractionTarget = params.target ?? {};
      const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : BROWSER_DEFAULT_TIMEOUT_MS;

      let session;
      try {
        ({ session } = await getPage(sessionOpts(ctx)));
      } catch (error) {
        return { content: [{ type: "text" as const, text: browserUnavailableMessage(error) }], details: { action }, isError: true };
      }

      const page = session.page;

      try {
        switch (action) {
          case "click": {
            const resolved = resolveTarget({ target });
            if (!resolved) return { content: [{ type: "text" as const, text: "click requires a target (ref/role/selector/text)." }], details: {} as any, isError: true };
            await resolved.apply(page).click({ timeout: timeoutMs });
            break;
          }
          case "fill": {
            const resolved = resolveTarget({ target });
            if (!resolved) return { content: [{ type: "text" as const, text: "fill requires a target." }], details: {} as any, isError: true };
            if (typeof params.value !== "string") return { content: [{ type: "text" as const, text: "fill requires a value." }], details: {} as any, isError: true };
            await resolved.apply(page).fill(params.value, { timeout: timeoutMs });
            break;
          }
          case "press": {
            if (!params.key) return { content: [{ type: "text" as const, text: "press requires a key." }], details: {} as any, isError: true };
            const resolved = resolveTarget({ target });
            const locator = resolved ? resolved.apply(page) : page.locator("body");
            await locator.press(params.key, { timeout: timeoutMs });
            break;
          }
          case "select": {
            const resolved = resolveTarget({ target });
            if (!resolved) return { content: [{ type: "text" as const, text: "select requires a target." }], details: {} as any, isError: true };
            if (typeof params.value !== "string") return { content: [{ type: "text" as const, text: "select requires a value (option label)." }], details: {} as any, isError: true };
            await resolved.apply(page).selectOption(params.value, { timeout: timeoutMs });
            break;
          }
          case "hover": {
            const resolved = resolveTarget({ target });
            if (!resolved) return { content: [{ type: "text" as const, text: "hover requires a target." }], details: {} as any, isError: true };
            await resolved.apply(page).hover({ timeout: timeoutMs });
            break;
          }
          case "scroll": {
            await page.mouse.wheel(0, 400).catch(() => undefined);
            break;
          }
          case "wait": {
            await page.waitForTimeout(Math.min(timeoutMs, 5000));
            break;
          }
          default:
            return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], details: { action }, isError: true };
        }
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `${action} failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { action, failure: error instanceof Error ? error.message : String(error) },
          isError: true,
        };
      }

      session.currentUrl = page.url();
      return {
        content: [{ type: "text" as const, text: `${action} ok (url=${session.currentUrl}). Use cynos_browser_inspect for evidence.` }],
        details: { action, url: session.currentUrl },
      };
    },

    renderCall(args: any, theme: Theme): Text {
      const action = args.action ?? "?";
      const target = args.target ?? {};
      const hint = target.ref ?? target.role ?? target.selector ?? target.text ?? "";
      return new Text(theme.fg("toolTitle", theme.bold("Browser ")) + theme.fg("accent", `${action} ${hint}`.trim()), 0, 0);
    },
    renderResult(result: any, { isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
      if (isPartial) return new Text(theme.fg("warning", "Interacting..."), 0, 0);
      const isError = result.isError;
      const marker = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
      return new Text(`${marker} ${theme.fg("muted", result.details?.action ?? "")}`, 0, 0);
    },
  });

  // ---- cynos_browser_inspect ----
  pi.registerTool({
    name: "cynos_browser_inspect",
    label: "Cynos Browser Inspect",
    description:
      "Capture page evidence: snapshot (interactive element refs), screenshot (PNG file), console (sanitized log), requests (network log without bodies/secret headers), or eval (run JS). " +
      "snapshot/screenshot/console/requests/eval count as direct browser evidence for completion checks; navigate/interact do not.",
    promptSnippet: "Snapshot/screenshot/console/network/eval the current browser page",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["snapshot", "screenshot", "console", "requests", "eval"], description: "Inspect action." },
        path: { type: "string", description: "Output path for screenshot. Default .cynos/browser-evidence/screenshot-<ts>.png." },
        fullPage: { type: "boolean", description: "Screenshot the full page (default true)." },
        expression: { type: "string", description: "JavaScript expression for eval. Runs in the page; may change page state." },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,

    async execute(_toolCallId: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const action = typeof params.action === "string" ? params.action : "";
      if (!action) {
        return { content: [{ type: "text" as const, text: "An action is required." }], details: {} as any, isError: true };
      }
      let session;
      try {
        ({ session } = await getPage(sessionOpts(ctx)));
      } catch (error) {
        return { content: [{ type: "text" as const, text: browserUnavailableMessage(error) }], details: {} as any, isError: true };
      }
      const page = session.page;

      const baseDetails = (): Record<string, unknown> => ({
        action,
        url: page.url(),
        title: session.currentTitle,
      });

      try {
        if (action === "snapshot") {
          const elements = await snapshotPage(page);
          storeRefs(session, elements);
          try { session.currentTitle = await page.title(); } catch { /* ignore */ }
          const text = formatSnapshot(page.url(), session.currentTitle, elements);
          return { content: [{ type: "text" as const, text }], details: { ...baseDetails(), title: session.currentTitle, elementCount: elements.length } };
        }
        if (action === "screenshot") {
          const outPath = resolveScreenshotPath(ctx, params.path);
          await ensureDirFor(outPath);
          await page.screenshot({ path: outPath, fullPage: params.fullPage !== false, timeout: BROWSER_DEFAULT_TIMEOUT_MS, type: "png" });
          return {
            content: [{ type: "text" as const, text: `Screenshot saved: ${outPath}` }],
            details: { ...baseDetails(), screenshotPath: outPath },
          };
        }
        if (action === "console") {
          const events = session.consoleEvents.slice(-50);
          const text = events.length === 0 ? "(no console events)" : events.map((e) => `[${e.type}] ${e.text}`).join("\n");
          return { content: [{ type: "text" as const, text }], details: { ...baseDetails(), count: events.length } };
        }
        if (action === "requests") {
          const events = session.networkEvents.slice(-50);
          const text = events.length === 0 ? "(no network events)" : events.map((e) => `${e.method} ${e.url} ${e.status ?? e.failure ?? ""}`.trim()).join("\n");
          return { content: [{ type: "text" as const, text }], details: { ...baseDetails(), count: events.length } };
        }
        if (action === "eval") {
          if (typeof params.expression !== "string" || !params.expression.trim()) {
            return { content: [{ type: "text" as const, text: "eval requires an expression." }], details: { action } as any, isError: true };
          }
          const result = await page.evaluate(params.expression);
          let text: string;
          try {
            text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          } catch {
            text = String(result);
          }
          const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: BROWSER_EVAL_BYTES() });
          let out = truncation.content;
          if (truncation.truncated) {
            out += `\n\n[eval output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} / ${formatSize(truncation.totalBytes)})]`;
          }
          return { content: [{ type: "text" as const, text: out }], details: { ...baseDetails(), truncated: truncation.truncated } };
        }
        return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], details: { action } as any, isError: true };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `${action} failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { ...baseDetails(), failure: error instanceof Error ? error.message : String(error) },
          isError: true,
        };
      }
    },

    renderCall(args: any, theme: Theme): Text {
      const action = args.action ?? "?";
      return new Text(theme.fg("toolTitle", theme.bold("Browser ")) + theme.fg("accent", `inspect ${action}`), 0, 0);
    },
    renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: Theme): Text {
      if (isPartial) return new Text(theme.fg("warning", "Inspecting..."), 0, 0);
      const isError = result.isError;
      const details = result.details as any;
      const marker = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
      let text = `${marker} ${theme.fg("muted", details?.action ?? "")}`;
      if (expanded && !isError) {
        const content = result.content?.[0];
        if (content?.type === "text") {
          for (const line of content.text.split("\n").slice(0, 8)) text += `\n  ${theme.fg("dim", line)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // ---- cynos_browser_close ----
  pi.registerTool({
    name: "cynos_browser_close",
    label: "Cynos Browser Close",
    description: "Close the current pi session's browser (page/context/browser). Idempotent: calling with no active session succeeds.",
    promptSnippet: "Close the browser session for the current pi session",
    parameters: { type: "object", properties: {}, additionalProperties: false } as any,
    async execute(_toolCallId: string, _params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const existed = !!getExistingSession(ctx.cwd, ctx.sessionManager?.getSessionId?.());
      await closeSession(ctx.cwd, ctx.sessionManager?.getSessionId?.());
      return {
        content: [{ type: "text" as const, text: existed ? "Browser closed." : "No active browser session." }],
        details: { closed: existed },
      };
    },
    renderResult(result: any, _opts: any, theme: Theme): Text {
      const closed = result.details?.closed;
      return new Text(theme.fg("success", closed ? "✓ closed" : "✓ (already closed)"), 0, 0);
    },
  });
}

function browserUnavailableMessage(error: unknown): string {
  if (error instanceof BrowserUnavailableError) return error.message;
  return `Browser unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

function BROWSER_EVAL_BYTES(): number {
  // Default eval output cap (kept consistent with infra/limits but defined locally to avoid a cycle).
  return 50_000;
}

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES };
