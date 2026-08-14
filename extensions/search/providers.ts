// Exa REST, Tavily REST, Exa MCP. Each provider is independently encapsulated;
// failures throw and the fallback chain tries the next provider.

import type { FetchResponse, McpResponse, SearchResponse, SearchResult } from "./shared";
import { EXA_SNIPPET_MAX_CHARS, MCP_SNIPPET_MAX_CHARS } from "./shared";

// ---- Exa REST ----

interface ExaRawResult {
  title?: string;
  url?: string;
  text?: string;
}

export async function exaRestSearch(apiKey: string, query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, numResults, contents: { text: { maxCharacters: EXA_SNIPPET_MAX_CHARS } } }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa REST API error (${res.status}): ${text}`);
  }
  const raw = (await res.json()) as { results?: ExaRawResult[] };
  return {
    query,
    results: (raw.results || []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.text ?? "" })),
  };
}

export async function exaRestFetch(apiKey: string, urls: string[], maxChars: number, signal?: AbortSignal): Promise<FetchResponse[]> {
  const res = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ ids: urls, text: { maxCharacters: maxChars } }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa Contents API error (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { results?: ExaRawResult[] };
  return (data.results || []).map((r) => ({ text: r.text ?? "", title: r.title || undefined, contentType: "text/plain" }));
}

// ---- Tavily REST ----

export async function tavilySearch(apiKey: string, query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: numResults }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily Search API error (${res.status}): ${text}`);
  }
  const raw = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }>; detail?: string };
  if (raw.detail) throw new Error(`Tavily error: ${raw.detail}`);
  return {
    query,
    results: (raw.results || []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" })),
  };
}

export async function tavilyFetch(apiKey: string, urls: string[], maxChars: number, signal?: AbortSignal): Promise<FetchResponse[]> {
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ urls }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily Extract API error (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
  };
  if (data.failed_results?.length) {
    const failed = data.failed_results[0];
    throw new Error(`Tavily extract failed for ${failed.url ?? urls[0]}: ${failed.error ?? "unknown"}`);
  }
  return (data.results || []).map((r) => ({ text: (r.raw_content ?? "").slice(0, maxChars), contentType: "text/plain" }));
}

// ---- Exa MCP (free fallback, no API key required) ----

const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";

export function parseMcpResponseText(text: string): McpResponse {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      return JSON.parse(payload) as McpResponse;
    } catch {
      // ignore malformed SSE lines
    }
  }
  try {
    return JSON.parse(text) as McpResponse;
  } catch {
    return { error: { code: -1, message: `Failed to parse MCP response: ${text.slice(0, 200)}` } };
  }
}

async function mcpCall(endpoint: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<McpResponse> {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal,
  });
  if (!resp.ok) {
    return { error: { code: resp.status, message: `HTTP ${resp.status}: ${await resp.text().catch(() => "")}` } };
  }
  return parseMcpResponseText(await resp.text());
}

export function parseMcpSearchResults(query: string, text: string): SearchResponse {
  const results: SearchResult[] = [];
  const blocks = text.split(/\n---\n/);
  for (const block of blocks) {
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim() ?? "";
    if (!title && !url) continue;
    const highlightMatch = block.match(/Highlights:\n([\s\S]*?)(?:\n\n|Published:|Author:|_meta:|$)/);
    const rawSnippet = highlightMatch?.[1]?.trim() ?? block.slice(0, MCP_SNIPPET_MAX_CHARS).trim();
    const snippet = rawSnippet.length > MCP_SNIPPET_MAX_CHARS ? rawSnippet.slice(0, MCP_SNIPPET_MAX_CHARS) + "..." : rawSnippet;
    results.push({ title, url, snippet });
  }
  return { query, results };
}

export async function exaMcpSearch(query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  const result = await mcpCall(EXA_MCP_ENDPOINT, "tools/call", { name: "web_search_exa", arguments: { query, numResults } }, signal);
  if (result.error) throw new Error(`Exa MCP search error: ${result.error.message}`);
  const content = result.result?.content || [];
  const text = content.filter((item) => item.type === "text" && item.text).map((item) => item.text!).join("\n");
  return parseMcpSearchResults(query, text);
}

export async function exaMcpFetch(urls: string[], maxChars: number, signal?: AbortSignal): Promise<FetchResponse[]> {
  const result = await mcpCall(EXA_MCP_ENDPOINT, "tools/call", { name: "web_fetch_exa", arguments: { urls, maxCharacters: maxChars } }, signal);
  if (result.error) throw new Error(`Exa MCP fetch error: ${result.error.message}`);
  const content = result.result?.content || [];
  return content.filter((item) => item.type === "text" && item.text).map((item) => ({ text: item.text!, contentType: "text/plain" as const }));
}
