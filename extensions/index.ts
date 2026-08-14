import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CYNOS_TOOLS_PACKAGE_VERSION,
  CYNOS_TOOLS_PROTOCOL_VERSION,
  formatProtocolConflictError,
  isResearcherChild,
  isVisionChild,
  markActivated,
  type ActivationResult,
} from "./runtime";
import { ensureUserConfig } from "./config/store";
import { migrateFromLegacyConfig } from "./config/migration";
import { registerToolsConfigCommand } from "./config/command";
import { registerSearchTools } from "./search";
import { registerVisionGuard, registerVisionTool } from "./vision";
import { registerBrowserTools } from "./browser";
import { registerBrowserShutdown } from "./browser/launch";
import { registerBrowserSetupCommand } from "./browser/setup-command";

// ============================================================
// activateCynosTools — the single programmatic entry point.
//
// Both the default pi extension export and Engineer's bundled call site use this.
// Dedup is per-pi-instance: see runtime.ts. A protocol conflict on the same pi
// instance throws a clear error so two incompatible Tools copies cannot coexist.
//
// Cross-extension coexistence: when a user has @cynos-ai/tools installed BOTH
// globally (user-scope package) AND via a project engineer that bundles its own
// tools copy, pi loads two separate extensions. Each receives its own ExtensionAPI
// bound to its own tools map (loader.js createExtensionAPI), so the WeakMap-keyed
// dedup below — which keys on the `pi` object — cannot detect the duplicate, and
// pi's detectExtensionConflicts then hard-fails on boot. The reliable cross-
// extension signal is `pi.getAllTools()`, which reads the SHARED runtime and thus
// aggregates tools across ALL extensions. If cynos_search is already registered
// by an earlier-loading extension, this copy defers (no-op). pi loads project-
// scope packages before user-scope (package-manager.js), so the project copy
// (engineer-bundled) registers first and the global copy defers — deterministic.
//
// Child-process role (CYNOS_AGENT_ROLE) controls what registers:
//   undefined      -> main profile (everything)
//   "researcher"   -> search/fetch only
//   "vision-child" -> nothing (prevents recursion)
//   anything else  -> nothing
// ============================================================

/**
 * Cross-extension coexistence guard. Returns true if another @cynos-ai/tools
 * copy has already registered the cynos tools in this pi session (visible via
 * the shared runtime's tool registry). The caller must then defer (no-op) to
 * avoid pi's tool-name conflict detection firing on boot.
 */
function hasCynosToolsAlreadyRegistered(pi: ExtensionAPI): boolean {
  // `cynos_search` is the canonical canary: every non-vision-child profile
  // (main + researcher) registers it, so its presence proves another copy won.
  const getAll = (pi as unknown as { getAllTools?: () => unknown }).getAllTools;
  if (typeof getAll !== "function") return false;
  try {
    const tools = getAll();
    if (!Array.isArray(tools)) return false;
    return tools.some(
      (t) => t != null && typeof (t as { name?: unknown }).name === "string" &&
        (t as { name: string }).name === "cynos_search",
    );
  } catch {
    // getAllTools() calls runtime.assertActive(); if the runtime is in a state
    // where that throws, we cannot determine coexistence — proceed to register.
    return false;
  }
}

export function activateCynosTools(pi: ExtensionAPI): Promise<void> | void {
  // Cross-extension coexistence: defer if an earlier-loading copy already won.
  // See the header comment for why the WeakMap dedup alone is insufficient.
  if (hasCynosToolsAlreadyRegistered(pi)) return;

  const activation: ActivationResult = markActivated(pi);
  if (activation.outcome === "already-registered") return;
  if (activation.outcome === "protocol-conflict") {
    throw formatProtocolConflictError(activation.record, CYNOS_TOOLS_PROTOCOL_VERSION);
  }

  // First activation on this pi instance: init config + migrate.
  // These are best-effort and must never block startup on failure.
  const initPromise = (async () => {
    try {
      await migrateFromLegacyConfig();
    } catch { /* ignore: migration is best-effort */ }
    try {
      await ensureUserConfig();
    } catch { /* ignore: config init failure should not break the extension */ }
  })();

  const roleAction = decideRoleAction();
  if (roleAction === "none") return initPromise;

  // Register shared tools.
  registerSearchTools(pi);

  if (roleAction === "researcher") {
    // Researcher only gets search/fetch. No commands, vision, or browser.
    return initPromise;
  }

  // Main profile: register everything else.
  registerVisionTool(pi);
  registerVisionGuard(pi);
  registerBrowserTools(pi);
  registerBrowserShutdown(pi);
  registerToolsConfigCommand(pi);
  registerBrowserSetupCommand(pi);

  return initPromise;
}

type RoleAction = "none" | "researcher" | "main";

function decideRoleAction(): RoleAction {
  if (isVisionChild()) return "none";
  if (isResearcherChild()) return "researcher";
  // Any other explicit role (e.g. engineer subagents) -> no Tools registration;
  // their `--tools` whitelist still controls what they can call.
  const role = process.env.CYNOS_AGENT_ROLE;
  if (role && role.trim()) return "none";
  return "main";
}

export { CYNOS_TOOLS_PROTOCOL_VERSION, CYNOS_TOOLS_PACKAGE_VERSION };

export default activateCynosTools;
