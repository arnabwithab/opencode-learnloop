# opencode-learnloop

Learn from your OpenCode sessions. After each session ends, learnloop notes where you corrected, overrode, or redid the agent's work by hand. Once enough notes pile up, it proposes `AGENTS.md` additions — per-repo and global — for you to review with `/learn`. Nothing is applied automatically.

## Install

```sh
npm install opencode-learnloop
```

Add to your global or project `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-learnloop"],
}
```

The server plugin (`./src/index.js`) loads automatically this way and provides `/learn` and `/learn-apply`. The TUI companion (`./tui`) loads automatically with it in a local TUI. Against a remote server, a CLI-only install needs `cli.json` instead:

```jsonc
// cli.json
{
  "plugins": ["opencode-learnloop"],
}
```

> Server and TUI must run on the same host: the TUI reads the state file the server plugin writes (`~/.local/share/opencode/learnloop/state.json`), so a remote TUI cannot see it.

## Usage

Just work. When enough sessions have notes, run in any session:

```
/learn
```

You get three sections: repeated patterns, proposed global `AGENTS.md` changes, proposed repo `AGENTS.md` changes (plus a trailing list of recent applies, if any). Copy what you want; ignore the rest.

`/learn` is a server-side command (full review text, works headless). `/learn-review` is the TUI companion: a dialog that browses the same state file (patterns / global / repo) with toasts when new notes arrive. Both are review-only.

To append a proposal to `AGENTS.md` after reviewing:

```
/learn-apply          # repo AGENTS.md only
/learn-apply repo     # same as bare
/learn-apply global   # global AGENTS.md only
/learn-apply all      # both
```

Each scope applies at most once (re-runs skip) and identical text is never appended twice.

> Proposals are untrusted model output — review them with `/learn` before applying. `/learn-apply` only ever writes files literally named `AGENTS.md` and refuses symlinks.

## Options

```jsonc
{
  "plugins": [{ "package": "opencode-learnloop", "options": { "model": "anthropic/claude-haiku-4-5", "threshold": 5 } }],
}
```

| Option              | Default                | Meaning                                                            |
| ------------------- | ---------------------- | ------------------------------------------------------------------ |
| `model`             | cheapest free Go model | `providerID/modelID` used for extraction and proposals             |
| `preferredProvider` | `opencode-go`          | provider preferred when auto-picking the zero-cost model           |
| `threshold`         | `3`                    | unreviewed findings that trigger background aggregation            |
| `enabled`           | `true`                 | set `false` as a killswitch                                        |

Without `model`, the plugin resolves a zero-cost model from the registry at fire time (free models rotate, so this is never pinned). Models with unknown cost info are never treated as free. If none is available the run is skipped and retried on the next session end; `/learn` shows a notice while analysis is paused.

To load from a local checkout instead of npm, use a `file://` URL — plain absolute paths are silently ignored by the plugin loader:

```jsonc
{
  "plugins": [{ "package": "file:///home/you/code/opencode-learnloop", "options": { "threshold": 1 } }]
}
```

The threshold counts unreviewed findings across all repos. Sessions you continue are re-analyzed on each end (only the new transcript tail is new work); `/learn` sessions themselves are never analyzed.

## How it works

1. **Session ends** (`session.execution.succeeded/failed/interrupted`) → one cheap pass extracts corrections into a finding tagged with the repo. Each session is claimed before analysis so concurrent ends and retries are idempotent.
2. **Threshold hit** → background aggregation runs twice: per-repo findings → repo proposal, all findings → global proposal. Findings are deleted after aggregation (applied state is preserved across re-aggregation).
3. **`/learn`** → renders patterns + both proposals as review-only text. **`/learn-apply`** → appends a reviewed proposal to `AGENTS.md`.

Model calls use `generate` (no session created), so the plugin never analyzes itself. Prompts are capped (~12k chars). The working-tree diff is read at analysis time (whatever is uncommitted when the session ends), not scoped to that session — treat diff-derived findings accordingly.

## Current limits (v0)

- `/learn` and `/learn-apply` dispatch through live sessions (TUI slash). Headless `opencode run "/learn"` passes the text to the agent instead of executing the command.
- `/learn-apply` appends whole proposals under a dated `## learnloop` heading; curating individual rules is manual.
- The TUI dialog (`/learn-review`) only displays state; applying happens from a session via `/learn-apply`.

## License

MIT
