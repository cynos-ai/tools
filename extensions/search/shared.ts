// Search shared types and utility functions. Adapted from the original Cynos search module.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export interface FetchResponse {
  text: string;
  title?: string;
  contentType?: string;
}

export type RestProvider = "exa" | "tavily";
export type ProviderMode = "rest" | "mcp";

export interface ProviderStep {
  provider: RestProvider;
  mode: ProviderMode;
}

export interface ProviderKeys {
  exaKey?: string;
  tavilyKey?: string;
}

export interface McpContentItem {
  type: string;
  text?: string;
}

export interface McpResponse {
  result?: { content?: McpContentItem[] };
  error?: { code: number; message: string };
}

export {
  MAX_NUM_RESULTS,
  MIN_FETCH_MAX_CHARS,
  MAX_FETCH_MAX_CHARS,
  MAX_FETCH_URLS,
  EXA_SNIPPET_MAX_CHARS,
  MCP_SNIPPET_MAX_CHARS,
  MCP_SEARCH_MAX_TOTAL_CHARS,
} from "../infra/limits";

export const DEFAULT_NUM_RESULTS = 5;
export const DEFAULT_FETCH_MAX_CHARS = 5000;

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function normalizeQuery(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeProvider(value: unknown): RestProvider | undefined {
  if (value === "exa" || value === "tavily") return value;
  return undefined;
}

export function normalizeUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const url = item.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

// Public web URLs only. localhost/loopback/.local are rejected here so search
// providers cannot be used to probe the local network.
// (Browser navigate uses a different allowlist that keeps localhost for dev servers.)
export function isAllowedWebUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // URL.hostname keeps brackets for IPv6 ([::1]); strip them for comparison.
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Search permission boundary: only the main agent and the researcher subagent
// may use search tools. Distinguish main vs child process via CYNOS_AGENT_ROLE.
export function isSearchAllowedForCurrentAgent(): boolean {
  const role = process.env.CYNOS_AGENT_ROLE;
  if (!role) return true; // main process
  return role === "researcher"; // only researcher child process allowed
}
