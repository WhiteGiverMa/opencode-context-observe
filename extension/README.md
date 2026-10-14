# 浏览器扩展（Chrome / Edge，MV3）

在 OpenCode 网页（`opencode web` 或任何自托管的 OpenCode app）上叠加一个
Shadow DOM 面板，查看服务端 `o3p.context.observe` 插件捕获的请求上下文。
不另起 Web 服务，不修改 OpenCode 本体。

## 构建

在仓库根目录执行 `bun run build`，产物在 `extension/dist/`：

- `manifest.json` / `popup.html` / `popup.js` — 工具栏弹窗（检测 + 注入）
- `content.js` — 面板本体（IIFE，单文件，无外部依赖）

## 安装

1. Chrome/Edge 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 开启「开发人员模式」→「加载解压缩的扩展」→ 选择 `extension/dist/`。

## 使用

1. 打开 OpenCode 网页（同源，例如 `http://localhost:4096`）。
2. 点击工具栏的扩展图标 →「在此页面启用观察器」。
   - 首次会请求该站点的可选主机权限（仅当前 origin，用户明确授予）；
   - 随后把一个自包含的探针函数注入**页面自身的隔离上下文**执行：
     同源 fetch 自动携带页面 Cookie（扩展侧永远读不到 Cookie 值），
     依次验证 `/api/session/:id` 或 `/api/location`（确认 OpenCode 服务并
     解析项目目录）与 `POST /api/rpc/o3p.context.observe/list`（确认服务端
     插件已启用），只回传 目录/错误信息 等安全元数据；
   - 探针成功后才向当前标签页注入 `content.js`。
3. 页面右下角出现 `CTX` 悬浮按钮，点击展开/收起右侧面板。
4. 面板：时间线 + 详情；会话/类型过滤；增量·原始·逻辑·差异四视图；
   跟随/暂停（暂停只停前端刷新，服务端继续捕获）；全文搜索（‹ › 跳转）；
   复制当前视图/原始请求；导出详情 JSON / 时间线 JSONL。左缘拖拽调宽。

## 数据与安全

- 所有请求均为**同源** `fetch`（`credentials: "same-origin"`），端口随页面，
  不硬编码；项目目录从 `/api/session/:id`（会话路由 `/server/:key/session/:id`）
  或 `/api/location` 解析，并通过 `?location[directory]=…` 传给 RPC。
- 捕获内容只用 textNode/textContent 渲染，不经过 innerHTML。
- 清单不含 `cookies`、不含持久化的宽泛主机权限；`http://*/*`、`https://*/*`
  仅为可选权限，且只在用户点击弹窗按钮时按当前 origin 逐一请求。
- 仅在页面 origin 与其连接的 OpenCode 服务同源时可用（例如 `opencode web`
  自托管页面）。官方托管 Web 连接远程服务的场景暂不支持。

## 重新注入

重复点击「启用」是安全的：内容脚本幂等，已注入时改为切换面板显隐。
