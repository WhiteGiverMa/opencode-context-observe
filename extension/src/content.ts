import { ObserverPanel } from "./panel.ts"
import { CSS } from "./styles.ts"

const MARKER = "__o3pContextObserver"

interface Handle {
  toggle(): void
}

function isHandle(value: unknown): value is Handle {
  return (
    typeof value === "object" &&
    value !== null &&
    "toggle" in value &&
    typeof (value as Handle).toggle === "function"
  )
}

function boot(): Handle {
  const host = document.createElement("div")
  host.id = "o3p-context-observe-host"
  host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;"
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = CSS
  shadow.append(style)
  const panel = new ObserverPanel(shadow, location.origin)
  const fab = document.createElement("button")
  fab.className = "fab"
  fab.type = "button"
  fab.textContent = "CTX"
  fab.title = "上下文观察器"
  fab.addEventListener("click", () => panel.toggle())
  shadow.append(fab)
  document.documentElement.append(host)
  return { toggle: () => panel.toggle() }
}

const existing: unknown = Reflect.get(globalThis, MARKER)
if (isHandle(existing)) existing.toggle()
else Reflect.set(globalThis, MARKER, boot())
