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

```bash
git clone https://github.com/lukaso/review-loop && cd review-loop
./setup --target /path/to/your/repo --paths ". :(exclude)prototypes/"
```

That does two things, and the split is the point:

```
~/.claude/hooks/review-loop.sh        the implementation  (machine, one copy)
<repo>/.claude/hooks/review-loop.sh   a ~5-line shim      (committed)
<repo>/.claude/settings.json          three registrations (committed)
```

**The standard lives in the repo; the implementation lives on the machine.**
Whether this repo reviews its changes, and which paths it watches, is a property
of the repo — so it is committed and arrives with the clone, rather than existing
only for whoever remembered to install it. The 500 lines that implement it are a
machine concern, so upstream fixes cost no commits in any consuming repo. Re-run
`./setup` to update. A re-run always refreshes the machine copy and the committed
shim — that is what it is for — and says so; it leaves `settings.json` alone when
the registrations already match. A plain re-run keeps whatever `--paths` the repo
was set up with.

If the implementation is missing on a machine, the shim says so once per session
through the ordinary nudge channel. It never goes quiet, and it never writes to
stderr — stderr from a hook breaks the turn.

`setup` merges into `.claude/settings.json` and preserves everything it did not
write, including a foreign hook sharing a matcher group with ours. It refuses a
file it cannot parse rather than repairing it, backs up before mutating, holds a
lock while it writes, and never runs git.

### Registering by hand

```json
// .claude/settings.json — all THREE events, same command, same timeout
{ "hooks": {
  "SessionStart":     [ { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", "timeout": 10 } ] } ],
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", "timeout": 10 } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", "timeout": 10 } ] } ]
} }
```

`UserPromptSubmit` samples the state of the tree at the start of each turn; `Stop`
asks only when it has moved since; `SessionStart` forgets the session's ask
history so a restart asks once before settling. A `Stop`-only install still works
and fails open — it just nudges about every dirty file in the checkout, including
another session's.

Skipping `SessionStart` costs one specific thing, and it is silent: `--resume`
reuses the session id and `/tmp` normally survives, so anything you hand-edited
while claude was closed is already in the tree when the first resumed prompt takes
its baseline, and is then never asked about. Measured without it: three silent
resumed turns on the user's own diff.

### Restart your session after installing

**Claude Code reads hooks at startup.** Installing mid-session registers nothing
that will fire, so until you restart you get no nudges at all — which looks
exactly like a broken tool.

```
in a session:   to pick it up in '<target>', exit and run:
                    claude --continue     # keeps the same conversation
                    claude --resume       # pick a different session

no session:     cd '<target>' && claude
```

Measured, not reasoned: before a `--continue` this repo had no state files for its
own session; after one, `review-loop-turn-<session-id>` appeared. A resume reads
settings at startup like any other start, so you get the tool without losing the
conversation.
`setup` prints this as its last line, and says it louder when it can tell it was
run from inside a live session.

This is not a footnote. It happened during development: installed, declared
working, and it had not fired once. The miss was caught only because someone asked
why nothing had prompted.

When checking whether this tool works, check that it **ran** — the state files in
`$REVIEW_LOOP_STATE_DIR` are the evidence — not that it is installed.

## Tests

```
npm install && npm test
```

232 tests. Every "→ silent" assertion carries a positive companion in the same
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
