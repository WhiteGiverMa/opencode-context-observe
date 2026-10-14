/**
 * Self-contained probe injected into the page's ISOLATED world via
 * `chrome.scripting.executeScript({ func: probeObserver, args })`.
 *
 * It MUST NOT reference anything outside its own body: Chrome serializes the
 * function source, so module imports and free variables would be undefined in
 * the page. Keep the RPC id in sync with PLUGIN_ID in ../../src/contract.ts
 * (asserted by test/frontend-state.test.ts).
 *
 * Runs in the page's content-script context: same-origin fetch, the page's
 * cookies are attached automatically by credentials:"same-origin", and the
 * cookie values themselves are never read. Only safe metadata comes back.
 */
export interface ProbeResult {
  readonly ok: boolean
  readonly directory: string | null
  readonly error: string | null
}

export async function probeObserver(origin: string, pathname: string): Promise<ProbeResult> {
  const readDirectory = (body: unknown): string | null => {
    // Native envelopes: session.get wraps Session.Info in { data };
    // location.get returns Location.PublicInfo directly. Envelope first.
    if (!body || typeof body !== "object") return null
    const record = body as Record<string, unknown>
    const data = record.data
    if (data && typeof data === "object") {
      const inner = readDirectory(data)
      if (inner) return inner
    }
    if (typeof record.directory === "string") return record.directory
    const location = record.location
    if (location && typeof location === "object") {
      const directory = (location as Record<string, unknown>).directory
      if (typeof directory === "string") return directory
    }
    return null
  }

  let directory: string | null = null
  const session = /^\/server\/[^/]+\/session\/([^/]+)/.exec(pathname)
  try {
    if (session) {
      const response = await fetch(`${origin}/api/session/${encodeURIComponent(decodeURIComponent(session[1]))}`, {
        credentials: "same-origin",
      })
      if (response.ok) directory = readDirectory(await response.json())
    }
    if (directory === null) {
      const response = await fetch(`${origin}/api/location`, { credentials: "same-origin" })
      if (response.ok) directory = readDirectory(await response.json())
    }
  } catch {
    return { ok: false, directory: null, error: "无法连接该服务" }
  }
  if (directory === null) return { ok: false, directory: null, error: "未发现 OpenCode 服务" }

  const query = `?location[directory]=${encodeURIComponent(directory)}`
  try {
    const response = await fetch(`${origin}/api/rpc/o3p.context.observe/list${query}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const body: unknown = await response.json()
        if (body && typeof body === "object") {
          const record = body as Record<string, unknown>
          const type = typeof record.type === "string" ? record.type : null
          const text = typeof record.message === "string" ? record.message : null
          if (type && text) message = `${type}: ${text}`
          else if (text) message = text
        }
      } catch {
        // keep the HTTP status message
      }
      return { ok: false, directory, error: message }
    }
  } catch {
    return { ok: false, directory, error: "无法连接该服务" }
  }
  return { ok: true, directory, error: null }
}
