import type { RequestDetail, RequestRow } from "../contract.ts"

export type Kind = RequestRow["kind"]
export type ViewMode = "incremental" | "raw" | "logical" | "diff"

export const VIEW_MODES: readonly ViewMode[] = ["incremental", "raw", "logical", "diff"]
export const VIEW_LABELS: Record<ViewMode, string> = {
  incremental: "增量",
  raw: "原始",
  logical: "逻辑",
  diff: "差异",
}
export const KIND_LABELS: Record<Kind, string> = {
  primary: "主请求",
  title: "标题",
  compaction: "压缩",
  generate: "生成",
}

/** Exact wording required by the accepted design; do not rephrase. */
export const PREFIX_CHANGED_BANNER = "前缀已变，缓存可能掉"

/** Largest detail-text search result set kept in memory. */
export const MATCH_LIMIT = 500

export interface RowFilter {
  readonly sessionID?: string
  readonly kind?: Kind
  readonly query?: string
}

export function rowMatchesQuery(row: RequestRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = [
    row.id,
    row.sessionID,
    row.parentID ?? "",
    row.title,
    row.agent,
    row.providerID,
    row.modelID,
    row.kind,
    row.transport,
    row.mode,
  ]
    .join("\n")
    .toLowerCase()
  return haystack.includes(needle)
}

export function filterRows(rows: readonly RequestRow[], filter: RowFilter): RequestRow[] {
  return rows.filter(
    (row) =>
      (filter.sessionID === undefined || row.sessionID === filter.sessionID) &&
      (filter.kind === undefined || row.kind === filter.kind) &&
      (filter.query === undefined || rowMatchesQuery(row, filter.query)),
  )
}

/** Distinct sessions present in the timeline, most recent activity first. */
export function sessionOptions(rows: readonly RequestRow[]): Array<{ sessionID: string; label: string }> {
  const seen = new Map<string, string>()
  for (const row of [...rows].sort((a, b) => b.seq - a.seq)) {
    if (!seen.has(row.sessionID)) {
      seen.set(row.sessionID, row.title || `${row.sessionID.slice(0, 12)}…`)
    }
  }
  return [...seen.entries()].map(([sessionID, label]) => ({ sessionID, label }))
}

/** Notices pinned above the detail view. The prefix banner wording is contractual. */
export function noticesFor(row: RequestRow): string[] {
  const notices: string[] = []
  if (row.prefixChanged) notices.push(`${PREFIX_CHANGED_BANNER} · 最早变更块 #${row.changedAt}`)
  if (row.missingPrevious) notices.push("未捕获到本次请求的逻辑上下文快照；逻辑/增量/差异视图可能为空")
  return notices
}

/** Pretty-print JSON when it parses; otherwise return the text untouched. */
export function pretty(text: string): string {
  if (!text) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export interface DiffLine {
  readonly type: "same" | "add" | "del"
  /** Consecutive unchanged lines are coalesced into one entry joined by \n. */
  readonly text: string
}

const DIFF_MAX_CELLS = 2_000_000
const DIFF_MAX_LINES = 6_000

function myers(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((text) => ({ type: "add", text }))
  if (m === 0) return a.map((text) => ({ type: "del", text }))
  const max = n + m
  const offset = max
  let v = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let depth = -1
  outer: for (let d = 0; d <= max; d++) {
    const current = new Int32Array(2 * max + 1)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      current[offset + k] = x
      if (x >= n && y >= m) {
        depth = d
        trace.push(current)
        break outer
      }
    }
    trace.push(current)
    v = current
  }
  const ops: DiffLine[] = []
  let x = n
  let y = m
  for (let d = depth; d > 0; d--) {
    const previous = trace[d - 1]
    const k = x - y
    const previousK =
      k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1]) ? k + 1 : k - 1
    const previousX = previous[offset + previousK]
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      ops.push({ type: "same", text: a[x - 1] })
      x--
      y--
    }
    if (x === previousX) {
      ops.push({ type: "add", text: b[y - 1] })
      y--
    } else {
      ops.push({ type: "del", text: a[x - 1] })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "same", text: a[x - 1] })
    x--
    y--
  }
  while (x > 0) {
    ops.push({ type: "del", text: a[x - 1] })
    x--
  }
  while (y > 0) {
    ops.push({ type: "add", text: b[y - 1] })
    y--
  }
  ops.reverse()
  return ops
}

/** Line diff between two texts. Common prefix/suffix is trimmed before Myers. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length > 0 ? before.split("\n") : []
  const b = after.length > 0 ? after.split("\n") : []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const lines: DiffLine[] = []
  if (start > 0) lines.push({ type: "same", text: a.slice(0, start).join("\n") })
  if (midA.length * midB.length > DIFF_MAX_CELLS || midA.length + midB.length > DIFF_MAX_LINES) {
    // Pathological middle: skip the minimal edit script and emit a plain replace.
    for (const line of midA) lines.push({ type: "del", text: line })
    for (const line of midB) lines.push({ type: "add", text: line })
  } else {
    let pending: string[] = []
    const flush = () => {
      if (pending.length > 0) lines.push({ type: "same", text: pending.join("\n") })
      pending = []
    }
    for (const op of myers(midA, midB)) {
      if (op.type === "same") pending.push(op.text)
      else {
        flush()
        lines.push(op)
      }
    }
    flush()
  }
  if (endA < a.length) lines.push({ type: "same", text: a.slice(endA).join("\n") })
  return lines
}

export function diffToText(lines: readonly DiffLine[]): string {
  return lines
    .map((line) => (line.type === "add" ? "+ " : line.type === "del" ? "- " : "  ") + line.text)
    .join("\n")
}

/** Index of the first diff line entry that is not "same", or -1. */
export function firstChangeIndex(lines: readonly DiffLine[]): number {
  return lines.findIndex((line) => line.type !== "same")
}

/** Rendered line number at which a diff entry starts (for scroll-to-change). */
export function diffLineOffset(lines: readonly DiffLine[], entryIndex: number): number {
  let line = 0
  for (let index = 0; index < entryIndex && index < lines.length; index++) {
    line += lines[index].text.split("\n").length
  }
  return line
}

export interface ViewContent {
  /** Flat text used for copy, export, and search offsets. */
  readonly text: string
  /** Structured lines for the diff view; absent for plain-text views. */
  readonly diff?: readonly DiffLine[]
  readonly notices: readonly string[]
}

export function viewContent(detail: RequestDetail, view: ViewMode): ViewContent {
  const notices = noticesFor(detail.row)
  switch (view) {
    case "incremental": {
      const text = detail.delta ? pretty(detail.delta) : ""
      const extra: string[] = []
      if (detail.row.mode !== "append") extra.push("本次请求为快照/重建：增量视图展示当前完整逻辑上下文")
      if (!text) extra.push("（无增量内容）")
      return { text, notices: [...notices, ...extra] }
    }
    case "raw": {
      // The raw view is byte-faithful: never re-format the captured wire body.
      return { text: detail.raw, notices: detail.raw ? notices : [...notices, "（未捕获到原始请求体）"] }
    }
    case "logical": {
      const text = detail.logical ? pretty(detail.logical) : ""
      return { text, notices: text ? notices : [...notices, "（未捕获到逻辑上下文快照）"] }
    }
    case "diff": {
      if (detail.previous === null) {
        const text = detail.logical ? pretty(detail.logical) : ""
        const diff: DiffLine[] = text ? [{ type: "add", text }] : []
        return { text: diffToText(diff), diff, notices: [...notices, "无前一快照：全量视为新增"] }
      }
      const diff = diffLines(pretty(detail.previous), pretty(detail.logical))
      return { text: diffToText(diff), diff, notices }
    }
  }
}

/** Segment of detail text; `hit` is the match index or -1 for plain text. */
export interface Segment {
  readonly text: string
  readonly hit: number
}

export function splitByMatches(text: string, matches: readonly number[], length: number): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  let plain = ""
  for (let index = 0; index < matches.length; index++) {
    const at = matches[index]
    if (at < cursor) continue
    plain += text.slice(cursor, at)
    if (plain) {
      segments.push({ text: plain, hit: -1 })
      plain = ""
    }
    segments.push({ text: text.slice(at, at + length), hit: index })
    cursor = at + length
  }
  plain += text.slice(cursor)
  if (plain) segments.push({ text: plain, hit: -1 })
  return segments
}

export function findMatches(text: string, query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const haystack = text.toLowerCase()
  const offsets: number[] = []
  let at = haystack.indexOf(needle)
  while (at >= 0 && offsets.length < MATCH_LIMIT) {
    offsets.push(at)
    at = haystack.indexOf(needle, at + needle.length)
  }
  return offsets
}

export function lineIndexAt(text: string, offset: number): number {
  let line = 0
  const end = Math.min(Math.max(0, offset), text.length)
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/**
 * Column of `offset` within its line, for horizontal scrolling of nowrap
 * text. Character-based; wide glyphs may be off by their extra cell.
 */
export function columnIndexAt(text: string, offset: number): number {
  const clamped = Math.min(Math.max(0, offset), text.length)
  const lineStart = clamped === 0 ? 0 : text.lastIndexOf("\n", clamped - 1) + 1
  return clamped - lineStart
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const pad2 = (value: number) => String(value).padStart(2, "0")

export function formatTime(time: number): string {
  const date = new Date(time)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** Filesystem-safe timestamp for fresh export file names. */
export function formatStamp(time: number): string {
  const date = new Date(time)
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  )
}

export function rowsToJSONL(rows: readonly RequestRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "")
}

export function detailToJSON(detail: RequestDetail): string {
  return JSON.stringify(detail, null, 2) + "\n"
}
