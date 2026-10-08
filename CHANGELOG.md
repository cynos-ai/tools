# Changelog

All notable public changes to Cynos Tools are documented here.

## 0.6.0

- The annotate overlay panel can now be dragged by its header (hide/close buttons stay clickable). The position clamps to the viewport so the header always stays reachable, persists in sessionStorage, and survives page switches / overlay reinstalls.

## 0.5.0

- Fix `/annotate` blocking the TUI input path: the command now returns immediately and the flow runs in the background (status line still shows progress); the report is delivered as a user message when the user submits.
- Annotate sessions are persistent and multi-round: submitting ("一起发送") keeps the overlay installed, and a background watcher forwards every later submit to the conversation as a new user message — no rerun of `/annotate` between rounds. "取消" only clears unsent notes; a new ✕ button removes the overlay for good (auto-removed after 1h idle).
- Notes are screenshotted at creation time (the overlay briefly hides its shapes), so per-note crops always match what the user saw; the stale full-page overview screenshot is gone.
- SPA page switches auto-stash the current page's notes (no stale boxes left behind): stashed pages are listed in the panel, ride along with the next send, and the report groups notes per page. Hard navigations mid-round are survived via a server-side stash restore.
- Routing guarantees: submits always arrive in the pi session that opened the browser window (isolated per session); a second concurrent annotate flow on the same session is rejected with a clear error instead of stealing the first one's submit.

## 0.4.0
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
