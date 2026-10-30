# opencode-context-observe

查看 OpenCode 实际发送给模型提供商的请求。一个服务端观察插件，两个可选查看入口：原生 TUI 和 Chrome/Edge 浏览器扩展。MIT。

## 能干什么

- 捕获 HTTP 请求正文和 WebSocket 出站帧，不改提供商地址，不需要代理或 HTTPS 解密证书。
- 默认只取、只看本次新增消息；切换到原始、逻辑或差异视图时按需获取完整详情。此前的系统提示、工具定义或消息改变时，重建完整视图并提示「前缀已变，缓存可能掉」。
- 增量、原始请求、逻辑上下文、差异四种视图，支持会话/请求类型筛选、全文搜索、复制和导出。
- 主请求、标题、压缩、生成分别记录。TUI 或浏览器面板关闭不影响服务端捕获。

运行时插件 ID 和 RPC ID 都是 `o3p.context.observe`；命令 ID 是 `o3p.context.observe.open`。包名和目录用连接符，运行时 ID 用点，两者不会自动转换。

## 构建与加载

需要 Bun 和 OpenCode v2.0.27+；开发类型固定 `@opencode/plugin@2.2.3` 与 `@opentui/* 0.8.0`。TUI 详情栏同时兼容 OpenTUI 0.6–0.8 的 ScrollBox 滚动接口。

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

在 OpenCode 服务端配置中加入仓库目录。将它放在修改请求内容的其他插件之后，观察它们修改后的结果：

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-context-observe",
      "options": { "maxRecords": 128, "maxBytes": 67108864 }
    }
  ]
}
```

Server 和 TUI 是独立入口，共用同一个 ID；TUI 从服务端插件清单发现查看入口。只需要后端时，可以在 `cli.json` 的插件列表中禁用 TUI 入口：

```jsonc
{ "plugins": ["-o3p.context.observe"] }
```

服务端 `options.enabled:false` 不注册观察 hooks 或 RPC。禁用后端后，前端会显示 RPC 不可用。

## 查看

**TUI**：发送两条消息后，输入 `/context-observe` 或从命令面板打开「上下文观察器」。会话面板按 `x` 全屏，`1–4` 切换视图，`/` 搜索，`n/N` 跳转，PgUp/PgDn 翻页，左右键横向滚动。`f` 跟随最新记录，`p` 暂停前端更新，`e` 导出详情，`E` 导出列表。导出文件在当前目录，不覆盖既有文件；Linux/macOS 新文件权限为 `0600`，Windows 使用目标目录的 NTFS 权限，请导出到私有目录。

**Chrome/Edge**：构建后，在浏览器扩展管理页开启开发者模式，加载 `extension/dist/`。打开已登录的、与 OpenCode API 同源的网页，点击扩展按钮，在当前站点启用观察器。页面右下角 `CTX` 打开查看面板。扩展只申请当前站点权限，不保存服务端密码。详见 [extension/README.md](extension/README.md)。

桌面内嵌界面不在本插件范围内；官方托管网页连接另一个远程服务器的跨源场景也不支持。

## 记录与边界

- 记录只在服务端内存保留，默认最近 128 条、压缩内容最多 64 MiB；服务端重启或插件重载会清空。超出预算的旧记录会淘汰，单条超限记录不截断，跳过保存并在服务端提示增大预算。
- 每条保留完整原始正文及独立压缩快照，所以基线淘汰后仍可查看已保留的记录。界面增量不改变模型请求，也不替提供商管理缓存。
- 「逻辑」是适配器转换前、观察 hook 所见的上下文；「原始」是请求级 hook 所见的实际出站正文。WebSocket 原文可能只有新增 `input` 和 `previous_response_id`，不会伪装成全量请求。
- 当前原始视图面向 UTF-8 JSON/文本请求与 WebSocket 文本帧；不是二进制附件或压缩传输的抓包归档。
- 采样参数或输出预算变化不会触发前缀提示。模型、提供商或路由变化会重建。
- 认证头和 URL 中的凭据不进入查询结果。正文仍可能包含用户主动提供的秘密，因此只应在可信的 OpenCode 服务上启用，导出文件也应按私密数据管理。
- 不新增模型工具、不注入提示词、不编辑记忆或宿主配置。观察失败只写无正文的服务端提示，不中断模型请求。

## 验证

原生隔离 QA 使用真实 OpenCode 二进制和本地 mock，不调用外部模型、不读取生产会话：

```sh
OPENCODE_QA_BINARY=/path/to/opencode node qa/native.mjs
```

浏览器/TUI 联合验收脚本在 `qa/`。它们使用专属临时配置与随机端口；浏览器脚本需要已安装 Chrome 和 Playwright Core，`PLAYWRIGHT_MODULE` 可指定模块路径。

本轮验证环境：Linux/WSL、官方 OpenCode v2.0.27、本地 HTTP/WebSocket mock、Chrome 148。TUI 的面板/全屏、长行横向查看、搜索与私有导出已手动验证；浏览器的 cookie 认证、扩展注入、增量/全量按需读取、重建提示与导出已通过真实浏览器驱动。无头浏览器使用专属 fixture 预授予 loopback 站点权限，首次工具栏授权弹窗未自动化；Edge 的实际运行和原生 Windows 未验证。

2026-10-30 兼容性回归：`qa/native.mjs` 在 OpenCode 2.2.3 + OpenTUI 0.8 与 2.1.2 + OpenTUI 0.6 上均通过；两个版本的 TUI 都能加载命令与观察器页面。
