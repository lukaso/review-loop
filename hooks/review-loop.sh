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
#   UserPromptSubmit ──> cksum of the dirty set ──> $TURN_FILE   (turn baseline)
#                                                          │
#   git status -uall -z ──> paths+mtimes ──> cksum ──> differs from it? ──┐
#                                                                         ├──> ask
#   find -H PLANS_DIR -newer $BASELINE_FILE ────────────────────────────┘
#
# ATTRIBUTION IS A KEY COMPARISON, NOT A TIMESTAMP TEST. An earlier version kept
# dirty paths whose mtime was not older than a marker file. It was wrong in four
# constructible ways, every one of them SILENT — which is the fatal direction for
# a nudge. All four were measured, not argued:
#   - `git mv`: rename(2) does not move mtime, so a staged rename vanished.
#   - `chmod +x`: mode changes do not move mtime either.
#   - a NEW symlink to an OLD target: `-e`/`-ot` dereference, `stat` does not, so
#     the filter and the state key disagreed about which inode they meant.
#   - a nested repo dirtied in place: git emits one directory entry, and a
#     directory's mtime does not move when a file already inside it is edited.
# git's notion of "changed" is not mtime, so mtime cannot decide what git saw.
# The same key the hook already trusts, sampled at the prompt, decides it — and
# the key carries MODE for exactly this reason, so a `chmod` on a file that was
# already dirty moves it too. RESIDUAL LIMIT, stated rather than papered over: a
# nested repo dirtied IN PLACE is still invisible, because git reports one
# directory entry and a directory's mtime does not move for an edit inside it.
# That limit predates this slice and is unchanged by it.
#
# THREE FILES, THREE JOBS, DELIBERATELY SEPARATE.
#   $STATE_FILE     contents = the git cksum key. Written only when the hook asks.
#   $BASELINE_FILE  mtime    = the plan cut-off. Advanced EVERY turn.
#   $TURN_FILE      contents = the same key, sampled at the START of this turn.
#
# Do not re-couple any of them. $TURN_FILE is written by UserPromptSubmit ONLY
# WHEN ABSENT, and removed by Stop as soon as it is read. That pair is what makes
# a second prompt arriving before any Stop — typed ahead, or after an interrupt —
# keep the ORIGINAL baseline instead of swallowing the work already in flight.
#
# THREE REGISTRATIONS, ONE SCRIPT, dispatched on .hook_event_name: the SID
# sanitiser and the STATE_DIR containment fallback must agree across all of them,
# and they only can if there is one copy. SessionStart forgets this session id's
# ask history on every source but `compact`, so a restarted session asks once
# before it settles. With no $TURN_FILE there is no filtering
# at all, so a checkout registered on Stop alone behaves exactly as it did before.
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
# `ln` and `rm` (the baseline write and the turn consume) are DELIBERATELY NOT
# LISTED, and that is a correctness decision, not an oversight. This list gates the
# WHOLE hook: an unlisted-but-missing binary is a runtime surprise, but a LISTED
# missing one exits 0 before the dispatch, on Stop as well — silence on unreviewed
# work, which is the one failure this hook must not have. Measured with a PATH
# holding everything but `ln`: listing it made a dirty tree silent; not listing it,
# the write simply fails, no baseline exists, and the Stop side fails OPEN and asks.
# Both degrade safely on their own, so neither belongs in a gate this absolute.
# They ARE in the test shims, which is what keeps those tests honest.
# (`stat` has its own flavour probe below; `find` is used with 2>/dev/null.)
for _bin in cat jq git xargs cksum cut tr find; do
  command -v "$_bin" >/dev/null 2>&1 || exit 0
done

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
STOP_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null || echo "")
# THREE registrations, ONE script: the SID sanitiser and the STATE_DIR containment
# fallback below must produce the same path on ALL of them, and they only can if
# there is one copy. SessionStart DELETES rather than compares, so pointed at a
# different dir it deletes nothing and the resume hole silently reopens. An empty
# event is treated as Stop so a payload without the field behaves as it always did.
case "$EVENT" in
  Stop|UserPromptSubmit|SessionStart|"") : ;;
  *) exit 0 ;;
esac
SOURCE=$(printf '%s' "$INPUT" | jq -r '.source // ""' 2>/dev/null || echo "")

[ -n "$CWD" ] && [ -d "$CWD" ] || exit 0
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

# THE THIRD FILE, AND THE THIRD JOB. $TURN_FILE mtime is the START OF THIS TURN.
# Written ONLY by UserPromptSubmit, never by Stop. If Stop advanced it, every file
# written earlier in the same turn would fall out of the window on the next Stop —
# the same class of deadlock that coupling $STATE_FILE to $BASELINE_FILE produced.
TURN_FILE="$STATE_DIR/review-loop-turn-$SID"

# A RESTARTED SESSION MUST ASK ONCE, and only SessionStart can say that it is one.
#
# `--resume` reuses the session id, and /tmp usually survives, so $STATE_FILE is
# still there from before — while everything the user hand-edited with claude
# closed is already in the tree when the first resumed prompt takes its baseline.
# The gate then suppresses it, permanently. Measured before this: turn 1 asks about
# the agent's edit, the user quits and hand-edits two files, and the next THREE
# resumed turns say nothing, where a Stop-only install asks. The user's own diff.
#
# `[ -f "$STATE_FILE" ]` already means "this session has asked once"; forgetting
# that one file is what makes a restart honest again, and it reuses that guard
# rather than adding a second notion of the same thing.
#
# ONLY $STATE_FILE. Removing $TURN_FILE alongside it was tried and DELETED: it
# cannot change an outcome, because gate 1 needs $STATE_FILE to exist and the same
# `rm` has just removed it, and by the time $STATE_FILE reappears (the first ask)
# consume_turn has already removed $TURN_FILE. A mutant dropping it survived the
# whole suite, and no case could be constructed — so it goes, per the rule about
# guards that cannot fail. `clear` resets too; it costs nothing there, because a
# cleared session has a new id and so nothing to forget.
#
# $BASELINE_FILE is deliberately NOT touched: it is the plan cut-off, it belongs to
# a different question, and the three files stay uncoupled.
if [ "$EVENT" = "SessionStart" ]; then
  # EVERYTHING EXCEPT `compact` RESETS, rather than listing startup|resume. The two
  # directions are not symmetric: resetting when we should not have costs ONE extra
  # ask, while failing to reset when we should have loses the work silently and for
  # good. So an unrecognised source — a value this hook has not heard of yet, or a
  # payload with the field missing entirely — must land on the noisy side.
  # `compact` is the one known source that is NOT a break in the work.
  case "$SOURCE" in
    compact) : ;;
    *) rm -f "$STATE_FILE" 2>/dev/null || true ;;
  esac
  exit 0
fi

# RE-ENTRY GUARD, and it must POISON THE BASELINE on its way out — exiting quietly
# here is what made this hook lose work permanently.
#
# stop_hook_active is true only on the continuation Stop a BLOCK produced. That
# block means the model kept working after a Stop this hook had already answered
# and whose baseline it had already consumed. Anything written in that stretch
# belongs to this turn, but lands after it: the next prompt finds no baseline,
# samples a tree that already contains the work, and every later Stop compares
# equal and says nothing. Measured before this: turn 1 asks about b.txt, a sibling
# blocks, c.txt is written, and c.txt is NEVER asked about — while `git status`
# shows it. That is not a dropped ask, it is a permanently silenced one, on this
# session's own code, and it needs no second session.
#
# It is also the common case here, not a corner: verify-build-gate.sh blocks
# precisely when TypeScript was edited without a passing build, which is mid-change.
#
# An EMPTY $TURN_FILE is the poison. It survives the next prompt, whose write is a
# create-if-absent `ln`, and at the gate an empty key can never equal $STATE — a
# cksum is never empty — so the turn gate cannot suppress. It is NOT "one extra
# ask": the ask-once guard further down still applies, so a block during which
# NOTHING changed stays silent, exactly as the closing comment of this file
# describes. What the poison guarantees is narrower and is the part that matters —
# work written DURING the block is still asked about, instead of being baselined
# away and lost.
#
# NOTE, because an earlier comment here got it wrong: the poison works through
# `[ "$STATE" = "$TURN_KEY" ]`, NOT through the `[ -n "$TURN_KEY" ]` guard beside
# it. Deleting that guard does not break this; see its own comment at the gate.
if [ "$STOP_ACTIVE" = "true" ]; then
  { : > "$TURN_FILE"; } 2>/dev/null || true
  exit 0
fi

# Probe the stat flavour ONCE, and BEFORE the dispatch: both events compute the
# same key, so both need it. GNU first: on GNU, `stat -f` means --file-system and
# exits 0 printing "%m" literally, so a BSD-first chain never falls through.
# --no-optional-locks is a TOP-LEVEL git option added in 2.15, and an older git
# REJECTS THE WHOLE INVOCATION rather than ignoring it (exit 129). Every git call
# here is `2>/dev/null`, so that rejection is invisible: the enumeration returns
# nothing, TOTAL is 0, and $STATE is the constant cksum("") — the hook then never
# asks again, in any session, ever. Measured against a shim that exits 129 on the
# flag, on a dirty tree: exit 0, no stdout, no stderr, forever silent. RHEL 7 still
# ships git 1.8.3.1. Probed once, and unset when unsupported.
GIT_NOLOCK=--no-optional-locks
git $GIT_NOLOCK rev-parse --git-dir >/dev/null 2>&1 || GIT_NOLOCK=

if stat -c %Y . >/dev/null 2>&1; then STAT_FLAVOUR=gnu
elif stat -f %m . >/dev/null 2>&1; then STAT_FLAVOUR=bsd
else
  # NOT on UserPromptSubmit: stderr from that event is shown to the user, and this
  # hook's contract there is to say nothing at all. The diagnostic is worth having
  # on Stop, where nobody is mid-sentence; on the prompt it would fire on EVERY
  # prompt for as long as the misconfiguration lasts.
  [ "$EVENT" = "UserPromptSubmit" ] || echo "review-loop: no usable stat(1); hook disabled" >&2
  exit 0
fi

# ── The state key, computed identically on both events ────────────────────────
# ONE copy, called twice. Two copies would drift, and a baseline computed even
# slightly differently from the value it is compared against is not a baseline —
# it is a permanent mismatch, which here means asking on every single turn.
# Sets: TOTAL, FILES, STATE_LINES, MTIMES, STATE.
collect_state() {
  TOTAL=0
  FILES=()
  STATE_LINES=""
  # Rename entries carry an extra NUL-terminated old path that must be consumed,
  # not parsed as a file.
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
    # --no-optional-locks: plain `git status` opportunistically refreshes and rewrites
  # .git/index, taking .git/index.lock to do it. This runs TWICE per turn now, in a
  # checkout this feature exists BECAUSE it is shared with concurrent sessions —
  # and a collision makes someone else's `git add` fail outright. Read-only status
  # does not need the lock.
  done < <(git $GIT_NOLOCK status --porcelain -uall -z -- $PATHS_WATCHED 2>/dev/null)

  # `--` terminates stat's options: a repo-root path beginning with "-" is otherwise
  # read as a flag, the whole batch produces nothing, and the re-arm loop dies
  # SILENTLY for the session. GNU getopt permutes, so such a path anywhere does it.
  #
  # AND MODE (`%p` BSD / `%f` GNU, one extra field in a call already being made).
  # Without it `chmod +x` on a file that was ALREADY dirty is invisible: the path,
  # mtime and size are all unchanged, so the key does not move and the hook stays
  # quiet on a real, reviewable change. The two flavours print mode differently
  # (100755 vs 81ed) and that is fine — a key is only ever compared with another
  # key computed by the same binary on the same machine.
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
      gnu) MTIMES=$(printf '%s\0' "${FILES[@]}" | xargs -0 stat -c '%Y %s %f' -- 2>/dev/null) ;;
      bsd) MTIMES=$(printf '%s\0' "${FILES[@]}" | xargs -0 stat -f '%m %z %p' -- 2>/dev/null) ;;
    esac
  fi
  STATE=$(printf '%s%s' "$STATE_LINES" "$MTIMES" | cksum | cut -d' ' -f1)
}

# UserPromptSubmit records the turn's baseline and says NOTHING. Anything on
# stdout here is injected into the user's prompt; anything on stderr breaks it.
#
# ONLY WHEN ABSENT. A second prompt with no Stop between them — typed ahead, or
# after an interrupt, since Stop does not fire when the user interrupts — would
# otherwise re-baseline over work already written this turn and hide it for good.
if [ "$EVENT" = "UserPromptSubmit" ]; then
  if [ ! -f "$TURN_FILE" ]; then
    collect_state
    # NOTE: the `[ ! -f ]` test above is a PERFORMANCE guard, not a correctness one
    # — it skips the enumeration on a typed-ahead prompt. Correctness is `ln`
    # alone, and mutating that test to `true` leaves the suite green.
    #
    # `ln`, NOT `mv -f`, and that is the whole point rather than a style choice.
    #
    # `mv -f` clobbers. The `[ ! -f ]` test above and this write are separated by
    # collect_state, the slowest thing here, and a continuation Stop can poison the
    # file inside that gap: the test says absent, the Stop writes the poison, the
    # write overwrites it with a key that already contains the block's work, and
    # the next Stop is silent on it for good — round 3's defect, restored by a
    # race. `ln` fails when the target exists, so the poison wins.
    #
    # It also makes "only when absent" atomic rather than merely checked, and it
    # keeps EMPTY unambiguous: a truncate-then-write could leave an empty file,
    # and empty here MEANS the blocked-turn poison.
    #
    # `.$$` is the pid, so two racing prompts cannot collide on the temp.
    { printf '%s' "$STATE" > "$TURN_FILE.$$" && ln "$TURN_FILE.$$" "$TURN_FILE"; } 2>/dev/null
    # Best-effort cleanup: a SIGTERM between the printf and here leaves the temp
    # behind and nothing reaps it. Harmless in the default /tmp; a custom state dir
    # accumulates one per killed prompt. `ln` also needs hard-link support in the
    # state dir — without it no baseline is ever written, which degrades to the
    # pre-attribution behaviour (noisier), never to silence.
    rm -f "$TURN_FILE.$$" 2>/dev/null || true
  fi
  exit 0
fi

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

# ── This turn's baseline, then the current state ──────────────────────────────
# Read the baseline and REMOVE it in the same breath. Stop is what closes a turn,
# so the next UserPromptSubmit must find the file gone and take a fresh sample.
#
# HONEST ABOUT THE EXITS ABOVE THIS LINE. EVERY `exit 0` above precedes it, and
# they do NOT all behave alike. No count is given on purpose: three successive
# versions of this comment stated one and all three were wrong, which is worse
# than no number at all.
#   - a missing preflight binary, an unrecognised event, an absent cwd, an empty
#     SID, a failed `cd`, a non-repo, and a missing stat: each leaves $TURN_FILE
#     UNTOUCHED, so the next prompt keeps the PREVIOUS turn's baseline. The
#     direction is safe — an older baseline is a WIDER window, which asks more
#     rather than less — but the cost is real: a wider window can re-admit a
#     concurrent session's diff, the symptom this slice exists to narrow.
#   - `stop_hook_active` does NOT leave it in place. It TRUNCATES it, on purpose,
#     and that poison is the whole subject of the re-entry guard above.
#   - SessionStart REMOVES $STATE_FILE (not this file), so a restarted session
#     asks once before it settles.
# Not moved above that guard: consuming the baseline on a continuation Stop would
# discard it without ever comparing against it.
#
# Missing or empty (never installed on UserPromptSubmit, unwritable state dir, a
# Stop with no prompt before it) => FAIL OPEN: no turn scoping at all, exactly the
# behaviour this hook had before attribution existed. Silence is the one outcome a
# nudge must never fail into.
TURN_KEY=$(cat "$TURN_FILE" 2>/dev/null || echo "")

collect_state

# CONSUMED AT EVERY TERMINAL POINT, AND NEVER BEFORE collect_state.
#
# The danger is a SIGTERM (the hook has a timeout) landing after the baseline is
# gone but before the ask exists. That takes BOTH: $STATE_FILE still holds the old
# key, so the next prompt samples the un-asked work as its own baseline and the
# gate is quiet on it for good. So the removal happens last on each path, and a
# kill before it leaves both files untouched — the next Stop re-evaluates against
# the same baseline and asks. A timeout then costs one ask, as it did before this
# feature existed.
#
# NO MEASURED TIMING CLAIM HERE. An earlier draft of this comment justified the
# ordering with "13.36s" — a real number from this project, but belonging to the
# DELETED grep-based verify-build design and its ugrep shadowing trap, not to
# `git status`. The enumeration measures 0.01-0.03s on a large monorepo. The
# ordering is right because losing the baseline is unrecoverable, not because the
# window is wide.
consume_turn() { rm -f "$TURN_FILE" 2>/dev/null || true; }

# NOTHING CHANGED DURING THIS TURN, AND WE HAVE ALREADY ASKED ONCE THIS SESSION.
#
# `[ -f "$STATE_FILE" ]` IS THE WHOLE CORRECTNESS OF THIS GATE, not a nicety.
# Without it the gate conflates two opposite cases: dirt that was there at the
# prompt AND has already been asked about (correctly silent), and dirt that was
# there at the prompt and NEVER HAS (must still be asked about). The second is
# ordinary: /clear mid-work, restarting claude on a dirty checkout, --resume after
# a reboot cleared /tmp, or any wipe of the state dir. In every one of those the
# user's OWN unreviewed diff sits in the tree and the session baselines it at its
# first prompt. Measured without this condition: session asks, /clear, then THREE
# consecutive silent turns on that same unreviewed diff, where a Stop-only
# install asks. Silence on unreviewed work is the one failure this hook cannot
# have, and it was reachable with no second session in the picture at all.
#
# The shared-checkout win is untouched: it needs a state that differs from the
# last ask but not from the prompt, which by definition is turn 2 or later, and
# $STATE_FILE exists by then.
#
# Exits WITHOUT writing $STATE_FILE: the stored key still belongs to the last
# thing we really asked about, so the next real change still re-arms.
# `[ -n "$TURN_KEY" ]` SURVIVES MUTATION, and is kept anyway. $STATE is a cksum, so
# it is never empty, so an empty key can never compare equal and the guard cannot
# change the outcome today. It is kept because the state it defends against — an
# empty $STATE meeting an empty baseline — resolves to SILENCE, and silence is the
# one failure this hook must not have. Said plainly rather than covered by a test
# that cannot fail.
if [ -f "$STATE_FILE" ] && [ -n "$TURN_KEY" ] && [ "$STATE" = "$TURN_KEY" ] && [ -z "$PLANS_CHANGED" ]; then
  consume_turn
  exit 0
fi

[ "$TOTAL" -gt 0 ] || [ -n "$PLANS_CHANGED" ] || { consume_turn; exit 0; }

# ── Ask once per distinct state ───────────────────────────────────────────────
# BOTH guards consult the plan set, not just the one above. $STATE is the cksum
# of the GIT set alone, so on a clean tree it is cksum("") — a CONSTANT. Comparing
# it here without the plan condition makes the plan trigger fire exactly once per
# session, ever: stop 1 differs from an absent file and asks, stops 2..n compare
# equal and exit. The single-plan-change test passes against that bug; only a
# SECOND change catches it.
if [ "$STATE" = "$(cat "$STATE_FILE" 2>/dev/null || echo "")" ] && [ -z "$PLANS_CHANGED" ]; then
  consume_turn
  exit 0
fi

jq -cn '{
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext: (
      "Wait for inflight actions to complete before doing anything.\n\n" +
      "Unreviewed changes in the tree? Run /code-review on the diff, or\n" +
      "/plan-eng-review on the plan.\n\n" +
      "Just completed a review? Fix or reject its findings. If there are fixes,\n" +
      "review again.\n\n" +
      "Consider skipping/rejecting: LOW priority; MEDIUM priority if the fix costs\n" +
      "more than the problem."
    )
  }
}' && { printf '%s' "$STATE" > "$STATE_FILE"; : > "$BASELINE_FILE"; consume_turn; } 2>/dev/null
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
