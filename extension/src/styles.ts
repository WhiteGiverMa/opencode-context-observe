/**
 * Shadow-DOM stylesheet. Static text only — captured payloads are always
 * rendered through text nodes, never through this stylesheet or innerHTML.
 * Dense devtool surface: 13px UI / 20px line-height, 12px mono detail,
 * no cards, no gradients; dark and light follow the OS preference.
 */
export const CSS = `
:host {
  all: initial;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.wrap {
  --bg: #14161a;
  --bg-raised: #1d2026;
  --bg-hover: #262a32;
  --fg: #d7dae0;
  --fg-dim: #8a8f99;
  --border: #33373f;
  --accent: #6ea8fe;
  --warn: #e0a44a;
  --err: #e06c75;
  --add: #7ec699;
  --del: #e06c75;
  --mark: #7a5b16;
  --mark-now: #b8860b;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  .wrap {
    --bg: #f7f7f5;
    --bg-raised: #ffffff;
    --bg-hover: #ececea;
    --fg: #24272c;
    --fg-dim: #6b7078;
    --border: #d4d6da;
    --accent: #1b66c9;
    --warn: #9a6a12;
    --err: #c03434;
    --add: #1c7a3d;
    --del: #c03434;
    --mark: #f2d488;
    --mark-now: #e0a44a;
    color-scheme: light;
  }
}
.wrap {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  min-width: 280px;
  max-width: 80vw;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-left: 1px solid var(--border);
  color: var(--fg);
  font: 13px/20px ui-sans-serif, system-ui, "Segoe UI", sans-serif;
  pointer-events: auto;
  z-index: 2147483646;
}
.grip {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
}
.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  flex: none;
  flex-wrap: wrap;
}
.bar .title {
  font-weight: 600;
  margin-right: 4px;
  white-space: nowrap;
}
.bar .status {
  color: var(--fg-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 60px;
}
.bar .status.error { color: var(--err); }
button, select, input {
  font: inherit;
  color: var(--fg);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 6px;
  height: 22px;
  line-height: 20px;
}
button {
  cursor: pointer;
  white-space: nowrap;
}
button:hover { background: var(--bg-hover); }
button:active { transform: translateY(1px); }
button.on {
  border-color: var(--accent);
  color: var(--accent);
}
button:disabled { opacity: 0.5; cursor: default; }
input[type="text"] {
  min-width: 80px;
  flex: 1;
}
.views button.current {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.banner {
  flex: none;
  border-bottom: 1px solid var(--border);
  padding: 2px 8px;
  color: var(--warn);
  display: none;
  white-space: pre-wrap;
  word-break: break-all;
}
.banner.show { display: block; }
.timeline {
  flex: none;
  height: 35%;
  min-height: 60px;
  overflow-y: auto;
  border-bottom: 1px solid var(--border);
  font: 12px/18px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
.row {
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-dim);
  cursor: default;
  user-select: none;
}
.row:hover { background: var(--bg-hover); }
.row.selected {
  background: var(--bg-hover);
  color: var(--fg);
}
.row .warn { color: var(--warn); }
.meta {
  flex: none;
  padding: 2px 8px;
  color: var(--fg-dim);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.detail {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 4px 8px;
  font: 12px/18px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}
.detail .dline { white-space: pre-wrap; }
.detail .dline.add { color: var(--add); }
.detail .dline.del { color: var(--del); }
.detail .dline.same { color: var(--fg-dim); }
.detail mark {
  background: var(--mark);
  color: var(--fg);
}
.detail mark.now {
  background: var(--mark-now);
  color: #14161a;
}
.detail .empty { color: var(--fg-dim); }
.fab {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--border, #33373f);
  background: #1d2026;
  color: #d7dae0;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  pointer-events: auto;
  z-index: 2147483646;
}
.fab:hover { background: #262a32; }
.fab:active { transform: translateY(1px); }
`
