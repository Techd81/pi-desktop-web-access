# 移植说明

上游：[nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)，钉在 commit `6dd57b7f5a0c3041053e65a28f5f425323ec95f9`（v0.47.0）。
`upstream/` 下 259 个文件与该提交逐字节一致，改动白名单见 `upstream/PATCHES.md`（当前为空）。

## 为什么用原生适配层

pi 扩展与 PI-Desktop 插件互不兼容，但上游内部已经分成了两层：

- `index.ts`（115 KB）——pi 专属外壳：pi-tui 组件、小部件、快捷键、curator 面板、`sendMessage`/`appendEntry` 会话持久化。
- `web-tool-core.ts` —— 与宿主无关的执行核心。文件头写明它必须不引入 `index.ts`、curator、summary、activation 或 `@earendil-works/*` 的**运行时**依赖，并且自带两个宿主实现：`createWebToolCore(host)`（pi 用）与 `createStandaloneWebToolCore()`（官方 MCP server 用）。

本移植不用 standalone 包装器，而是直接调 `createWebToolCore(host)`——同一个上游函数，只把宿主换成桌面能提供的那个。这是本次补齐能力的全部机制：standalone 包装器有三处收窄，全部来自它假设"宿主没有 Pi 就没有图片、模型和磁盘"，而桌面这三样都有。

- `extractOptions: { rejectDirectImages }` → 本移植不传，改由 `src/shims/pi-coding-agent.ts` 提供 `resizeImage`。
- `standaloneFetchRejection()` 拒绝 `mode: "answer"` → 本移植不经过它，改由 `src/core.ts` 提供 `answerFromPage`。
- 没有 `answerFromPage` / 只有内存存储 → 本移植提供 `answerFromPage`（`pi.agent.complete`）与落盘存储（`src/store.ts`）。

工具 descriptor 仍取上游 `MCP_TOOL_DEFINITIONS`，只在 `src/schema.ts` 给 `fetch_content` 派生一份扩展 schema；参数校验仍用上游 `validateMcpToolArguments`。provider、抓取、PDF、GitHub、SSRF 防护、结果存储全部是上游代码，未改一行，`npm run verify:upstream` 报告 0 patch / 0 差异。

这样选的理由：

- `contributes.agentExtensions` 兼容层虽然更省事，但桌面宿主对 `ExtensionAPI` 只支持一个子集：`sendMessage`、`appendEntry`、`sessionManager`、`registerShortcut` 都是惰性空实现，`ui.setWidget` 直接不支持。上游外壳的大量逻辑建立在这些面上，挂上去只会静默失效。
- 原生工具走 `contributes.agentTools` + `pi.agent.registerTool`，宿主负责 ToolSearch 延迟激活、模式门禁、审计与 110 秒超时，插件不必自己实现工具生命周期。

## 接缝映射

| 上游用法 | 桌面宿主 | 处理方式 |
| --- | --- | --- |
| `pi.registerTool(...)` + TypeBox schema | `pi.agent.registerTool({name, description, risk, schema, execute})` | `src/schema.ts` 以 `MCP_TOOL_DEFINITIONS` 为基准，只给 `fetch_content` 加回 Pi 专有参数；其余三个工具仍是上游原对象 |
| `pi.getActiveTools` / `setActiveTools` / `getAllTools`（`tool-activation.ts`） | 宿主自己的 ToolSearch 与模式门禁 | 不引入 `tool-activation.ts`，由宿主接管激活 |
| 配置路径（`utils.ts` 的 `getWebSearchConfigDir()`） | 插件私有数据目录 | `main.js` 在 require bundle **之前**设 `PI_CODING_AGENT_DIR`，用完即恢复（上游只在首次解析时缓存） |
| `ctx.ui.notify` / `ctx.ui.select` | 面板 + `onPanelInvoke` 桥 | 面板承担状态、可用性、凭据、设置、已存结果与活动 |
| `ctx.modelRegistry`（answer、extract 的字段抽取） | `pi.agent.complete` + 插件设置/环境变量 | `main.js` 的 `answerFromPage` 与 `providerAuth` 两个桥；见下节 |
| `pi.exec("cmd", ["/c", "start", url])`（打开浏览器） | `pi.shell.openExternal` | 结果浏览器里的「在浏览器中打开来源」按钮，只接受 http(s) |
| `ctx.sessionManager`（会话内结果索引） | 磁盘 `results/` 目录 | `src/store.ts` 落盘 + 冷启动 `hydrateResult`；见「已知限制」 |
| `registerShortcut`（`Ctrl+`）与 `ctx.ui.setWidget`（活动流） | `pi.keyboard.registerGlobalShortcut` + 面板 | 快捷键绑到本插件自己的命令；活动卡替代小部件 |
| `sendMessage` / `appendEntry`（结果随会话落盘） | — | 由 `src/store.ts` 取代，不依赖会话生命周期 |

## 能力对照

| 上游能力 | 状态 | 说明 |
| --- | --- | --- |
| `/curator` 交互面板 | 已替代 | 面板「已存结果」卡提供同一流程的桌面版：列出 responseId、时间、大小，可预览正文、复制 ID、打开来源、删除、清空、重建索引 |
| `/websearch`、`/search`、`/google-account` 命令 | 部分替代 | 三条桌面命令（`pi.web-access.open` / `.results` / `.settings`）从全局搜索打开面板对应分区。`pi.commands.register` 的 `run()` 无参数，因此不能像斜杠命令那样内联 query；`/google-account` 没有对应面 |
| 活动流小部件（`activity.ts`） | 已替代 | 面板「活动」卡列出本进程内的工具调用、模式与 answer 所用模型，环形缓冲 50 条 |
| `Ctrl+` 快捷键（`registerShortcut`） | 已替代 | `Ctrl/Cmd+Shift+Y` 绑到 `pi.web-access.open`；宿主保留 `Alt+Space` 与 `Alt+Shift+W`，冲突时返回 `registered:false` 并记日志，面板显示绑定状态 |
| `sendMessage` / `appendEntry` 会话持久化 | 已替代 | 结果写入插件数据目录的 `results/`（索引 + 每条一个 JSON），最多 120 条；`get_search_content` 冷启动自动 hydrate，跨重启有效 |
| 自动摘要（`summary-review.ts`） | 已启用（需打开开关） | 经上游的 `summarize` 钩子接 `pi.agent.complete`：`autoSummary` 打开时，搜索结果会先被会话模型总结成一段带链接的说明。默认关闭，因为每次搜索会多花一次补全；摘要失败时回落到原始结果表，不会让搜索失败 |
| 工具用法的 `promptSnippet` 与升级提示 | 已替代 | `skills/web-search.md` 经 `contributes.skills` + `agent.prompt.inject` 进入技能目录（含"prefer 2-4 varied queries"），正文按需加载 |
| `fetch` 的 `answer` 模式 | 已启用 | 走 `pi.agent.complete`；模型取 `answerModel` 或当前会话模型；额度由使用者承担。宿主 API 只收文本，因此图片或视频帧的 answer 会明确报错而不是静默降级 |
| `fetch` 的 `extract` 模式与 `fields` | 已启用（需凭据） | 参数经派生 schema 开放并透传到上游 `extractPageFields`。抽取调用 Cloudflare Workers AI，凭据由 `providerAuth` 从插件设置或环境变量（`CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`）提供。默认 `fetch.allowedModes` 仍不含 `extract`——上游的隐私默认（正文会发给 Cloudflare）——需在面板勾选 |
| 直接图片抓取 | 已启用 | `scripts/build.mjs` 的 esbuild alias 把 `@earendil-works/pi-coding-agent` 指向 `src/shims/pi-coding-agent.ts`：读 PNG/JPEG/GIF/WebP 头得到宽高，原样返回字节，超过 8 MiB 拒绝。实测 `Image fetched (460×460, image/png)` |
| 视频分析（`prompt` / `timestamp` / `frames` / `model`） | 不可用 | 参数已进 schema 并透传，但最后一环断了：宿主 `pi.agent.complete` 只收文本，抽出的帧没有输入通道。上游 core 会把帧作为 `images` 交给 `answerFromPage`，本移植的桥明确拒绝而不是只答文字。纯文本的视频页面（字幕/转录）另需 Gemini 凭据，且上游 YouTube 路径在无凭据时直接失败 |
| `auth`（浏览器 cookie 认证抓取）与 `redirects` | 参数已开放，未验证 | 两者已进 schema 并透传。`redirects: "same-origin"` 是纯 HTTP 行为，由上游在抓取层执行、不依赖模型或凭据；`auth` 由上游读本机浏览器 cookie，本机没有可用的认证配置，未做端到端验证 |
| 搜索 `model` 覆盖（openai / xai / mistral / gemini） | 已启用 | 派生 schema 给 `web_search` 加回 `model`（`provider/id`），由上游 `validateSearchModelOverride` 校验；只对支持覆盖的 provider 生效 |
| 浏览器 cookie 参与 gemini 可用性探测 | 已启用（需打开开关） | 与上游一致：浏览器登录态也算 gemini 可用。`isGeminiWebAvailable()` 先检查 `allowBrowserCookies`（或 `PI_ALLOW_BROWSER_COOKIES=1`），未开启时一个 cookie 都不读；开启后走上游的 Chromium 读取与 Windows DPAPI 解密 |
| 图片缩小（`extract.ts` 的 `import("@earendil-works/pi-coding-agent")`） | 已启用 | shim 用 `node:zlib` 自行解码与编码 PNG：超过 2000px 的 8 位 RGB/RGBA PNG 按面积平均缩小后重编码。JPEG/WebP/GIF 与 16 位、调色板、交织 PNG 仍原样返回（解码它们要引入编解码依赖）；超过 8 MiB 直接拒绝 |

## 上游用例子集怎么来的

`npm run test:upstream` 只跑 `scripts/upstream-tests.json` 里的 `include` 列表（70 个文件）。列表是把上游 151 个测试文件**逐个单独运行**后，按「退出码 0 且 `# fail 0`」筛出来的；`exclude` 里每个文件都带原因，生成脚本 `scripts/gen-port-notes.mjs` 会把它们逐条写进下面的表。

排除项分类汇总：

| 原因 | 文件数 |
| --- | --- |
| 直接导入 `upstream/index.ts`（Pi 外壳） | 42 |
| 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 | 24 |
| 子进程验证 Pi 外壳行为，本移植故意不复刻 | 12 |
| 需要未 vendoring 的 README.md（文档而非源码） | 2 |
| 需要 `npm` CLI（Windows 上该名称不在 PATH） | 1 |

逐条清单：

| 文件 | 原因 |
| --- | --- |
| `auto-summary-source.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `baizhi-provider.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `cloudflare-search-provider.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `codemode-nested-calls.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `codemode-structured-results.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `concurrent-sessions.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `curator-run.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `exa-result-metadata.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `exa-source-label.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-answer-storage.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-cache-storage.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-error-status.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-modes.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-not-found-guidance.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-pdf-answer.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-redirect-policy.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-render-call.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `fetch-youtube-answer.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `get-search-content.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `github-issue-pr.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `helper-model-selector.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `mcp-server.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `new-search-providers.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `page-query.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `pdf-config.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `perplexity-timeout.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `provider-argument.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `proxy-transport.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `query-rewrite.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `readme-tool-params.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `rsc-fallback.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `search-routing-weak-results.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `source-check.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `stored-response-id.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `summary-model-scope.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `summary-opencode-session.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `summary-prompt-snippets.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `summary-provider-routing.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `tool-registration-config.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `upgrade-notice.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `virtual-model-nested-calls.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `zai-provider.test.mjs` | 直接导入 `upstream/index.ts`（Pi 外壳） |
| `allowed-search-providers.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `anysearch-provider.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `auth-fetch.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `brightdata-serp.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `brightdata-unlocker.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `config-path.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `curator-fallback.test.mjs` | 需要未 vendoring 的 README.md（文档而非源码） |
| `fetch-answer-continuation.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `fetch-extract.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `fetch-mode-config.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `fetch-multi-answer.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `inline-content-config.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `jina-search.test.mjs` | 需要未 vendoring 的 README.md（文档而非源码） |
| `lazy-extract-load.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `linkup-provider.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `local-video-oversize.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `openai-alpha-search.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `package-typebox-dependency.test.mjs` | 需要 `npm` CLI（Windows 上该名称不在 PATH） |
| `pdf-extract.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `provider-credential-source.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `provider-precedence.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `publish-wrapper.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `querit-provider.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `search-providers.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `search-routing.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `search1api.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `serpdive-provider.test.mjs` | 子进程验证 Pi 外壳行为，本移植故意不复刻 |
| `tool-activation-sdk.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `tool-activation-version.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `tool-activation.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `tool-arguments.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `tool-definition-size.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `tool-error-flag.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `web-search-answer-render.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `web-search-concurrency.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `web-search-model-override.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `web-search-output-boundary.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `web-search-query-expand.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |
| `web-search-response-id.test.mjs` | 子进程导入 `index.ts`，撞上已发布 pi 包之间的版本不一致 |

上述排除都与本移植的行为无关：它们要么直接/间接导入 `upstream/index.ts`（本移植不使用的 pi 外壳），要么在子进程里依赖已发布的 pi 包（`@earendil-works/pi-coding-agent` 1.0.4 与它的 `@earendil-works/pi-codemode` 传递依赖对 `MCP_TYPESCRIPT_PREAMBLE` 的导出一致性有缺口，子进程在断言前就退出），要么需要本仓库不 vendoring 的文档/CLI。

## 观察记录（未修改上游）

- `extract.ts` 的图片分支动态导入 `resizeImage`，上游没为非 Pi 宿主提供替代。桌面用构建期 alias 提供同名导出；`upstream/` 里其余对该包的引用都是 `import type`，编译期即被擦除，因此 alias 只影响这一条运行时路径。
- `runClairic` 从 `modelRegistry.getProviderAuth("cloudflare-workers-ai")` 取 Cloudflare 凭据，没有就报 "extract mode runs only inside Pi"。本移植提供同形状的 hook，错误因此变成可操作的 "set CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID"。
- 上游把 `extract` 排除在默认 `fetch.allowedModes` 之外，注释写明理由是"会把页面正文发给 Cloudflare"。本移植保留该隐私默认，面板可显式勾选。
- 上游 `fetch` 默认允许 `answer`，但 standalone 包装器会拒绝它；本移植不经过该包装器，所以默认值按上游原样生效。
- gemini 的可用性探测与上游一致（API key 或浏览器登录态都算可用）。`isGeminiWebAvailable()` 在 `allowBrowserCookies` 关闭时直接返回 null，因此默认构建不读任何浏览器数据；Pi 与桌面共用同一段 cookie 读取代码（`chrome-cookies.ts`，Windows 走 DPAPI 解密）。
- 宿主设置页对 `json` 类型字段执行 `JSON.parse(当前值)`：`default` 若写成数组，会被 `String()` 成 `readable,raw,answer` 再解析失败，而页面只报"必须是有效 JSON"。因此 `fetchAllowedModes` 声明为 `string` + 逗号分隔，插件的 `normalizeSettingValue` 对数组与逗号串都接受。
- package-typebox-dependency.test.mjs 通过 spawnSync("npm") 调 npm；在 Windows 上进程名是 npm.cmd，因此该用例在 Windows 上必然 ENOENT，与移植无关。
- **结果 id 只能是文件名。** responseId 与面板的 results:* 通道都会把 id 拼进文件路径，而 path.join 会解析 ..：实测 results:drop 传 ../secrets 能删掉数据目录里的密钥文件。现在 src/store.ts 沿用上游 storage.ts 的 CACHE_ID_PATTERN（[A-Za-z0-9_-]{1,64}）在四个入口统一校验，通道层对非法 id 返回 INVALID_ARGUMENT，长度上限同时挡住 1 MB responseId 的整串回显。
- **fetch 结果在内存里有 1 小时保质期。** 上游 readCachedFetchData 会把超过 CACHE_TTL_MS（1 小时）的 fetch 结果替换成「已过期」占位，即使正文就在磁盘上。hydrateResult 因此给读回的内存副本盖上当前时间；磁盘上的 timestamp 不变，仍用于面板排序。
- **模型补全有配额，插件自己限流。** 宿主允许 8 次 pi.agent.complete/60 秒，而上游对 answer 模式是按 URL 并发（Promise.all），一次多 URL 抓取就能打光整分钟额度并连带拖垮自动总结。插件侧改成 6 次/60 秒滑窗，超额返回「N 秒后重试」的明确错误，而不是让上游包成含糊的单页失败。
- **runClairic 读的是嵌套凭据。** 上游写 credential?.auth.apiKey，可选链只护住 credential：扁平 { apiKey } 会让 auth 为 undefined，直接抛 TypeError（而不是给「未配置」提示）。适配层用 normalizeProviderAuth 把扁平形状升成上游要的嵌套形状，配好凭据后 extract 才真正走得通。
- **校验必须发生在写宿主设置之前。** 宿主 setSettings 先落值、插件随后才校验的写法，会让一个上游拒绝的配置留在宿主设置里：之后每次加载都在构建核心时失败，而能改配置的面板本身就在这个插件里，用户无法自救。saveSettings 现在先用 previewConfig 合并校验，通过后才写。

## 已知限制

- **`responseId` 跨重启有效，但有上限。** 磁盘保留最近 120 条（`src/store.ts` 的 `MAX_PERSISTED`），内存工作集仍是上游的 50 条。超出后最早的条目被删除，旧 id 会返回 "not found" 而不是错误内容。索引损坏时面板的「重建索引」会从结果文件重建。
- **`answer` 只能处理文本页面。** `pi.agent.complete` 的入参只有 `system` 与 `messages`（文本），没有图片通道；对图片或视频帧调用 answer 会返回明确错误，需要单独的抓取或视频能力。
- **`extract` 需要 Cloudflare Workers AI 凭据**，否则每次调用都返回 "not set up" 提示；且默认不在 `fetch.allowedModes` 内。
- **认证抓取（auth）未做端到端验证；视频分析不可用。** 视频帧需要把图片交给模型，而 pi.agent.complete 只收文本，所以面板把该能力标为不可用而不是「未验证」。auth 依赖浏览器登录态，需用户明确同意后才能实测，因此面板与文档都只说「未验证」。
- 面板停用某个工具后，当前会话里已注册的工具不会消失：宿主在加载期就完成了注册。重新加载插件才会生效，面板已标注。
- `web_search` 的 `includeContent: true` 在本宿主是**同步**的：没有 `startBackgroundFetch` 钩子，页面在返回前抓完，多 URL 或慢站容易接近宿主的 110 秒工具上限。
- 宿主的插件工具上限是 110 秒，比上游部分内部超时更短（单 URL 抓取 150 s、搜索路由 600 s、Datalab 300 s），因此超时由宿主先触发；插件没有额外计时，也不返回部分结果。
- 改配置会重建执行核心：`reload()` 清空内存工作集，但磁盘结果保留，下一次 `get_search_content` 会重新 hydrate。
- 免密钥 provider 的可用性依赖本机网络；面板显示的是实测结果，不是理论值。
