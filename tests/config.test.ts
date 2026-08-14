import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeUserConfig } from "../extensions/config/store";
import { migrateFromLegacyConfig } from "../extensions/config/migration";
import { legacyCynosConfigPath, userConfigPath } from "../extensions/config/paths";

let homeTmp = "";
let prevHome = "";

beforeEach(async () => {
  homeTmp = await fs.mkdtemp(path.join(os.tmpdir(), "cynos-tools-home-"));
  prevHome = process.env.CYNOS_HOME ?? "";
  process.env.CYNOS_HOME = homeTmp;
});

afterEach(async () => {
  if (prevHome) process.env.CYNOS_HOME = prevHome;
  else delete process.env.CYNOS_HOME;
  await fs.rm(homeTmp, { recursive: true, force: true }).catch(() => undefined);
});

async function writeLegacy(obj: Record<string, unknown>): Promise<void> {
  const p = legacyCynosConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj), "utf8");
}

describe("config store", () => {
  it("returns schemaVersion 1 default when file missing", async () => {
    const cfg = await readConfig();
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.exaApiKey).toBeUndefined();
  });

  it("writeUserConfig writes 0600 and reads back", async () => {
    await writeUserConfig({ schemaVersion: 1, exaApiKey: "<EXA_API_KEY>", visionModel: "anthropic/claude-3" });
    const cfg = await readConfig();
    expect(cfg.exaApiKey).toBe("<EXA_API_KEY>");
    expect(cfg.visionModel).toBe("anthropic/claude-3");
    const stat = await fs.stat(userConfigPath());
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("legacy migration", () => {
  it("migrates tools-owned fields from legacy cynos-config.json", async () => {
    await writeLegacy({
      schemaVersion: 1,
      visionModel: "anthropic/claude-3",
      exaApiKey: "exa-legacy",
      tavilyApiKey: "tavily-legacy",
      language: "zh",
      onboardMode: "human-assisted",
    });
    const result = await migrateFromLegacyConfig();
    expect(result.migrated).toBe(true);
    expect([...result.fieldsCopied].sort()).toEqual(["exaApiKey", "tavilyApiKey", "visionModel"]);
    const cfg = await readConfig();
    expect(cfg.visionModel).toBe("anthropic/claude-3");
    expect(cfg.exaApiKey).toBe("exa-legacy");
    expect(cfg.tavilyApiKey).toBe("tavily-legacy");
    // Engineer-owned fields are NOT migrated.
    expect((cfg as any).language).toBeUndefined();
    expect((cfg as any).onboardMode).toBeUndefined();
  });

  it("is idempotent: second run is a no-op", async () => {
    await writeLegacy({ visionModel: "anthropic/claude-3", exaApiKey: "exa-legacy" });
    const first = await migrateFromLegacyConfig();
    expect(first.migrated).toBe(true);
    // Mutate the target file to simulate post-migration user changes.
    await writeUserConfig({ schemaVersion: 1, visionModel: "user/changed-model" });
    const second = await migrateFromLegacyConfig();
    expect(second.migrated).toBe(false);
    const cfg = await readConfig();
    expect(cfg.visionModel).toBe("user/changed-model");
  });

  it("does nothing when legacy file is absent", async () => {
    const result = await migrateFromLegacyConfig();
    expect(result.migrated).toBe(false);
    expect(result.source).toBe("legacy-empty");
  });

  it("does nothing when legacy file has no tools-owned fields", async () => {
    await writeLegacy({ schemaVersion: 1, language: "zh", onboardMode: "auto" });
    const result = await migrateFromLegacyConfig();
    expect(result.migrated).toBe(false);
    expect(result.fieldsCopied).toEqual([]);
  });

  it("never deletes or modifies the legacy file", async () => {
    await writeLegacy({ visionModel: "anthropic/claude-3", exaApiKey: "exa-legacy" });
    const before = await fs.readFile(legacyCynosConfigPath(), "utf8");
    await migrateFromLegacyConfig();
    const after = await fs.readFile(legacyCynosConfigPath(), "utf8");
    expect(after).toBe(before);
  });
});
