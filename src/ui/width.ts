import stringWidth from "string-width"

/**
 * Display-cell string measurement for the TUI detail pane. Prefers
 * `Bun.stringWidth` — the same measurer the host OpenCode TUI uses under Bun
 * (packages/tui/src/util/string-width.bun.ts); under Node (the native QA
 * host) falls back to `string-width`, which @opentui/core itself depends on
 * (7.2.0) and which handles CJK wide glyphs and combining marks. Never
 * imported by the browser extension bundle.
 */
export function displayWidth(text: string): number {
  if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") return Bun.stringWidth(text)
  return stringWidth(text)
}

/** Display-cell column of `offset` within its newline-delimited line. */
export function displayColumnAt(text: string, offset: number): number {
  const clamped = Math.min(Math.max(0, offset), text.length)
  const lineStart = clamped === 0 ? 0 : text.lastIndexOf("\n", clamped - 1) + 1
  return displayWidth(text.slice(lineStart, clamped))
}

/** Intrinsic content width: the widest line in display cells (min 1). */
export function contentWidth(text: string): number {
  let max = 1
  for (const line of text.split("\n")) {
    const width = displayWidth(line)
    if (width > max) max = width
  }
  return max
}
