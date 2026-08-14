// cynos_search and cynos_fetch tool registration.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../infra/output";
import { resolveProviderKeys } from "../config/store";
import { buildFallbackChain, doFetchWithFallback, doSearchWithFallback } from "./fallback";
import { formatFetchResults, formatSearchResults, spillToTempFile } from "./format";
import { renderFetchCall, renderFetchResult, renderSearchCall, renderSearchResult } from "./render";
import {
  clampNumber,
  DEFAULT_FETCH_MAX_CHARS,
  DEFAULT_NUM_RESULTS,
  isAllowedWebUrl,
  isSearchAllowedForCurrentAgent,
  MAX_FETCH_MAX_CHARS,
  MAX_FETCH_URLS,
  MAX_NUM_RESULTS,
  MIN_FETCH_MAX_CHARS,
  normalizeProvider,
  normalizeQuery,
  normalizeUrls,
  type SearchResult,
} from "./shared";

export function registerSearchTools(pi: ExtensionAPI): void {
  // ---- cynos_search ----
  pi.registerTool({
    name: "cynos_search",
    label: "Cynos Search",
    description:
      "Search the web for current information. Returns titles, URLs, and content summaries. Describe the ideal page in natural language rather than using only keywords. " +
      "Supports Exa REST and Tavily REST (API key required); on REST failure or when not configured, falls back to the free Exa MCP.",
    promptSnippet: "Search the web for current documentation, facts, or external references",
    promptGuidelines: [
      "Use cynos_search for external research before asking the user — prefer self-discovery over asking.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query describing the ideal page." },
        numResults: { type: "number", description: "Number of results. Default 5, max 10." },
        provider: { type: "string", enum: ["exa", "tavily"], description: "Preferred REST search provider. Omit to auto-select. Exa MCP is only a fallback." },
      },
      required: ["query"],
      additionalProperties: false,
    } as any,

    execute: async (_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) => {
      if (!isSearchAllowedForCurrentAgent()) {
        return {
          content: [{ type: "text" as const, text: "Search is available to the main agent and the researcher subagent only." }],
          details: {} as any,
        };
      }

      const query = normalizeQuery(params.query);
      if (!query) {
        return {
          content: [{ type: "text" as const, text: "Search query must not be empty." }],
          details: { query: "", resultCount: 0, results: [] },
        };
      }

      const preferred = normalizeProvider(params.provider);
      const numResults = clampNumber(params.numResults, DEFAULT_NUM_RESULTS, 1, MAX_NUM_RESULTS);

      onUpdate?.({
        content: [{ type: "text" as const, text: `Searching: "${query}"...` }],
        details: { query, resultCount: 0, results: [] as SearchResult[] },
      });

      const { exaKey, tavilyKey } = await resolveProviderKeys();
      const keys = { exaKey, tavilyKey };
      const chain = buildFallbackChain(preferred, exaKey, tavilyKey);
      const { response, usedProvider, usedMode } = await doSearchWithFallback(chain, keys, query, numResults, signal);

      if (response.results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for "${query}".` }],
          details: { query, resultCount: 0, results: [] as SearchResult[], provider: usedProvider, mode: usedMode },
        };
      }

      const needsTruncation = usedMode === "mcp";
      return {
        content: [{ type: "text" as const, text: formatSearchResults(response, needsTruncation) }],
        details: { query, resultCount: response.results.length, results: response.results, provider: usedProvider, mode: usedMode },
      };
    },

    renderCall: renderSearchCall as any,
    renderResult: renderSearchResult as any,
  });

  // ---- cynos_fetch ----
  pi.registerTool({
    name: "cynos_fetch",
    label: "Cynos Fetch URL",
    description:
      "Fetch the full content of web pages as clean text. Pass one or more public http/https URLs. " +
      "Use this after cynos_search when you need more detail than a snippet. Supports Exa REST and Tavily REST (API key required); on REST failure, falls back to the Exa MCP.",
    promptSnippet: "Fetch full content of web pages as clean text",
    promptGuidelines: [
      "Use cynos_fetch after cynos_search when snippets are not enough and you need full page content.",
    ],
    parameters: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "Public http/https URLs to fetch." },
        maxCharacters: { type: "number", description: "Maximum characters per page. Default 5000, max 20000." },
        provider: { type: "string", enum: ["exa", "tavily"], description: "Preferred REST fetch provider. Omit to auto-select." },
      },
      required: ["urls"],
      additionalProperties: false,
    } as any,

    execute: async (_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, _ctx: any) => {
      if (!isSearchAllowedForCurrentAgent()) {
        return {
          content: [{ type: "text" as const, text: "Web fetch is available to the main agent and the researcher subagent only." }],
          details: {} as any,
        };
      }

      const urls = normalizeUrls(params.urls);
      if (urls.length === 0) {
        return { content: [{ type: "text" as const, text: "At least one URL is required." }], details: { urls, resultCount: 0, truncated: false } };
      }
      if (urls.length > MAX_FETCH_URLS) {
        return { content: [{ type: "text" as const, text: `Too many URLs. Maximum ${MAX_FETCH_URLS} per call.` }], details: { urls, resultCount: 0, truncated: false } };
      }

      const invalidUrls = urls.filter((url) => !isAllowedWebUrl(url));
      if (invalidUrls.length > 0) {
        return {
          content: [{ type: "text" as const, text: `Invalid or unsupported URLs: ${invalidUrls.join(", ")}. Only public http/https URLs are supported.` }],
          details: { urls, resultCount: 0, truncated: false },
        };
      }

      const preferred = normalizeProvider(params.provider);
      const maxChars = clampNumber(params.maxCharacters, DEFAULT_FETCH_MAX_CHARS, MIN_FETCH_MAX_CHARS, MAX_FETCH_MAX_CHARS);

      onUpdate?.({
        content: [{ type: "text" as const, text: `Fetching: ${urls.join(", ")}...` }],
        details: { urls, resultCount: 0, truncated: false },
      });

      const { exaKey, tavilyKey } = await resolveProviderKeys();
      const keys = { exaKey, tavilyKey };
      const chain = buildFallbackChain(preferred, exaKey, tavilyKey);
      const { responses, usedProvider, usedMode } = await doFetchWithFallback(chain, keys, urls, maxChars, signal);

      const fullText = formatFetchResults(responses, urls);
      const truncation = truncateHead(fullText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

      let output = truncation.content;
      let tempPath: string | undefined;

      if (truncation.truncated) {
        tempPath = await spillToTempFile(fullText);
        const truncatedLines = truncation.totalLines - truncation.outputLines;
        const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
        output +=
          `\n\n[Content truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines ` +
          `(${formatSize(truncation.outputBytes)} / ${formatSize(truncation.totalBytes)}). ` +
          `${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted. ` +
          `Full content saved to: ${tempPath}]`;
      }

      return {
        content: [{ type: "text" as const, text: output }],
        details: {
          urls,
          resultCount: responses.length,
          truncated: truncation.truncated,
          fullOutputPath: tempPath,
          titles: responses.map((r) => r.title).filter(Boolean) as string[],
          provider: usedProvider,
          mode: usedMode,
        },
      };
    },

    renderCall: renderFetchCall as any,
    renderResult: renderFetchResult as any,
  });
}
