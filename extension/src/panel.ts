import type { RequestRow } from "../../src/contract.ts"
import {
  findMatches,
  firstChangeIndex,
  formatBytes,
  formatTime,
  KIND_LABELS,
  MATCH_LIMIT,
  sessionOptions,
  splitByMatches,
  viewContent,
  VIEW_LABELS,
  VIEW_MODES,
  type ViewMode,
} from "../../src/ui/model.ts"
import { ObserverState, type ObserverSource } from "../../src/ui/state.ts"
import { createHttpSource, resolveDirectory, sessionFromPath } from "./client.ts"

const WIDTH_KEY = "o3p.context.observe.width"
const POLL_MS = 1500
const KINDS: Array<RequestRow["kind"]> = ["primary", "title", "compaction", "generate"]

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0;"
    document.body.append(area)
    area.select()
    let ok = false
    try {
      ok = document.execCommand("copy")
    } catch {
      ok = false
    }
    area.remove()
    return ok
  }
}

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function stamp(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export class ObserverPanel {
  private readonly state = new ObserverState()
  private readonly source: ObserverSource
  private readonly origin: string
  private directory: string | null = null
  private directoryKey: string | null = null
  private activeDirectory: string | null = null
  private pageSession: string | null = null
  private userFiltered = false
  private visible = false
  private timer: number | undefined
  private searchQuery = ""
  private matchIndex = 0
  private renderedRowsKey = ""
  private renderedDetailKey = ""
  private lastDetailRowID = ""

  private readonly root: HTMLDivElement
  private readonly statusEl: HTMLElement
  private readonly followButton: HTMLButtonElement
  private readonly pauseButton: HTMLButtonElement
  private readonly sessionSelect: HTMLSelectElement
  private readonly kindSelect: HTMLSelectElement
  private readonly viewButtons: HTMLButtonElement[] = []
  private readonly searchInput: HTMLInputElement
  private readonly bannerEl: HTMLElement
  private readonly timelineEl: HTMLElement
  private readonly metaEl: HTMLElement
  private readonly detailEl: HTMLElement

  constructor(shadow: ShadowRoot, origin: string) {
    this.origin = origin
    this.source = createHttpSource(origin, () => this.directory)

    this.root = el("div", "wrap") as HTMLDivElement
    this.root.style.display = "none"
    const savedWidth = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(savedWidth) && savedWidth >= 280) this.root.style.width = `${savedWidth}px`

    const grip = el("div", "grip")
    grip.addEventListener("pointerdown", (event) => this.startResize(event))

    const top = el("div", "bar")
    top.append(el("span", "title", "上下文观察器"))
    this.statusEl = el("span", "status")
    top.append(this.statusEl)
    this.followButton = this.button("跟随", () => this.state.toggleFollow())
    this.pauseButton = this.button("暂停", () => this.state.togglePause())
    top.append(this.followButton, this.pauseButton)
    this.sessionSelect = document.createElement("select")
    this.sessionSelect.title = "按会话过滤"
    this.sessionSelect.addEventListener("change", () => {
      this.userFiltered = true
      const value = this.sessionSelect.value
      this.state.setFilter({ sessionID: value === "" ? undefined : value })
    })
    this.kindSelect = document.createElement("select")
    this.kindSelect.title = "按类型过滤"
    this.kindSelect.append(new Option("全部类型", ""))
    for (const kind of KINDS) this.kindSelect.append(new Option(KIND_LABELS[kind], kind))
    this.kindSelect.addEventListener("change", () => {
      const value = this.kindSelect.value
      this.state.setFilter({ kind: KINDS.find((kind) => kind === value) })
    })
    top.append(this.sessionSelect, this.kindSelect)
    top.append(
      this.button("刷新", () => {
        void this.state.refresh(this.source, { force: true })
        // Manual refresh also retries an errored detail once.
        const row = this.state.selectedRow
        if (row) void this.state.retryDetail(this.source, row.id, this.state.view !== "incremental")
      }),
    )
    top.append(this.button("×", () => this.hide(), "关闭面板"))

    const views = el("div", "bar views")
    VIEW_MODES.forEach((mode, index) => {
      const button = this.button(`${index + 1} ${VIEW_LABELS[mode]}`, () => this.state.setView(mode))
      this.viewButtons.push(button)
      views.append(button)
    })
    this.searchInput = document.createElement("input")
    this.searchInput.type = "text"
    this.searchInput.placeholder = "搜索当前视图"
    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput.value
      this.matchIndex = 0
      this.renderDetail(true)
    })
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.stepMatch(event.shiftKey ? -1 : 1)
    })
    views.append(this.searchInput)
    views.append(this.button("‹", () => this.stepMatch(-1), "上一个匹配"))
    views.append(this.button("›", () => this.stepMatch(1), "下一个匹配"))
    views.append(this.button("复制", () => void this.copy(false), "复制当前视图"))
    views.append(this.button("复制原始", () => void this.copy(true), "复制原始请求"))
    views.append(this.button("导出", () => void this.exportDetail(), "导出当前详情 JSON"))
    views.append(this.button("导出列表", () => this.exportRows(), "导出时间线 JSONL"))

    this.bannerEl = el("div", "banner")
    this.timelineEl = el("div", "timeline")
    this.timelineEl.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-row]") : null
      const id = target?.getAttribute("data-row")
      if (id) this.state.select(id)
    })
    this.metaEl = el("div", "meta")
    this.detailEl = el("pre", "detail")

    this.root.append(grip, top, views, this.bannerEl, this.timelineEl, this.metaEl, this.detailEl)
    shadow.append(this.root)

    this.state.subscribe(() => this.render())
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    if (this.visible) return
    this.visible = true
    this.root.style.display = "flex"
    void this.tick()
    this.timer = setInterval(() => void this.tick(), POLL_MS)
  }

  hide(): void {
    this.visible = false
    this.root.style.display = "none"
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = label
    if (title) button.title = title
    button.addEventListener("click", onClick)
    return button
  }

  private startResize(event: PointerEvent): void {
    event.preventDefault()
    const grip = event.currentTarget
    if (!(grip instanceof HTMLElement)) return
    grip.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(window.innerWidth * 0.8, Math.max(280, window.innerWidth - moveEvent.clientX))
      this.root.style.width = `${Math.round(width)}px`
    }
    const up = (upEvent: PointerEvent) => {
      grip.removeEventListener("pointermove", move)
      grip.removeEventListener("pointerup", up)
      localStorage.setItem(WIDTH_KEY, String(Math.round(window.innerWidth - upEvent.clientX)))
    }
    grip.addEventListener("pointermove", move)
    grip.addEventListener("pointerup", up)
  }

  /** Poll tick: re-resolve the directory on navigation, then refresh rows. */
  private async tick(): Promise<void> {
    const pathname = location.pathname
    const session = sessionFromPath(pathname)
    if (session !== this.pageSession) {
      this.pageSession = session
      this.directory = null
      this.directoryKey = null
    }
    const key = session ?? ""
    if (this.directory === null && this.directoryKey !== key) {
      const resolved = await resolveDirectory(this.origin, pathname)
      if (resolved) {
        this.directory = resolved
        this.directoryKey = key
      }
    }
    // Project switch: drop every record from the old location before querying
    // the new one; in-flight old-location responses are discarded by epoch.
    if (this.directory !== this.activeDirectory) {
      this.activeDirectory = this.directory
      this.state.reset()
    }
    if (!this.userFiltered) this.state.setFilter({ sessionID: session ?? undefined })
    await this.state.refresh(this.source)
  }

  private stepMatch(delta: number): void {
    const matches = this.currentMatches()
    if (matches.length === 0) return
    this.matchIndex = (this.matchIndex + delta + matches.length) % matches.length
    this.renderDetail(true)
  }

  private currentMatches(): readonly number[] {
    const content = this.currentContent()
    if (!content || !this.searchQuery.trim()) return []
    return findMatches(content.text, this.searchQuery)
  }

  private currentContent() {
    const row = this.state.selectedRow
    return row ? this.contentFor(row, this.state.view) : null
  }

  /** View content for an exact record — immune to later selection changes. */
  private contentFor(row: RequestRow, view: ViewMode) {
    const entry = this.state.detailEntry(row.id)
    if (!entry || entry.state !== "ok" || entry.detail === null) return null
    return viewContent(entry.detail, view)
  }

  private async copy(raw: boolean): Promise<void> {
    const row = this.state.selectedRow
    if (!row) return
    // Snapshot the view text at click time; selection may move while the
    // full-body upgrade below is in flight.
    const viewText = this.contentFor(row, this.state.view)?.text ?? ""
    // Raw copies and full-body views must upgrade a lean detail first.
    if (raw || this.state.view !== "incremental") {
      await this.state.loadDetail(this.source, row.id, true)
    }
    // Exact record's cache entry — never the (possibly changed) selection.
    const detail = this.state.entryDetail(row.id)
    if (!detail) return
    const text = raw ? detail.raw : viewText
    if (!text) return
    const ok = await copyText(text)
    this.flash(ok ? `已复制${raw ? "原始请求" : "当前视图"}（${formatBytes(text.length)}）` : "复制失败：剪贴板不可用")
  }

  private async exportDetail(): Promise<void> {
    const row = this.state.selectedRow
    if (!row) return
    // Snapshot identity at click time; selection may move during the upgrade.
    const seq = row.seq
    const viewAtClick = this.state.view
    // Exports always carry full bodies.
    await this.state.loadDetail(this.source, row.id, true)
    const detail = this.state.entryDetail(row.id)
    if (!detail) return
    download(
      `context-observe-${stamp(Date.now())}-seq${seq}-${viewAtClick}.json`,
      JSON.stringify(detail, null, 2) + "\n",
    )
  }

  private exportRows(): void {
    const rows = this.state.visibleRows
    if (rows.length === 0) return
    download(
      `context-observe-${stamp(Date.now())}.jsonl`,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    )
  }

  private flash(message: string): void {
    this.statusEl.textContent = message
    this.statusEl.classList.remove("error")
    setTimeout(() => this.render(), 1600)
  }

  private render(): void {
    if (!this.visible) return
    this.renderStatus()
    this.renderControls()
    this.renderSessions()
    this.renderTimeline()
    this.renderDetail(false)
  }

  private renderStatus(): void {
    const state = this.state
    let text: string
    let error = false
    if (state.status === "error") {
      text = state.error ?? "未知错误"
      if (text.includes("rpc.unavailable") || text.includes("method_not_found")) {
        text += "（服务端未启用观察器插件）"
      }
      error = true
    } else if (state.status === "loading") text = "连接中…"
    else if (state.status === "paused") text = "已暂停（服务端仍在捕获）"
    else text = `实时 · ${state.visibleRows.length} 条`
    this.statusEl.textContent = text
    this.statusEl.classList.toggle("error", error)
  }

  private renderControls(): void {
    this.followButton.classList.toggle("on", this.state.follow)
    this.pauseButton.classList.toggle("on", this.state.paused)
    this.viewButtons.forEach((button, index) => {
      button.classList.toggle("current", VIEW_MODES[index] === this.state.view)
    })
    const kind = this.state.filter.kind ?? ""
    if (this.kindSelect.value !== kind) this.kindSelect.value = kind
  }

  private renderSessions(): void {
    const options = sessionOptions(this.state.rows)
    const wanted = ["", ...options.map((option) => option.sessionID)].join("\n")
    if (this.sessionSelect.getAttribute("data-key") !== wanted) {
      this.sessionSelect.textContent = ""
      this.sessionSelect.append(new Option("全部会话", ""))
      for (const option of options) {
        this.sessionSelect.append(new Option(option.label, option.sessionID))
      }
      this.sessionSelect.setAttribute("data-key", wanted)
    }
    const current = this.state.filter.sessionID ?? ""
    if (this.sessionSelect.value !== current) this.sessionSelect.value = current
  }

  private renderTimeline(): void {
    const rows = this.state.visibleRows
    const key = rows.map((row) => `${row.id}:${row.seq}`).join("|") + "#" + String(this.state.selectedID)
    if (key === this.renderedRowsKey) return
    this.renderedRowsKey = key
    const scrollTop = this.timelineEl.scrollTop
    this.timelineEl.textContent = ""
    if (rows.length === 0) {
      this.timelineEl.append(el("div", "row", "暂无捕获的请求。观察器后端是否已启用？"))
      return
    }
    const fragment = document.createDocumentFragment()
    for (const row of rows) {
      const line = el("div", "row")
      if (row.id === this.state.selectedID) line.classList.add("selected")
      line.setAttribute("data-row", row.id)
      const marker = row.prefixChanged ? "⚠" : row.missingPrevious ? "○" : " "
      const text = `${marker} #${row.seq} ${formatTime(row.time)} ${KIND_LABELS[row.kind]} ${row.providerID}/${row.modelID} ${row.mode} ${formatBytes(row.bytes)}${row.transport === "websocket" ? " ws" : ""}`
      if (row.prefixChanged) {
        line.append(el("span", "warn", "⚠"))
        line.append(document.createTextNode(text.slice(1)))
      } else {
        line.textContent = text
      }
      line.title = `${row.title || row.sessionID}\n${row.agent} · ${row.mode}/${row.transport}`
      fragment.append(line)
    }
    this.timelineEl.append(fragment)
    const selected = this.timelineEl.querySelector(".row.selected")
    if (this.state.follow && selected instanceof HTMLElement) selected.scrollIntoView({ block: "nearest" })
    else this.timelineEl.scrollTop = scrollTop
  }

  private renderDetail(force: boolean): void {
    const state = this.state
    const row = state.selectedRow
    // Every view except the incremental default needs full bodies.
    const wantFull = state.view !== "incremental"
    if (row) void state.loadDetail(this.source, row.id, wantFull)
    const entry = row ? state.detailEntry(row.id) : undefined
    const detailKey = `${row?.id ?? ""}:${state.view}:${entry?.state ?? "none"}:${wantFull && row ? state.isFull(row.id) : ""}:${this.searchQuery}:${this.matchIndex}`
    if (!force && detailKey === this.renderedDetailKey) return
    this.renderedDetailKey = detailKey

    // Banner mirrors the exact TUI semantics, including the fixed prefix wording.
    const content = this.currentContent()
    const notices = content?.notices ?? (row ? [] : [])
    this.bannerEl.textContent = notices.join("\n")
    this.bannerEl.classList.toggle("show", notices.length > 0)

    this.metaEl.textContent = row
      ? `#${row.seq} · ${row.agent} · ${row.providerID}/${row.modelID} · ${formatTime(row.time)} · ${formatBytes(row.bytes)} · ${row.mode}/${row.transport}`
      : ""

    this.detailEl.textContent = ""
    if (!row) {
      this.detailEl.append(el("span", "empty", "选择上方请求查看详情"))
      return
    }
    if (!entry || entry.state === "loading") {
      this.detailEl.append(el("span", "empty", "加载中…"))
      return
    }
    if (entry.state === "error") {
      this.detailEl.append(el("span", "empty", `加载失败：${entry.message}`))
      return
    }
    if (entry.detail === null) {
      this.detailEl.append(el("span", "empty", "记录已被淘汰或不存在"))
      return
    }
    // Lean entry but this view needs full bodies and the upgrade is pending.
    if (wantFull && !state.isFull(row.id)) {
      this.detailEl.append(el("span", "empty", "加载完整上下文…"))
      return
    }
    if (!content) return
    const matches = this.currentMatches()
    const queryLength = this.searchQuery.trim().length

    if (content.diff) {
      const fragment = document.createDocumentFragment()
      for (const line of content.diff) {
        const div = el("div", `dline ${line.type}`)
        const prefix = line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "
        div.append(document.createTextNode(prefix + line.text))
        fragment.append(div)
      }
      this.detailEl.append(fragment)
      // Newly opened record: jump to the first change (not on every poll).
      if (!this.searchQuery.trim() && row.id !== this.lastDetailRowID) {
        const first = firstChangeIndex(content.diff)
        if (first > 0) {
          const target = this.detailEl.children.item(first)
          if (target instanceof HTMLElement) target.scrollIntoView({ block: "center" })
        }
      }
    } else if (matches.length > 0 && queryLength > 0) {
      let currentMark: HTMLElement | null = null
      for (const segment of splitByMatches(content.text, matches, queryLength)) {
        if (segment.hit < 0) this.detailEl.append(document.createTextNode(segment.text))
        else {
          const mark = el("mark", segment.hit === this.matchIndex ? "now" : undefined, segment.text)
          if (segment.hit === this.matchIndex) currentMark = mark
          this.detailEl.append(mark)
        }
      }
      currentMark?.scrollIntoView({ block: "center" })
    } else {
      this.detailEl.append(document.createTextNode(content.text))
    }
    if (this.searchQuery.trim()) {
      const count = matches.length
      this.metaEl.textContent += ` · 匹配 ${count}${count >= MATCH_LIMIT ? "+" : ""} 处`
    }
    this.lastDetailRowID = row.id
  }
}
