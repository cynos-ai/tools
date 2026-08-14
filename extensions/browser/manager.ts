// Browser session manager: maintains an isolated browser/context/page per pi session,
// with in-memory console/network rings and ref maps. No persistent profile, no user cookies.

import type { Browser, BrowserContext, ConsoleMessage, Page, Request, Response } from "playwright-core";
import { BROWSER_CONSOLE_BUFFER, BROWSER_NETWORK_BUFFER } from "../infra/limits";
import { isSensitiveHeader } from "./security";

export interface ConsoleEvent {
  type: string;
  text: string;
  url?: string;
  line?: number;
  at: string;
}

export interface NetworkEvent {
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  fromCache?: boolean;
  failure?: string;
  at: string;
}

export interface ManagedBrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  consoleEvents: ConsoleEvent[];
  networkEvents: NetworkEvent[];
  refs: Map<string, ElementInfo>;
  currentUrl: string;
  currentTitle: string;
}

export interface ElementInfo {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  textPreview?: string;
}

// Static stub used when no real browser is available. Allows tests / setup-probe
// to detect "manager empty" without launching anything.
const EMPTY_SENTINEL: unique symbol = Symbol.for("@cynos-ai/tools/browser-empty");

interface SessionStore {
  session?: ManagedBrowserSession;
  tempDirs: Set<string>;
}

const sessions = new Map<string, SessionStore>();

function sessionKey(cwd: string, sessionId: string | undefined): string {
  return `${cwd}::${sessionId ?? "default"}`;
}

export function getExistingSession(cwd: string, sessionId: string | undefined): ManagedBrowserSession | undefined {
  return sessions.get(sessionKey(cwd, sessionId))?.session;
}

export function getTempDirs(cwd: string, sessionId: string | undefined): Set<string> {
  const key = sessionKey(cwd, sessionId);
  let store = sessions.get(key);
  if (!store) {
    store = { tempDirs: new Set() };
    sessions.set(key, store);
  }
  return store.tempDirs;
}

export function rememberTempDir(cwd: string, sessionId: string | undefined, dir: string): void {
  getTempDirs(cwd, sessionId).add(dir);
}

export function setSession(cwd: string, sessionId: string | undefined, session: ManagedBrowserSession): void {
  const key = sessionKey(cwd, sessionId);
  let store = sessions.get(key);
  if (!store) {
    store = { tempDirs: new Set() };
    sessions.set(key, store);
  }
  store.session = session;
}

export async function closeSession(cwd: string, sessionId: string | undefined): Promise<boolean> {
  const key = sessionKey(cwd, sessionId);
  const store = sessions.get(key);
  if (!store?.session) return false;
  const { session } = store;
  store.session = undefined;
  try { await session.context.close().catch(() => undefined); } catch { /* ignore */ }
  try { await session.browser.close().catch(() => undefined); } catch { /* ignore */ }
  return true;
}

export async function closeAllSessions(): Promise<void> {
  const keys = [...sessions.keys()];
  await Promise.all(keys.map((key) => {
    const [, sessionIdPart] = key.split("::");
    const cwd = key.slice(0, key.length - sessionIdPart.length - 2);
    return closeSession(cwd, sessionIdPart);
  }));
}

// Convert a playwright console message into a sanitized ConsoleEvent.
export function consoleMessageToEvent(msg: ConsoleMessage): ConsoleEvent {
  const loc = msg.location();
  return {
    type: msg.type(),
    text: msg.text().slice(0, 1000),
    url: loc.url,
    line: loc.lineNumber,
    at: new Date().toISOString(),
  };
}

// Convert a request/response into a sanitized NetworkEvent. Bodies and sensitive
// headers are never captured.
export function networkEventFromResponse(response: Response): NetworkEvent {
  const req = response.request();
  return {
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    status: response.status(),
    at: new Date().toISOString(),
  };
}

export function networkEventFromRequestFailure(req: Request): NetworkEvent {
  const failure = req.failure();
  return {
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    failure: failure?.errorText,
    at: new Date().toISOString(),
  };
}

export function pushConsole(events: ConsoleEvent[], event: ConsoleEvent): ConsoleEvent[] {
  events.push(event);
  if (events.length > BROWSER_CONSOLE_BUFFER) events.splice(0, events.length - BROWSER_CONSOLE_BUFFER);
  return events;
}

export function pushNetwork(events: NetworkEvent[], event: NetworkEvent): NetworkEvent[] {
  events.push(event);
  if (events.length > BROWSER_NETWORK_BUFFER) events.splice(0, events.length - BROWSER_NETWORK_BUFFER);
  return events;
}

export function hasSensitiveRequestHeaders(req: Request): boolean {
  return Object.keys(req.headers()).some(isSensitiveHeader);
}

export { EMPTY_SENTINEL };
