# Changelog

All notable public changes to Cynos Tools are documented here.

## 0.3.0

- Make `playwright-core` an optional peer and lazy-load browser support so ordinary installs stay lightweight.
- Add a Node.js/Pi compatibility matrix and scheduled/manual compatibility workflow.
- Verify core activation succeeds when the optional browser runtime is not installed.

## 0.2.3

- Derive the activation runtime package version from `package.json` instead of a stale hardcoded value.
- Verify the exported runtime version in unit tests and the built-artifact smoke test.

## 0.2.2

- Document Node.js and pi prerequisites.
- Link public maintenance and security documentation from the README.

## 0.2.1

- Point npm homepage metadata to the public GitHub README.

## 0.2.0

- Publish the source repository under the MIT License.
- Publish a readable, reproducible esbuild bundle.
- Add public security, contribution, and third-party notice documentation.
