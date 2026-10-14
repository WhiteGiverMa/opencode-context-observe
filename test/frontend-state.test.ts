import { describe, expect, test } from "bun:test"
import { createHttpSource, resolveDirectory, RPC_ID, sessionFromPath } from "../extension/src/client.ts"
import { probeObserver } from "../extension/src/probe.ts"
import { validateDetail, validateListResult } from "../extension/src/validate.ts"
import { PLUGIN_ID } from "../src/contract.ts"
import type { RequestDetail, RequestRow } from "../src/contract.ts"
import { MAX_DETAILS, MAX_ROWS, ObserverState, type ObserverSource } from "../src/ui/state.ts"

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

function makeDetail(row: RequestRow): RequestDetail {
  return {
    row,
    raw: "{}",
    logical: "{}",
    delta: "[]",
    previous: null,
    url: "https://api.example/v1/messages",
    headers: {},
    hash: "hash",
  }
}

class FakeSource implements ObserverSource {
  generation = "g1"
  rows: RequestRow[] = []
  details = new Map<string, RequestDetail>()
  listCalls: Array<{ after?: number; sessionID?: string }> = []
  detailCalls: Array<{ id: string; full?: boolean }> = []
  failNext: Error | null = null

  list(input: { after?: number; sessionID?: string }): Promise<{ rows: RequestRow[]; generation: string }> {
    this.listCalls.push({ ...input })
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      return Promise.reject(error)
    }
    const after = input.after ?? 0
    return Promise.resolve({
      rows: this.rows.filter((row) => row.seq > after),
      generation: this.generation,
    })
  }

  /** Mirrors the backend: lean responses (full falsy) only exist for append rows. */
  detail(input: { id: string; full?: boolean }): Promise<RequestDetail | null> {
    this.detailCalls.push({ ...input })
    const detail = this.details.get(input.id) ?? null
    if (!detail) return Promise.resolve(null)
    if (!input.full && detail.row.mode === "append") {
      return Promise.resolve({ ...detail, raw: "", logical: "", previous: null })
    }
    return Promise.resolve(detail)
  }
}

test("extension RPC id matches the shared contract", () => {
  expect(RPC_ID).toBe(PLUGIN_ID)
})

test("self-contained probe embeds the contractual RPC id literally", async () => {
  // The probe is serialized via Function.prototype.toString into the page, so
  // it must inline the id; guard the literal against drift from the contract.
  const source = await Bun.file(new URL("../extension/src/probe.ts", import.meta.url)).text()
  expect(source).toContain(`/api/rpc/${PLUGIN_ID}/list`)
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Stub globalThis.fetch for the duration of fn (probe runs against it in tests). */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  const mock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)
  globalThis.fetch = Object.assign(mock, { preconnect: original.preconnect })
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

describe("sessionFromPath", () => {
  test("parses the app session route and decodes the id", () => {
    expect(sessionFromPath("/server/local/session/ses_123")).toBe("ses_123")
    expect(sessionFromPath("/server/my%20srv/session/ses_%2F")).toBe("ses_/")
  })
  test("returns null off the session route", () => {
    expect(sessionFromPath("/")).toBeNull()
    expect(sessionFromPath("/settings")).toBeNull()
    expect(sessionFromPath("/server/local")).toBeNull()
  })
})

describe("createHttpSource wire shape", () => {
  test("posts {input} to the RPC route with deepObject location query", async () => {
    const seen: { url?: string; body?: unknown } = {}
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.url = request.url
        seen.body = await request.json()
        return Response.json({ output: { rows: [], generation: "g" } })
      },
    })
    try {
      const source = createHttpSource(`http://127.0.0.1:${server.port}`, () => "/proj/dir")
      const result = await source.list({ after: 3 })
      expect(result.generation).toBe("g")
      if (!seen.url) throw new Error("server saw no request")
      const url = new URL(seen.url)
      expect(url.pathname).toBe(`/api/rpc/${RPC_ID}/list`)
      expect(url.searchParams.get("location[directory]")).toBe("/proj/dir")
      expect(seen.body).toEqual({ input: { after: 3 } })
    } finally {
      server.stop(true)
    }
  })

  test("omits the location query when no directory is known", async () => {
    const seen: { url?: string; body?: unknown } = {}
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.url = request.url
        seen.body = await request.json()
        return Response.json({ output: null })
      },
    })
    try {
      const source = createHttpSource(`http://127.0.0.1:${server.port}`, () => null)
      await source.detail({ id: "row-1", full: false })
      if (!seen.url) throw new Error("server saw no request")
      const url = new URL(seen.url)
      expect(url.pathname).toBe(`/api/rpc/${RPC_ID}/detail`)
      expect(url.search).toBe("")
      // The default incremental path must travel lean.
      expect(seen.body).toEqual({ input: { id: "row-1", full: false } })
    } finally {
      server.stop(true)
    }
  })

  test("passes full:true through to the wire for upgrades", async () => {
    const seen: { body?: unknown } = {}
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.body = await request.json()
        return Response.json({ output: null })
      },
    })
    try {
      const source = createHttpSource(`http://127.0.0.1:${server.port}`, () => "/proj")
      await source.detail({ id: "row-1", full: true })
      expect(seen.body).toEqual({ input: { id: "row-1", full: true } })
    } finally {
      server.stop(true)
    }
  })

  test("surfaces rpc error bodies with type and message", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { _tag: "RpcError", type: "rpc.unavailable", message: "no handler at location" },
          { status: 400 },
        ),
    })
    try {
      const source = createHttpSource(`http://127.0.0.1:${server.port}`, () => "/proj/dir")
      await expect(source.list({})).rejects.toThrow("rpc.unavailable: no handler at location")
    } finally {
      server.stop(true)
    }
  })
})

describe("resolveDirectory", () => {
  test("native envelope: session.get wraps Session.Info in { data }", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/session/ses_1") {
          // Native shape: { data: PublicSessionInfo }
          return Response.json({ data: { id: "ses_1", location: { directory: "/work/project-a" } } })
        }
        return Response.json({ directory: "/default" })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      // The session's own project must win over the differing server default.
      expect(await resolveDirectory(origin, "/server/local/session/ses_1")).toBe("/work/project-a")
      expect(await resolveDirectory(origin, "/")).toBe("/default")
    } finally {
      server.stop(true)
    }
  })

  test("direct (unwrapped) Session.Info remains supported", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/session/ses_1") {
          return Response.json({ id: "ses_1", location: { directory: "/work/project-b" } })
        }
        return Response.json({ directory: "/default" })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      expect(await resolveDirectory(origin, "/server/local/session/ses_1")).toBe("/work/project-b")
    } finally {
      server.stop(true)
    }
  })

  test("returns null when nothing looks like an OpenCode server", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) })
    try {
      expect(await resolveDirectory(`http://127.0.0.1:${server.port}`, "/")).toBeNull()
    } finally {
      server.stop(true)
    }
  })
})

test("TUI entrypoint registers the contractual command id", async () => {
  const source = await Bun.file(new URL("../src/tui.tsx", import.meta.url)).text()
  expect(source).toContain('"o3p.context.observe.open"')
})

describe("ObserverState.refresh", () => {
  test("initial refresh loads rows, sets live status, and follows the latest", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 }), makeRow({ id: "b", seq: 2 })]
    const state = new ObserverState()
    await state.refresh(source)
    expect(state.status).toBe("live")
    expect(state.generation).toBe("g1")
    expect(state.rows.map((row) => row.id)).toEqual(["a", "b"])
    expect(state.selectedID).toBe("b")
  })

  test("incremental refresh passes the last seq and appends new rows", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    const state = new ObserverState()
    await state.refresh(source)
    source.rows = [...source.rows, makeRow({ id: "b", seq: 2 })]
    await state.refresh(source)
    expect(source.listCalls[1].after).toBe(1)
    expect(state.rows.map((row) => row.id)).toEqual(["a", "b"])
    expect(state.selectedID).toBe("b")
  })

  test("generation change resets local rows and re-syncs from zero", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 5 })]
    const state = new ObserverState()
    await state.refresh(source)
    source.generation = "g2"
    source.rows = [makeRow({ id: "c", seq: 1 }), makeRow({ id: "d", seq: 2 })]
    await state.refresh(source)
    expect(state.generation).toBe("g2")
    expect(state.rows.map((row) => row.id)).toEqual(["c", "d"])
    // One refresh = stale-generation call + resync call with after: 0.
    const lastCalls = source.listCalls.slice(-2)
    expect(lastCalls[0].after).toBe(5)
    expect(lastCalls[1].after).toBe(0)
  })

  test("errors surface and the next success recovers", async () => {
    const source = new FakeSource()
    const state = new ObserverState()
    source.failNext = new Error("rpc.unavailable: no handler")
    await state.refresh(source)
    expect(state.status).toBe("error")
    expect(state.error).toContain("rpc.unavailable")
    await state.refresh(source)
    expect(state.status).toBe("live")
    expect(state.error).toBeNull()
  })

  test("pause freezes the frontend while the server keeps capturing", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    const state = new ObserverState()
    await state.refresh(source)
    state.togglePause()
    expect(state.status).toBe("paused")
    // Server-side capture continues; the paused frontend does not fetch it.
    source.rows = [...source.rows, makeRow({ id: "b", seq: 2 })]
    const calls = source.listCalls.length
    await state.refresh(source)
    expect(source.listCalls.length).toBe(calls)
    expect(state.rows).toHaveLength(1)
    // Manual refresh forces a sync even while paused.
    await state.refresh(source, { force: true })
    expect(state.rows).toHaveLength(2)
    expect(state.status).toBe("paused")
  })
})

describe("ObserverState selection and filters", () => {
  test("manual selection disables follow; toggleFollow returns to the latest", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 }), makeRow({ id: "b", seq: 2 })]
    const state = new ObserverState()
    await state.refresh(source)
    state.select("a")
    expect(state.follow).toBe(false)
    source.rows = [...source.rows, makeRow({ id: "c", seq: 3 })]
    await state.refresh(source)
    expect(state.selectedID).toBe("a")
    state.toggleFollow()
    expect(state.selectedID).toBe("c")
  })

  test("selectDelta moves within the filtered list and clamps", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 }), makeRow({ id: "b", seq: 2 })]
    const state = new ObserverState()
    await state.refresh(source)
    state.selectDelta(-1)
    expect(state.selectedID).toBe("a")
    state.selectDelta(-1)
    expect(state.selectedID).toBe("a")
    state.selectDelta(5)
    expect(state.selectedID).toBe("b")
  })

  test("session/kind filters narrow visibleRows and keep selection valid", async () => {
    const source = new FakeSource()
    source.rows = [
      makeRow({ id: "a", seq: 1, sessionID: "ses_a", kind: "primary" }),
      makeRow({ id: "b", seq: 2, sessionID: "ses_b", kind: "title" }),
    ]
    const state = new ObserverState()
    state.follow = false
    await state.refresh(source)
    state.setFilter({ sessionID: "ses_a" })
    expect(state.visibleRows.map((row) => row.id)).toEqual(["a"])
    expect(state.selectedID).toBe("a")
    state.setFilter({ sessionID: undefined, kind: "title" })
    expect(state.visibleRows.map((row) => row.id)).toEqual(["b"])
    expect(state.selectedID).toBe("b")
    state.setFilter({ kind: undefined })
    expect(state.visibleRows).toHaveLength(2)
  })
})

describe("ObserverState.loadDetail", () => {
  test("caches results and dedupes in-flight requests", async () => {
    const source = new FakeSource()
    const row = makeRow({ id: "a", seq: 1 })
    source.details.set("a", makeDetail(row))
    const state = new ObserverState()
    const detail = source.details.get("a")
    if (!detail) throw new Error("fixture missing")
    await Promise.all([state.loadDetail(source, "a", true), state.loadDetail(source, "a", true)])
    expect(source.detailCalls).toEqual([{ id: "a", full: true }])
    expect(state.detailEntry("a")).toEqual({ state: "ok", detail })
    await state.loadDetail(source, "a", true)
    expect(source.detailCalls).toEqual([{ id: "a", full: true }])
  })

  test("unknown ids resolve to ok-null (evicted)", async () => {
    const source = new FakeSource()
    const state = new ObserverState()
    await state.loadDetail(source, "missing")
    expect(state.detailEntry("missing")).toEqual({ state: "ok", detail: null })
  })
})

describe("ObserverState.reset (project switch safety)", () => {
  test("clears rows, selection, filters, and status", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    const state = new ObserverState()
    await state.refresh(source)
    state.setFilter({ kind: "primary" })
    state.togglePause()
    state.reset()
    expect(state.rows).toEqual([])
    expect(state.selectedID).toBeNull()
    expect(state.filter).toEqual({})
    expect(state.paused).toBe(false)
    expect(state.status).toBe("loading")
    // A refresh after reset re-syncs from seq 0, not the old lastSeq.
    await state.refresh(source)
    expect(source.listCalls.at(-1)?.after).toBe(0)
    expect(state.rows.map((row) => row.id)).toEqual(["a"])
  })

  test("a stale list response from before reset cannot repopulate rows", async () => {
    const source = new FakeSource()
    const pending = deferred<{ rows: RequestRow[]; generation: string }>()
    source.list = (input) => {
      source.listCalls.push({ ...input })
      return pending.promise
    }
    const state = new ObserverState()
    const refresh = state.refresh(source)
    state.reset()
    pending.resolve({ rows: [makeRow({ id: "stale", seq: 9 })], generation: "g1" })
    await refresh
    expect(state.rows).toEqual([])
    expect(state.generation).toBeNull()
  })

  test("a stale detail response from before reset cannot repopulate the cache", async () => {
    const source = new FakeSource()
    const pending = deferred<RequestDetail | null>()
    source.detail = () => pending.promise
    const state = new ObserverState()
    const load = state.loadDetail(source, "old-row")
    state.reset()
    pending.resolve(makeDetail(makeRow({ id: "old-row", seq: 1 })))
    await load
    expect(state.detailEntry("old-row")).toBeUndefined()
  })
})

describe("ObserverState cache bounds", () => {
  test("rows are capped at MAX_ROWS, dropping the oldest", async () => {
    const source = new FakeSource()
    source.rows = Array.from({ length: MAX_ROWS + 50 }, (_, index) =>
      makeRow({ id: `r${index}`, seq: index + 1 }),
    )
    const state = new ObserverState()
    await state.refresh(source)
    expect(state.rows).toHaveLength(MAX_ROWS)
    expect(state.rows[0].seq).toBe(51)
    expect(state.rows.at(-1)?.seq).toBe(MAX_ROWS + 50)
  })

  test("detail cache is capped at MAX_DETAILS, evicting the oldest", async () => {
    const source = new FakeSource()
    for (let index = 0; index < MAX_DETAILS + 10; index++) {
      const id = `d${index}`
      source.details.set(id, makeDetail(makeRow({ id, seq: index + 1 })))
    }
    const state = new ObserverState()
    for (const id of source.details.keys()) await state.loadDetail(source, id)
    expect(state.detailEntry("d0")).toBeUndefined()
    expect(state.detailEntry(`d${MAX_DETAILS + 9}`)?.state).toBe("ok")
    let size = 0
    for (const id of source.details.keys()) if (state.detailEntry(id)) size++
    expect(size).toBe(MAX_DETAILS)
  })
})

describe("ObserverState auto-view on rebuild", () => {
  test("newly followed rebuild row switches to logical; next append returns to incremental", async () => {
    const source = new FakeSource()
    source.rows = [
      makeRow({ id: "a", seq: 1 }),
      makeRow({ id: "b", seq: 2, mode: "rebuild", prefixChanged: true }),
    ]
    const state = new ObserverState()
    await state.refresh(source)
    expect(state.selectedID).toBe("b")
    expect(state.view).toBe("logical")
    // A manual view choice survives later polls for the same row.
    state.setView("raw")
    await state.refresh(source)
    expect(state.view).toBe("raw")
    // A newly followed ordinary append returns to the incremental default;
    // a following rebuild switches to logical again.
    source.rows = [...source.rows, makeRow({ id: "c", seq: 3 })]
    await state.refresh(source)
    expect(state.selectedID).toBe("c")
    expect(state.view).toBe("incremental")
    source.rows = [...source.rows, makeRow({ id: "d", seq: 4, mode: "rebuild", prefixChanged: true })]
    await state.refresh(source)
    expect(state.selectedID).toBe("d")
    expect(state.view).toBe("logical")
  })

  test("manual selection of a rebuild row also switches to logical", async () => {
    const source = new FakeSource()
    source.rows = [
      makeRow({ id: "a", seq: 1 }),
      makeRow({ id: "b", seq: 2, mode: "rebuild", prefixChanged: true }),
    ]
    const state = new ObserverState()
    state.follow = false
    await state.refresh(source)
    state.setView("incremental")
    state.select("a")
    expect(state.view).toBe("incremental")
    state.select("b")
    expect(state.view).toBe("logical")
  })
})

describe("ObserverState lean/full details", () => {
  test("default load is lean (full:false) and marks append rows as not-full", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    source.details.set("a", makeDetail(source.rows[0]))
    const state = new ObserverState()
    await state.refresh(source)
    await state.loadDetail(source, "a")
    expect(source.detailCalls).toEqual([{ id: "a", full: false }])
    expect(state.isFull("a")).toBe(false)
    const entry = state.detailEntry("a")
    // Lean append detail: delta present, bodies empty.
    expect(entry?.state === "ok" && entry.detail?.raw).toBe("")
  })

  test("full request upgrades a lean entry and is not repeated", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    source.details.set("a", makeDetail(source.rows[0]))
    const state = new ObserverState()
    await state.refresh(source)
    await state.loadDetail(source, "a")
    await state.loadDetail(source, "a", true)
    expect(source.detailCalls).toEqual([
      { id: "a", full: false },
      { id: "a", full: true },
    ])
    expect(state.isFull("a")).toBe(true)
    const entry = state.detailEntry("a")
    expect(entry?.state === "ok" && entry.detail?.raw).toBe("{}")
    // Polls / repeated full loads hit the cache.
    await state.loadDetail(source, "a", true)
    await state.loadDetail(source, "a")
    expect(source.detailCalls).toHaveLength(2)
  })

  test("full request during a pending lean fetch awaits it, then upgrades", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    source.details.set("a", makeDetail(source.rows[0]))
    const state = new ObserverState()
    await state.refresh(source)
    const pending = deferred<RequestDetail | null>()
    const calls: Array<{ id: string; full?: boolean }> = []
    source.detail = (input) => {
      calls.push({ ...input })
      if (calls.length === 1) return pending.promise
      return Promise.resolve(source.details.get(input.id) ?? null)
    }
    const lean = state.loadDetail(source, "a")
    const full = state.loadDetail(source, "a", true)
    pending.resolve({ ...source.details.get("a")!, raw: "", logical: "", previous: null })
    await Promise.all([lean, full])
    expect(calls).toEqual([
      { id: "a", full: false },
      { id: "a", full: true },
    ])
    expect(state.isFull("a")).toBe(true)
  })

  test("snapshot/rebuild rows are full even on a lean fetch", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "s", seq: 1, mode: "snapshot" })]
    source.details.set("s", makeDetail(source.rows[0]))
    const state = new ObserverState()
    await state.refresh(source)
    await state.loadDetail(source, "s")
    expect(source.detailCalls).toEqual([{ id: "s", full: false }])
    expect(state.isFull("s")).toBe(true)
    // No upgrade fetch needed for the raw view.
    await state.loadDetail(source, "s", true)
    expect(source.detailCalls).toHaveLength(1)
  })

  test("reset clears fullness markers", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    source.details.set("a", makeDetail(source.rows[0]))
    const state = new ObserverState()
    await state.refresh(source)
    await state.loadDetail(source, "a", true)
    expect(state.isFull("a")).toBe(true)
    state.reset()
    expect(state.isFull("a")).toBe(false)
  })

  test("entryDetail snapshots the exact record across selection changes", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 }), makeRow({ id: "b", seq: 2 })]
    source.details.set("a", makeDetail(source.rows[0]))
    source.details.set("b", makeDetail(source.rows[1]))
    const state = new ObserverState()
    await state.refresh(source)
    await state.loadDetail(source, "a", true)
    // Selection moves to b while a's data was in flight / afterwards.
    state.select("a")
    state.select("b")
    const snapshot = state.entryDetail("a")
    expect(snapshot?.row.id).toBe("a")
    expect(state.entryDetail("b")).toBeUndefined()
  })

  test("errored details are stable: no auto-retry, retryDetail retries once", async () => {
    const source = new FakeSource()
    source.rows = [makeRow({ id: "a", seq: 1 })]
    const state = new ObserverState()
    await state.refresh(source)
    source.detail = (input) => {
      source.detailCalls.push({ ...input })
      return Promise.reject(new Error("boom"))
    }
    await state.loadDetail(source, "a", true)
    expect(state.detailEntry("a")?.state).toBe("error")
    // Render-driven polls must not retry.
    await state.loadDetail(source, "a", true)
    expect(source.detailCalls).toHaveLength(1)
    // Explicit user retry refetches.
    source.detail = (input) => {
      source.detailCalls.push({ ...input })
      return Promise.resolve(makeDetail(source.rows[0]))
    }
    await state.retryDetail(source, "a", true)
    expect(source.detailCalls).toHaveLength(2)
    expect(state.detailEntry("a")?.state).toBe("ok")
  })
})

describe("wire validators", () => {
  const goodRow = makeRow({ id: "a", seq: 1 })

  test("accepts a well-formed list result", () => {
    const result = validateListResult({ rows: [{ ...goodRow }], generation: "g" })
    expect(result.generation).toBe("g")
    expect(result.rows[0].id).toBe("a")
  })

  test("rejects malformed list payloads", () => {
    expect(() => validateListResult(null)).toThrow("malformed")
    expect(() => validateListResult({ rows: "x", generation: "g" })).toThrow("malformed")
    expect(() => validateListResult({ rows: [], generation: 1 })).toThrow("malformed")
    expect(() => validateListResult({ rows: [{ ...goodRow, kind: "weird" }], generation: "g" })).toThrow(
      "malformed",
    )
    expect(() => validateListResult({ rows: [{ ...goodRow, parentID: 5 }], generation: "g" })).toThrow(
      "malformed",
    )
  })

  test("accepts a well-formed detail or null", () => {
    const detail = makeDetail(goodRow)
    const result = validateDetail({ ...detail, headers: { "content-type": "application/json" } })
    expect(result?.hash).toBe("hash")
    expect(validateDetail(null)).toBeNull()
  })

  test("rejects malformed detail payloads", () => {
    const detail = makeDetail(goodRow)
    expect(() => validateDetail("x")).toThrow("malformed")
    expect(() => validateDetail({ ...detail, previous: 1 })).toThrow("malformed")
    expect(() => validateDetail({ ...detail, headers: { bad: 1 } })).toThrow("malformed")
    expect(() => validateDetail({ ...detail, row: { ...goodRow, bytes: "100" } })).toThrow("malformed")
  })

  test("createHttpSource rejects malformed payloads from the wire", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ output: { rows: [{ nope: true }], generation: "g" } }),
    })
    try {
      const source = createHttpSource(`http://127.0.0.1:${server.port}`, () => null)
      await expect(source.list({})).rejects.toThrow("malformed")
    } finally {
      server.stop(true)
    }
  })
})

describe("probeObserver (page-context probe)", () => {
  test("happy path: session route → directory → rpc ok", async () => {
    const calls: string[] = []
    await withFetch(async (url) => {
      calls.push(url)
      if (url.includes("/api/session/")) {
        // Native envelope: { data: PublicSessionInfo }
        return Response.json({ data: { id: "ses_1", location: { directory: "/proj" } } })
      }
      if (url.includes(`/api/rpc/${RPC_ID}/list`)) {
        expect(url).toContain(`location[directory]=${encodeURIComponent("/proj")}`)
        return Response.json({ output: { rows: [], generation: "g" } })
      }
      return new Response("unexpected", { status: 500 })
    }, async () => {
      const result = await probeObserver("http://127.0.0.1:4096", "/server/local/session/ses_1")
      expect(result).toEqual({ ok: true, directory: "/proj", error: null })
    })
    expect(calls.some((url) => url.includes("/api/session/ses_1"))).toBe(true)
  })

  test("session project differs from server default: session envelope wins", async () => {
    await withFetch(async (url) => {
      if (url.includes("/api/session/")) {
        return Response.json({ data: { id: "ses_9", location: { directory: "/work/other" } } })
      }
      if (url.includes("/api/location")) return Response.json({ directory: "/work/default" })
      if (url.includes(`/api/rpc/${RPC_ID}/list`)) {
        expect(url).toContain(`location[directory]=${encodeURIComponent("/work/other")}`)
        return Response.json({ output: { rows: [], generation: "g" } })
      }
      return new Response("unexpected", { status: 500 })
    }, async () => {
      const result = await probeObserver("http://127.0.0.1:4096", "/server/local/session/ses_9")
      expect(result).toEqual({ ok: true, directory: "/work/other", error: null })
    })
  })

  test("cookie-protected server (401 everywhere) fails closed without touching cookies", async () => {
    await withFetch(
      async () => new Response("unauthorized", { status: 401 }),
      async () => {
        const result = await probeObserver("http://127.0.0.1:4096", "/")
        expect(result.ok).toBe(false)
        expect(result.directory).toBeNull()
        expect(result.error).toBeTruthy()
      },
    )
  })

  test("rpc.unavailable is surfaced for the popup's plugin hint", async () => {
    await withFetch(async (url) => {
      if (url.includes("/api/location")) return Response.json({ directory: "/proj" })
      return Response.json(
        { _tag: "RpcError", type: "rpc.unavailable", message: "no handler" },
        { status: 400 },
      )
    }, async () => {
      const result = await probeObserver("http://127.0.0.1:4096", "/")
      expect(result.ok).toBe(false)
      expect(result.directory).toBe("/proj")
      expect(result.error).toContain("rpc.unavailable")
    })
  })

  test("unreachable host reports a connection error", async () => {
    await withFetch(
      async () => {
        throw new Error("network down")
      },
      async () => {
        const result = await probeObserver("http://127.0.0.1:4096", "/")
        expect(result).toEqual({ ok: false, directory: null, error: "无法连接该服务" })
      },
    )
  })
})
