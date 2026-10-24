import { Plugin } from "@opencode/plugin/tui"
import { readState } from "./state.js"

export default Plugin.define({
  id: "learnloop.cli",
  setup(context) {
    let lastSeen = 0
    // Boot check is NOT silent: toast immediately when prior state already
    // has pending findings or proposals (e.g. written by the server plugin).
    void check(false).catch((err) => console.error(`[learnloop] ${err?.message ?? err}`))

    async function check(silent) {
      let state
      try {
        state = await readState()
      } catch (err) {
        console.error(`[learnloop] readState: ${err?.message ?? err}`)
        return
      }
      const fresh = (state.updatedAt ?? 0) > lastSeen
      lastSeen = Math.max(lastSeen, state.updatedAt ?? 0)
      if (silent || !fresh) return
      const pending = state.pending ?? 0
      const hasProposals = !!(state.proposals?.global || Object.keys(state.proposals?.repos ?? {}).length)
      if (pending > 0 || hasProposals) {
        await context.ui.toast.show({
          title: "learnloop",
          message: `${pending} correction notes ready. /learn-review to browse, /learn in a session for the full review.`,
          duration: 5000,
        }).catch((err) => console.error(`[learnloop] toast: ${err?.message ?? err}`))
      }
    }

    const timer = setInterval(() => void check(false).catch((err) => console.error(`[learnloop] ${err?.message ?? err}`)), 60_000)
    const stopListen = context.data.listen(() => {
      void check(false).catch((err) => console.error(`[learnloop] ${err?.message ?? err}`))
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "learnloop.review",
          title: "Review learnloop proposals",
          group: "learnloop",
          palette: true,
          slash: { name: "learn-review" },
          run: async () => {
            await review(context).catch((err) => context.ui.toast.show({
              title: "learnloop",
              message: `Review failed: ${err?.message ?? err}`,
              duration: 4000,
            }).catch(() => {}))
          },
        },
      ],
      bindings: ["learnloop.review"],
    }))

    return () => {
      clearInterval(timer)
      stopListen()
    }
  },
})

function selectValue(choice) {
  if (typeof choice === "string") return choice
  if (choice && typeof choice === "object") return choice.value ?? choice.title
  return undefined
}

async function review(context) {
  const state = await readState()
  const options = []
  try {
    if ((state.recent ?? []).length > 0) {
      options.push({ title: `Patterns (${state.pending} pending)`, value: "patterns", description: state.recent[0].line })
    }
  } catch (err) {
    console.error(`[learnloop] review patterns: ${err?.message ?? err}`)
  }
  try {
    if (state.proposals?.global) options.push({ title: "Global AGENTS.md proposal", value: "global" })
    for (const repo of Object.keys(state.proposals?.repos ?? {})) {
      options.push({ title: `Repo proposal: ${repo}`, value: `repo:${repo}` })
    }
  } catch (err) {
    console.error(`[learnloop] review proposals: ${err?.message ?? err}`)
  }
  if (state.noModel) {
    options.push({ title: "Analysis paused (no free model)", value: "__nomodel", description: "Session analysis resumes when a free model is available" })
  }
  if (options.length === 0) {
    await context.ui.toast.show({ title: "learnloop", message: "Nothing to review yet.", duration: 3000 })
    return
  }
  const raw = await context.ui.dialog.select({ title: "learnloop review", options })
  const choice = selectValue(raw)
  if (!choice) return
  if (choice === "__nomodel") {
    await context.ui.dialog.alert({
      title: "Analysis paused",
      message: "No zero-cost model is available right now, so session analysis is paused. It resumes automatically on the next session end. You can also pin a model via the plugin's `model` option.",
    })
    return
  }
  let title = choice
  let text = ""
  try {
    if (choice === "patterns") {
      title = "Repeated patterns"
      text = (state.recent ?? []).map((r) => `- [${r.repo}] ${r.line}`).join("\n")
    } else if (choice === "global") {
      title = "Global AGENTS.md proposal"
      text = state.proposals.global.text ?? ""
    } else if (choice.startsWith("repo:")) {
      title = `Repo proposal: ${choice.slice(5)}`
      text = state.proposals.repos[choice.slice(5)]?.text ?? ""
    }
  } catch (err) {
    console.error(`[learnloop] review render: ${err?.message ?? err}`)
  }
  await context.ui.dialog.alert({
    title,
    message: `${String(text).slice(0, 4000)}\n\nApply from a session with /learn-apply (repo) or /learn-apply global.`,
  })
}
