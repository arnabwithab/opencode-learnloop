import { Plugin } from "@opencode/plugin"

const FINDING_PREFIX = "finding/"
const THRESHOLD_DEFAULT = 3

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
          const text = await renderReview(ctx, sessionID)
          await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (isSessionEnd(event)) await handleSessionEnd(ctx, options, event, threshold)
        } catch (err) {
          console.error(`[learnloop] ${err?.message ?? err}`)
        }
      }
    })()
    return () => controller.abort()
  },
})

// shortcut: session-end event name unverified against the V2EventEncoded schema.
// Confirm via the running server's /openapi.json before trusting silent operation.
const SESSION_END_TYPES = new Set(["session.execution.succeeded", "session.idle", "session.completed"])

function isSessionEnd(event) {
  return SESSION_END_TYPES.has(event?.type)
}

async function handleSessionEnd(ctx, options, event, threshold) {
  const sessionID = event?.data?.sessionID ?? event?.sessionID
  if (!sessionID) return
  const analyzed = (await ctx.storage.get("analyzed")) ?? []
  if (analyzed.includes(sessionID)) return

  const messages = await ctx.session.context({ sessionID }).catch(() => [])
  if (isLearnSession(messages)) {
    await markAnalyzed(ctx, analyzed, sessionID)
    return
  }
  const session = await ctx.session.get({ sessionID }).catch(() => undefined)
  const repo = session?.directory ?? session?.projectID ?? "global"

  const model = await resolveModel(ctx, options)
  if (!model) {
    console.error("[learnloop] no free model available, skipping this session")
    return
  }
  const finding = await extract(ctx, model, messages)
  if (finding && finding !== "NONE") {
    await ctx.storage.set(`${FINDING_PREFIX}${sessionID}`, {
      sessionID,
      repo,
      at: Date.now(),
      text: finding,
      aggregated: false,
    })
  }
  await markAnalyzed(ctx, analyzed, sessionID)

  const pending = await unaggregated(ctx)
  if (pending.length >= threshold) await aggregate(ctx, model, pending)
}

function isLearnSession(messages) {
  return (messages ?? []).some((m) => String(m?.text ?? m?.content?.text ?? "").includes("/learn"))
}

async function markAnalyzed(ctx, analyzed, sessionID) {
  analyzed.push(sessionID)
  await ctx.storage.set("analyzed", analyzed)
}

function parseRef(ref) {
  const i = String(ref).indexOf("/")
  return i < 0 ? null : { providerID: ref.slice(0, i), id: ref.slice(i + 1) }
}

async function resolveModel(ctx, options) {
  if (options.model) return parseRef(options.model)
  const models = (await ctx.model.list()) ?? []
  const free = models.filter(
    (m) => (m.cost ?? []).length > 0 && m.cost.every((t) => (t.input ?? 0) === 0 && (t.output ?? 0) === 0),
  )
  const pick = free.find((m) => m.providerID === "opencode-go") ?? free[0]
  return pick ? { providerID: pick.providerID, id: pick.id } : null
}

function transcript(messages) {
  return (messages ?? [])
    .slice(-60)
    .map((m) => {
      const text = m?.text ?? m?.content?.text ?? JSON.stringify(m?.content ?? "")
      return `${m?.role ?? "?"}: ${String(text)}`.slice(0, 1000)
    })
    .join("\n")
}

async function extract(ctx, model, messages) {
  const result = await ctx.generate.text({
    model,
    prompt: `You review one coding-agent session transcript and note where the user corrected, overrode, or redid the agent's work by hand. List each as one short line: what the agent did wrong and what the user wanted instead. Cover: follow-up corrections ("no, not that file", "use X instead"), rejected tool calls or aborted runs, and edits the user made by hand after the agent. If the session has no corrections, reply with exactly: NONE\n\nTranscript:\n${transcript(messages)}`,
  })
  return result.text.trim()
}

async function unaggregated(ctx) {
  const page = await ctx.storage.scan({ prefix: FINDING_PREFIX, limit: 500 })
  return page.entries.map((e) => e.value).filter((f) => f && !f.aggregated)
}

async function aggregate(ctx, model, findings) {
  const byRepo = new Map()
  for (const f of findings) {
    if (!byRepo.has(f.repo)) byRepo.set(f.repo, [])
    byRepo.get(f.repo).push(f)
  }
  for (const [repo, items] of byRepo) {
    const text = await propose(ctx, model, `repo scope (${repo}). Only propose rules specific to this repo.`, items)
    await ctx.storage.set(`proposal/repo/${encodeURIComponent(repo)}`, { repo, at: Date.now(), text })
  }
  const global = await propose(
    ctx,
    model,
    "global scope. Only propose rules that hold across repos (workflow and style preferences), never repo-specific paths or tools.",
    findings,
  )
  await ctx.storage.set("proposal/global", { at: Date.now(), text: global })
  for (const f of findings) {
    await ctx.storage.set(`${FINDING_PREFIX}${f.sessionID}`, { ...f, aggregated: true })
  }
}

async function propose(ctx, model, scope, findings) {
  const notes = findings.map((f) => `- [${f.repo}] ${f.text}`.slice(0, 2000)).join("\n")
  const result = await ctx.generate.text({
    model,
    prompt: `You turn repeated user corrections into AGENTS.md additions. ${scope}\n\nFirst list the repeated patterns (2+ occurrences of the same correction). Then write each proposed rule as a short markdown diff block. Skip one-off quirks. If nothing repeats, say so and propose nothing.\n\nFindings:\n${notes}`,
  })
  return result.text.trim()
}

async function renderReview(ctx, sessionID) {
  const session = await ctx.session.get({ sessionID }).catch(() => undefined)
  const repo = session?.directory ?? session?.projectID ?? "global"
  const global = await ctx.storage.get("proposal/global")
  const repoProposal = await ctx.storage.get(`proposal/repo/${encodeURIComponent(repo)}`)
  const pending = await unaggregated(ctx)
  const lines = [
    "# learnloop review",
    "",
    "## 1. Repeated patterns (unreviewed findings)",
    pending.length === 0
      ? "None pending. Findings appear here after sessions end."
      : pending.map((f) => `- [${f.repo}] ${String(f.text).split("\n")[0]}`.slice(0, 300)).join("\n"),
    "",
    "## 2. Proposed global AGENTS.md changes",
    global?.text ?? "No global proposal yet.",
    "",
    `## 3. Proposed repo AGENTS.md changes (${repo})`,
    repoProposal?.text ?? "No repo proposal yet.",
    "",
    "Review only: nothing is applied automatically. Copy what you want into the relevant AGENTS.md.",
  ]
  return lines.join("\n")
}
