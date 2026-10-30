import { describe, expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { panScrollBoxX } from "../src/ui/scroll.ts"
import { contentWidth, displayColumnAt, displayWidth } from "../src/ui/width.ts"

// Renderer-boundary test for the detail pane's horizontal access pattern.
// Background: OpenTUI 0.8 made ScrollBox scroll state native and removed the
// content renderable, so content.translateX no longer moves the children. On
// 0.7 and earlier scrollX is constructor-only, so the Solid reconciler cannot
// enable it after construction and translateX is still the only way to pan.
// panScrollBoxX keeps both hosts working; this test runs against the installed
// OpenTUI and pins whichever path that version takes.

const LONG_LINE = `{"model":"gpt-x","messages":[${"\"content\":\"甲乙丙丁abcdefghi\",".repeat(40)}],"end":"ENDMARK"}`

describe("detail pane horizontal layout (renderer boundary)", () => {
  test("intrinsic content width exceeds the viewport for a minified line", () => {
    expect(LONG_LINE.length).toBeGreaterThan(200)
    expect(contentWidth(LONG_LINE)).toBe(displayWidth(LONG_LINE))
    expect(contentWidth(LONG_LINE)).toBeGreaterThan(40)
  })

  test("inner box keeps intrinsic width and translateX pan reaches the end marker", async () => {
    let detail: ScrollBoxRenderable | undefined
    let inner: { width: number } | undefined
    const setup = await testRender(
      () => (
        <box width={40} height={10}>
          <scrollbox ref={(box: ScrollBoxRenderable) => (detail = box)} flexGrow={1} minHeight={0}>
            <box
              ref={(box: { width: number }) => (inner = box)}
              flexDirection="column"
              paddingLeft={1}
              width={contentWidth(LONG_LINE)}
              flexShrink={0}
            >
              <text wrapMode="none">{LONG_LINE}</text>
            </box>
          </scrollbox>
        </box>
      ),
      { width: 40, height: 10 },
    )
    try {
      await setup.renderOnce()
      if (!detail) throw new Error("scrollbox ref missing")
      // The inner box must render at full width despite the clamped content.
      expect(inner?.width).toBe(contentWidth(LONG_LINE))

      const start = setup.captureCharFrame()
      expect(start).toContain('{"model":"gpt-x"')
      expect(start).not.toContain("ENDMARK")

      // Same computation the view's search jump / arrow pan uses.
      const markerAt = LONG_LINE.indexOf("ENDMARK")
      const x = Math.max(0, displayColumnAt(LONG_LINE, markerAt) - 4)
      panScrollBoxX(detail, x)
      await setup.renderOnce()
      const end = setup.captureCharFrame()
      expect(end).toContain("ENDMARK")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("wide glyphs count as two cells in the column math", () => {
    const text = "ab甲乙END"
    // "ab" (2 cells) + "甲乙" (4 cells) → END starts at cell 6
    expect(displayColumnAt(text, text.indexOf("END"))).toBe(6)
  })

  test("node fallback measurer handles CJK and combining marks", async () => {
    // The Bun branch is exercised everywhere above; the Node fallback uses
    // string-width 7.2.0 (an @opentui/core dependency). Pin its semantics.
    const { default: stringWidth } = await import("string-width")
    expect(stringWidth("甲乙")).toBe(4)
    expect(stringWidth("é")).toBe(1)
    expect(stringWidth("plain")).toBe(5)
  })
})
