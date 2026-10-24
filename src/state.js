import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"

// Verified against @opencode/schema event-manifest: these three carry
// data: { sessionID }. Anything else is not a session end.
export const SESSION_END_TYPES = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]

export const STATE_VERSION = 1;
// Bump when plugin logic changes: tells which code version wrote a state file.
export const CODE_VERSION = 3

export function dataDir() {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "opencode", "learnloop")
}

export function statePath() {
  return join(dataDir(), "state.json")
}

export function emptyState() {
  return { version: STATE_VERSION, code: CODE_VERSION, pending: 0, recent: [], proposals: { global: null, repos: {} }, applies: [], noModel: false, updatedAt: 0 }
}

export async function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(await readFile(statePath(), "utf8")) }
  } catch {
    return emptyState()
  }
}

export async function writeState(patch) {
  await mkdir(dataDir(), { recursive: true })
  const next = { ...(await readState()), ...patch, version: STATE_VERSION, updatedAt: Date.now() }
  const tmp = `${statePath()}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, JSON.stringify(next, null, 2))
  await rename(tmp, statePath())
  return next
}
