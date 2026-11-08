# Web Access for PI-Desktop

> 把 [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) 的联网搜索、网页与图片抓取、结果检索、来源核查、页面问答与字段抽取搬进 PI-Desktop。上游源码逐字节复用，只替换 pi 专属外壳。

<p align="left">
  <img alt="PI-Desktop" src="https://img.shields.io/badge/PI--Desktop-%E2%89%A50.20.1-0485f7" />
  <img alt="upstream" src="https://img.shields.io/badge/upstream-v0.47.0-6f42c1" />
  <img alt="patched files" src="https://img.shields.io/badge/upstream%20patches-0-4fbd91" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-4fbd91" />
</p>

Pi coding agent 的扩展与 PI-Desktop 的插件是两套互不兼容的体系：扩展跑在 agent 进程里、拿 `ExtensionAPI` 和 `pi-tui`；插件跑在宿主进程里、拿 `globalThis.pi` 和面板桥。上游 `web-tool-core.ts` 本身与宿主无关，并自带两个宿主实现：`createWebToolCore(host)`（pi 用）和 `createStandaloneWebToolCore()`（官方 MCP server 用）。

本移植调 **`createWebToolCore(host)`**，把宿主换成桌面能提供的那个：图片走本地 `resizeImage` shim，页面问答走 `pi.agent.complete`，结果落盘到插件数据目录。`index.ts` 那层 pi 界面换成 PI-Desktop 的工具注册、命令、快捷键与面板。

## 四个工具

| 工具 | 风险 | 作用 |
| --- | --- | --- |
| `web_search` | medium | 搜索来源或答案；结果按 `responseId` 存起来供检索 |
| `fetch_content` | medium | 抓网页、PDF、GitHub 仓库、图片；支持 `answer` / `extract` / 认证抓取 / 视频参数 |
| `get_search_content` | low | 按 `responseId` 翻页或检索已存内容（跨重启有效） |
| `source_check` | medium | 针对某个断言收集带引用的网页片段 |

`web_search`、`get_search_content`、`source_check` 的参数面与上游 MCP 定义（`mcp-tool-definitions.ts`）完全一致。`fetch_content` 在此基础上补回了上游只给 pi 用的参数：

| 参数 | 作用 |
| --- | --- |
| `mode` | `readable`（默认）/ `raw` / `answer` / `extract` |
| `prompt` | `answer` 的问题；视频分析的指令 |
| `answerModel` | `answer` 用的模型（`provider/model-id`），默认取当前会话模型 |
| `fields` | `extract` 要抽的字段名与类型（text / number / date / time / datetime / duration） |
| `auth` | 用本机浏览器 cookie 抓登录墙页面（与 `answer`/`extract` 互斥） |
| `redirects` | `same-origin`：拒绝跨源重定向 |
| `timestamp` / `frames` / `model` | 视频定位、抽帧数与分析模型 |

## 安装

### 本地开发加载

1. **插件 → 加载开发插件**，选本仓库目录
2. 宿主会逐个列出声明的权限并等你确认（见下方「权限」）
3. 工作面板视图菜单 → **联网访问**；也可从全局搜索用 `Web Access: …` 三条命令打开，或按 `Ctrl/Cmd+Shift+Y`

### 一条命令装进本机

不点 GUI 也能装：

```bash
npm run install:local
```

它把 `dist/*.piplug` 解包到 `%USERPROFILE%\.pi-desktop\plugins\installed\pi.web-access\`，并在
`plugins/registry.json` 里 upsert 一条 `enabled: true` 的记录（首次运行先备份原 registry，可回滚）。
重启 PI-Desktop 后生效；高风险权限仍需你在插件页确认一次——脚本不会替你签这份同意。

### 打包安装

```bash
npm install
npm run pack      # dist/pi.web-access-0.2.1.piplug
npm run verify:pack
```

把 `.piplug` 拖进 **插件 → 安装插件包**。`build/agent.cjs` 已内置全部依赖，包内不含 `node_modules`。

## 配置与密钥

配置优先级（高到低）：

1. **插件凭据存储** —— 面板里填的密钥，写在插件私有数据目录的 `secrets.json`（`0600`）
2. **插件设置表单** —— 默认供应商、抓取模式、字符上限、代理、四个工具开关
3. **旧 `~/.pi/web-search.json`** —— 直接沿用 Pi 那边的配置；存在即合并
4. **上游内置默认值**

插件会把三者合并后写进数据目录的 `web-search.json`，再让上游照它读。所以上游任何配置键都能用：

```json
{
  "braveApiKey": "…",
  "searchProvider": "exa",
  "fetch": { "defaultMode": "readable", "allowedModes": ["readable", "raw", "answer"] },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] },
  "proxy": "http://127.0.0.1:7892"
}
```

面板的「密钥与高级配置（JSON）」就是把这种对象合并进凭据存储；已保存的密钥只显示「已配置 / 未配置」，值不会回显到面板。

`PI_WEB_ACCESS_LEGACY_CONFIG` 可指定旧配置文件路径（空值表示不读旧文件），`PI_CODING_AGENT_DIR` 仍被上游用于定位缓存。

### 两种模式的额外凭据

| 能力 | 需要什么 | 从哪读 |
| --- | --- | --- |
| `fetch_content` 的 `answer` | 一个会话模型 | 当前会话模型，或 `answerModel`；走宿主的 `agent.complete` |
| `fetch_content` 的 `extract` | Cloudflare Workers AI 凭据 | 面板的 `cloudflareApiKey` / `cloudflareAccountId`，或环境变量 `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`；可选 `CLOUDFLARE_GATEWAY_ID` |

`extract` 默认**不在** `fetch.allowedModes` 里——这是上游的隐私默认，因为该模式会把页面正文发给 Cloudflare。要用请在面板勾选。

### 浏览器 cookie（可选，默认关闭）

`auth` 认证抓取与 gemini 登录态探测都要读本机 Chromium（Chrome / Edge）的 cookie。上游把这件事放在 `allowBrowserCookies` 开关后面，默认关闭：关闭时 `isGeminiWebAvailable()` 直接返回 null，**一个 cookie 都不读**。

开启方式二选一：

- 面板「密钥与高级配置（JSON）」里写入 `{ "allowBrowserCookies": true }`
- 或设环境变量 `PI_ALLOW_BROWSER_COOKIES=1`

开启后可用 `browserCookies.profile` 指定 Chromium 配置目录名（`Default`、`Profile 1` 等）；Windows 上由上游做 DPAPI 解密，插件本身不接触明文密钥。

## 供应商支持面

全部 46 个上游供应商都在，没有裁剪：

`openai` · `brave` · `parallel` · `parallel-mcp` · `tinyfish` · `search1api` · `searchinfinity` · `querit` · `tavily` · `you` · `firecrawl` · `jina` · `searxng` · `degoog` · `duckduckgo` · `perplexity` · `gemini` · `kimi` · `exa` · `serpdive` · `kagi` · `ollama` · `anysearch` · `xai` · `mistral` · `brightdata` · `serpbase` · `serpapi` · `serper` · `serply` · `valyu` · `bocha` · `xcrawl` · `baizhi` · `zai` · `keenable` · `ceramic` · `deepseek` · `linkup` · `ninerouter` · `cloudflare` · `searchapi` · `outcrawl` · `sofya` · `cloro` · `tabstack`

免密钥即可用的是 `degoog`、`duckduckgo`、`exa`、`anysearch`、`keenable`、`parallel-mcp`（以本机实测为准，面板会逐个标出可用性）。其余需要在面板里填对应凭据。

两个例外：`kimi` 只走 Pi 的登录态（上游 MCP 宿主也把它剔除了，桌面端选它会得到 "unknown provider"）；`gemini` 可用 API key，或在本机 Chrome/Edge 登录后开启 `allowBrowserCookies`。

## 安全边界

插件在三处直接接触不可信输入，各自有明确防线：

- **结果 id 只能是文件名。** `responseId` 与面板的 `results:*` 通道都会把 id 拼进文件路径，而 `path.join` 会解析 `..` —— 实测 `results:drop` 传 `../secrets` 能删掉数据目录里的密钥文件。插件沿用上游 `CACHE_ID_PATTERN`（`[A-Za-z0-9_-]{1,64}`）在存储层四个入口统一校验，通道层对非法 id 直接返回 `INVALID_ARGUMENT`；长度上限同时挡住 1 MB `responseId` 的整串回显。
- **外链只开 http(s)。** 「打开来源」用全锚定正则 `/^https?:\/\//i` 校验，`javascript:`、`file://`、前导空白与大小写变体全部拒绝。渲染层没有任何 `innerHTML`／`insertAdjacentHTML`，任意网页的标题、摘要、正文、错误文案都只经过 `textContent`。
- **模型补全自己限流。** 宿主允许 8 次 `pi.agent.complete`／60 秒，而上游对 answer 模式是按 URL 并发（`Promise.all`），一次多 URL 抓取就能打光整分钟额度并连带拖垮自动总结。插件侧改成 6 次／60 秒滑窗，超额返回明确的「N 秒后重试」，并由 `signal` 感知取消。

## 权限

| 权限 | 风险 | 用途 |
| --- | --- | --- |
| `agent.tool.register` | high | 注册上面四个 agent 工具 |
| `net.anyHost` | high | 联网工具必须能访问搜索供应商与用户给出的任意 URL；这是开放世界的抓取，无法预先列域名 |
| `agent.prompt.inject` | high | 提供一份说明如何选用这些工具的技能文档（`skills/web-search.md`） |
| `agent.complete` | high | `fetch_content` 的 `answer` 模式用你的模型回答页面问题；只在显式要求时调用 |
| `ui.view` | low | 在工作面板里提供「联网访问」视图 |
| `keyboard.globalShortcut` | medium | 把 `Ctrl/Cmd+Shift+Y` 绑到本插件自己的打开面板命令 |
| `shell.openExternal` | medium | 在「已存结果」里打开你点的那条来源链接（只接受 http(s)） |

不读会话、不读写剪贴板以外的内容、不启动子进程、无遥测。密钥只落插件私有数据目录，不写日志、不进打包产物（`npm run test:config` 与 `npm run verify:pack` 都在验证这一点）。

## 与上游的差异

完整对照见 [docs/PORT-NOTES.md](docs/PORT-NOTES.md)。要点：

- **换了一个宿主实现**：不经过 `createStandaloneWebToolCore()` 的收窄，直接用 `createWebToolCore(host)`，因此图片、页面问答、磁盘结果都能工作。
- **pi 界面换成桌面面**：`/curator` → 面板「已存结果」；活动小部件 → 面板「活动」卡；`Ctrl+` → `Ctrl/Cmd+Shift+Y`；`sendMessage`/`appendEntry` → 落盘 `results/`；`promptSnippet` → `skills/web-search.md`。
- **命令只做导航**：三条桌面命令从全局搜索打开面板分区；`pi.commands.register` 的 `run()` 无参数，不能像斜杠命令那样内联 query。
- **自动摘要默认关闭**：`autoSummary` 打开后，`web_search` 会先让会话模型把结果总结成一段带链接的说明；关闭时保持原始结果表。摘要失败会回落到原始结果，不会让搜索失败。
- **gemini 可用性与上游一致**：API key 或本机浏览器登录态都算可用；`isGeminiWebAvailable()` 在 `allowBrowserCookies` 关闭时直接返回 null，默认不读任何浏览器数据。
- **搜索 `model` 覆盖可用**：`web_search` 接受 `model`（`provider/id`），只对支持覆盖的 provider 生效；不传则用配置里的 `*SearchModel`。

## 开发

```bash
npm install
npm run build              # build/agent.cjs（esbuild，把上游与依赖一起打进去）
npm test                   # 适配层 + 配置 + 视图 + 持久化
npm run test:adapter       # 验收 1：四工具注册 / 清单一致 / 反注册 / 命令 / 快捷键
npm run verify:upstream    # 验收 2：上游逐字节比对
npm run test:upstream      # 验收 3：上游用例子集，要求 0 失败
npm run smoke              # 验收 4：真实搜索 + 抓取 + 按 id 取回（无需任何 key）
npm run test:config        # 验收 5：配置优先级与密钥不外泄
npm run pack               # 验收 6：产出 .piplug
npm run verify:pack        # 验收 6：包规则 + 解包加载
npm run test:view          # 验收 7：面板纯函数 + DOM
npm run verify:docs        # 验收 8：文档齐备
npm run devkit:check       # 用官方 devkit 的 pi-plugin check 校验清单
```

面板可以脱离宿主预览：浏览器打开 `test/harness.html`（内置假宿主与示例数据）。

## 已知限制

- **`answer` 只处理文本页面。** `pi.agent.complete` 的入参只有 `system` 与 `messages`（文本），没有图片通道；对图片或视频帧调用 `answer` 会返回明确错误，需要单独的抓取或视频能力。
- **自动摘要会多花一次补全**：`autoSummary` 默认关闭，打开后每次 `web_search` 都会先跑一次会话模型。
- **`extract` 需要 Cloudflare Workers AI 凭据**，且默认不在 `fetch.allowedModes` 内（隐私默认，正文会发给 Cloudflare）。
- **视频分析不可用**：宿主 `pi.agent.complete` 只收文本，抽取的视频帧没有输入通道，对视频帧调用 `answer` 会明确报错而不是只答文字。
- **`auth` 认证抓取未验证**：参数与代码路径已接通，本机没有可用的认证配置，无法证明产出质量；`redirects: "same-origin"` 是纯 HTTP 行为，随抓取直接生效。
- **`responseId` 跨重启有效，最多保留最近 120 条**（`src/store.ts` 的 `MAX_PERSISTED`）；内存工作集仍是上游的 50 条，超出后最早的条目会被删除。
- 面板停用某个工具后，当前会话的注册不会变化，需要重新加载插件才生效（面板里已标注）。
- `web_search` 的 `includeContent: true` 是**同步**的：返回前抓完所有页面，多 URL 或慢站容易接近宿主的 110 秒工具上限；上游部分内部超时（抓取 150 s、搜索路由 600 s）比这个上限更长，因此超时由宿主先触发，插件不返回部分结果。
- 改配置会重建执行核心并清空内存工作集；磁盘结果保留，下一次 `get_search_content` 会重新 hydrate。
- Plan/Goal 模式下宿主不提供插件工具（没有 `planSafeActions` 声明），这是宿主策略。
- 图片缩放只覆盖 PNG：8 位 RGB/RGBA 且超过 2000px 才缩（`node:zlib` 自解码/编码）；JPEG、WebP、GIF 与 16 位/调色板/交织 PNG 原样返回，超过 8 MiB 直接拒绝。
- 上游包的首次加载会把 9 MB 的 bundle 读进内存，之后常驻。
- `degoog`/`duckduckgo` 等免密钥通道在部分网络下需要代理，可在面板里填 `proxy`。

## 许可

MIT。`upstream/` 下的文件来自 [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access)（MIT，© 2025 Nico Bailon），保持原样。
