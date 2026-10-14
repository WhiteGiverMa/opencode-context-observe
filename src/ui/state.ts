import type { RequestDetail, RequestRow } from "../contract.ts"
import { filterRows, type RowFilter, type ViewMode } from "./model.ts"

export interface ListResult {
  readonly rows: readonly RequestRow[]
  readonly generation: string
}

/**
 * Minimal data contract both frontends implement: the TUI adapts
 * `ctx.client.rpc(Observer)`, the browser extension adapts same-origin fetch.
 */
export interface ObserverSource {
  list(input: { readonly after?: number; readonly sessionID?: string }): Promise<ListResult>
  detail(input: { readonly id: string; readonly full?: boolean }): Promise<RequestDetail | null>
}

export type Status = "loading" | "live" | "paused" | "error"

export type DetailEntry =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly detail: RequestDetail | null }
  | { readonly state: "error"; readonly message: string }

/** The server retains 128 rolling records; the frontend keeps a bounded margin above that. */
export const MAX_ROWS = 256
/** Detail bodies are large; cache at most the server's retention window. */
export const MAX_DETAILS = 128

/**
 * Framework-free observer state shared by the TUI and the browser panel.
 * Mutation methods fire subscribers synchronously; frontends map that to
 * their own reactivity (Solid signal bump / DOM re-render).
 */
export class ObserverState {
  private readonly listeners = new Set<() => void>()
  private rowList: RequestRow[] = []
  private ids = new Set<string>()
  private lastSeq = 0
  private refreshing = false
  private readonly detailCache = new Map<string, DetailEntry>()
  private readonly detailInFlight = new Map<string, { promise: Promise<void>; full: boolean }>()
  /** Ids whose cached detail is known to carry full bodies (raw/logical/previous). */
  private readonly fullDetails = new Set<string>()
  /** Bumped by reset(); responses started under an older epoch are discarded. */
  private epoch = 0

  generation: string | null = null
  status: Status = "loading"
  error: string | null = null
  follow = true
  paused = false
  selectedID: string | null = null
  view: ViewMode = "incremental"
  filter: RowFilter = {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  get rows(): readonly RequestRow[] {
    return this.rowList
  }

  get visibleRows(): readonly RequestRow[] {
    return filterRows(this.rowList, this.filter)
  }

  get selectedRow(): RequestRow | undefined {
    const id = this.selectedID
    return id === null ? undefined : this.rowList.find((row) => row.id === id)
  }

  detailEntry(id: string): DetailEntry | undefined {
    return this.detailCache.get(id)
  }

  /** True when the cached detail carries full bodies (raw/logical/previous). */
  isFull(id: string): boolean {
    return this.fullDetails.has(id)
  }

  /**
   * Exact-record detail snapshot for copy/export: immune to selection changes
   * that happen while an upgrade fetch is in flight.
   */
  entryDetail(id: string): RequestDetail | null | undefined {
    const entry = this.detailCache.get(id)
    return entry?.state === "ok" ? entry.detail : undefined
  }

  /**
   * Drop every locally held record (navigation to another project/location).
   * In-flight list/detail responses from before the reset are discarded via
   * the epoch check, so a stale project can never repopulate the timeline.
   */
  reset(): void {
    this.epoch++
    this.rowList = []
    this.ids = new Set()
    this.lastSeq = 0
    this.generation = null
    this.detailCache.clear()
    this.detailInFlight.clear()
    this.fullDetails.clear()
    this.selectedID = null
    this.filter = {}
    this.follow = true
    this.paused = false
    this.error = null
    this.status = "loading"
    this.emit()
  }

  /**
   * Incremental refresh. A generation change means the backend restarted:
   * local rows and cached details are dropped and re-synced from seq 0.
   * When paused this is a no-op unless `force` — the server keeps capturing.
   */
  async refresh(source: ObserverSource, options?: { readonly force?: boolean }): Promise<void> {
    if (this.refreshing) return
    if (this.paused && !options?.force) return
    const epoch = this.epoch
    this.refreshing = true
    try {
      let result = await source.list({ after: this.lastSeq })
      if (epoch !== this.epoch) return
      if (this.generation === null) {
        this.generation = result.generation
      } else if (result.generation !== this.generation) {
        this.generation = result.generation
        this.rowList = []
        this.ids = new Set()
        this.lastSeq = 0
        this.detailCache.clear()
        this.fullDetails.clear()
        result = await source.list({ after: 0 })
        if (epoch !== this.epoch) return
      }
      let added = false
      for (const row of result.rows) {
        if (this.ids.has(row.id)) continue
        this.ids.add(row.id)
        this.rowList.push(row)
        if (row.seq > this.lastSeq) this.lastSeq = row.seq
        added = true
      }
      if (added) this.rowList.sort((a, b) => a.seq - b.seq)
      // Bound local growth; the server's rolling window is smaller than this.
      while (this.rowList.length > MAX_ROWS) {
        const dropped = this.rowList.shift()
        if (!dropped) break
        this.ids.delete(dropped.id)
        this.detailCache.delete(dropped.id)
        this.fullDetails.delete(dropped.id)
      }
      this.error = null
      this.status = this.paused ? "paused" : "live"
      this.ensureSelection()
    } catch (error) {
      if (epoch !== this.epoch) return
      this.status = "error"
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.refreshing = false
      this.emit()
    }
  }

  /**
   * Fetch a detail on demand. Default is lean (full: false): append rows then
   * carry metadata + delta only. Passing full: true upgrades a lean cache
   * entry. Fullness is tracked explicitly — never inferred from body
   * truthiness, because a raw body can legitimately be empty. Snapshot and
   * rebuild rows are always full on the wire, so a lean fetch of one marks
   * the entry full immediately. A full request arriving while a lean fetch is
   * in flight awaits it and then upgrades.
   */
  loadDetail(source: ObserverSource, id: string, full = false): Promise<void> {
    const cached = this.detailCache.get(id)
    if (cached && cached.state === "ok" && (!full || this.fullDetails.has(id))) {
      return Promise.resolve()
    }
    // Errors are stable: render-driven callers must not retry in a loop.
    // Explicit user refresh goes through retryDetail.
    if (cached && cached.state === "error") return Promise.resolve()
    const pending = this.detailInFlight.get(id)
    if (pending) {
      if (!full || pending.full) return pending.promise
      return pending.promise.then(() => this.loadDetail(source, id, true))
    }
    const epoch = this.epoch
    // Keep a lean ok-entry visible while the full upgrade is in flight.
    if (!cached) this.detailCache.set(id, { state: "loading" })
    const task = (async () => {
      try {
        const detail = await source.detail({ id, full })
        if (epoch !== this.epoch) return
        this.detailCache.set(id, { state: "ok", detail })
        const row = this.rowList.find((item) => item.id === id)
        if (full || detail === null || (row !== undefined && row.mode !== "append")) {
          this.fullDetails.add(id)
        }
        // Insertion-ordered bound: evict the oldest entries, never the fresh one.
        while (this.detailCache.size > MAX_DETAILS) {
          const oldest = this.detailCache.keys().next().value
          if (oldest === undefined || oldest === id) break
          this.detailCache.delete(oldest)
          this.fullDetails.delete(oldest)
        }
      } catch (error) {
        if (epoch !== this.epoch) return
        this.detailCache.set(id, {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        this.detailInFlight.delete(id)
        this.emit()
      }
    })()
    this.detailInFlight.set(id, { promise: task, full })
    this.emit()
    return task
  }

  /** Explicit retry of an errored detail (user-triggered refresh only). */
  retryDetail(source: ObserverSource, id: string, full = false): Promise<void> {
    if (this.detailCache.get(id)?.state === "error") this.detailCache.delete(id)
    return this.loadDetail(source, id, full)
  }

  select(id: string): void {
    if (this.selectedID === id && !this.follow) return
    this.applySelection(id)
    this.follow = false
    this.emit()
  }

  selectDelta(delta: number): void {
    const visible = this.visibleRows
    if (visible.length === 0) return
    const current = visible.findIndex((row) => row.id === this.selectedID)
    const next = Math.min(visible.length - 1, Math.max(0, (current < 0 ? visible.length - 1 : current) + delta))
    this.applySelection(visible[next].id)
    this.follow = false
    this.emit()
  }

  toggleFollow(): void {
    this.follow = !this.follow
    this.ensureSelection()
    this.emit()
  }

  togglePause(): void {
    this.paused = !this.paused
    if (this.status !== "error") this.status = this.paused ? "paused" : "live"
    this.emit()
  }

  setView(view: ViewMode): void {
    this.view = view
    this.emit()
  }

  setFilter(patch: Partial<RowFilter>): void {
    this.filter = { ...this.filter, ...patch }
    this.ensureSelection()
    this.emit()
  }

  private ensureSelection(): void {
    const visible = this.visibleRows
    if (visible.length === 0) {
      this.applySelection(null)
      return
    }
    if (this.follow) {
      this.applySelection(visible[visible.length - 1].id)
      return
    }
    if (this.selectedID !== null && visible.some((row) => row.id === this.selectedID)) return
    this.applySelection(visible[visible.length - 1].id)
  }

  /**
   * Selection changes only (never a poll re-selecting the same row) apply the
   * per-record default view: a rebuilt request shows the full logical context;
   * anything else shows the increment. A manual view choice survives polls
   * because this runs only on actual selection changes.
   */
  private applySelection(id: string | null): void {
    if (id === this.selectedID) return
    this.selectedID = id
    if (id === null) return
    const row = this.rowList.find((item) => item.id === id)
    if (!row) return
    this.view = row.mode === "rebuild" && row.prefixChanged ? "logical" : "incremental"
  }
}
