import type { RequestDetail, RequestRow } from "../../src/contract.ts"
import type { ListResult } from "../../src/ui/state.ts"

/**
 * Tiny hand-written validators for the RPC wire format. The extension bundle
 * must stay free of effect/@opencode/plugin, so we check the contract fields
 * directly instead of evaluating the effect schemas in the page.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function needString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== "string") throw new Error(`malformed payload: ${field} must be a string`)
  return value
}

function needNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`malformed payload: ${field} must be a number`)
  }
  return value
}

function needBoolean(record: Record<string, unknown>, field: string): boolean {
  const value = record[field]
  if (typeof value !== "boolean") throw new Error(`malformed payload: ${field} must be a boolean`)
  return value
}

function needNullableString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  if (value !== null && typeof value !== "string") {
    throw new Error(`malformed payload: ${field} must be a string or null`)
  }
  return value
}

function needLiteral<const T extends string>(
  record: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T {
  const value = record[field]
  const match = values.find((candidate) => candidate === value)
  if (match === undefined) throw new Error(`malformed payload: ${field} is not a known value`)
  return match
}

const KINDS = ["primary", "title", "compaction", "generate"] as const
const TRANSPORTS = ["http", "websocket"] as const
const MODES = ["snapshot", "append", "rebuild"] as const

export function validateRow(value: unknown): RequestRow {
  if (!isRecord(value)) throw new Error("malformed payload: row must be an object")
  return {
    id: needString(value, "id"),
    seq: needNumber(value, "seq"),
    sessionID: needString(value, "sessionID"),
    parentID: needNullableString(value, "parentID"),
    title: needString(value, "title"),
    agent: needString(value, "agent"),
    providerID: needString(value, "providerID"),
    modelID: needString(value, "modelID"),
    kind: needLiteral(value, "kind", KINDS),
    transport: needLiteral(value, "transport", TRANSPORTS),
    time: needNumber(value, "time"),
    bytes: needNumber(value, "bytes"),
    mode: needLiteral(value, "mode", MODES),
    baseID: needNullableString(value, "baseID"),
    prefixChanged: needBoolean(value, "prefixChanged"),
    changedAt: needNumber(value, "changedAt"),
    missingPrevious: needBoolean(value, "missingPrevious"),
  }
}

export function validateListResult(value: unknown): ListResult {
  if (!isRecord(value)) throw new Error("malformed payload: list result must be an object")
  const rows = value.rows
  if (!Array.isArray(rows)) throw new Error("malformed payload: rows must be an array")
  return { rows: rows.map(validateRow), generation: needString(value, "generation") }
}

export function validateDetail(value: unknown): RequestDetail | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error("malformed payload: detail must be an object or null")
  const headers = value.headers
  if (!isRecord(headers)) throw new Error("malformed payload: headers must be an object")
  const cleanHeaders: Record<string, string> = {}
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header !== "string") throw new Error(`malformed payload: header ${name} must be a string`)
    cleanHeaders[name] = header
  }
  return {
    row: validateRow(value.row),
    raw: needString(value, "raw"),
    logical: needString(value, "logical"),
    delta: needString(value, "delta"),
    previous: needNullableString(value, "previous"),
    url: needString(value, "url"),
    headers: cleanHeaders,
    hash: needString(value, "hash"),
  }
}
