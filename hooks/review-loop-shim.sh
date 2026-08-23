#!/usr/bin/env bash
# review-loop shim — the COMMITTED half of the install.
#
#   <repo>/.claude/hooks/review-loop.sh   this file: committed, stable, tiny
#        │  exec, stdin/args/env passed straight through
#        ▼
#   ${REVIEW_LOOP_IMPL:-$HOME/.claude/hooks/review-loop.sh}   the real hook
#
# WHY THE SPLIT. The registration and this repo's REVIEW_LOOP_PATHS are a REPO
# STANDARD — they belong in the repo, committed, arriving with the clone, because
# a rule that depends on a teammate remembering a local command drifts. The 500
# lines that implement it are a MACHINE concern, and committing those would make
# every upstream fix a commit in every consuming repo. So the repo commits this,
# which changes almost never, and the machine holds the part that changes.
#
# NEVER BLOCKS, NEVER WRITES STDERR. stderr from a hook breaks the turn, and on
# UserPromptSubmit it lands in the user's face mid-sentence.
#
# THE ONLY INTERESTING CASE IS A MISSING IMPLEMENTATION, and the right answer
# DIFFERS PER EVENT, because their contracts differ:
#   Stop              may speak -> say so IN-BAND, once per session
#   UserPromptSubmit  zero bytes, always: stdout here is injected into the prompt
#   SessionStart      zero bytes, always
# Saying nothing at all on Stop would make an uninstalled tool look exactly like
# a clean tree, which is this project's one unacceptable failure.

set -u

IMPL=${REVIEW_LOOP_IMPL:-${HOME:-}/.claude/hooks/review-loop.sh}

# Read stdin ONCE. It is a pipe: consuming it here to find the event and then
# exec'ing would hand the implementation an empty payload, so the exec path has
# to replay what was read.
INPUT=$(cat 2>/dev/null || true)

# NOT `| exec`: in a pipeline `exec` replaces the SUBSHELL, not this shell, so
# control returns here and the not-installed branch below ALSO runs. Measured —
# the transparency test caught the implementation's output and the "not
# installed" notice concatenated in one payload.
if [ -x "$IMPL" ]; then
  printf '%s' "$INPUT" | "$IMPL" "$@"
  exit $?
fi

# ── Not installed ────────────────────────────────────────────────────────────
# jq is the implementation's dependency, not necessarily this file's. Without it
# there is no way to read the event or emit valid JSON, and guessing would risk
# printing to an event whose contract is silence. Exit quiet.
command -v jq >/dev/null 2>&1 || exit 0

EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null || echo "")
[ "$EVENT" = "Stop" ] || exit 0

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
SID=$(printf '%s' "$SID" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-64)
[ -n "$SID" ] || exit 0

# ONCE PER SESSION. A notice on every turn is the wallpaper the message's own
# line cap exists to prevent, and it would be arriving on a turn where the tool
# cannot even tell whether there is anything to review.
STATE_DIR=${REVIEW_LOOP_STATE_DIR:-/tmp}
case "$STATE_DIR" in /*) : ;; *) STATE_DIR="$PWD/$STATE_DIR" ;; esac
MARKER="$STATE_DIR/review-loop-uninstalled-$SID"
[ -e "$MARKER" ] && exit 0
{ : > "$MARKER"; } 2>/dev/null || true

jq -cn --arg impl "$IMPL" '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: (
      "review-loop is registered in this repo but is not installed on this\n" +
      "machine, so nothing is checking whether your changes have been reviewed.\n\n" +
      "Install it: clone review-loop and run ./setup\n" +
      "Expected at: " + $impl + "\n\n" +
      "This notice appears once per session, not once per turn."
    )
  }
}'
exit 0
