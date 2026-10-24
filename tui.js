// Root re-export so OpenCode's directory-plugin loader (Bun.resolveSync of
// <packageDir>/tui, which ignores the "exports" map) finds the TUI entry.
export * from "./src/tui.js"
export { default } from "./src/tui.js"
