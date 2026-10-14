import { probeObserver } from "./probe.ts"
import { sessionFromPath } from "./client.ts"

async function main(): Promise<void> {
  const status = document.querySelector<HTMLElement>("#status")
  const originEl = document.querySelector<HTMLElement>("#origin")
  const hint = document.querySelector<HTMLElement>("#hint")
  const button = document.querySelector<HTMLButtonElement>("#attach")
  if (!status || !originEl || !hint || !button) return

  const fail = (message: string) => {
    status.textContent = message
    button.disabled = false
  }

  let tab
  try {
    ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch (error) {
    fail(`读取当前标签页失败：${error instanceof Error ? error.message : String(error)}`)
    button.disabled = true
    return
  }
  const url = tab?.url
  if (tab?.id === undefined || !url || !/^https?:\/\//.test(url)) {
    fail("当前标签页不是 http(s) 页面。")
    button.disabled = true
    return
  }
  const tabID = tab.id
  const parsed = new URL(url)
  const origin = parsed.origin
  originEl.textContent = origin
  const session = sessionFromPath(parsed.pathname)
  hint.textContent = session
    ? "检测到会话页面：面板默认过滤到当前会话。"
    : "非会话页面：面板显示该服务默认项目目录的全部请求。"

  button.addEventListener("click", async () => {
    button.disabled = true
    status.textContent = "正在请求站点权限…"
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
      if (!granted) {
        fail("未授予站点权限，无法连接该服务。")
        return
      }
      // Probe from the page's own content-script context: same-origin fetch
      // attaches the page's cookies; the extension origin never sees them.
      status.textContent = "正在页面内验证 OpenCode 服务与观察器插件…"
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabID },
        world: "ISOLATED",
        func: probeObserver,
        args: [origin, parsed.pathname],
      })
      const probe = results[0]?.result
      if (!probe) {
        fail("探针未返回结果（页面可能不允许脚本注入）。")
        return
      }
      if (!probe.ok) {
        fail(
          probe.error?.includes("rpc.unavailable") || probe.error?.includes("method_not_found")
            ? "观察器插件未在该服务启用（RPC 不可用）。"
            : `验证失败：${probe.error ?? "未知错误"}`,
        )
        return
      }
      await chrome.scripting.executeScript({ target: { tabId: tabID }, files: ["content.js"] })
      status.textContent = "已启用：页面右下角的 CTX 按钮可开关面板。"
      button.disabled = false
    } catch (error) {
      fail(`注入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

void main()
