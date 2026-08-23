# Changelog

Shape borrowed from gstack: a bolded headline sentence, then what actually
happened, then the numbers that back it. Every claim here is a measurement — if a
number cannot be reproduced it is deleted rather than repeated.

## [0.2.2] - 2026-08-23

**`setup` said "installed." and then nothing fired, for the rest of your session.**

Claude Code reads hooks at startup, so installing mid-session registers nothing
that runs. `setup` printed a success summary and exited 0, and the user got zero
nudges with no way to tell that from a broken tool — silence that looks like
health, which is the exact failure this project exists to prevent.

It happened here. This repo installed the hook on itself, declared it working on
the strength of the files existing, and it had not fired once. The miss surfaced
only when someone asked why no prompt had appeared after a plan was written, and
after that plan was reviewed.

**`setup` overwrote the machine-global hook on paths that printed "nothing was
changed".** `$IMPL` — the single copy at `~/.claude/hooks/review-loop.sh` that
every shimmed repo on the machine executes — was installed before the settings
merge was known to succeed. A stale `REVIEW_LOOP_SRC` therefore downgraded the
hook for *every* consuming repo on any run that then hit a held lock or an
unparseable `settings.json`, while the summary said nothing had changed. The
merge now runs first, and the no-op path reports the refresh instead of denying
it. **Upgrade for this one if you have run `setup` from more than one checkout.**

**`setup` reported "installed." over three destinations it had not actually
written.** `mv -f` and `install(1)` share a behaviour: when the destination is a
*directory* they put the file inside it and return 0. All three of setup's
destinations were exposed, and setup printed its success summary and the restart
notice over every one:

- `settings.json` — a registration Claude Code cannot parse
- the **committed shim** — every turn then exits 126 leaking bare stderr, which
  on `UserPromptSubmit` lands in the user's face mid-sentence
- `$IMPL`, the machine-global copy — and `[ -x ]` is true for a searchable
  directory, so the v0.2.1 shim guard did not catch this shape either

The symlinked variant of the shim case wrote **outside the target repo**.
Installed-looking and permanently silent, produced by the installer of a tool
whose entire purpose is to prevent silence. One predicate now covers all three,
checked before the lock, the backup, both installs and the creation of
`.claude/` itself, so a refusal leaves the repo exactly as it found it.

`$IMPL` and the committed shim could also be **the same file**. With
`--target $HOME` they are; with `.claude/hooks` symlinked to `~/.claude/hooks` —
the ordinary "share one hooks dir across repos" arrangement — they are too. Both
destinations passed their check, the implementation was installed, and then the
shim was installed over it. The shim became its own `$IMPL`, `[ -x ]` was true
because it *was* itself, and it exec'd itself until the turn timed out. In the
symlinked case that overwrote the **machine-global implementation every shimmed
repo on the machine executes**, and the `.claude` variant rewrote the user's
global `~/.claude/settings.json` while reporting only the repo path. Both
operands of the comparison are resolved now — resolving one of them is not
resolving it.

**A re-run stopped discarding the repo's other committed settings.** The env
prefix on a registration is the repo's standard — `REVIEW_LOOP_PATHS`, and any
`REVIEW_LOOP_PLANS_DIR` or `REVIEW_LOOP_STATE_DIR` beside it. Three separate
paths dropped some of it and still printed "installed.": a plain re-run, a
re-run where another assignment came first, and `--paths` itself. Dropping the
plans dir silences the plan trigger specifically — and on a clean tree only a
plan produces an ask, so those nudges go missing while the git trigger masks it.
Extraction happens once now, above every branch, and a replaced or cleared
pathspec is reported instead of vanishing.

**`setup` installed into the wrong directory when `CDPATH` was set.** `cd`
echoes the resolved path when it resolves via `CDPATH`, and command substitution
concatenated that with `pwd`, so the target became a two-line string.
Reproduced: the shim and `settings.json` landed in a *different* repo while the
named one stayed empty, and setup exited 0 saying "installed." A `cd` that
failed outright left the target empty and operated on `/`.

**A plain `./setup` re-run stripped the repo's `REVIEW_LOOP_PATHS`** — the exact
invocation the README prescribes for updating — reverting a committed standard
without mentioning it. The existing pathspec is now carried forward.

`setup` now ends with a runnable command rather than a diagnosis. It cannot know
which project the calling session is in — `CLAUDE_PROJECT_DIR` is not exported
into a spawned shell — so it names the directory it installed into and lets you
match it, rather than asserting anything about "this session":

```
in a session:      to pick it up in '<target>', exit and run:
                       claude --continue     # keeps the same conversation
                       claude --resume       # pick a different session
no session:        cd '<target>' && claude
```

An earlier draft compared `$TARGET` to `$PWD` and claimed to know. It was wrong
three ways, the worst being `cd /B && setup` from a session whose project is /A:
the paths match, so it said "restart this session", and `claude --continue`
reopens /A, whose settings were never touched. Told the install is active, gets
silence — the exact failure this notice was added to prevent, produced by the
notice.

It states the mechanism rather than a diagnosis — "Claude Code reads hooks at
startup, so a session already running does not have this registration yet" —
because someone who installed yesterday and restarted already has them firing.

Measured, not reasoned: this repo had no state files for its own session before a
`--continue`, and a turn file immediately after one.

### The review of this change found the same bug one level up

**The activation tests passed only because they ran inside Claude Code.** The test
helper inherited `CLAUDECODE` from the parent process, and the assertions matched
words that exist only in the in-session branch. `env -u CLAUDECODE npm test` went
red — so a plain terminal, or the first CI job on the new public remote, would have
failed on a release that was green here. **The branch a non-Claude user sees had no
test at all**: mutating its message survived all 19.

Fixed at the root — the helper now strips the ambient session and each test
declares the context it means. There is one test per context, because the branch
nobody tested is reliably the one that is wrong.

Also: `--target` with no value died with `bash: $2: unbound variable` and exit 1
instead of a `setup:` message and exit 2.

## [0.2.1] - 2026-08-23

**The shim treated a non-executable implementation as runnable, and leaked
`Permission denied` to stderr — which breaks the turn.**

`[ -x "$IMPL" ]` was correct; nothing tested it. A copy that dropped the mode bit
(a zip, a checkout without the exec bit, `cp` without `-p`) leaves a file that
exists and cannot run. Mutating `-x` to `-e` passed the entire suite while making
the shim write to stderr — the one thing a hook must never do. The jq-missing exit
code was unpinned the same way.

Both are now pinned, each by a test that kills exactly its own mutant.

### How they were found

Not by reading the code. By enumerating mutation targets **from the diff** rather
than choosing them by hand, which is the difference this release exists to
demonstrate:

| | |
| --- | --- |
| Targets enumerated from a 40-line file | 5 |
| Survivors | 3 |
| Verified real gaps | **2** |
| Equivalent mutants | 1 |

The file had been written test-first and hand-mutated the same day, with five
mutants chosen by attention. Attention missed both. Enumeration found them in five
seconds.

## [0.2.0] - 2026-08-23

**The nudge now asks about what THIS turn changed, instead of every dirty file in
the checkout — and there is a `setup` script, a licence and a version.**

The hook told a session to run `/code-review` on 17 files another session had
written. It now samples the state of the tree when your prompt arrives and asks
only when that state has moved by the time the turn ends. Three registrations,
one script: `UserPromptSubmit` takes the baseline, `Stop` compares and consumes
it, `SessionStart` forgets it so a restarted session asks once before settling.

Installing is now one command. `./setup` puts the implementation on your machine
and commits a five-line shim plus three registrations into the repo — the standard
lives in the repo, the implementation lives on the machine, so upstream fixes cost
no commits in consuming repos.

### The numbers that matter

Source: the measurements in `TODO.md` and the 129-test suite, which fails on the
previous release.

| Property | Before | After |
| --- | --- | --- |
| Another session's dirt, present before your prompt | asked about it | silent |
| Work you did this turn | asked | asked |
| `git mv`, `chmod +x`, new symlink, nested repo | (mtime filter dropped all four) | asked |
| A session opening on an already-dirty tree | — | asks once, then settles |
| Work written after a blocked Stop | — | still asked about |
| Attribution by transcript `Write`/`Edit` paths | 3 of 17 files | not used; refuted by measurement |
| Tests | 65 | 129 |

Seven review rounds found seven ways this went silent on unreviewed work, four of
them introduced by the fix for the round before. The governing rule that came out
of it is now the first thing `AGENTS.md` says: a wrong ASK costs one line of
output, a wrong SILENCE loses the work.

### Also

- The message no longer claims you wrote the code.
- The state key carries file mode, so `chmod` on an already-dirty file re-arms.
- `git status` waives the optional index lock where git supports it, and falls
  back where it does not — git before 2.15 rejects the flag outright and the tree
  would read as clean forever.
- `LICENSE` (MIT) now exists. `package.json` had claimed MIT since the first
  commit with no licence file behind it.
- `VERSION` is the single source of truth; `bin/review-loop-version-bump` writes
  both it and `package.json`, and a test asserts they agree.

## [0.1.0] - 2026-08-22

First extraction from the `chiefofstaff` prototype after four adversarial review
rounds. A `Stop` hook that asks whether the uncommitted code has been reviewed,
and asks again after anything changes. 65 tests.
