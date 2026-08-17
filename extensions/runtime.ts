import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json";

// ============================================================
// Process-level activation registry for @cynos-ai/tools.
//
// Problem: when both user-global Tools and Engineer-bundled Tools exist in the
// same pi runtime, they come from two independent npm module roots, so Node's
// module cache does not dedupe them. Without an explicit registry, each copy
// would register the same tools/commands twice, producing /cynos-tools-config:1
// and :2 suffixes and double-firing hooks.
//
// Solution: store an ActivationRecord per ExtensionAPI instance on a Symbol-keyed
// globalThis slot. Same pi instance => no-op on second call. A new pi instance
// (e.g. after /reload) gets its own record and can re-register cleanly.
//
// A protocol version guards against incompatible bundled copies coexisting.
// ============================================================

export const CYNOS_TOOLS_PROTOCOL_VERSION = 1;
// Keep the activation record aligned with the package that owns the bundle.
// This value is inlined by esbuild, so package.json is not required at runtime.
export const CYNOS_TOOLS_PACKAGE_VERSION = packageJson.version;

export interface ActivationRecord {
  protocolVersion: number;
  packageVersion: string;
  activatedAt: number;
}

const REGISTRY_KEY = Symbol.for("@cynos-ai/tools/runtime");

interface GlobalShape {
  [REGISTRY_KEY]?: WeakMap<object, ActivationRecord>;
}

function getRegistry(): WeakMap<object, ActivationRecord> {
  const globalAny = globalThis as unknown as GlobalShape;
  if (!globalAny[REGISTRY_KEY]) {
    globalAny[REGISTRY_KEY] = new WeakMap();
  }
  return globalAny[REGISTRY_KEY]!;
}

export type ActivationOutcome = "registered" | "already-registered" | "protocol-conflict";

export interface ActivationResult {
  outcome: ActivationOutcome;
  record: ActivationRecord;
}

// Mark a pi instance as activated. Returns:
//   - "already-registered" if this exact pi instance already has a compatible record (no-op).
//   - "protocol-conflict" if this exact pi instance was previously activated with an
//     incompatible protocol version (caller must throw, since a pi instance cannot
//     host two incompatible Tools copies).
//   - "registered" otherwise.
export function markActivated(pi: ExtensionAPI, protocolVersion: number = CYNOS_TOOLS_PROTOCOL_VERSION, packageVersion: string = CYNOS_TOOLS_PACKAGE_VERSION): ActivationResult {
  const registry = getRegistry();
  const existing = registry.get(pi);
  const record: ActivationRecord = { protocolVersion, packageVersion, activatedAt: Date.now() };
  if (existing) {
    if (existing.protocolVersion !== protocolVersion) {
      return { outcome: "protocol-conflict", record: existing };
    }
    return { outcome: "already-registered", record: existing };
  }
  registry.set(pi, record);
  return { outcome: "registered", record };
}

export function isActivated(pi: ExtensionAPI): boolean {
  return getRegistry().has(pi);
}

export function getActivationRecord(pi: ExtensionAPI): ActivationRecord | undefined {
  return getRegistry().get(pi);
}

export function formatProtocolConflictError(existing: ActivationRecord, requested: number): Error {
  return new Error(
    `@cynos-ai/tools protocol conflict: this pi instance already loaded Tools protocol v${existing.protocolVersion}` +
      ` (package ${existing.packageVersion}), but a different copy requested protocol v${requested}.` +
      ` Two incompatible @cynos-ai/tools versions are installed in the same pi runtime.` +
      ` Keep only one (recommend the newer one), then restart pi.`,
  );
}

// Neutral child-process role. The activation layer uses this to decide what to
// register when running inside a sub-process spawned by another Cynos product.
//
//   undefined  -> main profile (everything)
//   researcher -> search/fetch only (used by Engineer's researcher subagent)
//   vision-child -> nothing (used by cynos_vision's own child to avoid recursion)
//   any other  -> nothing (subagent tool whitelist still applies)
export type ChildAgentRole = "researcher" | "vision-child" | string;

export function getChildAgentRole(): ChildAgentRole | undefined {
  const value = process.env.CYNOS_AGENT_ROLE;
  return value && value.trim() ? value.trim() : undefined;
}

export function isMainProfile(): boolean {
  return !getChildAgentRole();
}

export function isResearcherChild(): boolean {
  return getChildAgentRole() === "researcher";
}

export function isVisionChild(): boolean {
  return getChildAgentRole() === "vision-child";
}
