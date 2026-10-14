import solidPlugin from "@opentui/solid/bun-plugin"
import { cpSync, mkdirSync } from "node:fs"

// TUI viewer: host-provided deps stay external so the bundle binds to the
// running OpenCode TUI's own @opencode/plugin and OpenTUI instances.
const tui = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "node",
  plugins: [solidPlugin],
  external: ["@opencode/plugin", "@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js", "effect"],
})
if (!tui.success) throw new AggregateError(tui.logs, "TUI build failed")

// Backend and shared contract (parent-owned sources).
const server = await Bun.build({
  entrypoints: ["./src/server.ts", "./src/contract.ts"],
  outdir: "./dist",
  target: "node",
  external: ["@opencode/plugin", "effect"],
})
if (!server.success) throw new AggregateError(server.logs, "Server build failed")

// Browser extension: two self-contained IIFE bundles (no imports at runtime,
// content scripts cannot lazy-load chunks) plus static popup/manifest files.
const extension = await Bun.build({
  entrypoints: ["./extension/src/content.ts", "./extension/src/popup.ts"],
  outdir: "./extension/dist",
  target: "browser",
  format: "iife",
  splitting: false,
})
if (!extension.success) throw new AggregateError(extension.logs, "Extension build failed")

mkdirSync("./extension/dist", { recursive: true })
cpSync("./extension/manifest.json", "./extension/dist/manifest.json")
cpSync("./extension/popup.html", "./extension/dist/popup.html")

// The root tsconfig intentionally covers src/test/scripts only; the extension
// tree is typechecked against its own config here so builds stay clean.
const check = Bun.spawnSync([process.execPath, "x", "tsc", "-p", "extension/tsconfig.json"], {
  stdout: "inherit",
  stderr: "inherit",
})
if (check.exitCode !== 0) throw new Error("Extension typecheck failed")

console.log("built: dist/tui.js, dist/server.js, extension/dist/")
