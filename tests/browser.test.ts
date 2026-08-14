import { describe, expect, it } from "vitest";
import { checkBrowserUrl, isSensitiveHeader } from "../extensions/browser/security";
import { resolveTarget, cssEscape, validateActionTarget } from "../extensions/browser/targets";

describe("browser/security checkBrowserUrl", () => {
  it("allows public http/https and localhost dev servers", () => {
    expect(checkBrowserUrl("http://example.com").ok).toBe(true);
    expect(checkBrowserUrl("https://example.com/x").ok).toBe(true);
    expect(checkBrowserUrl("http://localhost:5173").ok).toBe(true);
    expect(checkBrowserUrl("http://127.0.0.1:3000").ok).toBe(true);
    expect(checkBrowserUrl("http://[::1]:8080").ok).toBe(true);
  });

  it("blocks cloud metadata endpoints", () => {
    expect(checkBrowserUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(checkBrowserUrl("http://metadata.google.internal/computeMetadata/v1/").ok).toBe(false);
  });

  it("blocks non-http and dangerous protocols", () => {
    expect(checkBrowserUrl("file:///etc/passwd").ok).toBe(false);
    expect(checkBrowserUrl("data:text/html,<script>").ok).toBe(false);
    expect(checkBrowserUrl("javascript:alert(1)").ok).toBe(false);
    expect(checkBrowserUrl("chrome://settings").ok).toBe(false);
    expect(checkBrowserUrl("devtools://devtools").ok).toBe(false);
    expect(checkBrowserUrl("about:blank").ok).toBe(false);
  });

  it("blocks link-local range", () => {
    expect(checkBrowserUrl("http://169.254.100.5/").ok).toBe(false);
  });

  it("rejects malformed urls", () => {
    expect(checkBrowserUrl("not a url").ok).toBe(false);
  });
});

describe("browser/security isSensitiveHeader", () => {
  it("flags authorization/cookie/api keys", () => {
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("cookie")).toBe(true);
    expect(isSensitiveHeader("set-cookie")).toBe(true);
    expect(isSensitiveHeader("x-api-key")).toBe(true);
    expect(isSensitiveHeader("x-auth-token")).toBe(true);
    expect(isSensitiveHeader("content-type")).toBe(false);
    expect(isSensitiveHeader("accept")).toBe(false);
  });
});

describe("browser/targets resolveTarget precedence", () => {
  const fakePage: any = {
    locator() { return { first: () => "sel-locator" }; },
    getByRole() { return "role-locator"; },
    getByText() { return { first: () => "text-locator" }; },
  };

  it("ref wins over role/selector/text", () => {
    const t = resolveTarget({ target: { ref: "e3", role: "button", selector: "#x", text: "Go" } });
    expect(t?.kind).toBe("ref");
    expect(t?.apply(fakePage as any)).toBe("sel-locator");
  });

  it("role wins over selector and text", () => {
    const t = resolveTarget({ target: { role: "button", name: "Save", selector: "#x", text: "Go" } });
    expect(t?.kind).toBe("role");
    expect(t?.apply(fakePage as any)).toBe("role-locator");
  });

  it("selector wins over text", () => {
    const t = resolveTarget({ target: { selector: "#submit", text: "Go" } });
    expect(t?.kind).toBe("selector");
  });

  it("text is the fallback", () => {
    const t = resolveTarget({ target: { text: "Go" } });
    expect(t?.kind).toBe("text");
  });

  it("returns undefined when no target fields present", () => {
    expect(resolveTarget({ target: {} })).toBeUndefined();
    expect(resolveTarget({})).toBeUndefined();
  });

  it("cssEscape escapes backslash and quote", () => {
    expect(cssEscape('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe("browser/targets validateActionTarget", () => {
  it("requires target for click/fill/select/hover/press", () => {
    expect(validateActionTarget("click", undefined).length).toBeGreaterThan(0);
    expect(validateActionTarget("scroll", undefined)).toHaveLength(0);
    expect(validateActionTarget("wait", undefined)).toHaveLength(0);
  });
});
