#!/usr/bin/env node
// Smoke-test the built readable root index.js without requiring pi's loader.
// Verifies the published CJS artifact exposes activateCynosTools + default export,
// and that child-mode activation registers only the search/fetch subset.
import { createRequire } from "node:module";
import Module from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "index.js");

if (!fs.existsSync(indexPath)) {
  console.error("Built artifact missing: index.js. Run npm run build first.");
  process.exit(1);
}

const piCodingAgentStub = {
  DEFAULT_MAX_BYTES: 80_000,
  DEFAULT_MAX_LINES: 2_000,
  formatSize(value) { return `${value} B`; },
  truncateHead(text, maxLines = 2_000, maxBytes = 80_000) {
    const byBytes = Buffer.byteLength(text, "utf8") > maxBytes ? text.slice(0, maxBytes) : text;
    return { content: byBytes.split(/\r?\n/).slice(0, maxLines).join("\n"), truncated: false, outputLines: 1, totalLines: 1, outputBytes: byBytes.length, totalBytes: byBytes.length };
  },
  truncateTail: (text) => ({ content: text, truncated: false, outputLines: 1, totalLines: 1, outputBytes: text.length, totalBytes: text.length }),
};
const piTuiStub = { Text: (props) => props };
const typeboxStub = {
  Type: new Proxy({}, {
    get(_t, prop) {
      if (prop === "Optional") return (schema) => ({ optional: true, schema });
      if (prop === "Array") return (schema, options) => ({ kind: "Array", schema, options });
      if (prop === "Union") return (schemas, options) => ({ kind: "Union", schemas, options });
      if (prop === "Literal") return (value) => ({ kind: "Literal", value });
      return (...args) => ({ kind: String(prop), args });
    },
  }),
};
// playwright-core is stubbed so the smoke test does not require the real package
// to be importable from a plain Node context.
const playwrightStub = {
  chromium: {
    launch() { throw new Error("no browser in smoke"); },
  },
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cynos-tools-smoke-"));
const prevRole = process.env.CYNOS_AGENT_ROLE;
const prevHome = process.env.CYNOS_HOME;
process.env.CYNOS_HOME = tmpHome;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "@earendil-works/pi-coding-agent") return piCodingAgentStub;
  if (request === "@earendil-works/pi-tui") return piTuiStub;
  if (request === "typebox") return typeboxStub;
  if (request === "typebox/compile") return { TypeCompiler: { Compile: () => ({ Check: () => true, Errors: () => [] }) } };
  if (request === "typebox/value") return { Value: { Check: () => true, Errors: () => [], Parse: (_s, v) => v } };
  if (request === "playwright-core") return playwrightStub;
  return originalLoad.call(this, request, parent, isMain);
};

function makePi() {
  const registeredTools = [];
  const commands = [];
  const hooks = [];
  return {
    registeredTools,
    commands,
    hooks,
    pi: {
      registerTool(tool) { registeredTools.push(tool?.name); },
      registerCommand(name) { commands.push(name); },
      on(event) { hooks.push(event); },
    },
  };
}

try {
  const require = createRequire(import.meta.url);
  const mod = require(indexPath);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (mod?.CYNOS_TOOLS_PACKAGE_VERSION !== packageJson.version) {
    throw new Error(`built runtime version ${mod?.CYNOS_TOOLS_PACKAGE_VERSION ?? "<missing>"} does not match package.json ${packageJson.version}`);
  }
  const activate = mod?.default ?? mod?.activateCynosTools;
  if (typeof activate !== "function") throw new Error("index.js does not expose activateCynosTools / default");

  // Main profile: full tool set.
  const main = makePi();
  await activate(main.pi);

  const expectedMainTools = ["cynos_search", "cynos_fetch", "cynos_vision", "cynos_browser_navigate", "cynos_browser_interact", "cynos_browser_inspect", "cynos_browser_close"];
  for (const name of expectedMainTools) {
    if (!main.registeredTools.includes(name)) throw new Error(`main profile missing tool: ${name}`);
  }
  for (const cmd of ["cynos-tools-config", "cynos-tools-browser-setup"]) {
    if (!main.commands.includes(cmd)) throw new Error(`main profile missing command: ${cmd}`);
  }

  // Idempotency: activate again on the same pi -> no-op (still exactly one of each).
  await activate(main.pi);
  const searchCount = main.registeredTools.filter((n) => n === "cynos_search").length;
  if (searchCount !== 1) throw new Error(`expected cynos_search registered once, got ${searchCount}`);

  // Researcher profile: search/fetch only.
  process.env.CYNOS_AGENT_ROLE = "researcher";
  const researcher = makePi();
  await activate(researcher.pi);
  const unexpected = researcher.registeredTools.filter((n) => n !== "cynos_search" && n !== "cynos_fetch");
  if (unexpected.length > 0) throw new Error(`researcher profile registered unexpected tools: ${unexpected.join(", ")}`);
  if (!researcher.registeredTools.includes("cynos_search") || !researcher.registeredTools.includes("cynos_fetch")) {
    throw new Error("researcher profile must register cynos_search and cynos_fetch");
  }
  if (researcher.commands.length !== 0) throw new Error(`researcher profile must not register commands, got: ${researcher.commands.join(", ")}`);

  // Vision-child profile: nothing.
  process.env.CYNOS_AGENT_ROLE = "vision-child";
  const visionChild = makePi();
  await activate(visionChild.pi);
  if (visionChild.registeredTools.length !== 0) throw new Error(`vision-child must not register tools, got: ${visionChild.registeredTools.join(", ")}`);

  // Fresh pi instance for reload scenario (dedup is per-instance).
  process.env.CYNOS_AGENT_ROLE = "";
  delete process.env.CYNOS_AGENT_ROLE;
  const afterReload = makePi();
  await activate(afterReload.pi);
  if (afterReload.registeredTools.length !== expectedMainTools.length) {
    throw new Error(`new pi instance after reload should re-register all tools (got ${afterReload.registeredTools.length})`);
  }

  console.log(`✓ built index.js smoke OK (main=${main.registeredTools.length} tools/${main.commands.length} cmds; researcher subset verified)`);
} finally {
  Module._load = originalLoad;
  if (prevRole === undefined) delete process.env.CYNOS_AGENT_ROLE;
  else process.env.CYNOS_AGENT_ROLE = prevRole;
  if (prevHome === undefined) delete process.env.CYNOS_HOME;
  else process.env.CYNOS_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
