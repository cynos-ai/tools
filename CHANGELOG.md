# Changelog

All notable public changes to Cynos Tools are documented here.

## 0.4.0

- Add `/annotate` + `cynos_browser_annotate`: Codex-style page annotation in the tools-managed headed browser. The page stays interactive; "开始标注" enters region-drag mode (rectangle + comment, repeat), element mode adds selector context, and the bottom bar's "一起发送" submits all notes at once — regions are cropped from the full-page render at their document coordinates, elements keep selectors/box-model/a11y/styles. Report goes to the conversation as a user message (command) or the tool result (agent-invoked). No browser extension or native-host install required.
- Overlay UI is Chinese by default and follows the system locale; `browser.annotate.uiLanguage` (`zh`/`en`/`auto`) overrides.
- Add `browser.annotate` config (`timeoutMs`, `screenshots`, `uiLanguage`) and `browser.args` (extra Chromium launch flags) with `/cynos-tools-config` menu entries; annotate sessions automatically relaunch headless browsers headed.

## 0.3.1

- Use `cynos_vision` only as a fallback when the active model cannot process images.
- Hide the fallback tool from vision-capable models and direct them to read images natively.

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
