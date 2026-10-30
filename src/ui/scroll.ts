import type { ScrollBoxRenderable } from "@opentui/core"

type NativeScrollBox = ScrollBoxRenderable & { scrollX: boolean }

/**
 * OpenTUI 0.8 turned ScrollBox scrolling into native state. Before it, the
 * scrollX option was constructor-only, so the Solid reconciler could not enable
 * it after construction and content.translateX was the public horizontal pan.
 */
function hasNativeScrollX(box: ScrollBoxRenderable): boolean {
  return typeof (box as { scrollX?: unknown }).scrollX === "boolean"
}

/**
 * Pans a scrollbox horizontally without touching its vertical position. Uses
 * the native scroll state on OpenTUI 0.8+, and the 0.5-0.7 content translate
 * fallback on the host versions that still run that way.
 */
export function panScrollBoxX(box: ScrollBoxRenderable, x: number): void {
  if (hasNativeScrollX(box)) {
    const native = box as NativeScrollBox
    if (!native.scrollX) native.scrollX = true
    native.scrollTo({ x, y: native.scrollTop })
    return
  }
  ;(box.content as ScrollBoxRenderable["content"] & { translateX: number }).translateX = -x
}
