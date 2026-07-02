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

## Known limitation

This patches `claude-hud`'s versioned plugin-cache directory
(`~/.claude/plugins/cache/claude-hud/claude-hud/<version>/src/`), which the plugin
manager overwrites wholesale on every version update. The patch will be silently lost
the next time `claude-hud` updates — symptom: the indicator reverts to a grey
`out: X tok/s` with no peak/avg/min segment. Re-running `install.sh` (see
[PROMPT.md](PROMPT.md)) reapplies it in a couple of minutes. The durable fix is
upstreaming this into `claude-hud` itself.

## Manual porting (when install.sh can't do it automatically)

`install.sh` checks for the literal call site `getOutputSpeed(ctx.stdin)` in the
installed `render/session-line.ts` and `render/lines/project.ts` before touching
anything, and refuses to proceed if it's missing — a signal that the plugin's
internals have drifted further than a straight file copy can safely handle. That
check only covers the call site itself, though — each reference file also assumes
several sibling symbols still exist with the same shape: `speed-tracker.ts` imports
`StdinData` from `./types.js`; `colors.ts` imports `HudColorName`/`HudColorValue`/
`HudColorOverrides` from `../config.js`; `session-line.ts` imports `RenderContext` and
`isLimitReached` from `../types.js` and `getContextPercent`/`getBufferedPercent`/
`getModelName`/`getProviderLabel`/`getTotalTokens` from `../stdin.js` and
`getAdaptiveBarWidth` from `../utils/terminal.js`; `lines/project.ts` imports
`RenderContext` from `../../types.js` and `getModelName`/`getProviderLabel` from
`../../stdin.js`. If any of those have been renamed or reshaped elsewhere in the
plugin, the call-site grep can still pass while the patched files fail at runtime —
`install.sh`'s self-test is the real backstop for that class of drift, which is why
it's a hard failure (with automatic rollback) rather than a skippable check. If it
does fail, or you're porting by hand for any other reason:

1. Diff each file in `reference/` against its counterpart in the installed
   `.../claude-hud/<version>/src/` tree. If a file is structurally close (same
   exports, same call sites), replace it wholesale. If it's diverged — different
   function names, different types, a different render pipeline — port the same
   *logic* instead of copy-pasting; the goal is behavior parity, not literal file
   identity.
2. Confirm `showSpeed: true` is set under `display` in
   `~/.claude/plugins/claude-hud/config.json` (add the key if it's missing).
3. Verify the same way `install.sh`'s self-test does: pipe a synthetic stdin payload
   with a `transcript_path` pointing at a two-line JSONL (one `user` entry, one
   `assistant` entry with a `usage.output_tokens` value) through the real statusline
   command, and confirm a `⚡ <speed> tok/s (▲<max> ~<avg> ▼<min>)` segment comes out
   with sane, non-absurd numbers.
