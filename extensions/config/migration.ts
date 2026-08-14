import { readJsonFileOptional, writeJsonAtomicIfAbsent } from "../infra/fs-utils";
import { legacyCynosConfigPath, userConfigPath } from "./paths";
import type { ToolsConfig } from "./store";

// Idempotent one-way migration from the legacy ~/.pi/agent/cynos-config.json
// (which Engineer used to own) into the new ~/.pi/agent/cynos-tools.json.
//
// Rules (per the implementation plan §3.2):
//   - Only runs when the new file does NOT already exist.
//   - Copies only Tools-owned fields: visionModel, exaApiKey, tavilyApiKey.
//   - Legacy file is never modified or deleted.
//   - New file already existing => no-op (never overwrite).
//   - Sensitive file written with 0600.

const LEGACY_TOOLS_FIELDS = ["visionModel", "exaApiKey", "tavilyApiKey"] as const;

export interface MigrationResult {
  migrated: boolean;
  source: "none" | "legacy-empty" | "legacy";
  fieldsCopied: ReadonlyArray<(typeof LEGACY_TOOLS_FIELDS)[number]>;
}

export async function migrateFromLegacyConfig(): Promise<MigrationResult> {
  const target = userConfigPath();
  // Cheap existence check first to avoid touching disk on the hot path.
  const existing = await readJsonFileOptional<ToolsConfig>(target);
  if (existing) {
    return { migrated: false, source: "none", fieldsCopied: [] };
  }

  const legacy = await readJsonFileOptional<Record<string, unknown>>(legacyCynosConfigPath());
  if (!legacy) {
    return { migrated: false, source: "legacy-empty", fieldsCopied: [] };
  }

  const copied: string[] = [];
  const migrated: ToolsConfig = { schemaVersion: 1 };
  const migratedRecord = migrated as unknown as Record<string, unknown>;
  for (const field of LEGACY_TOOLS_FIELDS) {
    const value = legacy[field];
    if (typeof value === "string" && value.trim()) {
      migratedRecord[field] = value;
      copied.push(field);
    }
  }

  if (copied.length === 0) {
    return { migrated: false, source: "legacy-empty", fieldsCopied: [] };
  }

  // Hard-link semantics: if another process created the target between our check and
  // write, do NOT overwrite. preserveDefaults ensures the first writer wins.
  await writeJsonAtomicIfAbsent(target, migrated, { mode: 0o600 });
  return { migrated: true, source: "legacy", fieldsCopied: copied as MigrationResult["fieldsCopied"] };
}
