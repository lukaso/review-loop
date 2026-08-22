# review-loop

A [Claude Code](https://claude.com/claude-code) `Stop` hook that keeps the
**fix → review → fix** loop running until findings are resolved.

It fires at the moment the CLI hands the prompt back to you — the moment the
workflow would otherwise be abandoned — and asks whether the work that exists
has been reviewed.

**It never blocks.** It emits `hookSpecificOutput.additionalContext`, or nothing.

## What it is not

It does not review anything, and it is not responsible for the quality or
completeness of the reviews it asks for. It knows exactly one thing: *this work
has changed since the last time I asked about it.*

## What it watches

| Source | Mechanism |
| --- | --- |
| Code in the repo | `git status --porcelain -uall -z`, hashed to a state key |
| Plans outside the repo | `find -H $PLANS_DIR -maxdepth 1 -name '*.md' -newer $BASELINE_FILE` |

Plans live outside the repo, so a planning turn produces no diff at all. Watching
only `git status` made the one phase where a plan review is mandatory the one
phase the hook was blind to.

Two files per session, deliberately separate:

| File | Holds | Written |
| --- | --- | --- |
| `review-loop-$SID` | the git cksum key | only when the hook asks |
| `review-loop-baseline-$SID` | the plan cut-off, as its mtime | **every turn** |

Do not re-couple them. Using the state file as the plan baseline deadlocks — see
the portability note below.

The plan baseline is its **own file**, advanced every turn — not the state file.
Coupling them deadlocks: the state file is written only when the hook asks, and
on a clean tree only a plan can make it ask, so plan detection that depends on
the state file existing can never start.

On the session's first Stop there is no baseline yet, so the cut-off is the
transcript file's **birth time** — session start. Firing unconditionally instead
would be a guaranteed contentless question at the most salient moment of every
session.

## Configuration

All optional.

| Variable | Default | Notes |
| --- | --- | --- |
| `REVIEW_LOOP_PATHS` | `.` | git pathspecs. Add your own churn: `". :(exclude)prototypes/"` |
| `REVIEW_LOOP_PLANS_DIR` | `$HOME/.claude/plans` | |
| `REVIEW_LOOP_STATE_DIR` | `/tmp` | Must be **absolute** and **outside the repo** — see below |

The default watches the **whole tree**. A released tool must not ship one repo's
exclude list.

`REVIEW_LOOP_STATE_DIR` is handled defensively, because both ways of getting it
wrong were measured to be silent:

- **Relative paths are resolved** against `$PWD`, and symlinks are resolved with
  `pwd -P`. The path is consumed before the hook `cd`s to the repo root and again
  afterwards, so a relative value used to read one file and write another — and
  the hook then asked on every single turn.
- **A state dir inside the repo falls back to `/tmp`.** The default watches
  everything, so state files written inside the tree are themselves dirt, and the
  baseline is rewritten every turn — its own mtime moves, the key never settles.
  Measured before the fallback: **5 asks in 5 turns on a pristine checkout**,
  nothing else happening.

`REVIEW_LOOP_PATHS` is **whitespace-split and not glob-expanded** — the pathspecs
are passed to git unquoted, under `set -f`. Both halves matter: `set -f` is what
stops the shell expanding `src/*.ts` before git sees it (git's `*` crosses `/`,
the shell's does not, so expansion would silently hide nested files). The cost is
that a pathspec containing a space becomes two arguments and matches nothing.
Space-free pathspecs only.

## Install

```json
// .claude/settings.json
{ "hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh", "timeout": 10 }
] } ] } }
```

## Tests

```
npm install && npm test
```

65 tests. Every "→ silent" assertion carries a positive companion in the same
fixture: without one, a hook that emits nothing passes half the suite.

## Portability notes

- `find -H` is **load-bearing**. Without it, find `lstat`s the start point and
  never descends into a symlinked plans dir: no output, exit 0, *and no stderr* —
  byte-identical to "no plan changed".
- `-newermB` is **BSD-only**; GNU find rejects `B` (verified against findutils
  4.10.0: `invalid predicate`). It errors into `/dev/null`, so on Linux the
  session-start cut-off is unavailable and a plan written in the session's
  **first turn** is missed. Every turn after that works normally, because the
  baseline file is created whether or not the hook asked.
  An earlier version coupled the baseline to the state file, which made this a
  permanent failure rather than a one-turn one: measured 5 consecutive stops on a
  clean tree with the plan rewritten between each — **silent every time**.
- **Never measure this hook's behaviour through an agent's shell.** Claude Code's
  shell snapshot shadows `grep`→`ugrep` and `find`→`bfs`. An earlier design
  measured `0.26s` that was really **13.36s** against a 10s timeout, and ugrep
  inverts empty-pattern-file semantics. Use `/usr/bin/` prefixes.
