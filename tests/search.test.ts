import { describe, expect, it } from "vitest";
import {
  clampNumber,
  isAllowedWebUrl,
  normalizeProvider,
  normalizeQuery,
  normalizeUrls,
} from "../extensions/search/shared";
import { buildFallbackChain } from "../extensions/search/fallback";
import { parseMcpSearchResults } from "../extensions/search/providers";

describe("search/shared", () => {
  it("isAllowedWebUrl rejects localhost, loopback, and non-http", () => {
    expect(isAllowedWebUrl("http://example.com")).toBe(true);
    expect(isAllowedWebUrl("https://example.com/page")).toBe(true);
    expect(isAllowedWebUrl("localhost:3000")).toBe(false);
    expect(isAllowedWebUrl("http://127.0.0.1:5173")).toBe(false);
    expect(isAllowedWebUrl("http://[::1]/")).toBe(false);
    expect(isAllowedWebUrl("http://dev.local/")).toBe(false);
    expect(isAllowedWebUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedWebUrl("not-a-url")).toBe(false);
  });

  it("normalizeUrls deduplicates and filters non-strings", () => {
    expect(normalizeUrls(["https://a.com", "https://a.com", "https://b.com"])).toEqual(["https://a.com", "https://b.com"]);
    expect(normalizeUrls(["", "   ", 123 as any])).toEqual([]);
    expect(normalizeUrls("not-array" as any)).toEqual([]);
  });

  it("normalizeQuery trims; normalizeProvider only accepts exa/tavily", () => {
    expect(normalizeQuery("  hi  ")).toBe("hi");
    expect(normalizeQuery(undefined)).toBe("");
    expect(normalizeProvider("exa")).toBe("exa");
    expect(normalizeProvider("tavily")).toBe("tavily");
    expect(normalizeProvider("google")).toBeUndefined();
  });

  it("clampNumber clamps to range with fallback", () => {
    expect(clampNumber(3, 5, 1, 10)).toBe(3);
    expect(clampNumber(0, 5, 1, 10)).toBe(1);
    expect(clampNumber(100, 5, 1, 10)).toBe(10);
    expect(clampNumber("abc", 5, 1, 10)).toBe(5);
  });
});

describe("search/fallback", () => {
  it("includes mcp fallback when no keys configured", () => {
    const chain = buildFallbackChain(undefined, undefined, undefined);
    expect(chain).toEqual([{ provider: "exa", mode: "mcp" }]);
  });

  it("prioritizes preferred REST provider then mcp", () => {
    const chain = buildFallbackChain("tavily", "exa-key", "tavily-key");
    expect(chain[0]).toEqual({ provider: "tavily", mode: "rest" });
    expect(chain.some((s) => s.provider === "exa" && s.mode === "rest")).toBe(true);
    expect(chain.some((s) => s.provider === "exa" && s.mode === "mcp")).toBe(true);
  });

  it("dedupes same provider+mode", () => {
    const chain = buildFallbackChain("exa", "exa-key", undefined);
    const exaRest = chain.filter((s) => s.provider === "exa" && s.mode === "rest");
    expect(exaRest).toHaveLength(1);
  });
});

describe("search/providers parsing", () => {
  it("parseMcpSearchResults parses Title/URL blocks", () => {
    const text = [
      "Title: Result One",
      "URL: https://example.com/one",
      "Highlights:",
      "snippet one",
      "",
      "---",
      "Title: Result Two",
      "URL: https://example.com/two",
      "Highlights:",
      "snippet two",
    ].join("\n");
    const res = parseMcpSearchResults("q", text);
    expect(res.results).toHaveLength(2);
    expect(res.results[0].title).toBe("Result One");
    expect(res.results[1].url).toBe("https://example.com/two");
  });
});
