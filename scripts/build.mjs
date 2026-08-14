#!/usr/bin/env node
// Build the published @cynos-ai/tools package.
//
// The source entrypoint is bundled into a readable CommonJS file at the package
// root. Host packages and playwright-core remain external. The published artifact
// is intentionally readable and unminified.
import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryFile = path.join(root, "extensions", "index.ts");
const outFile = path.join(root, "index.js");

const external = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-tui",
  "typebox",
  "typebox/compile",
  "typebox/value",
  // playwright-core ships its own browser-driver code; bundling it would balloon
  // the tarball and duplicate the host dependency. It must stay external.
  "playwright-core",
];

async function main() {
  fs.rmSync(outFile, { force: true });
  console.log("→ esbuild readable bundle → index.js");
  const buildResult = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    outfile: outFile,
    external,
    banner: { js: "" },
    legalComments: "none",
    sourcemap: false,
    treeShaking: true,
    minify: false,
    logLevel: "info",
    metafile: true,
  });

  assertHostPackagesExternal(buildResult.metafile);
  const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`✓ index.js written (${sizeKB} KB, readable bundle)`);
}

function assertHostPackagesExternal(metafile) {
  const output = Object.values(metafile.outputs).find((item) => item.entryPoint);
  const imports = output?.imports ?? [];
  const hostImports = imports.filter(
    (item) =>
      item.path.startsWith("@earendil-works/") ||
      item.path === "typebox" ||
      item.path.startsWith("typebox/") ||
      item.path === "playwright-core" ||
      item.path.startsWith("playwright-core/"),
  );
  const bundledHostImports = hostImports.filter((item) => item.external !== true);
  if (bundledHostImports.length > 0) {
    throw new Error(`Host/package(s) were bundled instead of externalized: ${bundledHostImports.map((item) => item.path).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
