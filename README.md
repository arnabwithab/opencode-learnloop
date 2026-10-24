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

## Usage

Just work. When enough sessions have notes, run:

```
/learn
```

You get three sections: repeated patterns, proposed global `AGENTS.md` changes, proposed repo `AGENTS.md` changes. Copy what you want; ignore the rest.

## Options

```jsonc
{
  "plugins": [{ "package": "opencode-learnloop", "options": { "model": "anthropic/claude-haiku-5-5", "threshold": 5 } }],
}
```

| Option      | Default                | Meaning                                                            |
| ----------- | ---------------------- | ------------------------------------------------------------------ |
| `model`     | cheapest free Go model | `providerID/modelID` used for extraction and proposals             |
| `threshold` | `3`                    | unreviewed findings that trigger background aggregation            |
| `enabled`   | `true`                 | set `false` as a killswitch                                        |

Without `model`, the plugin resolves a zero-cost `opencode-go` model from the registry at fire time (free models rotate, so this is never pinned). If none is available the run is skipped and retried on the next session end.

## How it works

1. **Session ends** → one cheap pass extracts corrections into a finding tagged with the repo.
2. **Threshold hit** → background aggregation runs twice: per-repo findings → repo proposal, all findings → global proposal.
3. **`/learn`** → renders patterns + both proposals as review-only text.

Model calls use `generate` (no session created), so the plugin never analyzes itself.

## Current limits (v0)

- Review only: applying diffs to `AGENTS.md` is manual.
- TUI toasts and dialog review are not wired yet; `/learn` works everywhere including headless.
- The session-end event name still needs confirmation against the V2 event schema (see `shortcut` comment in `src/index.js`).

## License

MIT
