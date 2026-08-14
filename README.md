# Cynos Tools

> **Language:** [English](./README.md) · [简体中文](./README-zh-CN.md)

Search, vision, and browser tools for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

[![npm version](https://img.shields.io/npm/v/@cynos-ai/tools.svg)](https://www.npmjs.com/package/@cynos-ai/tools)
[![GitHub release](https://img.shields.io/github/v/release/cynos-ai/tools.svg)](https://github.com/cynos-ai/tools/releases)

## What it gives you

Four capabilities, exposed as pi tools the agent can call directly:

- **Web search** — `cynos_search` finds current documentation and references.
- **Web fetch** — `cynos_fetch` pulls the full text of public pages.
- **Vision** — `cynos_vision` analyzes local image files (screenshots, UI, charts, diagrams) with a vision-capable model.
- **Browser automation** — `cynos_browser_*` drives an isolated browser: navigate, interact, capture snapshot/screenshot/console/network evidence, and close.

Install once at the user level and every project gets these tools.

## Install

```bash
pi install npm:@cynos-ai/tools
```

Or project-locally (writes to `.pi/settings.json`, shareable with your team):

```bash
pi install npm:@cynos-ai/tools -l
```

Update or remove:

```bash
pi update --extensions       # upgrade all installed packages
pi remove npm:@cynos-ai/tools
```

## Tools

| Tool | Purpose |
|---|---|
| `cynos_search` | Search the web. Exa REST / Tavily REST (API key), free Exa MCP fallback. |
| `cynos_fetch` | Fetch full page content for one or more public http/https URLs. |
| `cynos_vision` | Analyze local image files with the configured vision model (describe / ocr / compare / ui). |
| `cynos_browser_navigate` | Open a URL in an isolated browser session (localhost allowed for dev servers). |
| `cynos_browser_interact` | click / fill / press / select / hover / scroll / wait on the current page. |
| `cynos_browser_inspect` | snapshot (element refs) / screenshot / console / requests / eval. |
| `cynos_browser_close` | Close the current session's browser. |

## Commands

- `/cynos-tools-config` — edit search API keys, vision model, and browser launch options.
- `/cynos-tools-browser-setup` — probe system browsers; optionally install Chromium.

## Configuration

Config lives at `~/.pi/agent/cynos-tools.json`:

```json
{
  "schemaVersion": 1,
  "exaApiKey": "optional",
  "tavilyApiKey": "optional",
  "visionModel": "provider/model-id",
  "browser": {
    "channel": "chrome",
    "executablePath": null,
    "headless": true,
    "timeoutMs": 30000
  }
}
```

`exaApiKey` / `tavilyApiKey` may also come from the `EXA_API_KEY` / `TAVILY_API_KEY` environment variables; the config file wins. Edit interactively with `/cynos-tools-config` — no need to touch JSON by hand.

### Search providers

Order: user-preferred REST → other configured REST → free Exa MCP. Search works out of the box via MCP even without an API key; configuring Exa or Tavily improves quality and quota.

### Vision

`cynos_vision` runs the configured `visionModel` in an isolated child process. Configure a vision-capable model via `/cynos-tools-config`. When the main agent's model does not support image input, Tools reminds the agent to use `cynos_vision` instead of `read` (which would fail).

> Images are sent to the configured model provider. Don't pass images you cannot send to that provider.

### Browser

Tools uses `playwright-core` and does **not** bundle a browser. On first use:

1. If a system Chrome / Chromium / Edge is detected, Tools launches it directly.
2. Otherwise Tools returns a clear setup pointer. Run `/cynos-tools-browser-setup` to probe, or to install Chromium via `playwright-core` (explicit confirmation required — ~150 MB download).

Each pi session gets an isolated, ephemeral browser context — no persistent profile, no user cookies, no login state.

URL policy:

- Allowed: public `http`/`https`, and `localhost` / `127.0.0.1` / `[::1]` (for local dev verification).
- Blocked: `file:`, `data:`, `javascript:`, `chrome:`, `devtools:`, `about:`, link-local and cloud-metadata addresses.

Workflow: `cynos_browser_navigate` → `cynos_browser_inspect(action="snapshot")` to get element refs → `cynos_browser_interact` using those refs → `cynos_browser_inspect(action="screenshot"|"console"|"requests"|"eval")` to capture evidence → `cynos_browser_close`. Refs are invalidated by navigation, so re-snapshot after navigating.

## Security notes

- Browser tools run with your full system permissions and can drive a real browser on your machine. Review what you ask the agent to do.
- `eval` runs arbitrary JavaScript in the page context and can change page state — treat it as the same trust level as `bash`.
- API-key config files are written `0600`. Never commit them.
- Browser console/network buffers drop request/response bodies and sensitive headers (`authorization`, `cookie`, etc.).

## License

Cynos Tools is licensed under the [MIT License](./LICENSE). See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for upstream notices.
