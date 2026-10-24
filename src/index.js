import { homedir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { appendFile, lstat, readFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { SESSION_END_TYPES, writeState } from "./state.js"

const FINDING_PREFIX = "finding/"
const ANALYZED_PREFIX = "analyzed/"
const THRESHOLD_DEFAULT = 3
const SWEEP_LIMIT = 5
const SCAN_LIMIT = 200
const SCAN_MAX_PAGES = 50
const MAX_PROMPT_CHARS = 12000
const MAX_TRANSCRIPT_CHARS = 10000
const MAX_DIFF_CHARS = 2000
const NO_MODEL_KEY = "noModel"
const CHANGELOG_KEY = "changelog"
const CHANGELOG_CAP = 100

export default Plugin.define({
  id: "learnloop",
  async setup(ctx) {
    const options = ctx.options ?? {}
    if (options.enabled === false) return
    const threshold = options.threshold ?? THRESHOLD_DEFAULT

    await ctx.command.transform((editor) => {
      editor.add({
        name: "learn",
        description: "Review repeated corrections and proposed AGENTS.md changes",
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = await renderReview(ctx, sessionID).catch(
            (err) => `# learnloop review\n\nFailed to load review state: ${err?.message ?? err}`,
          )
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
      editor.add({
        name: "learn-apply",
        description: "Append reviewed learnloop proposals to AGENTS.md (repo by default; global or all)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = await applyProposals(ctx, sessionID, prompt?.text ?? "").catch(
            (err) => `# learnloop apply\n\nApply failed: ${err?.message ?? err}`,
          )
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
    })

    // Catch sessions that ended while the app was closed.
    void sweep(ctx, options, threshold).catch((err) =>
      console.error(`[learnloop] sweep: ${err?.message ?? err}`),
    )

    const controller = new AbortController()
    const seenTypes = new Set()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (SESSION_END_TYPES.includes(event?.type)) {
              const sessionID = event?.data?.sessionID ?? event?.data?.id ?? event?.sessionID
              if (!sessionID) {
                console.error(`[learnloop] session-end event ${event?.type} has no usable session ID (data keys: ${Object.keys(event?.data ?? {}).join(",") || "none"})`)
                continue
              }
              await handleSessionEnd(ctx, options, sessionID, threshold)
            } else if (event?.type && !seenTypes.has(event.type)) {
              seenTypes.add(event.type)
              console.error(`[learnloop] unseen event type: ${event.type} (data keys: ${Object.keys(event?.data ?? {}).join(",") || "none"})`)
            }
          } catch (err) {
            console.error(`[learnloop] event ${event?.type}: ${err?.message ?? err}`)
          }
        }
      } catch (err) {
        // Unload aborts the subscription; anything else is a real failure.
        if (!controller.signal.aborted && err?.name !== "AbortError") {
          console.error(`[learnloop] event subscription ended: ${err?.message ?? err}`)
        }
      }
    })()
    return () => controller.abort()
  },
})

async function sweep(ctx, options, threshold) {
  const page = await ctx.session.list({ directory: ctx.location.directory, limit: SWEEP_LIMIT })
  const items = page?.data ?? page?.items ?? (Array.isArray(page) ? page : [])
  for (const s of items) {
    const id = s?.id ?? s?.sessionID
    if (!id) continue
    if (!s?.outcome) continue // still open; its end event will handle it
    try {
      await handleSessionEnd(ctx, options, id, threshold)
    } catch (err) {
      console.error(`[learnloop] sweep ${id}: ${err?.message ?? err}`)
    }
  }
}

async function handleSessionEnd(ctx, options, sessionID, threshold) {
  if (!sessionID) return
  const analyzedKey = `${ANALYZED_PREFIX}${sessionID}`
  const prior = await ctx.storage.get(analyzedKey).catch(() => null)
  const release = () => ctx.storage.remove(analyzedKey).catch(() => {})

  try {
    const rawMessages = await ctx.session.context({ sessionID }).catch(() => [])
    const messages = unwrapList(rawMessages)
    if (messages.length === 0) {
      await ctx.storage.set(analyzedKey, { at: Date.now(), count: 0 }).catch(() => {})
      return
    }
    if (isLearnSession(messages)) {
      await ctx.storage.set(analyzedKey, { at: Date.now(), count: messages.length }).catch(() => {})
      return
    }
    // Continued sessions get re-analyzed: a claim only covers the transcript
    // length it saw, so corrections made after a first analysis are picked up.
    if (prior && (prior.count ?? 0) >= messages.length) return
    // Claim-first: concurrent ends collapse onto one analysis.
    await ctx.storage.set(analyzedKey, { at: Date.now(), count: messages.length })
    const rawSession = await ctx.session.get({ sessionID }).catch(() => undefined)
    const repo = repoOf(rawSession?.data ?? rawSession, ctx)

    const model = await resolveModel(ctx, options)
    if (!model) {
      await ctx.storage.set(NO_MODEL_KEY, { at: Date.now(), reason: "no zero-cost model in registry" }).catch(() => {})
      console.error("[learnloop] no free model available, skipping (will retry on next session end)")
      await mirrorState(ctx, await unaggregated(ctx))
      await release()
      return
    }
    await ctx.storage.remove(NO_MODEL_KEY).catch(() => {})
    const diff = await ctx.vcs
      .diff({ mode: "working", context: 1, ...(isAbsolute(repo) ? { location: { directory: repo } } : {}) })
      .catch(() => null)
    const finding = await extract(ctx, model, messages, diff)
    if (finding && !isNone(finding)) {
      await ctx.storage.set(`${FINDING_PREFIX}${sessionID}`, {
        sessionID,
        repo,
        at: Date.now(),
        text: finding,
      })
    }

    const pending = await unaggregated(ctx)
    await mirrorState(ctx, pending)
    if (pending.length >= threshold) await aggregate(ctx, model, pending)
  } catch (err) {
    await release()
    throw err
  }
}

function unwrapList(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.data)) return raw.data
  return []
}

// SessionMessageInfo is a union: user messages carry .text, assistant
// messages carry .content (array of {type,text} parts). Verified against
// @opencode/client generated types; fallbacks cover anything else.
export function messageText(m) {
  if (m == null) return ""
  if (typeof m.text === "string") return m.text
  const c = m.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p
        if (typeof p?.text === "string") return p.text
        // Assistant tool parts carry no .text; without this the transcript is
        // blind to tool calls, including rejected/errored ones we must detect.
        if (p?.type === "tool") {
          const status = p?.state?.status ?? p?.status ?? "?"
          const detail = status === "error" ? `: ${p?.state?.error?.message ?? p?.state?.error ?? ""}` : ""
          return `[tool ${p?.name ?? "?"} ${status}${detail}]`
        }
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (c && typeof c === "object") {
    return typeof c.text === "string" ? c.text : JSON.stringify(c).slice(0, 500)
  }
  return ""
}

// SessionInfo has location.directory (absolute) and projectID; there is no
// top-level .directory. Verified against @opencode/client generated types.
export function repoOf(session, ctx) {
  return (
    session?.location?.directory ??
    session?.directory ??
    session?.projectID ??
    ctx?.location?.directory ??
    "global"
  )
}

function isLearnSession(messages) {
  // Anchored to command position so that merely discussing the plugin
  // (e.g. "what does /learn do?") doesn't skip analysis.
  return (messages ?? []).some((m) => /(^|\s)\/learn(-apply|-review)?(\s|$)/m.test(messageText(m)))
}

function isNone(text) {
  return /^\s*(none\b|no\s+(thing|corrections?|t\s+(a\s+)?corrections?|patterns?|repeated\s+patterns?)\b)/i.test(text)
}

function parseRef(ref) {
  const i = String(ref).indexOf("/")
  return i < 0 ? null : { providerID: ref.slice(0, i), id: ref.slice(i + 1) }
}

function modelCandidates(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.data)) return raw.data
  return []
}

function isFree(m) {
  const cost = m?.cost
  // Unknown cost is NOT free: a provider omitting cost data must never be
  // treated as zero-cost, or the plugin could spend real money silently.
  if (!Array.isArray(cost) || cost.length === 0) return false
  return cost.every((t) => (t?.input ?? 0) === 0 && (t?.output ?? 0) === 0)
}

function toRef(m) {
  return m?.providerID && (m?.id ?? m?.modelID) ? { providerID: m.providerID, id: m.id ?? m.modelID } : null
}

async function resolveModel(ctx, options) {
  if (options.model) return parseRef(options.model)
  const preferred = options.preferredProvider ?? "opencode-go"
  let raw
  try {
    raw = await ctx.model.list()
  } catch (err) {
    console.error(`[learnloop] model.list failed: ${err?.message ?? err}`)
    return null
  }
  const models = modelCandidates(raw)
  const freeModels = models.filter(isFree)
  const pick =
    freeModels.find((m) => m.providerID === preferred) ??
    freeModels.find((m) => (m.cost ?? []).length > 0) ??
    freeModels[0]
  return pick ? toRef(pick) : null
}

function transcript(messages) {
  const lines = (messages ?? []).slice(-60).map((m) => {
    const role = m?.role ?? m?.type ?? "?"
    return `${role}: ${messageText(m)}`.slice(0, 1000)
  })
  return lines.join("\n").slice(0, MAX_TRANSCRIPT_CHARS)
}

function generateTextOf(result) {
  if (typeof result === "string") return result
  if (typeof result?.text === "string") return result.text
  if (typeof result?.data?.text === "string") return result.data.text
  return ""
}

async function extract(ctx, model, messages, diff) {
  const diffText = diff ? JSON.stringify(diff).slice(0, MAX_DIFF_CHARS) : "(unavailable)"
  const prompt =
    `You review one coding-agent session transcript and note where the user corrected, overrode, or redid the agent's work by hand. List each as one short line: what the agent did wrong and what the user wanted instead. Cover: follow-up corrections ("no, not that file", "use X instead"), rejected tool calls or aborted runs, and hand edits visible in the working-tree diff below. If the session has no corrections, reply with exactly: NONE\n\nTranscript:\n${transcript(messages)}\n\nWorking-tree diff after the session (user's hand edits):\n${diffText}`.slice(0, MAX_PROMPT_CHARS)
  const result = await ctx.generate.text({ model, prompt })
  return generateTextOf(result).trim()
}

async function scanAll(ctx, prefix) {
  const out = []
  let after
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const res = await ctx.storage.scan({ prefix, limit: SCAN_LIMIT, ...(after ? { after } : {}) })
    out.push(...(res?.entries ?? []))
    if (!res?.next || res.next === after) break
    after = res.next
  }
  return out
}

async function unaggregated(ctx) {
  // Keys travel with values so aggregation deletes by exact storage key —
  // never by a possibly-missing sessionID.
  return (await scanAll(ctx, FINDING_PREFIX))
    .map((e) => ({ key: e.key, ...(e.value ?? {}) }))
    .filter((f) => f && f.key && !f.aggregated)
}

async function aggregate(ctx, model, findings) {
  const usable = findings.filter((f) => f.sessionID && f.text)
  if (usable.length > 0) {
    const byRepo = new Map()
    for (const f of usable) {
      if (!byRepo.has(f.repo)) byRepo.set(f.repo, [])
      byRepo.get(f.repo).push(f)
    }
    for (const [repo, items] of byRepo) {
      const text = await propose(ctx, model, `repo scope (${repo}). Only propose rules specific to this repo.`, items)
      await storeProposal(ctx, `proposal/repo/${encodeURIComponent(repo)}`, {
        repo,
        at: Date.now(),
        text,
        sessions: items.map((f) => f.sessionID),
      })
    }
    const text = await propose(
      ctx,
      model,
      "global scope. Only propose rules that hold across repos (workflow and style preferences), never repo-specific paths or tools.",
      usable,
    )
    await storeProposal(ctx, "proposal/global", { at: Date.now(), text, sessions: usable.map((f) => f.sessionID) })
  }
  // Findings are consumed: delete by exact key so scans stay O(pending).
  for (const f of findings) {
    try {
      await ctx.storage.remove(f.key)
    } catch {
      await ctx.storage.set(f.key, { ...f, aggregated: true }).catch(() => {})
    }
  }
  await mirrorState(ctx, [])
}

async function storeProposal(ctx, key, proposal) {
  if (!proposal?.text?.trim()) {
    await ctx.storage.remove(key).catch(() => {})
    return
  }
  const prev = await ctx.storage.get(key).catch(() => null)
  // Never reset applied state on re-aggregation of an identical proposal.
  const appliedAt = prev?.text === proposal.text ? (prev?.appliedAt ?? null) : null
  await ctx.storage.set(key, { ...proposal, appliedAt })
}

async function propose(ctx, model, scope, findings) {
  const notes = findings
    .map((f) => `- [${f.repo}] ${f.text}`.slice(0, 2000))
    .join("\n")
    .slice(0, MAX_TRANSCRIPT_CHARS)
  const prompt =
    `You turn repeated user corrections into AGENTS.md additions. ${scope}\n\nFirst list the repeated patterns (2+ occurrences of the same correction). Then write each proposed rule as a short markdown diff block. Skip one-off quirks. If nothing repeats, say so and propose nothing.\n\nFindings:\n${notes}`.slice(0, MAX_PROMPT_CHARS)
  const result = await ctx.generate.text({ model, prompt })
  return generateTextOf(result).trim()
}

async function readChangelog(ctx) {
  const raw = await ctx.storage.get(CHANGELOG_KEY).catch(() => null)
  return Array.isArray(raw) ? raw : []
}

async function mirrorState(ctx, pending) {
  // Best-effort: the state file feeds the TUI only. It must never mask a
  // successful analysis or apply with a throw.
  try {
    const global = await ctx.storage.get("proposal/global").catch(() => null)
  const repos = {}
  try {
    for (const e of await scanAll(ctx, "proposal/repo/")) {
      // Skip tombstones/blank entries (removed keys can scan back without a value).
      if (!e || typeof e.value !== "object" || !e.value || !e.value.text) continue
      repos[decodeURIComponent(e.key.slice("proposal/repo/".length))] = e.value
    }
  } catch (err) {
    console.error(`[learnloop] mirrorState proposals: ${err?.message ?? err}`)
  }
  const changelog = await readChangelog(ctx)
  const noModel = await ctx.storage.get(NO_MODEL_KEY).catch(() => null)
  await writeState({
    pending: pending.length,
    recent: pending
      .slice(-10)
      .map((f) => ({ repo: f.repo, line: String(f.text).split("\n")[0].slice(0, 200), at: f.at })),
    proposals: { global, repos },
    applies: changelog.slice(-5).map((c) => ({ at: c.at, scope: c.scope, file: c.file })),
    noModel: !!noModel,
  })
  } catch (err) {
    console.error(`[learnloop] mirrorState: ${err?.message ?? err}`)
  }
}

function globalAgentsPath() {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "opencode", "AGENTS.md")
}

const APPLY_USAGE = 'Usage: /learn-apply [repo|global|all] (bare "/learn-apply" writes the repo file only).'

async function applyProposals(ctx, sessionID, rawText) {
  const cleaned = (rawText ?? "").replace(/^\/learn-apply\s*/, "").trim()
  const arg = (cleaned.split(/\s+/)[0] ?? "").toLowerCase()
  if (!["", "repo", "global", "all"].includes(arg)) {
    return `# learnloop apply\n\nUnknown argument "${arg}". ${APPLY_USAGE}`
  }
  const rawSession = await ctx.session.get({ sessionID }).catch(() => undefined)
  const repo = repoOf(rawSession?.data ?? rawSession, ctx)
  const out = []
  if (arg === "global" || arg === "all") {
    out.push(await applyOne(ctx, "global", globalAgentsPath(), await ctx.storage.get("proposal/global").catch(() => null)))
  }
  if (arg === "" || arg === "repo" || arg === "all") {
    out.push(
      repo === "global"
        ? "repo: no repo for this session, nothing to apply."
        : !isAbsolute(repo)
          ? `repo: session directory is not absolute (${repo}), refusing to apply.`
          : await applyOne(ctx, repo, join(repo, "AGENTS.md"), await ctx.storage.get(`proposal/repo/${encodeURIComponent(repo)}`).catch(() => null)),
    )
  }
  await mirrorState(ctx, await unaggregated(ctx))
  return `# learnloop apply\n\n${out.join("\n")}\n\n${APPLY_USAGE}`
}

// looksLikeRules is a quality gate, not a sanitizer: injected text shaped
// like rules passes it. Human review before /learn-apply is the real control.
function looksLikeRules(text) {
  if (!text || typeof text !== "string") return false
  if (/nothing (to propose|repeats)|propose nothing|no (repeated |new )?patterns?|no corrections/i.test(text)) return false
  return /^\s*#{1,6}\s/m.test(text) || /^\s*([-*+]|\d+[.)])\s/m.test(text) || /```/.test(text)
}

async function resolveAgentsFile(scope, file) {
  const abs = resolve(file)
  if (basename(abs) !== "AGENTS.md") return { error: `${scope}: refusing to write ${abs} (not an AGENTS.md file).` }
  try {
    if ((await lstat(abs)).isSymbolicLink()) {
      return { error: `${scope}: refusing to write ${abs} (symlink).` }
    }
  } catch {
    // Missing file is fine; appendFile creates it.
  }
  return { path: abs }
}

async function applyOne(ctx, scope, file, proposal) {
  try {
    if (!proposal?.text || !looksLikeRules(proposal.text)) {
      return `${scope}: no proposal to apply.`
    }
    // Cap unbounded model output before it lands in AGENTS.md (and every
    // future agent context).
    const text = proposal.text.slice(0, 4000)
    if (proposal.appliedAt) {
      return `${scope}: already applied at ${new Date(proposal.appliedAt).toISOString()}, skipping.`
    }
    const resolved = await resolveAgentsFile(scope, file)
    if (resolved.error) return resolved.error
    let existing = ""
    try {
      existing = await readFile(resolved.path, "utf8")
    } catch {
      // File does not exist yet; appendFile creates it.
    }
    if (existing.includes(text)) return `${scope}: identical text already in ${resolved.path}, skipping.`
    const block = `\n## learnloop (${new Date().toISOString().slice(0, 10)})\n${text}\n<!-- learnloop sources: ${(proposal.sessions ?? []).join(", ")} -->\n`
    await appendFile(resolved.path, block)
    const key = scope === "global" ? "proposal/global" : `proposal/repo/${encodeURIComponent(scope)}`
    await ctx.storage.set(key, { ...proposal, appliedAt: Date.now() })
    const changelog = (await readChangelog(ctx)).slice(-(CHANGELOG_CAP - 1))
    changelog.push({ at: Date.now(), scope, file: resolved.path })
    await ctx.storage.set(CHANGELOG_KEY, changelog)
    return `${scope}: appended to ${resolved.path}.`
  } catch (err) {
    return `${scope}: apply failed (${err?.message ?? err}).`
  }
}

async function renderReview(ctx, sessionID) {
  const rawSession = await ctx.session.get({ sessionID }).catch(() => undefined)
  const repo = repoOf(rawSession?.data ?? rawSession, ctx)
  const global = await ctx.storage.get("proposal/global").catch(() => null)
  const repoProposal = await ctx.storage.get(`proposal/repo/${encodeURIComponent(repo)}`).catch(() => null)
  const pending = await unaggregated(ctx)
  const changelog = await readChangelog(ctx)
  const noModel = await ctx.storage.get(NO_MODEL_KEY).catch(() => null)
  const status = (p) => (p?.appliedAt ? ` (applied ${new Date(p.appliedAt).toISOString().slice(0, 10)})` : "")
  const lines = [
    "# learnloop review",
    "",
  ]
  if (noModel) {
    lines.push(
      "_Note: no zero-cost model is currently available, so session analysis is paused. It resumes automatically on the next session end._",
      "",
    )
  }
  lines.push(
    "## 1. Repeated patterns (unreviewed findings)",
    pending.length === 0
      ? "None pending. Findings appear here after sessions end."
      : pending.map((f) => `- [${f.repo}] ${String(f.text).split("\n")[0]}`.slice(0, 300)).join("\n"),
    "",
    `## 2. Proposed global AGENTS.md changes${status(global)}`,
    global?.text?.trim() ? global.text : "No global proposal yet.",
    "",
    `## 3. Proposed repo AGENTS.md changes (${repo})${status(repoProposal)}`,
    repoProposal?.text?.trim() ? repoProposal.text : "No repo proposal yet.",
    "",
  )
  if (changelog.length > 0) {
    lines.push(
      "Recent applies:",
      ...changelog.slice(-3).map((c) => `- ${new Date(c.at).toISOString().slice(0, 10)} ${c.scope} → ${c.file}`),
      "",
    )
  }
  lines.push("Review only: nothing is applied automatically. Run /learn-apply to append a proposal (repo by default).")
  return lines.join("\n")
}
