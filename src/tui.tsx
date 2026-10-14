import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { PLUGIN_ID } from "./contract.ts"
import { ObserverView } from "./ui/view.tsx"

type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>

const PAGE_NAME = "context-observe"
const PANEL_NAME = "context-observe"

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    if (context.options.enabled === false) return

    const [previous, setPrevious] = createSignal<Route>({ type: "home" })

    const unregister = context.ui.router.register({
      name: PAGE_NAME,
      render: (input) => {
        const sessionID: unknown = input.data?.["sessionID"]
        return (
          <ObserverView
            context={context}
            sessionID={typeof sessionID === "string" ? sessionID : undefined}
            onClose={() => context.ui.router.navigate(previous())}
          />
        )
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "o3p.context.observe.open",
          title: "上下文观察器（查看发送给模型的实际上下文）",
          group: "Plugins",
          slash: { name: "context-observe" },
          palette: true,
          run() {
            const route = context.ui.router.current()
            if (route.type === "plugin" && route.name === PAGE_NAME) return
            if (route.type === "session" && context.ui.panel.open(PANEL_NAME)) return
            // The router store is mutable; retain the route before navigating.
            setPrevious({ ...route })
            context.ui.dialog.clear()
            context.ui.router.navigate({ type: "plugin", name: PAGE_NAME })
          },
        },
      ],
    }))

    const removePanel = context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL_NAME) return null
        return (
          <ObserverView
            context={context}
            sessionID={input.sessionID}
            active={() => input.focused}
            onClose={() => input.close()}
            onExpand={() => {
              const sessionID = input.sessionID
              input.close()
              const route = context.ui.router.current()
              if (!(route.type === "plugin" && route.name === PAGE_NAME)) setPrevious({ ...route })
              context.ui.dialog.clear()
              context.ui.router.navigate({ type: "plugin", name: PAGE_NAME, data: { sessionID } })
            }}
          />
        )
      },
    })

    return () => {
      unregister()
      removePanel()
    }
  },
})
