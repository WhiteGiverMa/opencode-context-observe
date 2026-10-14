// Keep in sync with PLUGIN_ID in ../../src/contract.ts (asserted by test/frontend-state.test.ts).
// The contract module is type-only here so effect/@opencode/plugin stay out of the browser bundle.
export const RPC_ID = "o3p.context.observe"

import type { ObserverSource } from "../../src/ui/state.ts"
import { validateDetail, validateListResult } from "./validate.ts"

/** Extract the session id from the OpenCode web app route `/server/:key/session/:id`. */
export function sessionFromPath(pathname: string): string | null {
  const match = /^\/server\/[^/]+\/session\/([^/]+)/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

function readDirectory(body: unknown): string | null {
  // Native envelopes: session.get wraps Session.Info in { data }, while
  // location.get returns Location.PublicInfo directly. Accept both, checking
  // the envelope first so a session's own project wins over any default.
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  const data = record.data
  if (data && typeof data === "object") {
    const inner = readDirectory(data)
    if (inner) return inner
  }
  // location.get → { directory, project }
  if (typeof record.directory === "string") return record.directory
  // session.get (unwrapped) → Session.Info { location: { directory } }
  const location = record.location
  if (location && typeof location === "object") {
    const directory = (location as Record<string, unknown>).directory
    if (typeof directory === "string") return directory
  }
  return null
}

/**
 * Resolve the project directory the backend Location is bound to.
 * On a session route we ask for that session's location (multi-project
 * servers); elsewhere we fall back to the server's default location.
 */
export async function resolveDirectory(origin: string, pathname: string): Promise<string | null> {
  const sessionID = sessionFromPath(pathname)
  if (sessionID) {
    try {
      const response = await fetch(`${origin}/api/session/${encodeURIComponent(sessionID)}`, {
        credentials: "same-origin",
      })
      if (response.ok) {
        const directory = readDirectory(await response.json())
        if (directory) return directory
      }
    } catch {
      // fall through to the default location
    }
  }
  try {
    const response = await fetch(`${origin}/api/location`, { credentials: "same-origin" })
    if (response.ok) return readDirectory(await response.json())
  } catch {
    // not an OpenCode server (or unreachable)
  }
  return null
}

function readRpcError(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const record = body as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type : null
  const message = typeof record.message === "string" ? record.message : null
  if (type && message) return `${type}: ${message}`
  return message
}

/**
 * Same-origin RPC client. Cookies ride along (`credentials: "same-origin"`);
 * the location query uses the deepObject form `location[directory]=…`.
 * Payloads are validated at the boundary; malformed JSON is rejected.
 */
export function createHttpSource(origin: string, directory: () => string | null): ObserverSource {
  async function call(method: "list" | "detail", input: unknown): Promise<unknown> {
    const dir = directory()
    const query = dir ? `?location[directory]=${encodeURIComponent(dir)}` : ""
    const response = await fetch(`${origin}/api/rpc/${RPC_ID}/${method}${query}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        message = readRpcError(await response.json()) ?? message
      } catch {
        // keep the HTTP status message
      }
      throw new Error(message)
    }
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null) throw new Error("malformed RPC response envelope")
    return (body as Record<string, unknown>).output
  }
  return {
    list: async (input) => validateListResult(await call("list", input)),
    detail: async (input) => validateDetail(await call("detail", input)),
  }
}
