#!/usr/bin/env bash
# tokrate installer — patches accurate, persistent tok/s into a local claude-hud install.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/reedchan7/tokrate/main/install.sh | bash
# or, from a local checkout:
#   ./install.sh
#
# What it does: locates the active claude-hud plugin version directory, backs up the
# four files it's about to touch, replaces them with tokrate's reference implementation,
# turns on the showSpeed display flag, then runs a real statusline invocation against a
# synthetic transcript to confirm the change actually works before declaring success.
# If anything goes wrong after patching starts, the four files are restored from backup.
#
# See https://github.com/reedchan7/tokrate for what this changes and why (DESIGN.md).
set -euo pipefail

REPO_URL="https://github.com/reedchan7/tokrate.git"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGIN_ROOT="$CONFIG_DIR/plugins/cache/claude-hud/claude-hud"
HUD_CONFIG="$CONFIG_DIR/plugins/claude-hud/config.json"

CLEANUP_DIRS=()
PATCH_STARTED=""
PATCH_DONE=""
BACKUP_DIR=""

cleanup() {
  local exit_code=$?
  if [ -n "$PATCH_STARTED" ] && [ -z "$PATCH_DONE" ] && [ -n "$BACKUP_DIR" ]; then
    echo "tokrate: aborting mid-patch — restoring originals from $BACKUP_DIR" >&2
    cp "$BACKUP_DIR/speed-tracker.ts" "$CURRENT_SPEED_TRACKER" 2>/dev/null || true
    cp "$BACKUP_DIR/render/colors.ts" "$CURRENT_COLORS" 2>/dev/null || true
    cp "$BACKUP_DIR/render/session-line.ts" "$CURRENT_SESSION_LINE" 2>/dev/null || true
    cp "$BACKUP_DIR/render/lines/project.ts" "$CURRENT_PROJECT_LINE" 2>/dev/null || true
  fi
  for d in "${CLEANUP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
  exit "$exit_code"
}
trap cleanup EXIT

fail() { echo "tokrate: $*" >&2; exit 1; }
info() { echo "tokrate: $*"; }

manual_fallback() {
  fail "$1
tokrate: ask your coding agent to read reference/*.ts and DESIGN.md at
tokrate: $REPO_URL and port the change by hand instead."
}

command -v bun >/dev/null 2>&1 \
  || fail "bun not found on PATH (claude-hud itself requires it — is claude-hud actually installed and working?)"
[ -d "$PLUGIN_ROOT" ] || fail "claude-hud not found at $PLUGIN_ROOT — is the plugin installed?"

VERSION_DIR=$(find "$PLUGIN_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
  | awk -F/ '{ print $NF "\t" $0 "/" }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-)
[ -n "$VERSION_DIR" ] || fail "no claude-hud version directory found under $PLUGIN_ROOT"
SRC_DIR="${VERSION_DIR}src"
[ -d "$SRC_DIR" ] || manual_fallback "no src/ under $VERSION_DIR — plugin layout has changed."
info "found claude-hud at $VERSION_DIR"

# Fetch the patch. Works whether this script is run from a local checkout (reference/
# sits right next to it — only trusted when $0 is a real file, not when piped via curl,
# so a coincidental ./reference/ in the caller's cwd can't get copied in by accident) or
# piped in via curl (clones the repo to a temp dir instead).
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ] && [ -d "$(dirname "$SCRIPT_SOURCE")/reference" ]; then
  REF="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)/reference"
else
  command -v git >/dev/null 2>&1 \
    || fail "git not found on PATH (needed to fetch the patch — clone $REPO_URL yourself and re-run install.sh from inside it)"
  WORKDIR="$(mktemp -d)"
  CLEANUP_DIRS+=("$WORKDIR")
  info "fetching tokrate..."
  git clone --depth 1 -q "$REPO_URL" "$WORKDIR" || fail "could not clone $REPO_URL"
  REF="$WORKDIR/reference"
fi
[ -d "$REF" ] || fail "reference/ missing from tokrate checkout"

CURRENT_SPEED_TRACKER="$SRC_DIR/speed-tracker.ts"
CURRENT_COLORS="$SRC_DIR/render/colors.ts"
CURRENT_SESSION_LINE="$SRC_DIR/render/session-line.ts"
CURRENT_PROJECT_LINE="$SRC_DIR/render/lines/project.ts"

for f in "$CURRENT_SPEED_TRACKER" "$CURRENT_COLORS" "$CURRENT_SESSION_LINE" "$CURRENT_PROJECT_LINE"; do
  [ -f "$f" ] || manual_fallback "expected file missing: $f"
done

# Compatibility check: bail rather than corrupt an install whose internals have
# drifted too far from what these reference files assume. This only catches the call
# site itself — the self-test below is the real backstop for deeper drift (renamed
# helpers, reshaped types elsewhere in the plugin), which is why it's mandatory, not
# best-effort.
grep -q "getOutputSpeed(ctx.stdin)" "$CURRENT_SESSION_LINE" \
  || manual_fallback "render/session-line.ts call site doesn't match what tokrate expects."
grep -q "getOutputSpeed(ctx.stdin)" "$CURRENT_PROJECT_LINE" \
  || manual_fallback "render/lines/project.ts call site doesn't match what tokrate expects."

# Back up, then patch. From here on, an abort restores the four files from BACKUP_DIR
# (see cleanup() above) instead of leaving a mixed old/new file set behind.
STAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_DIR="$CONFIG_DIR/plugins/claude-hud/.tokrate-backup-$STAMP"
mkdir -p "$BACKUP_DIR/render/lines"
cp "$CURRENT_SPEED_TRACKER" "$BACKUP_DIR/speed-tracker.ts"
cp "$CURRENT_COLORS" "$BACKUP_DIR/render/colors.ts"
cp "$CURRENT_SESSION_LINE" "$BACKUP_DIR/render/session-line.ts"
cp "$CURRENT_PROJECT_LINE" "$BACKUP_DIR/render/lines/project.ts"
info "backed up originals to $BACKUP_DIR"
PATCH_STARTED=1

cp "$REF/speed-tracker.ts" "$CURRENT_SPEED_TRACKER"
cp "$REF/colors.ts" "$CURRENT_COLORS"
cp "$REF/session-line.ts" "$CURRENT_SESSION_LINE"
cp "$REF/lines/project.ts" "$CURRENT_PROJECT_LINE"
info "patched speed-tracker.ts, colors.ts, session-line.ts, lines/project.ts"

# Keep only the 5 most recent backups so these don't accumulate forever across updates.
# Names sort lexicographically the same as chronologically (YYYYMMDDHHMMSS), so a plain
# reverse name sort avoids depending on filesystem mtimes.
# Best-effort: pruning old backups must never abort an otherwise-successful install.
{ find "$CONFIG_DIR/plugins/claude-hud" -mindepth 1 -maxdepth 1 -type d -name ".tokrate-backup-*" 2>/dev/null \
  | sort -r \
  | tail -n +6 \
  | while IFS= read -r old; do rm -rf "$old"; done; } || true

# Turn the display on.
mkdir -p "$(dirname "$HUD_CONFIG")"
HUD_CONFIG_PATH="$HUD_CONFIG" bun -e '
  const fs = require("fs");
  const path = process.env.HUD_CONFIG_PATH;
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
  if (typeof config !== "object" || config === null || Array.isArray(config)) config = {};
  config.display = { ...(config.display ?? {}), showSpeed: true };
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
'
info "showSpeed enabled in $HUD_CONFIG"

# Self-test: run the real statusline command against a synthetic transcript with one
# completed turn, and confirm a sane tok/s segment comes out the other end. This is not
# best-effort — if it can't run or doesn't find the segment, the install is treated as
# failed (and rolled back) rather than declared a silent success.
TEST_DIR="$(mktemp -d)"
CLEANUP_DIRS+=("$TEST_DIR")
TEST_TRANSCRIPT="$TEST_DIR/transcript.jsonl"
cat > "$TEST_TRANSCRIPT" <<'EOF'
{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","timestamp":"2026-01-01T00:00:02.000Z","message":{"id":"msg_tokrate_selftest","role":"assistant","usage":{"output_tokens":200}}}
EOF

STATUSLINE_SETTINGS="$CONFIG_DIR/settings.json"
[ -f "$STATUSLINE_SETTINGS" ] \
  || fail "no settings.json at $STATUSLINE_SETTINGS — can't verify. Originals restored; check your statusLine config and re-run."

STATUSLINE_CMD=$(STATUSLINE_SETTINGS_PATH="$STATUSLINE_SETTINGS" bun -e '
  const fs = require("fs");
  try {
    const settings = JSON.parse(fs.readFileSync(process.env.STATUSLINE_SETTINGS_PATH, "utf8"));
    process.stdout.write(settings?.statusLine?.command ?? "");
  } catch {
    process.stdout.write("");
  }
')
[ -n "$STATUSLINE_CMD" ] \
  || fail "could not read statusLine.command from $STATUSLINE_SETTINGS — can't verify. Originals restored; check your statusLine config and re-run."

OUTPUT=$(echo "{\"transcript_path\":\"$TEST_TRANSCRIPT\",\"cwd\":\"$PWD\",\"model\":{\"display_name\":\"test\"}}" \
  | bash -c "$STATUSLINE_CMD" 2>&1 || true)
CLEAN_OUTPUT=$(printf '%s' "$OUTPUT" | sed 's/\x1b\[[0-9;]*m//g')
if printf '%s' "$CLEAN_OUTPUT" | grep -q 'tok/s' && printf '%s' "$CLEAN_OUTPUT" | grep -q '▲'; then
  info "self-test passed:"
  printf '%s\n' "$CLEAN_OUTPUT" | grep '⚡'
  PATCH_DONE=1
else
  fail "self-test did not find a tok/s segment in the statusline output — originals restored.
tokrate: raw output was:
$OUTPUT
tokrate: if statusLine.command resolves to a different claude-hud version directory than
tokrate: $VERSION_DIR, that mismatch is the likely cause — check which one is actually running."
fi

info "done — restart your statusline (or wait for the next refresh) to see it."
