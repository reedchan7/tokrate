# tokrate

Accurate, persistent tok/s for [`claude-hud`](https://github.com/jarrodwatts/claude-hud) —
current speed, plus session peak / average / min, reconstructed from your real session
transcript instead of guessed from noisy hook-call timing.

```
out: 161.3 tok/s                              stock claude-hud — grey, vanishes when idle

⚡ 44.9 tok/s (▲135 ~74 ▼13)                   tokrate — colored, stays visible for the
                                               whole session
```

## Preview

<img width="1168" height="109" alt="Warp 2026-07-02 10 50 36" src="https://github.com/user-attachments/assets/1a6d1fa2-45e4-4ff9-817f-1af4d444fe97" />


## Install

```bash
curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash
```

Or hand it to your coding agent instead:

```
Run tokrate's installer to fix claude-hud's tok/s display by running
curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash
then confirm the statusline shows a persistent "⚡ tok/s (▲~▼)" segment. If the
script reports incompatibility, read https://github.com/reedchan7/tokrate's
reference/ and DESIGN.md and port the change by hand instead.
```

`install.sh` installs `claude-hud` itself if it isn't already, locates the install,
backs up the files it's about to touch, patches them, and runs a real self-test before
declaring success — it either works and tells you so, or fails loudly and rolls back.
Standalone copy of the prompt in [PROMPT.md](PROMPT.md).

## Why

`claude-hud`'s built-in `showSpeed` diffs `output_tokens` between statusline hook calls,
which fire at irregular real-world intervals. That means it:

- can go an entire session without ever registering a single reading
- occasionally reports impossible numbers (a real one: 17,492 tok/s) when a context jump
  lands in a short gap between calls
- renders barely-visible grey and disappears the instant nothing's generating

tokrate reconstructs each turn's real duration and token count from the transcript
instead — tool-wait time structurally falls outside every interval, no threshold-tuning
needed, and there's no cache file to go stale. Full writeup, including the two confirmed
bugs that motivated the rewrite, in [DESIGN.md](DESIGN.md).

## What's here

- `install.sh` — the installer
- `apply-patch.mjs` — surgically patches `colors.ts`/`session-line.ts`/`lines/project.ts`
  in place (only `speed-tracker.ts` is replaced wholesale)
- `reference/` — a current-version worked example (`speed-tracker.ts`, `colors.ts`,
  `session-line.ts`, `lines/project.ts`) for manual porting
- `PROMPT.md` — the agent prompt, standalone
- `DESIGN.md` — algorithm rationale, the bugs this replaces, manual porting notes
- `.github/workflows/shellcheck.yml` — lints `install.sh` on every push/PR

## License

[MIT](./LICENSE)
