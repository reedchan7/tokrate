# Design notes

## Starting point

[`claude-hud`](https://github.com/jarrodwatts/claude-hud) already ships a `showSpeed` display option. Enabling it
prints a grey `out: X.X tok/s` computed like this:

- Every time the statusline hook fires, read `output_tokens` from the stdin payload's
  `context_window.current_usage`.
- Diff it against the value + timestamp recorded on the *previous* hook call.
- If the two calls landed within a fixed window (originally 2 seconds), report
  `deltaTokens / deltaMs` as the instantaneous rate.

This has three compounding problems, found in roughly this order while chasing why the
number kept disappearing.

## Problem 1: the indicator vanishes when idle

If `deltaTokens` is 0 (nothing generated between calls) or the gap exceeds the window,
the function returns `null` and the renderer skips the segment entirely — not "0.0",
not the last known value, just gone. First fix: cache the last live reading and carry
it forward (`isLive: false`) while idle, rendered in a forced-dim color to distinguish
"stale" from "fresh."

## Problem 2: the 2-second window almost never fires in real usage

Inspecting real session cache files showed `sampleCount` stuck at 0–3 across
15–20 minute sessions with heavy tool activity. Claude Code's statusline hook isn't
invoked continuously during generation — real gaps are frequently several seconds,
not the ~300ms originally assumed. Widened the window to 15 seconds to tolerate that
cadence. This helped, but see Problem 4.

## Problem 3: naive mean-of-samples for average

`avg = sumSpeed / sampleCount` treats every sample as "one vote," regardless of how
long a real span it covers. A session with two 0.3s bursts at 200 tok/s and one 13s
gap (mostly a tool call, 5 tok/s measured) reports `avg ≈ 151 tok/s` — the true
throughput over the whole span is `total_tokens / total_time ≈ 17 tok/s`. Fix: track
`sumTokens` and `sumMs` instead of a running sum-of-rates, so
`avg = sumTokens / (sumMs / 1000)` — a time-weighted mean. Mechanically correct, but
still only as good as the samples it's built from (see Problem 4).

## Problem 4: the real, structural bug — sampling hook-call deltas can't distinguish generation from everything else

Even with a wide window and correct weighting, diffing `output_tokens` across two
*wall-clock* hook invocations conflates real generation time with tool-call waits,
thinking time, and idle gaps that happen to land inside the window. Two things were
found by inspecting real cache files from a 15-hour session:

- The tok/s indicator had **never fired once** in 15 hours — the "two calls close
  enough together" condition simply never lined up until moments before it was
  checked.
- When it finally did fire, it reported **17,492 tok/s** — physically impossible.
  The likely cause: `context_window.current_usage.output_tokens` isn't a smoothly
  incrementing per-token counter; it can jump by thousands within a sub-second gap
  between hook calls (a plausible trigger being a subagent's result folding back into
  the parent's context, causing a one-time context recount that has nothing to do
  with real-time decode speed). Sampling deltas of this field is fundamentally
  unreliable, no matter how the window or weighting is tuned.

## The fix: reconstruct turns from the transcript, not from hook-call sampling

Inspired by [`ccstatusline`](https://github.com/sirmalloc/ccstatusline)'s
`Token Speed` widget, which takes a completely different approach: it never diffs
hook-call state. Instead, on every invocation it reads the session's transcript JSONL
(`transcript_path`, already present in the standard statusline stdin payload) and
walks it to reconstruct per-turn intervals:

- Track the timestamp of the most recent `type: "user"` entry — this covers both
  real user input *and* tool-result messages, since Claude Code writes tool results
  back to the transcript as `user`-role entries.
- For each `type: "assistant"` entry, attribute its message's `usage.output_tokens`
  to the span `[last_user_timestamp, this_message_timestamp]`.
- A single logical message can appear as multiple JSONL lines (one per streamed
  content block — `thinking`, `text`, `tool_use` — each carrying the same final
  `usage`), so intervals are deduplicated by `message.id`: only the last line for a
  given id contributes, using its timestamp as the interval end.

Tool-execution wait time structurally falls in the gap *between* an assistant entry
and the next user entry — it's never inside any interval, so it's excluded without
any threshold to tune. Stats are computed directly from the interval list on every
call:

- **current** — the last interval's own `tokens / duration`.
- **max / min** — the extremes across all intervals.
- **avg** — `total_tokens / total_duration` across all intervals (still
  time-weighted, now sourced from real per-turn spans instead of hook-call deltas).

This is stateless — no cache file, nothing to migrate, nothing that can go stale or
corrupt. It's also now genuinely persistent: as soon as one turn exists anywhere in
the transcript, the reading is available and stays available indefinitely, regardless
of how long the gap since is or how the hook happens to be invoked.

Verified against a real 2MB / 1200-line, 15-hour transcript: full reparse takes
~90ms (statusline-refresh budget is generally hundreds of ms), and every number
produced was in a physically sane range.

## Bug found after the rewrite: interleaved tool_use blocks re-attributing a message's full token count

The first version of the rewrite closed out the "current message" on *every* `user`
entry — reasoning that a `user` entry always means the previous assistant turn is
done. That's wrong for a message with multiple `tool_use` blocks: Claude Code can log
each block's tool result as its own `user` entry as soon as that tool finishes, while
*later* blocks of the *same* message (same `message.id`) are still being written. The
transcript ends up looking like:

```
assistant (thinking)      msg_ABC
assistant (tool_use #1)   msg_ABC
user (tool_result #1)
assistant (tool_use #2)   msg_ABC   <- same message.id, after an intervening user entry
user (tool_result #2)
assistant (tool_use #3)   msg_ABC   <- same message.id again
user (tool_result #3)
```

Closing on every `user` entry finalized `msg_ABC` after the first `tool_use` block,
then treated its reappearance as a *new* message starting fresh from the just-seen
`user` timestamp. Since `usage.output_tokens` is the message's full total token count
(not a per-block increment), the same ~1000-token total got re-attributed to each
remaining fragment, each spanning well under a second — producing readings confirmed
in real session transcripts as high as 5,048 tok/s.

Found by testing the actual documented install path end-to-end (a `curl | bash`
install plus a fresh agent following [PROMPT.md](PROMPT.md) with no context from the
development conversation) against several real recent session transcripts, rather than
only the synthetic two-line self-test transcript, which never exercises multi-tool-call
messages.

**Fix:** track messages in a map keyed by `message.id` instead of a single "current
message" slot. A message's interval starts at first sighting and its end keeps
extending as later blocks for the same id arrive, regardless of what `user` entries
are interleaved in between — so the same message contributes exactly one interval, at
its true (possibly tool-call-spanning) duration, no matter how its blocks are split
across the transcript. Re-verified against the same real transcripts that had produced
impossible readings: all now report rates in the tens-to-low-hundreds tok/s range.

## What's deliberately not carried over from claude-hud's original code

- **`isLive`** — no longer meaningful. Every reading is now "the real rate of the
  actual last completed (or in-progress) turn," not a wall-clock-gap artifact, so
  there's nothing to distinguish "fresh" from "stale."
- **Any use of dim/grey for the speed value** — removed in two steps, both at the
  user's request. First the *forced* dim-while-idle carry-forward behavior went away
  once the indicator became reliably persistent. Then the original "slow speed reads
  as dim" tier went too — a genuinely slow reading is still real, useful information
  and should stay as easy to read as a fast one, not fade out like a stale/broken
  value would. `getSpeedColor` now has exactly two tiers: green (≥150 tok/s) and cyan
  (everything else). `DIM` is still used elsewhere in `colors.ts` for unrelated
  low-emphasis labels (session name, duration) — just never for the speed reading.

## A semantic trade-off worth knowing about

"min" can include a turn where the model spent a long time on internal `thinking`
before responding — that thinking time counts toward the interval, so a low reading
reflects real end-to-end latency for that turn, not "pure decode throughput." There's
no finer-grained, per-token streaming timestamp available in the transcript to split
those apart.

## Version drift found by actually testing against a version jump: wholesale copy is the wrong mechanism for 3 of the 4 files

`install.sh` originally replaced all four target files wholesale — copy `reference/*.ts`
straight over the installed files, gated by a grep for the literal call site
`getOutputSpeed(ctx.stdin)`. This looked safe as long as testing only ever happened
against whatever version was already cached locally (0.0.11, installed months earlier
and never auto-updated). Testing the actual `curl | bash` install path against a
genuinely fresh environment — no local checkout, `claude-hud` not installed at all —
surfaced two things at once:

1. **A missing capability, not just a missing check.** `install.sh` required
   `claude-hud` to already be installed and just failed with "is the plugin installed?"
   otherwise. Since `claude plugin marketplace add`/`claude plugin install` are both
   real, non-interactive, idempotent CLI commands, `install.sh` now auto-installs
   `claude-hud` when it's missing (falling back to printing the manual commands only
   if the `claude` CLI itself isn't on PATH).
2. **The auto-install pulled `claude-hud` 0.3.0** — five minor versions ahead of the
   0.0.11 every reference file had been written and tested against. `render/colors.ts`,
   `render/session-line.ts`, and `render/lines/project.ts` had all grown substantially
   in the meantime: i18n (`t(...)`), cost-estimate/prompt-cache/session-time/advisor
   lines, provider-aware model formatting, configurable context thresholds, a new git
   file-stats line (`renderGitFilesLine`), and more — none of it related to speed.
   Copying the old reference files over these wholesale did pass the `getOutputSpeed`
   grep check (the call site itself hadn't moved), but crashed the whole statusline
   with `SyntaxError: export 'renderGitFilesLine' not found in './project.js'` — a
   different file (`render/lines/index.ts`) still expected to re-export a function the
   overwritten `project.ts` no longer had, because it belonged to 0.3.0 and the
   overwrite silently deleted it. The self-test *did* correctly catch this and roll
   back rather than leaving the install broken — but a fresh environment has no
   `settings.json` yet either, so in that specific case the self-test itself couldn't
   run, and the install just failed outright instead of subtly breaking the statusline.
   Either way: shipping this against current `claude-hud` would have made tokrate
   simply not work for anyone starting fresh.

**Fix — stop wholesale-copying the three files that carry unrelated content, patch them
in place instead.** `speed-tracker.ts` still gets replaced wholesale (nothing else in
the plugin imports from it beyond the single `getOutputSpeed` call, so there's nothing
to lose). `colors.ts`/`session-line.ts`/`lines/project.ts` are now patched surgically by
[`apply-patch.mjs`](apply-patch.mjs):

- **`colors.ts`**: verifies the `GREEN`/`CYAN`/`BRIGHT_MAGENTA`/`RESET` constants it
  needs still exist, then *appends* an import (`SpeedReading` type) and the
  `getSpeedColor`/`formatSpeedReading` functions — additive only, nothing existing is
  touched.
- **`session-line.ts`** / **`lines/project.ts`**: finds the literal
  `if (display?.showSpeed) {` marker, walks forward counting brace depth to find its
  *matching* closing brace (robust to whatever's inside — the exact rendering
  expression has already differed between 0.0.11 and 0.3.0), and replaces only that
  span with the fixed 5-line reading/rendering block, adding `formatSpeedReading` to
  the existing `colors.js` import if it isn't already there.

Every check fails loudly (thrown error, non-zero exit, caught by `install.sh`'s `set -e`
and rolled back via the existing backup) rather than guessing — same fail-closed
posture as before, just checking the right things now. Verified against both a fully
fresh environment (auto-install pulling 0.3.0, patch, self-test, all in one run) and the
real 0.0.11 → 0.3.0 upgrade path on the machine this was developed on; both patch
cleanly, both preserve every unrelated feature (`renderGitFilesLine` included), and both
produce identical, sane numbers against the same real transcripts.

`reference/colors.ts`, `reference/session-line.ts`, and `reference/lines/project.ts` are
now kept as **current-version worked examples** (currently 0.3.0-based) for humans or
agents doing the manual fallback below — `install.sh` itself no longer copies them
directly.

## Known limitation

This patches `claude-hud`'s versioned plugin-cache directory
(`~/.claude/plugins/cache/claude-hud/claude-hud/<version>/src/`), which the plugin
manager overwrites wholesale on every version update. The patch will be silently lost
the next time `claude-hud` updates — symptom: the indicator reverts to a grey
`out: X tok/s` with no peak/avg/min segment. Re-running `install.sh` (see
[PROMPT.md](PROMPT.md)) reapplies it in a couple of minutes. The durable fix is
upstreaming this into `claude-hud` itself.

## Manual porting (when install.sh can't do it automatically)

`apply-patch.mjs` fails loudly — thrown error, `install.sh` rolls back to the backup —
if any of what it depends on has moved: the `GREEN`/`CYAN`/`BRIGHT_MAGENTA`/`RESET`
color constants in `colors.ts`, or the `if (display?.showSpeed) {` marker and its
`getOutputSpeed(ctx.stdin)` call in `session-line.ts`/`lines/project.ts`. That's still
narrower than everything the reference files assume, though — `speed-tracker.ts`
imports `StdinData` from `./types.js`; `colors.ts` imports `HudColorName`/
`HudColorValue`/`HudColorOverrides` from `../config.js`; the two render files import
`RenderContext` and whatever model/context helpers they call from `../stdin.js` (or
`../../stdin.js`). If any of those have been renamed or reshaped elsewhere in the
plugin, `install.sh`'s self-test is the real backstop for that class of drift, which is
why it's a hard failure (with automatic rollback) rather than a skippable check. If it
does fail, or you're porting by hand for any other reason:

1. Diff each file in `reference/` against its counterpart in the installed
   `.../claude-hud/<version>/src/` tree — `reference/` holds a current-version worked
   example, not necessarily what your installed version looks like. For
   `speed-tracker.ts`, replace wholesale if structurally close, otherwise port the
   *logic*. For `colors.ts`/`session-line.ts`/`lines/project.ts`, don't copy the whole
   file — find the equivalent `getSpeedColor`/`formatSpeedReading` functions and the
   `showSpeed` rendering block in `reference/` and insert just those into the installed
   file's real current structure, the same way `apply-patch.mjs` does it mechanically.
2. Confirm `showSpeed: true` is set under `display` in
   `~/.claude/plugins/claude-hud/config.json` (add the key if it's missing).
3. Verify the same way `install.sh`'s self-test does: pipe a synthetic stdin payload
   with a `transcript_path` pointing at a two-line JSONL (one `user` entry, one
   `assistant` entry with a `usage.output_tokens` value) through the real statusline
   command, and confirm a `⚡ <speed> tok/s (▲<max> ~<avg> ▼<min>)` segment comes out
   with sane, non-absurd numbers.
