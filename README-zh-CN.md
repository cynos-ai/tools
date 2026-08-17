# Cynos Tools

> **语言：** [English](./README.md) · 简体中文

面向 [pi](https://github.com/earendil-works/pi-coding-agent) 编码代理的搜索、视觉与浏览器工具。

[![npm 版本](https://img.shields.io/npm/v/@cynos-ai/tools.svg)](https://www.npmjs.com/package/@cynos-ai/tools)
[![GitHub 发布](https://img.shields.io/github/v/release/cynos-ai/tools.svg)](https://github.com/cynos-ai/tools/releases)

## 使用要求

- Node.js 22 或更高版本
- 已安装并可调用的 [pi](https://github.com/earendil-works/pi-coding-agent)
- Exa 或 Tavily API key 可选；搜索有免费的 Exa MCP 兜底
- 使用 `cynos_vision` 前，需要配置支持视觉的模型

## 提供的能力

四类能力，以 agent 可直接调用的 pi 工具形式提供：

- **网页搜索** — `cynos_search` 查找最新的文档和参考资料。
- **网页抓取** — `cynos_fetch` 拉取公开页面的完整正文。
- **视觉** — `cynos_vision` 用支持视觉的模型分析本地图片（截图、UI、图表、示意图）。
- **浏览器自动化** — `cynos_browser_*` 驱动隔离浏览器：导航、交互、采集 snapshot/screenshot/console/network 证据、关闭。

用户级安装一次，所有项目都获得这些工具。

## 安装

```bash
pi install npm:@cynos-ai/tools
```

或项目级安装（写入 `.pi/settings.json`，可与团队共享）：

```bash
pi install npm:@cynos-ai/tools -l
```

升级或移除：

```bash
pi update --extensions       # 升级所有已安装的包
pi remove npm:@cynos-ai/tools
```

## 工具

| 工具 | 用途 |
|---|---|
| `cynos_search` | 搜索网页。Exa REST / Tavily REST（需 API key），免费 Exa MCP 兜底。 |
| `cynos_fetch` | 抓取一个或多个公开 http/https URL 的完整正文。 |
| `cynos_vision` | 用配置的视觉模型分析本地图片（describe / ocr / compare / ui）。 |
| `cynos_browser_navigate` | 在隔离浏览器会话中打开 URL（允许 localhost 用于本地开发验证）。 |
| `cynos_browser_interact` | click / fill / press / select / hover / scroll / wait。 |
| `cynos_browser_inspect` | snapshot（元素 ref）/ screenshot / console / requests / eval。 |
| `cynos_browser_close` | 关闭当前会话的浏览器。 |

## 命令

- `/cynos-tools-config` — 编辑搜索 API key、视觉模型、浏览器启动选项。
- `/cynos-tools-browser-setup` — 探测系统浏览器；可选安装 Chromium。

## 配置

配置文件位于 `~/.pi/agent/cynos-tools.json`：

```json
{
  "schemaVersion": 1,
  "exaApiKey": "可选",
  "tavilyApiKey": "可选",
  "visionModel": "provider/model-id",
  "browser": {
    "channel": "chrome",
    "executablePath": null,
    "headless": true,
    "timeoutMs": 30000
  }
}
```

`exaApiKey` / `tavilyApiKey` 也可以来自 `EXA_API_KEY` / `TAVILY_API_KEY` 环境变量；配置文件优先。用 `/cynos-tools-config` 可视化编辑，无需手改 JSON。

### 搜索 Provider

顺序：用户首选 REST → 其他已配置 REST → 免费 Exa MCP。即使没有 API key，搜索也能用（走 MCP）；配置 Exa 或 Tavily 会提升质量和额度。

### 视觉

`cynos_vision` 在隔离的子进程中运行配置的 `visionModel`。通过 `/cynos-tools-config` 配置一个支持图片的模型。当主 agent 的模型不支持图片时，Tools 会提醒改用 `cynos_vision`，而不是会失败的 `read`。

> 图片会被发送到配置的模型供应商。不要传入不能发给该供应商的图片。

### 浏览器

浏览器支持是可选的，因此普通的搜索/视觉安装不会自动拉取 Playwright
运行时。需要浏览器时，在宿主项目中显式安装可选 peer：

```bash
npm install --save-dev playwright-core
```

没有安装它时，搜索、视觉和配置功能仍然可用；浏览器调用会返回明确的
setup 错误，不会在 Tools 启动阶段直接失败。安装后，Tools 使用
`playwright-core`，但**不**捆绑浏览器。首次使用时：

1. 检测到系统 Chrome / Chromium / Edge，则直接启动。
2. 否则 Tools 返回明确的 setup 指引。运行 `/cynos-tools-browser-setup` 探测，或通过 `playwright-core` 安装 Chromium（需要明确确认，约 150 MB 下载）。

每个 pi session 使用一个隔离的、临时的浏览器 context——没有持久 profile、没有用户 cookies、没有登录态。

URL 策略：

- 允许：公开 `http`/`https`，以及 `localhost` / `127.0.0.1` / `[::1]`（用于本地开发验证）。
- 禁止：`file:`、`data:`、`javascript:`、`chrome:`、`devtools:`、`about:`、link-local 与云元数据地址。

工作流：`cynos_browser_navigate` → `cynos_browser_inspect(action="snapshot")` 获取元素 ref → `cynos_browser_interact` 使用 ref → `cynos_browser_inspect(action="screenshot"|"console"|"requests"|"eval")` 采集证据 → `cynos_browser_close`。导航后 ref 失效，需重新 snapshot。

## 安全说明

- 浏览器工具以你完整的系统权限运行，可以在你的机器上驱动真实浏览器。请留意你让 agent 做什么。
- `eval` 在页面上下文执行任意 JavaScript，可以改变页面状态——信任级别与 `bash` 相同。
- API key 配置文件以 `0600` 权限写入。永远不要提交它们。
- 浏览器 console/network 缓冲会丢弃 request/response body 和敏感 header（`authorization`、`cookie` 等）。

## 文档与维护

- [贡献指南](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [变更记录](./CHANGELOG.md)
- [第三方许可说明](./THIRD_PARTY_NOTICES.md)

## 许可证

Cynos Tools 使用 [`MIT License`](./LICENSE)。第三方许可说明见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
