#!/usr/bin/env bash
# Stop hook. Asks whether the uncommitted code has had a code review that came
# back clean. NEVER blocks — it emits hookSpecificOutput.additionalContext, or
# nothing at all.
#
# SCOPE, deliberately narrow. This hook is responsible for ONE thing: making sure
# a code review happened on code that was produced, and that a review returning
# findings produced FIXES leads to another review — a fix is code nobody has
# reviewed. Findings alone do not: one that is rejected changes nothing. It is NOT responsible for the
# quality or completeness of those reviews, and it does not know or care whether
# tests pass — that is a repo-specific concern owned by other gates.
#
# An earlier version keyed on ./scripts/verify-build.sh having passed since the
# last edit, to fire only at a "work finished" boundary. Proving that claim needed
# content hashing, per-file mtimes, deletion/rename handling, unicode paths,
# ARG_MAX and fork batching — and every HIGH and MEDIUM finding across six review
# rounds came from that machinery, none from the nudging itself. It is gone.
#
# The workflow itself lives in AGENTS.md. This hook does not restate it; it
# re-delivers the pointer at the moment it applies. An instruction does not get
# stronger by being copied into more files — it gets stronger by arriving on time.
#
#   git status --porcelain -uall -z ──> paths+mtimes ──> cksum ──┐
#                                                                 ├──> ask
#   find -H PLANS_DIR -newer $BASELINE_FILE ─────────────────────┘
#
# TWO FILES, TWO JOBS, DELIBERATELY SEPARATE.
#   $STATE_FILE     contents = the git cksum key. Written only when the hook asks.
#   $BASELINE_FILE  mtime    = the plan cut-off. Advanced EVERY turn.
#
# Do not re-couple them. Using the state file as the plan baseline deadlocks: it
# is written only on an ask, and on a clean tree only a plan can produce an ask,
# so plan detection that waits for it can never start. On GNU find (no -newermB)
# that was permanent — measured 5 consecutive stops, clean tree, plan rewritten
# between each, SILENT every time.
#
# WHY -z. Without it, git QUOTES paths containing spaces or non-ASCII and
# octal-escapes them (`?? "a/te st.ts"`, `?? "a/t\303\253st.ts"`), and renames
# arrive as `R old -> new`. Any strip-the-prefix parse then hands stat a literal
# quote or an arrow.
#
# WHY -uall. Without it a whole new module collapses to one line, `?? packages/new/`,
# and unreviewed new code is invisible. It does NOT close the same class for nested
# repositories or submodules — git will not recurse into those regardless.
#
# PATHSPECS, not shell globs: git's `*` crosses `/`, so `packages/*/src/**/*.ts`
# silently misses files sitting directly in src/. Directory pathspecs and excludes
# avoid the entire class. Do not "improve" them into globs.

set -u
set -f   # word-split $PATHS_WATCHED, but never glob it

# EXCLUDE AS LITTLE AS POSSIBLE. Omitting a path means unreviewed code the hook
# never asks about; including a noisy one costs one question. The DEFAULT is the
# whole tree — a released tool must not ship one repo's exclude list. Projects
# add their own churn via REVIEW_LOOP_PATHS, e.g.
#
#   ". :(exclude)prototypes/ :(exclude)notes.md"
#
# NOT excluded by default, deliberately: `*.md`. Excluding it once hid prompt
# files that were read at RUNTIME. A git exclude also beats a later positive
# pathspec, so a broad exclusion cannot be walked back by re-including a dir.
#
# PATHSPECS, not shell globs: git's `*` crosses `/`, so `packages/*/src/**/*.ts`
# silently misses files sitting directly in src/. Do not "improve" them.
PATHS_WATCHED=${REVIEW_LOOP_PATHS:-"."}
STATE_DIR=${REVIEW_LOOP_STATE_DIR:-/tmp}
# ABSOLUTE, resolved before anything cd's. This path is consumed before `cd "$CWD"`
# and again after `cd "$TOPLEVEL"`; left relative, the hook READ one file and WROTE
# another, so it asked on every single turn. Measured: 3 identical runs, 3 asks.
case "$STATE_DIR" in /*) : ;; *) STATE_DIR="$PWD/$STATE_DIR" ;; esac

# Plans live OUTSIDE the repo, so a planning turn produces no diff and git cannot
# see the one phase where a plan review is mandatory. $HOME is GUARDED: two test
# spawn sites replace the environment wholesale and pass no HOME, and `set -u`
# makes a bare $HOME fatal. An unset HOME yields /.claude/plans, which simply
# does not exist -> no plans, git-only behaviour.
PLANS_DIR=${REVIEW_LOOP_PLANS_DIR:-${HOME:-}/.claude/plans}
# PLANS_DIR gets the same treatment, and for the same reason. The find that reads
# it runs AFTER the hook cd's to the repo root, so a relative value would resolve
# against the repo instead of the launch cwd — silently, and differently from
# STATE_DIR just above. Symmetry here is the whole point.
case "$PLANS_DIR" in /*) : ;; *) PLANS_DIR="$PWD/$PLANS_DIR" ;; esac

INPUT=$(cat 2>/dev/null || true)
# Every external the hook runs. THE LOAD-BEARING THREE are `cksum`, `cut` and
# `tr`: they sit in pipelines with no 2>/dev/null (the SID sanitiser and the state
# key), so without this preflight a missing one prints "command not found" to
# stderr and breaks the turn. The rest are already silenced at their call sites
# and are listed so the shim-based tests stay honest — a binary used but unlisted
# makes the hook bail early under a shim, and every later assertion goes vacuous.
# (`stat` has its own flavour probe below; `find` is used with 2>/dev/null.)
for _bin in cat jq git xargs cksum cut tr find; do
  command -v "$_bin" >/dev/null 2>&1 || exit 0
done

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
STOP_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")

[ -n "$CWD" ] && [ -d "$CWD" ] || exit 0
# Re-entry guard: this is true only on the continuation stop a block produced, so
# it prevents re-asking on turns another hook generated.
[ "$STOP_ACTIVE" = "true" ] && exit 0
# A session id is interpolated into a path; an empty or unsanitised one would give
# every session one shared state file and silently defeat per-session isolation.
SID=$(printf '%s' "$SID" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-64)
[ -n "$SID" ] || exit 0

cd "$CWD" 2>/dev/null || exit 0
# Pathspecs resolve against the CURRENT directory; from a subdirectory an
# unnormalised pathspec matches nothing and the hook is silently inert all session.
# (A `git rev-parse --git-dir` check used to sit here. It was DEAD: --show-toplevel
# already fails everywhere --git-dir does, and also in a bare repo where --git-dir
# succeeds. One fork per turn for a guard that could not fail.)
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
[ -n "$TOPLEVEL" ] && cd "$TOPLEVEL" || exit 0

# STATE_DIR MUST LIVE OUTSIDE THE REPO, so fall back rather than break. The
# default pathspec watches everything, so state files written inside the tree are
# themselves dirt — and since the baseline is rewritten on EVERY Stop, its own
# mtime moves every turn and the key never settles. Measured with the state dir
# inside the repo: 5 asks in 5 turns on a PRISTINE checkout, nothing else
# happening. That is the wallpaper failure the message-length test exists to
# prevent, arriving before the user has done anything at all.
#
# Falling back keeps the hook working; refusing would make a typo silently
# disable it. `case` still matches under `set -f` — that disables pathname
# expansion, not pattern matching.
# Resolve symlinks on BOTH sides first. `git rev-parse --show-toplevel` returns a
# PHYSICAL path, and on macOS a temp dir under /var is really /private/var — so a
# textual prefix test silently never matches and the containment check is inert.
_SD=$(cd "$STATE_DIR" 2>/dev/null && pwd -P) && STATE_DIR=$_SD
case "$STATE_DIR/" in "$TOPLEVEL"/*) STATE_DIR=/tmp ;; esac

STATE_FILE="$STATE_DIR/review-loop-$SID"
# The plan baseline is its OWN file, NOT the state file. Coupling them deadlocked:
# the state file is written only when the hook ASKS, and on a clean tree the only
# thing that can make it ask is a plan — so if plan detection needs the state file
# to exist, it can never start. On GNU find (no -newermB) that was not a graceful
# degradation, it was permanent death in exactly the phase this hook exists for.
# Measured before the fix: 5 consecutive stops, clean tree, plan rewritten between
# each -> SILENT x5. This file is advanced every turn, so the loop always starts.
BASELINE_FILE="$STATE_DIR/review-loop-baseline-$SID"

# -H is LOAD-BEARING. Without it find lstat()s the start point and never descends
# into a SYMLINKED plans dir: no output, exit 0, and no stderr either — byte
# identical to "no plan changed". `~/.claude` symlinked into a dotfiles repo is a
# common setup, so this must not depend on the author's dir being real.
#
# -maxdepth 1 bounds the walk: PLANS_DIR is a user knob, and without it the hook
# walks an arbitrary tree on EVERY Stop and arms on any nested .md.
#
# 2>/dev/null covers three real stderr paths, all exit 1: a missing PLANS_DIR, an
# unreadable one, and a -newer/-newermB reference that is not there (or -newermB
# itself on GNU find, which rejects the predicate outright).
if [ -f "$BASELINE_FILE" ]; then
  PLANS_CHANGED=$(find -H "$PLANS_DIR" -maxdepth 1 -name '*.md' -newer "$BASELINE_FILE" 2>/dev/null)
elif [ -n "$TRANSCRIPT" ]; then
  # First Stop of the session. The transcript's BIRTH time is session start, so
  # this catches a plan written in the very first turn. -newermB is BSD-only; GNU
  # find rejects `B`, which now costs only that first turn instead of the whole
  # session, because the baseline below is created either way.
  PLANS_CHANGED=$(find -H "$PLANS_DIR" -maxdepth 1 -name '*.md' -newermB "$TRANSCRIPT" 2>/dev/null)
else
  PLANS_CHANGED=
fi

# THE CONDITION IS LOAD-BEARING, not decoration. Advancing unconditionally would
# consume a pending plan change on any turn that exits before emitting — a
# non-repo cwd, a jq failure — and that nudge is then gone for good, because
# nothing will touch the plan again until after the review nobody asked for.
# Advancing HERE rather than only on emission is what guarantees the file exists
# from the first Stop onward, on every platform.
#
# Braces: `: > f 2>/dev/null` OPENS f before applying the redirect, so an
# unopenable path still prints to the real stderr.
[ -n "$PLANS_CHANGED" ] || { : > "$BASELINE_FILE"; } 2>/dev/null || true

# Probe the stat flavour ONCE. GNU first: on GNU, `stat -f` means --file-system and
# exits 0 printing "%m" literally, so a BSD-first chain never falls through.
if stat -c %Y . >/dev/null 2>&1; then STAT_FLAVOUR=gnu
elif stat -f %m . >/dev/null 2>&1; then STAT_FLAVOUR=bsd
else
  echo "review-loop: no usable stat(1); hook disabled" >&2
  exit 0
fi

# ── Enumerate dirty watched paths ─────────────────────────────────────────────
# Rename entries carry an extra NUL-terminated old path that must be consumed, not
# parsed as a file.
TOTAL=0
FILES=()
STATE_LINES=""
while IFS= read -r -d '' ENTRY; do
  [ -n "$ENTRY" ] || continue
  XY=${ENTRY:0:2}
  P=${ENTRY:3}
  # Rename/copy entries carry an extra NUL-terminated OLD path that must be consumed,
  # not parsed as a file. BOTH columns matter: an INDEX rename is "R " but a
  # WORK-TREE one is " R" (also " C", "DR", "DC"), so matching only R*|C* misses
  # half of them.
  #
  # Missing one is not cosmetic, it is a silent kill. The unconsumed old path gets
  # read as a status line, so its first two characters become XY and the rest
  # becomes a phantom path. Two ways that bites, both measured:
  #   - the phantom can name a REAL file, including an excluded one, whose mtime
  #     then drives the state key
  #   - if the old path starts with R or C — README.md, CHANGELOG.md,
  #     CONTRIBUTING.md all sit in this repo's root — the phantom's own XY matches
  #     the rename pattern and SWALLOWS THE NEXT REAL ENTRY, dropping that file out
  #     of the key for the rest of the session while the hook keeps exiting 0.
  case "$XY" in [RC]?|?[RC]) IFS= read -r -d '' _OLD || true ;; esac
  TOTAL=$(( TOTAL + 1 ))
  # Paths only, NOT the XY status chars: staging flips " M" to "M " and would
  # re-arm on code that did not change. The path set still moves when files appear
  # or disappear, and mtime+size below carry content changes.
  STATE_LINES="${STATE_LINES}${P}"$'\n'
  # -e, not -f: a nested repo or submodule appears as a single directory entry
  # (git status does not recurse into one), and with -f it contributed no mtime at
  # all — so the key was constant and edits inside NEVER re-armed. RESIDUAL LIMIT,
  # stated rather than papered over: a directory's mtime moves when entries are
  # added or removed inside it, not when a file already there is edited in place.
  # So a nested repo is better covered than before, not fully covered.
  # -e OR -L: `-e` dereferences, so a dirty BROKEN symlink is false under it and
  # contributes no mtime/size — its status line is byte-identical across edits, so
  # re-pointing it never re-arms, silently. `stat` itself does not dereference on
  # either flavour, so only this gate loses it. Same class as the -f -> -e change.
  { [ -e "$P" ] || [ -L "$P" ]; } && FILES+=("$P")
done < <(git status --porcelain -uall -z -- $PATHS_WATCHED 2>/dev/null)

[ "$TOTAL" -gt 0 ] || [ -n "$PLANS_CHANGED" ] || exit 0

# `--` terminates stat's options: a repo-root path beginning with "-" is otherwise
# read as a flag, the whole batch produces nothing, and the re-arm loop dies
# SILENTLY for the session. GNU getopt permutes, so such a path anywhere does it.
#
# mtime AND SIZE. mtime alone has one-second resolution, so a same-second edit to
# an already-dirty file was invisible — and the status line is byte-identical for
# " M" -> " M", so nothing else discriminates. Size shrinks the blind spot to edits
# that land in the same second AND keep the byte count identical.
# These make an edit to an ALREADY-dirty file re-arm the question — without them
# the status line is byte-identical before and after a fix, and the loop would ask
# once and never again. Batched through xargs: one fork regardless of diff size,
# and xargs splits above ARG_MAX rather than failing.
MTIMES=""
if [ ${#FILES[@]} -gt 0 ]; then
  case $STAT_FLAVOUR in
    gnu) MTIMES=$(printf '%s\0' "${FILES[@]}" | xargs -0 stat -c '%Y %s' -- 2>/dev/null) ;;
    bsd) MTIMES=$(printf '%s\0' "${FILES[@]}" | xargs -0 stat -f '%m %z' -- 2>/dev/null) ;;
  esac
fi

# ── Ask once per distinct state ───────────────────────────────────────────────
STATE=$(printf '%s%s' "$STATE_LINES" "$MTIMES" | cksum | cut -d' ' -f1)
# BOTH guards consult the plan set, not just the one above. $STATE is the cksum
# of the GIT set alone, so on a clean tree it is cksum("") — a CONSTANT. Comparing
# it here without the plan condition makes the plan trigger fire exactly once per
# session, ever: stop 1 differs from an absent file and asks, stops 2..n compare
# equal and exit. The single-plan-change test passes against that bug; only a
# SECOND change catches it.
[ "$STATE" = "$(cat "$STATE_FILE" 2>/dev/null || echo "")" ] && [ -z "$PLANS_CHANGED" ] && exit 0

jq -cn '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: (
      "Wait for inflight actions to complete before doing anything.\n\n" +
      "Just written code or a plan? Run /code-review on the diff, or\n" +
      "/plan-eng-review on the plan.\n\n" +
      "Just completed a review? Fix or reject its findings. If there are fixes,\n" +
      "review again.\n\n" +
      "Consider skipping/rejecting: LOW priority; MEDIUM priority if the fix costs\n" +
      "more than the problem."
    )
  }
}' && { printf '%s' "$STATE" > "$STATE_FILE"; : > "$BASELINE_FILE"; } 2>/dev/null
# Recorded only after the message is on stdout, so a FAILED STATE WRITE retries
# rather than silently swallowing the ask. Deliberately NOT claimed: this does not
# survive a sibling Stop hook's block. jq exiting 0 means jq wrote JSON, not that
# the model received it — on the continuation stop, stop_hook_active short-circuits
# this hook and that ask is gone. Making that case retry needs a pending-marker
# promoted on the next unblocked stop; not built. Be honest about the cost, which
# is NOT a duplicate ask: the ask is DROPPED for that state, and since the key is
# unchanged the next clean stop stays silent. And it bites in the common case —
# verify-build-gate.sh blocks precisely when TypeScript was edited without a
# passing verify-build, which is mid-change, which is when this matters most.
# Braces around the redirect: `> f 2>/dev/null` opens f BEFORE applying 2>&-, so an
# unopenable path still prints to the real stderr.
exit 0
