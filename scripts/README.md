# Maintenance scripts

- `build.mjs` — creates the readable CommonJS package entrypoint with esbuild.
- `check-pack.mjs` — validates the npm tarball allowlist and browser-binary boundary.
- `smoke-built-index.mjs` — loads the generated entrypoint with host stubs and
  checks the public activation shape.

Invoke scripts through their `package.json` commands so lifecycle behavior stays
consistent.
