// Provider fallback chain: preferred REST -> remaining configured REST -> Exa MCP.

import { exaMcpFetch, exaMcpSearch, exaRestFetch, exaRestSearch, tavilyFetch, tavilySearch } from "./providers";
import type { FetchResponse, ProviderKeys, ProviderStep, RestProvider, SearchResponse } from "./shared";

function stepKey(step: ProviderStep): string {
  return `${step.provider}:${step.mode}`;
}
function stepLabel(step: ProviderStep): string {
  return `${step.provider}(${step.mode})`;
}

function getConfiguredRestSteps(keys: ProviderKeys): ProviderStep[] {
  const steps: ProviderStep[] = [];
  if (keys.exaKey) steps.push({ provider: "exa", mode: "rest" });
  if (keys.tavilyKey) steps.push({ provider: "tavily", mode: "rest" });
  return steps;
}

export function buildFallbackChain(preferred: RestProvider | undefined, exaKey: string | undefined, tavilyKey: string | undefined): ProviderStep[] {
  const keys: ProviderKeys = { exaKey, tavilyKey };
  const restSteps = getConfiguredRestSteps(keys);
  const chain: ProviderStep[] = [];

  if (preferred) {
    const preferredIndex = restSteps.findIndex((step) => step.provider === preferred);
    if (preferredIndex >= 0) {
      chain.push(restSteps.splice(preferredIndex, 1)[0]);
    }
  }
  chain.push(...restSteps);
  chain.push({ provider: "exa", mode: "mcp" }); // free fallback, no API key required

  const seen = new Set<string>();
  return chain.filter((step) => {
    const key = stepKey(step);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatFallbackError(kind: "search" | "fetch", errors: { step: ProviderStep; error: string }[]): Error {
  return new Error(
    `All ${kind} providers failed:\n${errors.map((item) => `  - ${stepLabel(item.step)}: ${item.error}`).join("\n")}\n\n` +
      "Configure an API key in ~/.pi/agent/cynos-tools.json (or run /cynos-tools-config):\n" +
      '  { "exaApiKey": "..." } or { "tavilyApiKey": "..." }',
  );
}

async function runSearchStep(step: ProviderStep, keys: ProviderKeys, query: string, numResults: number, signal?: AbortSignal): Promise<SearchResponse> {
  if (step.provider === "exa" && step.mode === "rest" && keys.exaKey) return exaRestSearch(keys.exaKey, query, numResults, signal);
  if (step.provider === "tavily" && step.mode === "rest" && keys.tavilyKey) return tavilySearch(keys.tavilyKey, query, numResults, signal);
  if (step.provider === "exa" && step.mode === "mcp") return exaMcpSearch(query, numResults, signal);
  throw new Error(`Provider step is not available: ${stepLabel(step)}`);
}

async function runFetchStep(step: ProviderStep, keys: ProviderKeys, urls: string[], maxChars: number, signal?: AbortSignal): Promise<FetchResponse[]> {
  if (step.provider === "exa" && step.mode === "rest" && keys.exaKey) return exaRestFetch(keys.exaKey, urls, maxChars, signal);
  if (step.provider === "tavily" && step.mode === "rest" && keys.tavilyKey) return tavilyFetch(keys.tavilyKey, urls, maxChars, signal);
  if (step.provider === "exa" && step.mode === "mcp") return exaMcpFetch(urls, maxChars, signal);
  throw new Error(`Provider step is not available: ${stepLabel(step)}`);
}

export async function doSearchWithFallback(
  chain: ProviderStep[],
  keys: ProviderKeys,
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<{ response: SearchResponse; usedProvider: RestProvider; usedMode: "rest" | "mcp" }> {
  const errors: { step: ProviderStep; error: string }[] = [];
  for (const step of chain) {
    try {
      const response = await runSearchStep(step, keys, query, numResults, signal);
      return { response, usedProvider: step.provider, usedMode: step.mode };
    } catch (error) {
      errors.push({ step, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw formatFallbackError("search", errors);
}

export async function doFetchWithFallback(
  chain: ProviderStep[],
  keys: ProviderKeys,
  urls: string[],
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ responses: FetchResponse[]; usedProvider: RestProvider; usedMode: "rest" | "mcp" }> {
  const errors: { step: ProviderStep; error: string }[] = [];
  for (const step of chain) {
    try {
      const responses = await runFetchStep(step, keys, urls, maxChars, signal);
      return { responses, usedProvider: step.provider, usedMode: step.mode };
    } catch (error) {
      errors.push({ step, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw formatFallbackError("fetch", errors);
}
