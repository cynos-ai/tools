import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import {
  activateCynosTools,
  CYNOS_TOOLS_PACKAGE_VERSION,
  CYNOS_TOOLS_PROTOCOL_VERSION,
} from "../extensions";
import {
  formatProtocolConflictError,
  getActivationRecord,
  isActivated,
  markActivated,
  type ActivationRecord,
} from "../extensions/runtime";

function fakePi(): any {
  return { _id: Math.random(), registerTool() {}, registerCommand() {}, on() {} };
}

function resetRegistry() {
  // Tests share the globalThis registry; clear between cases where we want fresh state.
  const key = Symbol.for("@cynos-ai/tools/runtime");
  (globalThis as any)[key] = undefined;
}

describe("markActivated dedup", () => {
  it("registers on first call, no-ops on second call for the same pi", () => {
    resetRegistry();
    const pi = fakePi();
    const r1 = markActivated(pi, 1, "0.1.0");
    expect(r1.outcome).toBe("registered");
    const r2 = markActivated(pi, 1, "0.1.0");
    expect(r2.outcome).toBe("already-registered");
    expect(isActivated(pi)).toBe(true);
    const rec = getActivationRecord(pi);
    expect(rec?.protocolVersion).toBe(1);
  });

  it("treats different pi instances independently (reload scenario)", () => {
    resetRegistry();
    const pi1 = fakePi();
    const pi2 = fakePi();
    expect(markActivated(pi1).outcome).toBe("registered");
    expect(markActivated(pi2).outcome).toBe("registered");
    expect(isActivated(pi1)).toBe(true);
    expect(isActivated(pi2)).toBe(true);
  });

  it("reports protocol conflict when the same pi was activated with a different version", () => {
    resetRegistry();
    const pi = fakePi();
    markActivated(pi, 1, "0.1.0");
    const r = markActivated(pi, 2, "0.2.0");
    expect(r.outcome).toBe("protocol-conflict");
    expect((r.record as ActivationRecord).protocolVersion).toBe(1);
    const err = formatProtocolConflictError(r.record as ActivationRecord, 2);
    expect(err.message).toContain("protocol conflict");
    expect(err.message).toContain("v1");
    expect(err.message).toContain("v2");
  });
});

describe("activateCynosTools roles", () => {
  it("main profile registers search+fetch+vision+browser and both commands", async () => {
    resetRegistry();
    delete process.env.CYNOS_AGENT_ROLE;
    const tools: string[] = [];
    const cmds: string[] = [];
    const hooks: string[] = [];
    const pi = {
      ...fakePi(),
      registerTool(t: any) { tools.push(t.name); },
      registerCommand(n: string) { cmds.push(n); },
      on(ev: string) { hooks.push(ev); },
    };
    await activateCynosTools(pi);
    for (const t of ["cynos_search", "cynos_fetch", "cynos_vision", "cynos_browser_navigate", "cynos_browser_interact", "cynos_browser_inspect", "cynos_browser_close"]) {
      expect(tools).toContain(t);
    }
    expect(cmds).toEqual(expect.arrayContaining(["cynos-tools-config", "cynos-tools-browser-setup"]));
  });

  it("is idempotent on the same pi (no duplicate registrations)", async () => {
    resetRegistry();
    delete process.env.CYNOS_AGENT_ROLE;
    const tools: string[] = [];
    const pi = {
      ...fakePi(),
      registerTool(t: any) { tools.push(t.name); },
      registerCommand(n: string) { (pi as any)._cmds = ((pi as any)._cmds ?? []); (pi as any)._cmds.push(n); },
      on() {},
    };
    await activateCynosTools(pi);
    await activateCynosTools(pi);
    const searchCount = tools.filter((n) => n === "cynos_search").length;
    expect(searchCount).toBe(1);
  });

  it("researcher role registers only search/fetch and no commands", async () => {
    resetRegistry();
    process.env.CYNOS_AGENT_ROLE = "researcher";
    try {
      const tools: string[] = [];
      const cmds: string[] = [];
      const pi = {
        ...fakePi(),
        registerTool(t: any) { tools.push(t.name); },
        registerCommand(n: string) { cmds.push(n); },
        on() {},
      };
      await activateCynosTools(pi);
      expect(tools.sort()).toEqual(["cynos_fetch", "cynos_search"]);
      expect(cmds).toHaveLength(0);
    } finally {
      delete process.env.CYNOS_AGENT_ROLE;
    }
  });

  it("vision-child role registers nothing", async () => {
    resetRegistry();
    process.env.CYNOS_AGENT_ROLE = "vision-child";
    try {
      const tools: string[] = [];
      const pi = {
        ...fakePi(),
        registerTool(t: any) { tools.push(t.name); },
        registerCommand() {},
        on() {},
      };
      await activateCynosTools(pi);
      expect(tools).toHaveLength(0);
    } finally {
      delete process.env.CYNOS_AGENT_ROLE;
    }
  });

  it("other roles (e.g. reviewer) register nothing", async () => {
    resetRegistry();
    process.env.CYNOS_AGENT_ROLE = "reviewer";
    try {
      const tools: string[] = [];
      const pi = {
        ...fakePi(),
        registerTool(t: any) { tools.push(t.name); },
        registerCommand() {},
        on() {},
      };
      await activateCynosTools(pi);
      expect(tools).toHaveLength(0);
    } finally {
      delete process.env.CYNOS_AGENT_ROLE;
    }
  });
});

describe("activateCynosTools cross-extension coexistence", () => {
  it("defers (registers nothing) when another copy already registered cynos_search", async () => {
    resetRegistry();
    delete process.env.CYNOS_AGENT_ROLE;
    const tools: string[] = [];
    const cmds: string[] = [];
    const pi = {
      ...fakePi(),
      registerTool(t: any) { tools.push(t.name); },
      registerCommand(n: string) { cmds.push(n); },
      on() {},
      // Simulate an earlier-loading @cynos-ai/tools copy that already registered.
      getAllTools() { return [{ name: "cynos_search" }, { name: "cynos_fetch" }]; },
    };
    await activateCynosTools(pi);
    expect(tools).toEqual([]);
    expect(cmds).toEqual([]);
  });

  it("registers normally when getAllTools shows no cynos tools (fresh session)", async () => {
    resetRegistry();
    delete process.env.CYNOS_AGENT_ROLE;
    const tools: string[] = [];
    const pi = {
      ...fakePi(),
      registerTool(t: any) { tools.push(t.name); },
      registerCommand() {},
      on() {},
      getAllTools() { return [{ name: "read" }, { name: "bash" }]; },
    };
    await activateCynosTools(pi);
    expect(tools).toContain("cynos_search");
    expect(tools).toContain("cynos_browser_close");
  });

  it("registers normally when getAllTools is unavailable (older pi / no signal)", async () => {
    resetRegistry();
    delete process.env.CYNOS_AGENT_ROLE;
    const tools: string[] = [];
    const pi = {
      ...fakePi(),
      registerTool(t: any) { tools.push(t.name); },
      registerCommand() {},
      on() {},
      // No getAllTools method at all.
    };
    await activateCynosTools(pi);
    expect(tools).toContain("cynos_search");
  });

  it("registers normally when getAllTools throws (runtime not yet active)", async () => {
    resetRegistry();
    delete process.env.CYNOS_AGENT_ROLE;
    const tools: string[] = [];
    const pi = {
      ...fakePi(),
      registerTool(t: any) { tools.push(t.name); },
      registerCommand() {},
      on() {},
      getAllTools() { throw new Error("runtime not active"); },
    };
    await activateCynosTools(pi);
    expect(tools).toContain("cynos_search");
  });
});

describe("runtime versions", () => {
  it("exports the protocol version", () => {
    expect(CYNOS_TOOLS_PROTOCOL_VERSION).toBe(1);
  });

  it("uses the package.json version in activation records", () => {
    resetRegistry();
    expect(CYNOS_TOOLS_PACKAGE_VERSION).toBe(packageJson.version);
    expect(markActivated(fakePi()).record.packageVersion).toBe(packageJson.version);
  });
});
