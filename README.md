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

Three files per session, deliberately separate:

| File | Holds | Written |
| --- | --- | --- |
| `review-loop-$SID` | the git cksum key | only when the hook asks |
| `review-loop-baseline-$SID` | the plan cut-off, as its mtime | **every turn** |
| `review-loop-turn-$SID` | the same git cksum key, sampled at the START of the turn | by `UserPromptSubmit`, only when absent; truncated to empty as a poison by a continuation Stop; removed by Stop once read |

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

**Register the same script on all THREE events.** `UserPromptSubmit` samples the
state of the tree at the start of each turn; `Stop` asks only when that state has
actually moved since; `SessionStart` forgets the session's
ask history on every source but `compact`, so a restarted session asks once before
it settles. With only `Stop`
registered the hook still works, but it nudges about every dirty file in the
checkout — including work another session is doing right now.

```json
// .claude/settings.json
{ "hooks": {
  "SessionStart": [ { "hooks": [
    { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh", "timeout": 10 }
  ] } ],
  "UserPromptSubmit": [ { "hooks": [
    { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh", "timeout": 10 }
  ] } ],
  "Stop": [ { "hooks": [
    { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh", "timeout": 10 }
  ] } ]
} }
```

Skipping `SessionStart` costs you one specific thing, and it is a silent one:
`--resume` reuses the session id and `/tmp` normally survives, so anything you
hand-edited while claude was closed is already in the tree when the first resumed
prompt takes its baseline — and it is then never asked about. Measured without it:
three silent resumed turns on the user's own diff.

Merge into an existing `hooks` block rather than replacing it — other tools
register `Stop` hooks too, and clobbering a project's commit or push gate would
be worse than anything this fixes.

**Keep every `REVIEW_LOOP_*` knob identical across all three registrations.** This
matters more than it looks, and the consequence is not uniform — an earlier
version of this section said the worst case was noise, and that was wrong once
`SessionStart` existed.

Measured, three turns each, with another session writing while this one idles:

| mismatch | result |
| --- | --- |
| none | turn 1 asks, then silent — working as intended |
| `REVIEW_LOOP_PATHS` on prompt vs Stop | **asks 3 of 3** — suppression off. Noise. |
| `REVIEW_LOOP_STATE_DIR` on prompt vs Stop | **asks 3 of 3** — no baseline found, fails open. Noise. |
| `REVIEW_LOOP_STATE_DIR` on **SessionStart** vs the other two | **SILENT on the user's own diff after `--resume`** |
| `REVIEW_LOOP_PLANS_DIR` anywhere | no effect — not part of the key |

That fourth row is the dangerous one. `SessionStart` does not compare anything, it
*deletes* — so pointed at the wrong directory it deletes nothing, and the resume
hole it exists to close is silently open again. Everything else degrades loudly.

If you use the inline-env style (`REVIEW_LOOP_PATHS="…" "$CLAUDE_PROJECT_DIR/…"`),
put the prefix on every line or on none. Adding a third registration and
forgetting the prefix is the easiest way to hit that row.

Same reason all three get the same timeout: it is the same work on both sides, so a
tighter budget on the prompt is backwards.

Only `SessionStart`, `UserPromptSubmit` and `Stop` are handled. Any other event
exits without doing anything, so registering it on `SubagentStop` gets you no
nudge rather than a surprise.

A `Stop`-only install **fails open by design**: no baseline means no turn
comparison, and the hook behaves exactly as it did before attribution existed.
The cost of leaving it that way is noise, and the symptom is easy to miss, so
register all three.

### What it still will not see

The window is `[prompt, Stop]`, and **that is a trade, not an oversight.** To
suppress another session's writes that land between your turns, it has to suppress
everything that lands between your turns — including some of your own:

- a background command **the agent itself started** that finishes after the Stop,
- edits you make in your editor between turns,
- a `git stash pop` or branch switch before you type the next prompt.

Anything arriving that way joins the baseline. It stays unasked until the tree
changes again during a turn — at which point the nudge covers the whole diff,
including it. If nothing in the tree ever moves again, it is never asked about.
There is no cheap fix: a rule that distinguishes those arrivals from another
session's would have to know who wrote a file, and nothing in the hook's reach
does. Use a worktree per session if that matters more than the noise.

Three cases are handled rather than lost: work written after a **blocked** Stop (a
sibling hook returning a block) is still asked about on the next turn; a session
that opens on an already-dirty tree always asks before it settles; and a hook
killed by its own timeout costs one ask, not the baseline. A nested repository
dirtied **in place** stays invisible, as it was before this feature — git reports
one directory entry and a directory's mtime does not move for an edit inside it.

### Cost

The enumeration now runs on the prompt as well as the Stop. End to end, whole
hook, `/usr/bin/time -p`, warm, dirty tree: **0.07-0.08s** here over six runs, and
**0.07s** on a large monorepo with 13 dirty entries. It moves with machine load —
a first pass measured 0.06-0.07s and a review under concurrent writes saw
0.08-0.10s, so treat it as "under a tenth of a second", not a constant. The `git status` inside it is
0.00-0.01s; the rest is process startup and `jq`.

**Unmeasured:** a network-backed or otherwise slow filesystem. There the prompt
registration is dead time before the model starts, so if that is your checkout,
time it before installing rather than trusting these numbers.

## Tests

```
npm install && npm test
```

99 tests. Every "→ silent" assertion carries a positive companion in the same
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
