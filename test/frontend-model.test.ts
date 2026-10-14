import { describe, expect, test } from "bun:test"
import type { RequestDetail, RequestRow } from "../src/contract.ts"
import {
  columnIndexAt,
  detailToJSON,
  diffLines,
  diffLineOffset,
  diffToText,
  filterRows,
  findMatches,
  firstChangeIndex,
  formatBytes,
  formatStamp,
  lineIndexAt,
  MATCH_LIMIT,
  noticesFor,
  PREFIX_CHANGED_BANNER,
  pretty,
  rowMatchesQuery,
  rowsToJSONL,
  sessionOptions,
  splitByMatches,
  viewContent,
} from "../src/ui/model.ts"

let seqCounter = 0

function makeRow(partial: Partial<RequestRow> = {}): RequestRow {
  seqCounter += 1
  return {
    id: `row-${seqCounter}`,
    seq: seqCounter,
    sessionID: "ses_a",
    parentID: null,
    title: "",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude",
    kind: "primary",
    transport: "http",
    time: 1_700_000_000_000,
    bytes: 100,
    mode: "append",
    baseID: null,
    prefixChanged: false,
    changedAt: 0,
    missingPrevious: false,
    ...partial,
  }
}

function makeDetail(partial: Partial<RequestDetail> = {}): RequestDetail {
  return {
    row: makeRow(),
    raw: "",
    logical: "",
    delta: "",
    previous: null,
    url: "https://api.example/v1/messages",
    headers: { "content-type": "application/json" },
    hash: "abc123",
    ...partial,
  }
}

describe("noticesFor", () => {
  test("prefix banner uses the exact contractual wording and shows changedAt", () => {
    const notices = noticesFor(makeRow({ prefixChanged: true, changedAt: 7 }))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(PREFIX_CHANGED_BANNER)
    expect(notices[0]).toContain("#7")
  })

  test("missing previous snapshot produces a notice", () => {
    const notices = noticesFor(makeRow({ missingPrevious: true }))
    expect(notices.some((notice) => notice.includes("未捕获"))).toBe(true)
  })

  test("plain rows have no notices", () => {
    expect(noticesFor(makeRow())).toEqual([])
  })
})

describe("pretty", () => {
  test("reformats parseable JSON", () => {
    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}')
  })
  test("passes through non-JSON and empty text untouched", () => {
    expect(pretty("not json {")).toBe("not json {")
    expect(pretty("")).toBe("")
  })
})

describe("filterRows / rowMatchesQuery", () => {
  const rows = [
    makeRow({ sessionID: "ses_a", kind: "primary", modelID: "claude", title: "fix bug" }),
    makeRow({ sessionID: "ses_b", kind: "title", modelID: "gpt", title: "" }),
    makeRow({ sessionID: "ses_a", kind: "compaction", modelID: "claude", title: "" }),
  ]

  test("filters by session and kind", () => {
    expect(filterRows(rows, { sessionID: "ses_a" })).toHaveLength(2)
    expect(filterRows(rows, { kind: "title" })).toHaveLength(1)
    expect(filterRows(rows, { sessionID: "ses_a", kind: "compaction" })).toHaveLength(1)
  })

  test("query matches metadata case-insensitively", () => {
    expect(rowMatchesQuery(rows[0], "CLAUDE")).toBe(true)
    expect(rowMatchesQuery(rows[0], "fix BUG")).toBe(true)
    expect(rowMatchesQuery(rows[0], "gpt")).toBe(false)
    expect(filterRows(rows, { query: "ses_b" })).toHaveLength(1)
  })
})

describe("sessionOptions", () => {
  test("lists distinct sessions, most recent first, title preferred", () => {
    const rows = [
      makeRow({ sessionID: "ses_old", title: "old title", seq: 1 }),
      makeRow({ sessionID: "ses_new", title: "", seq: 2 }),
      makeRow({ sessionID: "ses_old", title: "old title", seq: 3 }),
    ]
    const options = sessionOptions(rows)
    expect(options.map((option) => option.sessionID)).toEqual(["ses_old", "ses_new"])
    expect(options[0].label).toBe("old title")
    expect(options[1].label).toContain("ses_new")
  })
})

describe("diffLines", () => {
  test("identical texts produce one coalesced same block", () => {
    const lines = diffLines("a\nb\nc", "a\nb\nc")
    expect(lines).toEqual([{ type: "same", text: "a\nb\nc" }])
    expect(firstChangeIndex(lines)).toBe(-1)
  })

  test("append keeps the shared prefix and reports additions", () => {
    const lines = diffLines("a\nb", "a\nb\nc\nd")
    expect(lines).toEqual([
      { type: "same", text: "a\nb" },
      { type: "add", text: "c" },
      { type: "add", text: "d" },
    ])
    expect(firstChangeIndex(lines)).toBe(1)
  })

  test("middle edits are minimal", () => {
    const lines = diffLines("a\nb\nc", "a\nx\nc")
    expect(lines).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "same", text: "c" },
    ])
  })

  test("empty before means everything is added; empty after means deleted", () => {
    expect(diffLines("", "a\nb")).toEqual([{ type: "add", text: "a" }, { type: "add", text: "b" }])
    expect(diffLines("a", "")).toEqual([{ type: "del", text: "a" }])
    expect(diffLines("", "")).toEqual([])
  })

  test("diffToText prefixes lines for copy/export", () => {
    const text = diffToText(diffLines("a\nb", "a\nx"))
    expect(text).toBe("  a\n- b\n+ x")
  })

  test("diffLineOffset maps an entry index to its rendered line", () => {
    const lines = diffLines("a\nb\nc\nd", "a\nx\nc\nd")
    // entries: same("a"), del("b"), add("x"), same("c\nd")
    expect(firstChangeIndex(lines)).toBe(1)
    expect(diffLineOffset(lines, 1)).toBe(1)
    expect(diffLineOffset(lines, 3)).toBe(3)
  })
})

describe("viewContent", () => {
  test("raw view is byte-faithful (never re-formatted)", () => {
    const raw = '{"model":"x","messages":[]}'
    const content = viewContent(makeDetail({ raw }), "raw")
    expect(content.text).toBe(raw)
  })

  test("incremental view shows delta for append mode", () => {
    const content = viewContent(makeDetail({ delta: '[{"role":"user"}]' }), "incremental")
    expect(content.text).toContain('"role"')
    expect(content.notices).toEqual([])
  })

  test("incremental view explains snapshot/rebuild semantics", () => {
    const content = viewContent(
      makeDetail({ row: makeRow({ mode: "rebuild" }), delta: '{"a":1}' }),
      "incremental",
    )
    expect(content.notices.some((notice) => notice.includes("快照/重建"))).toBe(true)
  })

  test("logical view pretty-prints and flags empty snapshots", () => {
    const empty = viewContent(makeDetail({ logical: "" }), "logical")
    expect(empty.text).toBe("")
    expect(empty.notices.some((notice) => notice.includes("逻辑上下文"))).toBe(true)
    const full = viewContent(makeDetail({ logical: '{"system":"s"}' }), "logical")
    expect(full.text).toContain('"system": "s"')
  })

  test("diff view without a previous snapshot treats everything as added", () => {
    const content = viewContent(makeDetail({ logical: '{"a":1}', previous: null }), "diff")
    expect(content.diff).toBeDefined()
    expect(content.diff?.every((line) => line.type === "add")).toBe(true)
    expect(content.notices.some((notice) => notice.includes("无前一快照"))).toBe(true)
  })

  test("diff view compares previous vs logical", () => {
    const content = viewContent(
      makeDetail({ logical: '{"a":2}', previous: '{"a":1}' }),
      "diff",
    )
    const text = content.text
    expect(text).toContain('-   "a": 1')
    expect(text).toContain('+   "a": 2')
  })
})

describe("search helpers", () => {
  test("findMatches is case-insensitive, non-overlapping, and capped", () => {
    expect(findMatches("Aa aa aA", "aa")).toEqual([0, 3, 6])
    expect(findMatches("aaa", "aa")).toEqual([0])
    expect(findMatches("abc", "")).toEqual([])
    const dense = "ab".repeat(MATCH_LIMIT + 50)
    expect(findMatches(dense, "ab")).toHaveLength(MATCH_LIMIT)
  })

  test("lineIndexAt counts newlines before the offset", () => {
    expect(lineIndexAt("a\nb\nc", 0)).toBe(0)
    expect(lineIndexAt("a\nb\nc", 4)).toBe(2)
    expect(lineIndexAt("a\nb\nc", 100)).toBe(2)
  })

  test("columnIndexAt locates the column within the line", () => {
    expect(columnIndexAt("a\nb\nc", 0)).toBe(0)
    expect(columnIndexAt("a\nb\nc", 3)).toBe(1)
    expect(columnIndexAt("a\nb\nc", 4)).toBe(0)
    expect(columnIndexAt("a\nb\nc", 100)).toBe(1)
    // single minified line: column equals the offset
    expect(columnIndexAt('{"x":12345}', 8)).toBe(8)
  })

  test("splitByMatches reconstructs the text and tags hits", () => {
    const segments = splitByMatches("foo bar foo", [0, 8], 3)
    expect(segments.map((segment) => segment.text).join("")).toBe("foo bar foo")
    expect(segments.filter((segment) => segment.hit >= 0).map((segment) => segment.hit)).toEqual([0, 1])
  })
})

describe("export/format helpers", () => {
  test("rowsToJSONL emits one parseable row per line", () => {
    const rows = [makeRow(), makeRow()]
    const lines = rowsToJSONL(rows).trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(JSON.parse(line).id).toStartWith("row-")
    expect(rowsToJSONL([])).toBe("")
  })

  test("detailToJSON round-trips", () => {
    const detail = makeDetail({ logical: '{"a":1}' })
    const parsed: unknown = JSON.parse(detailToJSON(detail))
    expect((parsed as RequestDetail).hash).toBe("abc123")
  })

  test("formatBytes and formatStamp", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1023)).toBe("1023 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB")
    expect(formatStamp(0)).toMatch(/^\d{8}-\d{6}$/)
  })
})
