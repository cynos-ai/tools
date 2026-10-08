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
- **页面标注** — `/annotate` 在有头浏览器窗口里打开页面，点选元素写批注，结构化报告直接发送进对话。

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
| `cynos_browser_annotate` | 打开有头标注窗口；用户拖区域/点元素写批注，返回报告。阻塞至提交。 |

## 命令

- `/annotate <url>` — 在有头浏览器窗口中标注页面元素，报告以用户消息形式发送给 agent。
- `/cynos-tools-config` — 编辑搜索 API key、视觉模型、浏览器启动与标注选项。
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
    "timeoutMs": 30000,
    "args": ["--ozone-platform=x11"],
    "annotate": {
      "timeoutMs": 600000,
      "screenshots": true,
      "uiLanguage": "auto"
    }
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

### 页面标注（`/annotate` 或自然语言）

`/annotate <url>` —— 或直接对 agent 说（"用 /annotate 标注这个页面"，它会调用 `cynos_browser_annotate`）—— 会在**有头**浏览器窗口打开页面（无头会话自动以有头重启），并注入 Codex 风格的标注 overlay。无需安装浏览器扩展或 Native Host：

1. **页面默认可正常操作。** 点 **开始标注** 进入标注模式；随时点 **完成标注** 退出回到正常交互（已加批注保留）。
2. **区域模式（默认）**：拖出矩形区域，在弹窗里输入批注，可连续多次。**元素模式**：点击 HTML 元素附加选择器级上下文。`Esc` 先退出标注模式，再收起面板。
3. **底部栏**是整体需求输入框 + **一起发送 (N)**：一次提交序列化所有批注（区域含文档坐标矩形 + 逐区域裁剪图，元素含选择器/盒模型/无障碍/样式），同时截取带徽章的视口图和干净全页图，生成 Markdown 报告（命令路径：作为用户消息；工具路径：作为工具结果供 agent 立即处理）。

Overlay 界面**默认中文**；自动跟随系统 locale（`LANG`/`LC_ALL`），可用 `browser.annotate.uiLanguage`（`"zh" | "en" | "auto"`）覆盖。随时再次运行 `/annotate` 进行下一轮；浏览器会话复用。其他选项：`browser.annotate.timeoutMs`（默认 10 分钟）、`browser.annotate.screenshots`、`browser.args`（额外 Chromium 启动参数）。

限制：标注发生在隔离临时会话中（无登录态）；批注不跨页面导航保留；仅主框架可标注（不支持 iframe / 穿透 shadow host）。

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
