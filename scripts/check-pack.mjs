#!/usr/bin/env node
// Verify the npm tarball contents without creating a package file.
import { execFileSync } from "node:child_process";

const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

const pack = parsePackJson(output);
const files = new Set((pack.files ?? []).map((file) => file.path));

const required = [
  "index.js",
  "index.d.ts",
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
];

const missing = required.filter((file) => !files.has(file));
if (missing.length > 0) {
  console.error(`npm package is missing required file(s): ${missing.join(", ")}`);
  process.exit(1);
}

const forbiddenPrefixes = ["extensions/", "scripts/", "tests/", ".github/"];
const forbidden = [...files].filter((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
if (forbidden.length > 0) {
  console.error(`npm package includes source/internal file(s): ${forbidden.slice(0, 20).join(", ")}`);
  if (forbidden.length > 20) console.error(`...and ${forbidden.length - 20} more`);
  process.exit(1);
}

// playwright-core must be in node_modules (runtime dep), but its browser binaries
// must NOT be in the tarball.
const browserBinary = [...files].find((file) => /(^|\/)\.local-browsers\//.test(file) || /chromium-[0-9]/.test(file));
if (browserBinary) {
  console.error(`npm package includes a browser binary, which must not ship: ${browserBinary}`);
  process.exit(1);
}

console.log(`✓ npm package dry-run OK (${files.size} files, includes index.js + index.d.ts)`);

function parsePackJson(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed[0] : parsed;
    }
    throw new Error(`Unable to parse npm pack --json output:\n${text}`);
  }
}
