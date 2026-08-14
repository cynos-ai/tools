import * as os from "node:os";
import * as path from "node:path";

// Centralized path management for Tools.
// User-level config: ~/.pi/agent/cynos-tools.json (overridable via CYNOS_HOME for tests).

export function homeDir(): string {
  return process.env.CYNOS_HOME ?? os.homedir();
}

export function userConfigPath(): string {
  return path.join(homeDir(), ".pi", "agent", "cynos-tools.json");
}

// Legacy engineer config — read-only, used as a migration source only.
export function legacyCynosConfigPath(): string {
  return path.join(homeDir(), ".pi", "agent", "cynos-config.json");
}
