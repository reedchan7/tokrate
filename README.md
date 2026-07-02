# tokrate

Accurate, persistent tok/s (output speed) for [`claude-hud`](https://github.com/jarrodwatts/claude-hud) — current
speed plus session peak / average / min, computed from the real session transcript instead
of guessed from noisy hook-call sampling.

## The problem

`claude-hud` already ships a `showSpeed` option, but the built-in implementation:

- computes rate by diffing `output_tokens` between two consecutive statusline hook
  invocations — and those fire at wildly irregular intervals (idle waiting, tool calls,
  thinking time all mixed in), so most two-call deltas are meaningless
- can go an entire multi-hour session without ever landing two calls close enough
  together to register a single reading
- when it does land one, a single context-recount jump (e.g. right after a subagent's
  result folds back into context) can produce a physically impossible number like
  17,000 tok/s
- renders in a barely-visible grey and vanishes completely the instant it's not
  mid-generation

## The fix

Reconstruct every turn's real duration and token count directly from the session's
transcript JSONL: attribute each assistant message's `output_tokens` to the span between
the preceding user entry (real input, or a tool result — Claude Code writes those back as
`user`-role entries too) and that message's own timestamp. Tool-execution wait time falls
in the gap between an assistant entry and the next user entry, so it's structurally
excluded — no threshold-tuning needed. Averages are time-weighted (total tokens ÷ total
active seconds), not a naive mean of per-sample rates. The whole thing is stateless: no
cache file, nothing to corrupt, nothing that depends on how often the hook happens to fire.

See [DESIGN.md](DESIGN.md) for the full rationale, including the two confirmed bugs
(15-hour session that never once fired, and a real 17,492 tok/s reading) that motivated
the rewrite.

## Before / after

```
out: 161.3 tok/s                              stock claude-hud — grey, vanishes when idle

⚡ 44.9 tok/s (▲135 ~74 ▼13)                   tokrate — colored by speed tier, stays
                                               visible for the whole session once one
                                               turn has completed
```

## Quick start

Paste this into your coding agent (Claude Code or anything with shell access):

> Run tokrate's installer to fix claude-hud's tok/s display
> (`curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash`),
> confirm the statusline now shows a persistent `⚡ tok/s (▲~▼)` segment, and if the
> script reports incompatibility, read `https://github.com/reedchan7/tokrate`'s
> `reference/` and `DESIGN.md` to port the change by hand instead.

Or just run the installer yourself, no agent required:

```bash
curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash
```

`install.sh` locates your installed `claude-hud` version, backs up the four files it's
about to touch, patches them, turns on the `showSpeed` display flag, and runs a real
self-test (a synthetic transcript through the actual statusline command) before declaring
success — so it either works and tells you so, or fails loudly with the fallback
instruction above instead of silently corrupting your install. Standalone copy of the
agent prompt in [PROMPT.md](PROMPT.md).

## Why an installer *and* an agent fallback

`claude-hud` runs its TypeScript source directly out of
`~/.claude/plugins/cache/claude-hud/claude-hud/<version>/`, a versioned cache directory the
plugin manager overwrites wholesale on every update. There's no stable path to `npm install`
against, and the exact file structure can shift between versions. `install.sh` handles the
common case mechanically — locate, back up, patch, verify — and checks a compatibility
marker before touching anything. If that check fails (plugin internals have drifted too
far), it bails out loudly instead of guessing, and tells you to fall back to an agent
reading `reference/` + `DESIGN.md` and porting the same logic by hand. Re-run either path
any time a `claude-hud` update wipes the patch.

## What's here

- `install.sh` — the installer described above
- `reference/` — the patched source it copies in (`speed-tracker.ts`, `colors.ts`,
  `session-line.ts`, `lines/project.ts`)
- `PROMPT.md` — the agent prompt above, standalone
- `DESIGN.md` — algorithm rationale, the bugs this replaces, and manual porting notes
- `.github/workflows/shellcheck.yml` — lints `install.sh` on every push/PR

## License

MIT
