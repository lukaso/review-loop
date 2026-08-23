# Changelog

Shape borrowed from gstack: a bolded headline sentence, then what actually
happened, then the numbers that back it. Every claim here is a measurement — if a
number cannot be reproduced it is deleted rather than repeated.

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
