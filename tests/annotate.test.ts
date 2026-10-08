import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatAnnotateReport, normalizeAnnotatePayload, normalizeAnnotatePages } from "../extensions/browser/annotate-report";
import { getBrowserConfig, readConfig, writeUserConfig } from "../extensions/config/store";
// vitest supports `?raw` natively; the same import the annotate command uses.
import overlaySource from "../extensions/browser/annotate-overlay.js?raw";

function validNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    n: 1,
    kind: "element",
    selector: "#submit-btn",
    nth: 0,
    tag: "button",
    id: "submit-btn",
    classes: ["btn", "btn-primary"],
    textPreview: "Submit",
    comment: "Make this blue with rounded corners",
    rect: { x: 10, y: 20, width: 120, height: 40, docX: 10, docY: 20 },
    box: { padding: "8 16", border: "1", margin: "0" },
    styles: { display: "flex", backgroundColor: "rgb(59, 130, 246)" },
    attributes: { type: "submit" },
    a11y: { role: "button", name: "Submit", focusable: true },
    ...overrides,
  };
}

describe("annotate/normalizeAnnotatePayload", () => {
  it("round-trips a valid payload", () => {
    const raw = {
      url: "http://localhost:3000/pricing",
      title: "Pricing",
      userAgent: "test-agent",
      viewport: { width: 1440, height: 900 },
      context: "Fix the pricing cards",
      notes: [validNote()],
    };
    const { payload, droppedNotes } = normalizeAnnotatePayload(raw);
    expect(droppedNotes).toBe(0);
    expect(payload.url).toBe("http://localhost:3000/pricing");
    expect(payload.viewport).toEqual({ width: 1440, height: 900 });
    expect(payload.context).toBe("Fix the pricing cards");
    expect(payload.notes).toHaveLength(1);
    expect(payload.notes[0].selector).toBe("#submit-btn");
    expect(payload.notes[0].comment).toBe("Make this blue with rounded corners");
    expect(payload.notes[0].a11y).toEqual({ role: "button", name: "Submit", focusable: true });
  });

  it("drops malformed notes and counts them", () => {
    const { payload, droppedNotes } = normalizeAnnotatePayload({
      url: "http://localhost:3000",
      notes: [null, "junk", 42, validNote(), { tag: "div" }],
    });
    expect(droppedNotes).toBe(4);
    expect(payload.notes).toHaveLength(1);
  });

  it("keeps region notes located by rectangle, with center element context", () => {
    const { payload, droppedNotes } = normalizeAnnotatePayload({
      url: "http://localhost:3000",
      notes: [
        {
          n: 1,
          kind: "region",
          comment: "间距不对",
          rect: { x: 0, y: 0, width: 200, height: 100, docX: 100, docY: 200, docWidth: 200, docHeight: 100 },
          center: { selector: "#b1", nth: 0, tag: "button", classes: ["btn"], textPreview: "Submit" },
        },
      ],
    });
    expect(droppedNotes).toBe(0);
    expect(payload.notes[0].kind).toBe("region");
    expect(payload.notes[0].selector).toBeUndefined();
    expect(payload.notes[0].rect?.docWidth).toBe(200);
    expect(payload.notes[0].center?.selector).toBe("#b1");
  });

  it("drops region notes without a rectangle", () => {
    const { payload, droppedNotes } = normalizeAnnotatePayload({
      url: "http://localhost:3000",
      notes: [{ n: 1, kind: "region", comment: "no rect" }],
    });
    expect(droppedNotes).toBe(1);
    expect(payload.notes).toHaveLength(0);
  });

  it("caps string fields and long collections", () => {
    const note = validNote({
      comment: "x".repeat(5000),
      classes: Array.from({ length: 30 }, (_, i) => `c${i}`),
      styles: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`prop-${i}`, "v"])),
    });
    const { payload } = normalizeAnnotatePayload({ url: "http://localhost:3000", notes: [note] });
    expect(payload.notes[0].comment).toHaveLength(2000);
    expect(payload.notes[0].classes).toHaveLength(10);
    expect(Object.keys(payload.notes[0].styles ?? "")).toHaveLength(30);
  });

  it("survives non-object input", () => {
    const { payload } = normalizeAnnotatePayload("not an object");
    expect(payload.url).toBe("");
    expect(payload.notes).toHaveLength(0);
  });

  it("marks non-object attribute values as dropped", () => {
    const note = validNote({ attributes: { type: "submit", nested: { deep: true } } });
    const { payload } = normalizeAnnotatePayload({ url: "http://localhost:3000", notes: [note] });
    expect(payload.notes[0].attributes).toEqual({ type: "submit" });
  });

  it("normalizes per-page grouping and flattens notes", () => {
    const { payload, droppedNotes } = normalizeAnnotatePayload({
      url: "http://localhost:3000/page-2",
      title: "Page 2",
      context: "多页批注",
      pages: [
        {
          url: "http://localhost:3000/page-1",
          title: "Page 1",
          notes: [validNote({ n: 1 })],
        },
        {
          url: "http://localhost:3000/page-2",
          title: "Page 2",
          notes: [validNote({ n: 2, selector: "#other", id: "other" }), { junk: true }],
        },
        { notes: [] },
      ],
      notes: [],
    });
    expect(droppedNotes).toBe(1);
    expect(payload.pages).toHaveLength(2);
    expect(payload.pages![0].url).toBe("http://localhost:3000/page-1");
    expect(payload.pages![1].notes).toHaveLength(1);
    expect(payload.notes).toHaveLength(2);
    expect(payload.notes[0].n).toBe(1);
    expect(payload.notes[1].n).toBe(2);
  });

  it("synthesizes a single page from flat notes when pages are absent", () => {
    const { payload } = normalizeAnnotatePayload({ url: "http://localhost:3000", notes: [validNote()] });
    expect(payload.pages).toHaveLength(1);
    expect(payload.pages![0].notes[0].selector).toBe("#submit-btn");
  });

  it("normalizes server-side stash arrays defensively", () => {
    const { pages, droppedNotes } = normalizeAnnotatePages([
      { url: "http://localhost:3000/a", title: "A", notes: [validNote({ n: 3 })] },
      null,
      { url: "http://localhost:3000/b", notes: [{ junk: true }] },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0].notes[0].n).toBe(3);
    expect(droppedNotes).toBe(1);
    expect(normalizeAnnotatePages("junk")).toEqual({ pages: [], droppedNotes: 0 });
  });
});

describe("annotate/formatAnnotateReport", () => {
  const evidence = {
    dir: ".cynos/annotate-test",
    viewportScreenshot: ".cynos/annotate-test/viewport-r1.png",
    noteScreenshots: [".cynos/annotate-test/note-1.png"],
  };

  it("renders selectors, comments, a11y, and evidence paths", () => {
    const { payload } = normalizeAnnotatePayload({
      url: "http://localhost:3000",
      title: "Home",
      viewport: { width: 1280, height: 800 },
      context: "Fix spacing",
      notes: [validNote()],
    });
    const report = formatAnnotateReport(payload, evidence);
    expect(report).toContain("## Page Annotation");
    expect(report).toContain("**URL:** http://localhost:3000");
    expect(report).toContain("**Viewport:** 1280×800");
    expect(report).toContain("**Context:** Fix spacing");
    expect(report).toContain("### 1. button#submit-btn.btn.btn-primary");
    expect(report).toContain("- Selector: `#submit-btn`");
    expect(report).toContain('- Comment: Make this blue with rounded corners');
    expect(report).toContain("- Accessibility: role=button, name=Submit, focusable");
    expect(report).toContain(".cynos/annotate-test/note-1.png");
    expect(report).toContain("viewport-r1.png");
  });

  it("renders region notes with document coords and center element", () => {
    const { payload } = normalizeAnnotatePayload({
      url: "http://localhost:3000",
      notes: [
        {
          n: 2,
          kind: "region",
          comment: "这里间距不对",
          rect: { x: 0, y: 0, width: 200, height: 100, docX: 100, docY: 200, docWidth: 200, docHeight: 100 },
          center: { selector: "#b1", nth: 0, tag: "button", classes: [] },
        },
      ],
    });
    const report = formatAnnotateReport(payload, { dir: ".", noteScreenshots: [".cynos/annotate-x/note-2.png"] });
    expect(report).toContain("### 2. Region 200×100 at (100, 200) (document coords)");
    expect(report).toContain("- Element at region center: button `#b1`");
    expect(report).toContain("- Region crop: .cynos/annotate-x/note-2.png");
    expect(report).toContain("- Comment: 这里间距不对");
  });

  it("flags untrusted page-derived data", () => {
    const { payload } = normalizeAnnotatePayload({ url: "http://localhost:3000", notes: [validNote()] });
    expect(formatAnnotateReport(payload, { dir: ".", noteScreenshots: [] })).toContain("untrusted");
  });

  it("renders an empty-notes report", () => {
    const { payload } = normalizeAnnotatePayload({ url: "http://localhost:3000", notes: [] });
    const report = formatAnnotateReport(payload, { dir: ".", noteScreenshots: [] });
    expect(report).toContain("(No element notes were submitted.)");
  });

  it("marks notes whose element was removed from the DOM", () => {
    const { payload } = normalizeAnnotatePayload({ url: "http://localhost:3000", notes: [validNote({ removed: true })] });
    const report = formatAnnotateReport(payload, { dir: ".", noteScreenshots: [undefined] });
    expect(report).toContain("removed from DOM since selection");
    expect(report).toContain("Screenshot: unavailable");
  });

  it("groups notes under page sections in multi-page reports", () => {
    const { payload } = normalizeAnnotatePayload({
      url: "http://localhost:3000/b",
      title: "B",
      context: "ctx",
      pages: [
        { url: "http://localhost:3000/a", title: "A", notes: [validNote({ n: 1 })] },
        { url: "http://localhost:3000/b", title: "B", notes: [validNote({ n: 2, selector: "#b", id: "b" })] },
      ],
      notes: [],
    });
    const report = formatAnnotateReport(payload, { dir: ".", noteScreenshots: [undefined, undefined] });
    expect(report).toContain("(across 2 pages)");
    expect(report).toContain("### Page 1: A");
    expect(report).toContain("### Page 2: B");
    expect(report).toContain("- URL: http://localhost:3000/a");
    expect(report.indexOf("### 1. ")).toBeLessThan(report.indexOf("### 2. "));
  });
});

describe("annotate overlay source", () => {
  it("exposes the expected API surface", () => {
    expect(overlaySource).toContain("window.__cynosAnnotate");
    expect(overlaySource).toContain("install");
    expect(overlaySource).toContain("teardown");
    expect(overlaySource).toContain("state");
    expect(overlaySource).toContain("__cynosAnnotateEvent");
    expect(overlaySource).toContain("cancelled");
    expect(overlaySource).toContain("uiLang");
  });

  it("defaults to the Chinese UI with an English table available", () => {
    expect(overlaySource).toContain("开始标注");
    expect(overlaySource).toContain("一起发送");
    expect(overlaySource).toContain("整体需求");
    expect(overlaySource).toContain("en: {");
  });

  it("evaluates as an IIFE and reinstalls idempotently", () => {
    const code = overlaySource.replace(/^\s*\/\/.*$/gm, "").trimStart();
    expect(code.startsWith("(function")).toBe(true);
    expect(overlaySource).toContain("window.__cynosAnnotate.teardown()");
  });

  it("keeps the overlay alive after submit and supports stash/restore", () => {
    // Submit clears notes but must not tear the overlay down.
    expect(overlaySource).toContain("function resetRound()");
    expect(overlaySource).not.toContain("function finish()");
    // SPA page switching stashes notes; the host can restore them.
    expect(overlaySource).toContain("stashCurrentPage");
    expect(overlaySource).toContain("restoreStash");
    expect(overlaySource).toContain("page-stash");
    // Note creation screenshots via an awaited binding (overlay hides shapes).
    expect(overlaySource).toContain("note-added");
    expect(overlaySource).toContain("captureNoteSnapshot");
  });

  it("supports dragging the panel by its header with a persisted position", () => {
    expect(overlaySource).toContain("makePanelDraggable");
    expect(overlaySource).toContain("setPointerCapture");
    expect(overlaySource).toContain("cynosAnnotatePanelPos");
    expect(overlaySource).toContain("restorePanelPos");
  });
});

describe("annotate config", () => {
  let homeTmp = "";
  let prevHome = "";

  beforeEach(async () => {
    homeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "cynos-tools-annotate-"));
    prevHome = process.env.CYNOS_HOME ?? "";
    process.env.CYNOS_HOME = homeTmp;
  });

  afterEach(async () => {
    if (prevHome) process.env.CYNOS_HOME = prevHome;
    else delete process.env.CYNOS_HOME;
    await fs.rm(homeTmp, { recursive: true, force: true }).catch(() => undefined);
  });

  it("returns annotate defaults when unset", async () => {
    const browser = await getBrowserConfig();
    expect(browser.annotate.timeoutMs).toBe(600_000);
    expect(browser.annotate.screenshots).toBe(true);
    expect(browser.annotate.uiLanguage).toBe("auto");
  });

  it("persists annotate overrides", async () => {
    const config = await readConfig();
    await writeUserConfig({
      ...config,
      browser: { ...config.browser, annotate: { timeoutMs: 60_000, screenshots: false } },
    });
    const browser = await getBrowserConfig();
    expect(browser.annotate.timeoutMs).toBe(60_000);
    expect(browser.annotate.screenshots).toBe(false);
  });
});
