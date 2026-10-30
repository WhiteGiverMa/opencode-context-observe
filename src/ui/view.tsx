import { openSync, writeSync, closeSync } from "node:fs"
import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Observer, type RequestRow } from "../contract.ts"
import {
  diffLineOffset,
  findMatches,
  firstChangeIndex,
  formatBytes,
  formatStamp,
  formatTime,
  KIND_LABELS,
  lineIndexAt,
  MATCH_LIMIT,
  sessionOptions,
  splitByMatches,
  viewContent,
  VIEW_LABELS,
  VIEW_MODES,
  type DiffLine,
  type ViewMode,
} from "./model.ts"
import { panScrollBoxX } from "./scroll.ts"
import { ObserverState, type ObserverSource } from "./state.ts"
import { contentWidth, displayColumnAt } from "./width.ts"

type Theme = Plugin.Context["theme"]

export function createSource(context: Plugin.Context): ObserverSource {
  const rpc = context.client.rpc(Observer)
  const directory = context.location?.directory
  const location = directory === undefined ? undefined : { directory }
  return {
    list: (input) => rpc.list(input, { location }),
    detail: (input) => rpc.detail({ id: input.id, full: input.full }, { location }),
  }
}

function TimelineRow(props: { row: RequestRow; selected: () => boolean; theme: Theme }) {
  const marker = () =>
    props.row.prefixChanged ? "⚠" : props.row.missingPrevious ? "○" : props.selected() ? "▸" : " "
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={1}
      backgroundColor={props.selected() ? props.theme.background.raised.high : undefined}
    >
      <text
        fg={props.selected() ? props.theme.text.base : props.theme.text.muted}
        wrapMode="none"
        selectable={false}
      >
        {`${marker()} #${props.row.seq} ${formatTime(props.row.time)} ${KIND_LABELS[props.row.kind]} ${props.row.providerID}/${props.row.modelID} ${props.row.mode} ${formatBytes(props.row.bytes)}${props.row.transport === "websocket" ? " ws" : ""}`}
      </text>
    </box>
  )
}

function HighlightedText(props: {
  text: string
  matches: readonly number[]
  queryLength: number
  current: number
  theme: Theme
}) {
  const segments = createMemo(() => splitByMatches(props.text, props.matches, props.queryLength))
  return (
    <text wrapMode="none">
      <For each={segments()}>
        {(segment) => (
          <Show when={segment.hit >= 0} fallback={segment.text}>
            <span
              style={{
                fg: props.theme.text.base,
                bg:
                  segment.hit === props.current
                    ? props.theme.background.feedback.warning.base
                    : props.theme.background.raised.max,
              }}
            >
              {segment.text}
            </span>
          </Show>
        )}
      </For>
    </text>
  )
}

function DiffText(props: { lines: readonly DiffLine[]; theme: Theme }) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={props.lines}>
        {(line) => (
          <text
            wrapMode="none"
            fg={
              line.type === "add"
                ? props.theme.diff.text.added
                : line.type === "del"
                  ? props.theme.diff.text.removed
                  : props.theme.diff.text.context
            }
          >
            {(line.type === "add" ? "+ " : line.type === "del" ? "- " : "  ") + line.text}
          </text>
        )}
      </For>
    </box>
  )
}

export interface ObserverViewProps {
  readonly context: Plugin.Context
  /** Pre-filter to one session (panel mode / deep link from a session). */
  readonly sessionID?: string
  readonly onClose: () => void
  /** Panel only: jump to the fullscreen router page. */
  readonly onExpand?: () => void
  /** Panel only: gate keybinds on host focus. */
  readonly active?: () => boolean
}

export function ObserverView(props: ObserverViewProps) {
  const context = props.context
  const theme = context.theme
  const dimensions = useTerminalDimensions()
  const state = new ObserverState()
  if (props.sessionID !== undefined) state.filter = { sessionID: props.sessionID }
  const source = createSource(context)
  const [revision, setRevision] = createSignal(0)
  const unsubscribe = state.subscribe(() => setRevision((value) => value + 1))
  const [query, setQuery] = createSignal("")
  const [matchIndex, setMatchIndex] = createSignal(0)
  let timelineScroll: ScrollBoxRenderable | undefined
  let detailScroll: ScrollBoxRenderable | undefined

  onMount(() => {
    void state.refresh(source)
    const timer = setInterval(() => void state.refresh(source), 1500)
    const offEvents = context.client.rpc(Observer).events.on("updated", () => void state.refresh(source))
    onCleanup(() => {
      clearInterval(timer)
      offEvents()
      unsubscribe()
    })
  })

  const rows = createMemo(() => {
    revision()
    return state.visibleRows
  })
  const selected = createMemo(() => {
    revision()
    return state.selectedRow
  })
  const selectedID = createMemo(() => {
    revision()
    return state.selectedID
  })
  const view = createMemo(() => {
    revision()
    return state.view
  })
  /** Full bodies are needed by every view except the incremental default. */
  const wantFull = createMemo(() => view() !== "incremental")
  const status = createMemo(() => {
    revision()
    return state.status
  })
  const detailState = createMemo(() => {
    revision()
    const row = selected()
    const entry = row ? state.detailEntry(row.id) : undefined
    // A lean entry must not render as an empty raw/logical/diff view while
    // the full upgrade is still in flight.
    if (entry?.state === "ok" && entry.detail !== null && row && wantFull() && !state.isFull(row.id)) {
      return "loading"
    }
    return entry?.state ?? "loading"
  })
  const detailError = createMemo(() => {
    revision()
    const row = selected()
    const entry = row ? state.detailEntry(row.id) : undefined
    return entry?.state === "error" ? entry.message : ""
  })
  const detail = createMemo(() => {
    revision()
    const row = selected()
    const entry = row ? state.detailEntry(row.id) : undefined
    return entry?.state === "ok" ? entry.detail : undefined
  })
  createEffect(() => {
    const row = selected()
    const full = wantFull()
    if (row) void state.loadDetail(source, row.id, full)
  })
  const content = createMemo(() => {
    revision()
    const current = detail()
    return current ? viewContent(current, state.view) : null
  })
  // Intrinsic width of the widest displayed line, memoized per content text.
  // The detail wrapper gets this width with flexShrink 0 so the text renders
  // at full width inside the scrollbox content (which the Solid reconciler
  // keeps clamped to the viewport: on 0.7 and earlier ScrollBoxRenderable's
  // scrollX option is constructor-only, while the reconciler sets props after
  // construction).
  const detailWidth = createMemo(() => {
    const current = content()
    return current ? contentWidth(current.text) : 1
  })
  // Horizontal panning is manual on the old renderer (content.translateX) and
  // native on 0.8+ (scrollX + scrollTo); panScrollBoxX picks the host's form.
  const [detailX, setDetailX] = createSignal(0)
  const maxDetailX = () => {
    dimensions()
    const viewport = detailScroll?.viewport.width ?? 0
    return Math.max(0, detailWidth() + 1 - viewport)
  }
  const panDetail = (dx: number) => {
    setDetailX((x) => Math.min(maxDetailX(), Math.max(0, x + dx)))
  }
  createEffect(() => {
    const box = detailScroll
    if (!box) return
    const x = Math.min(detailX(), maxDetailX())
    if (x !== detailX()) setDetailX(x)
    panScrollBoxX(box, x)
  })
  const notices = createMemo((): readonly string[] => content()?.notices ?? [])
  const matches = createMemo(() => {
    const current = content()
    const needle = query()
    return current && needle ? findMatches(current.text, needle) : []
  })

  // Keep the selected timeline row visible.
  createEffect(() => {
    const list = rows()
    const id = selectedID()
    const index = list.findIndex((row) => row.id === id)
    const box = timelineScroll
    if (index < 0 || !box) return
    const top = box.scrollTop
    const height = Math.max(1, box.height - 2)
    if (index < top) box.scrollTo({ x: 0, y: index })
    else if (index >= top + height) box.scrollTo({ x: 0, y: index - height + 1 })
  })

  // Keep the current search match visible; with no query and a diff view,
  // jump to the first change once per newly selected record. Horizontal
  // positioning pans via translateX (see detailX above).
  let lastDetailScrollKey = ""
  createEffect(() => {
    const list = matches()
    const current = content()
    const box = detailScroll
    if (!box || !current) return
    const key = `${state.selectedID ?? ""}:${state.view}`
    if (key !== lastDetailScrollKey) setDetailX(0)
    if (list.length > 0) {
      const index = Math.min(matchIndex(), list.length - 1)
      const offset = list[index]
      // No-wrap text: bring both the row and the (display-cell) column of
      // the match into view.
      setDetailX(Math.min(maxDetailX(), Math.max(0, displayColumnAt(current.text, offset) - 4)))
      box.scrollTo({ x: 0, y: Math.max(0, lineIndexAt(current.text, offset) - 2) })
    } else if (current.diff && key !== lastDetailScrollKey) {
      const first = firstChangeIndex(current.diff)
      if (first >= 0) box.scrollTo({ x: 0, y: Math.max(0, diffLineOffset(current.diff, first) - 2) })
    }
    lastDetailScrollKey = key
  })

  const stepMatch = (delta: number) => {
    const list = matches()
    if (list.length === 0) return
    setMatchIndex((index) => (index + delta + list.length) % list.length)
  }

  const search = async () => {
    const value = await context.ui.dialog.prompt({
      title: "搜索当前视图",
      placeholder: "在详情全文中查找（不截断）",
      value: query(),
    })
    if (value === undefined) return
    setQuery(value)
    setMatchIndex(0)
  }

  const pickSession = async () => {
    revision()
    const value = await context.ui.dialog.select<string>({
      title: "按会话过滤",
      options: [
        { title: "全部会话", value: "" },
        ...sessionOptions(state.rows).map((option) => ({
          title: option.label,
          value: option.sessionID,
          description: option.sessionID,
        })),
      ],
      current: state.filter.sessionID ?? "",
    })
    if (value === undefined) return
    state.setFilter({ sessionID: value === "" ? undefined : value })
  }

  const pickKind = async () => {
    const kinds: Array<RequestRow["kind"]> = ["primary", "title", "compaction", "generate"]
    const value = await context.ui.dialog.select<RequestRow["kind"] | "">({
      title: "按类型过滤",
      options: [
        { title: "全部类型", value: "" },
        ...kinds.map((kind) => ({ title: KIND_LABELS[kind], value: kind })),
      ],
      current: state.filter.kind ?? "",
    })
    if (value === undefined) return
    state.setFilter({ kind: value === "" ? undefined : value })
  }

  const copy = async (raw: boolean) => {
    const row = selected()
    if (!row) return
    // Snapshot the view text at click time; the selection may change while
    // the full-body upgrade below is in flight.
    const viewText = content()?.text ?? ""
    // Raw copies and full-body views must upgrade a lean detail first.
    if (raw || wantFull()) await state.loadDetail(source, row.id, true)
    // Read the exact record's cache entry — never the (possibly changed)
    // current selection.
    const current = state.entryDetail(row.id)
    if (!current) return
    const text = raw ? current.raw : viewText
    if (!text) {
      context.ui.toast.show({ message: "当前视图没有可复制的内容", variant: "warning" })
      return
    }
    const ok = context.renderer.copyToClipboardOSC52(text)
    context.ui.toast.show({
      message: ok
        ? `已复制${raw ? "原始请求" : "当前视图"}（${formatBytes(text.length)}）`
        : "剪贴板不可用（OSC52 写入失败）",
      variant: ok ? "success" : "error",
    })
  }

  const writeFresh = (name: string, text: string): string => {
    const path = `${process.cwd()}/${name}`
    // Captures are private: fresh file only ("wx"), owner-read/write only (0o600).
    const fd = openSync(path, "wx", 0o600)
    try {
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
    return path
  }

  const exportDetail = async () => {
    const row = selected()
    if (!row) return
    // Snapshot identity at click time; selection may move during the upgrade.
    const seq = row.seq
    const viewAtClick = state.view
    // Exports always carry full bodies.
    await state.loadDetail(source, row.id, true)
    const current = state.entryDetail(row.id)
    if (!current) return
    try {
      const path = writeFresh(
        `context-observe-${formatStamp(Date.now())}-seq${seq}-${viewAtClick}.json`,
        JSON.stringify(current, null, 2) + "\n",
      )
      context.ui.toast.show({ message: `已导出 ${context.ui.format.path(path)}`, variant: "success" })
    } catch (error) {
      context.ui.toast.show({
        message: `导出失败：${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
      })
    }
  }

  const exportRows = () => {
    const list = rows()
    if (list.length === 0) return
    try {
      const path = writeFresh(
        `context-observe-${formatStamp(Date.now())}.jsonl`,
        list.map((row) => JSON.stringify(row)).join("\n") + "\n",
      )
      context.ui.toast.show({
        message: `已导出 ${list.length} 行到 ${context.ui.format.path(path)}`,
        variant: "success",
      })
    } catch (error) {
      context.ui.toast.show({
        message: `导出失败：${error instanceof Error ? error.message : String(error)}`,
        variant: "error",
      })
    }
  }

  const cycleView = () => {
    const index = VIEW_MODES.indexOf(state.view)
    state.setView(VIEW_MODES[(index + 1) % VIEW_MODES.length])
  }

  // Detail pane scrolling. ↑/↓/j/k belong to timeline selection, so the
  // detail pane uses pageup/pagedown vertically (native scrollbox) and ←/→
  // horizontally (manual translateX pan) — required because raw wire bodies
  // are single minified lines.
  const scrollDetail = (dx: number, dy: number) => {
    const box = detailScroll
    if (!box) return
    if (dx !== 0) panDetail(dx)
    if (dy !== 0) box.scrollBy({ x: 0, y: dy })
  }
  const detailPage = () => Math.max(1, (detailScroll?.height ?? 10) - 2)

  context.keymap.layer(() => ({
    enabled: props.active ?? true,
    commands: [
      { bind: "escape", title: "close", run: () => props.onClose() },
      { bind: "up", run: () => state.selectDelta(-1) },
      { bind: "k", run: () => state.selectDelta(-1) },
      { bind: "down", run: () => state.selectDelta(1) },
      { bind: "j", run: () => state.selectDelta(1) },
      { bind: "1", run: () => state.setView("incremental") },
      { bind: "2", run: () => state.setView("raw") },
      { bind: "3", run: () => state.setView("logical") },
      { bind: "4", run: () => state.setView("diff") },
      { bind: "tab", run: cycleView },
      { bind: "f", title: "follow", run: () => state.toggleFollow() },
      { bind: "p", title: "pause", run: () => state.togglePause() },
      { bind: "r", title: "refresh", run: () => {
          void state.refresh(source, { force: true })
          // Manual refresh also retries an errored detail once.
          const row = selected()
          if (row) void state.retryDetail(source, row.id, wantFull())
        } },
      { bind: "/", title: "search", run: () => void search() },
      { bind: "n", run: () => stepMatch(1) },
      { bind: "shift+n", run: () => stepMatch(-1) },
      { bind: "pageup", title: "detail page up", run: () => scrollDetail(0, -detailPage()) },
      { bind: "pagedown", title: "detail page down", run: () => scrollDetail(0, detailPage()) },
      { bind: "left", title: "detail scroll left", run: () => scrollDetail(-16, 0) },
      { bind: "right", title: "detail scroll right", run: () => scrollDetail(16, 0) },
      { bind: "s", title: "session filter", run: () => void pickSession() },
      { bind: "t", title: "kind filter", run: () => void pickKind() },
      { bind: "c", title: "copy view", run: () => void copy(false) },
      { bind: "shift+c", title: "copy raw", run: () => void copy(true) },
      { bind: "e", title: "export detail", run: () => void exportDetail() },
      { bind: "shift+e", title: "export rows", run: exportRows },
      ...(props.onExpand ? [{ bind: "x", title: "fullscreen", run: () => props.onExpand?.() }] : []),
    ],
  }))

  const statusText = () => {
    revision()
    const parts: string[] = []
    if (state.status === "error") parts.push(`错误: ${state.error ?? "未知"}`)
    else if (state.status === "loading") parts.push("连接中…")
    else if (state.status === "paused") parts.push("已暂停（服务端仍在捕获）")
    else parts.push("实时")
    parts.push(state.follow ? "跟随" : "手动")
    parts.push(`会话:${state.filter.sessionID ? "当前" : "全部"}`)
    parts.push(`类型:${state.filter.kind ? KIND_LABELS[state.filter.kind] : "全部"}`)
    parts.push(`${rows().length} 条`)
    if (query()) parts.push(`匹配 ${matches().length}${matches().length >= MATCH_LIMIT ? "+" : ""} 处`)
    return parts.join(" · ")
  }

  const wide = () => dimensions().width >= 110

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background.base}>
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="none">
          上下文观察器
        </text>
        <text fg={status() === "error" ? theme.text.feedback.error.base : theme.text.muted} wrapMode="none">
          {statusText()}
        </text>
      </box>
      <Show when={notices().length > 0}>
        <box flexShrink={0} flexDirection="column" paddingLeft={1}>
          <For each={notices()}>
            {(notice) => (
              <text fg={theme.text.feedback.warning.base} wrapMode="none">
                {"⚠ " + notice}
              </text>
            )}
          </For>
        </box>
      </Show>
      <box flexGrow={1} minHeight={0} flexDirection={wide() ? "row" : "column"}>
        <box
          flexDirection="column"
          flexShrink={0}
          width={wide() ? "42%" : "100%"}
          height={wide() ? "100%" : 12}
          minHeight={0}
        >
          <scrollbox ref={(box: ScrollBoxRenderable) => (timelineScroll = box)} flexGrow={1} viewportCulling>
            <Show
              when={rows().length > 0}
              fallback={
                <box paddingLeft={1}>
                  <text fg={theme.text.muted}>暂无捕获的请求。观察器后端是否已启用？</text>
                </box>
              }
            >
              <For each={rows()}>
                {(row) => <TimelineRow row={row} selected={() => selectedID() === row.id} theme={theme} />}
              </For>
            </Show>
          </scrollbox>
        </box>
        <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0}>
          <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} gap={2}>
            <For each={VIEW_MODES}>
              {(mode: ViewMode) => (
                <text
                  fg={view() === mode ? theme.text.base : theme.text.muted}
                  attributes={view() === mode ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {`${VIEW_MODES.indexOf(mode) + 1} ${VIEW_LABELS[mode]}`}
                </text>
              )}
            </For>
            <box flexGrow={1} />
            <Show when={selected()}>
              {(row) => (
                <text fg={theme.text.muted} wrapMode="none">
                  {`#${row().seq} ${row().agent} · ${row().mode}/${row().transport}`}
                </text>
              )}
            </Show>
          </box>
          <scrollbox ref={(box: ScrollBoxRenderable) => (detailScroll = box)} flexGrow={1} minHeight={0}>
            <Show
              when={selected()}
              fallback={
                <box paddingLeft={1}>
                  <text fg={theme.text.muted}>选择一条请求查看详情</text>
                </box>
              }
            >
              <Show
                when={detailState() !== "loading"}
                fallback={
                  <box paddingLeft={1}>
                    <text fg={theme.text.muted}>加载中…</text>
                  </box>
                }
              >
                <Show
                  when={detailState() !== "error"}
                  fallback={
                    <box paddingLeft={1}>
                      <text fg={theme.text.feedback.error.base}>{`加载失败：${detailError()}`}</text>
                    </box>
                  }
                >
                  <Show
                    when={detail() !== null && detail() !== undefined}
                    fallback={
                      <box paddingLeft={1}>
                        <text fg={theme.text.muted}>记录已被淘汰或不存在</text>
                      </box>
                    }
                  >
                    <Show when={content()} keyed>
                      {(current) => (
                        <box flexDirection="column" paddingLeft={1} width={detailWidth()} flexShrink={0}>
                          <Show
                            when={current.diff}
                            fallback={
                              <HighlightedText
                                text={current.text}
                                matches={matches()}
                                queryLength={query().trim().length}
                                current={Math.min(matchIndex(), Math.max(0, matches().length - 1))}
                                theme={theme}
                              />
                            }
                          >
                            {(lines) => <DiffText lines={lines()} theme={theme} />}
                          </Show>
                        </box>
                      )}
                    </Show>
                  </Show>
                </Show>
              </Show>
            </Show>
          </scrollbox>
        </box>
      </box>
      <box height={2} flexShrink={0} paddingLeft={1} flexDirection="column">
        <text fg={theme.text.muted} wrapMode="none" selectable={false}>
          {"↑↓/jk 选择 · 1-4 视图 · tab 切换 · pgup/pgdn 详情翻页 · ←→ 详情横向 · / 搜索 · n/N 跳转"}
        </text>
        <text fg={theme.text.muted} wrapMode="none" selectable={false}>
          {props.onExpand
            ? "f 跟随 · p 暂停 · r 刷新 · s 会话 · t 类型 · c/C 复制 · e/E 导出 · x 全屏 · esc 关闭"
            : "f 跟随 · p 暂停 · r 刷新 · s 会话 · t 类型 · c/C 复制 · e/E 导出 · esc 返回"}
        </text>
      </box>
    </box>
  )
}
