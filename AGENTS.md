# AGENTS.md — review-loop

Read this first, every session. `CLAUDE.md` is one line (`@AGENTS.md`) because
Claude Code reads `CLAUDE.md` and does **not** read `AGENTS.md` on its own; the
import is what makes this file load-bearing.

---

## What this is

A Claude Code `Stop` hook that keeps the **fix → review → fix** loop running. It
fires when the CLI hands the prompt back to the user and asks whether the work
that exists has been reviewed. **It never blocks** — it prints
`hookSpecificOutput.additionalContext`, or nothing.

It does **not** review anything and is **not** responsible for review quality. It
knows one thing: *this work changed since I last asked about it.* Do not let the
scope drift into reviewing, scoring, or gating.

Origin: extracted from a prototype inside the `chiefofstaff` repo after four
adversarial review rounds, so that it can be built and released independently.
`README.md` is the user-facing doc; `TODO.md` is the work queue and carries the
reasoning behind everything deferred.

---

## Rules

### Reviews (this project's whole subject — practise it here)
- **Every plan goes through a plan review before code is written.** No exceptions
  for "small" — the small-looking ones shipped the worst bugs in this codebase.
- **Every change gets an adversarial code review before commit. Run it
  automatically; never ask permission.** "Want me to review first?" is not a
  question — the review is part of finishing, not a step the user opts into.
- **A review that confirms your reasoning is worthless.** Ask it to *refute* the
  change. Treat "no findings" as a reason to look harder.
- **If a review produced fixes, review again.** A fix is code nobody has
  reviewed. Loop until a round comes back clean; four rounds is normal here.
- **The re-review trigger is CHANGED CODE, not a non-empty findings list.** A
  round that only corrected comments, README prose or a stale number does not earn
  another round — nothing executable moved. Triage findings by severity and act on
  correctness; prose is discretionary and can be batched or skipped. Ignoring this
  is how the attribution slice reached SEVEN rounds against a predicted four: every
  prose-only round triggered a full re-review, which found more prose. The genuine
  defects had all surfaced by round 7.
- **A plan whose body changed after its review is an unreviewed plan.**

### Committing
- **Never commit or push without explicit user approval.** Report what to test
  and wait. Commit directly to `main`; this project does not use PRs.

### Evidence
- **Measure, don't assume — and construct the failing case.** Every claim in
  `README.md` and in the hook's comments is a measurement. Keep it that way; if
  you cannot reproduce a number, delete it rather than repeat it.

---

## Traps that have already cost real time

**The Bash tool shadows `grep` → `ugrep` and `find` → `bfs`.** A hook runs under
plain `bash` and gets `/usr/bin/grep` (BSD) and `/usr/bin/find`. They differ in
speed *and* semantics.

> **Always use `/usr/bin/` prefixes when measuring or testing anything the hook
> does at runtime.** `type grep` shows the shadow.

This invalidated an entire design: `0.26s` measured through the Bash tool was
**13.36s** in production, against a 10s timeout. ugrep also *inverts*
empty-pattern-file semantics, so a test "verified" through the Bash tool gives
the opposite answer.

**`bash -n` proves nothing about correctness.** A `case` placed above its
variable's definition is valid syntax and `exit 1` under `set -u` on every turn.
What caught it was the suite.

**Do not re-couple the two state files.** `$STATE_FILE` contents are the git key;
`$BASELINE_FILE` mtime is the plan cut-off. Coupling them deadlocks: the state
file is written only on an ask, and on a clean tree only a plan produces an ask.
On GNU find that was permanent death — measured 5 consecutive stops, plan
rewritten between each, silent every time. The hook header repeats this warning.

**The message has a `< 13` line cap, enforced by a test.** It reached 25 lines
once by accreting a clause per review round. Length is a feature of it, not a
detail. Do not inline rules into it.

---

## Test discipline (non-negotiable, and it has caught real bugs)

- **Every "→ silent" assertion carries a positive companion in the same
  fixture.** Without one, a hook that emits nothing passes half the suite.
- **`fire()` asserts `stderr === ""` on every call.** This line was added under
  protest at a reviewer's insistence and has since caught two defects it was not
  written for, including a completely dead hook.
- **A green test is not a working test. Mutate it.** Point the suite at a copy so
  a killed run never leaves a mutant in the tree:

  ```bash
  cp hooks/review-loop.sh /tmp/m.sh
  sed -i '' 's/<the guard>/<broken>/' /tmp/m.sh
  cmp -s hooks/review-loop.sh /tmp/m.sh && echo "MUTATION DID NOT APPLY — vacuous"
  REVIEW_LOOP_HOOK=/tmp/m.sh npx vitest run
  ```

  Check **which** test fails, by name. A mutant killed by 30 tests but not by the
  one written for it means that test is not doing its job. Aim for disjoint kill
  sets: one mutant, one test.
- **A surviving mutant means the path is uncovered.** Construct the case before
  concluding the guard is unnecessary — and if a guard genuinely cannot fail,
  **delete it** rather than write a test that cannot fail. Two were deleted on
  exactly that basis (`git rev-parse --git-dir`, `[ -f "$TRANSCRIPT" ]`).

---

## State as of 2026-08-22

- Committed at `dc3f599` on `main`, plus the turn-window attribution slice in the
  working tree. **No remote, nothing pushed.**
- **129 tests green** (99 hook, 14 setup, 7 shim, 9 release), and the suite no longer leaks state files into `/tmp` (382 had accumulated; a central `afterEach` sweep now covers the failing path too). Mutation-tested here: 19 guards before this slice, plus the
  turn comparison, its plan condition, the dispatch and the baseline lifecycle.
  One survivor is kept deliberately and says so in a comment (`[ -n "$TURN_KEY" ]`
  cannot change the outcome, but the state it guards resolves to silence); two
  others found in round 7 were resolved rather than kept — the `$TURN_FILE` half
  of the SessionStart reset was DELETED as unable to fail, and the state-dir
  agreement of that reset got the test it was missing. The
  review agent's own harness reported 25 across four rounds, also all killed —
  that second number is its measurement, not one reproduced in this repo.
- **`setup` exists** as of 2026-08-23, and it installs the SPLIT: the
  implementation to `~/.claude/hooks/`, a committed shim plus three registrations
  into the target repo. The standard belongs to the repo; the implementation
  belongs to the machine. This repo is the one exception — its own
  `.claude/settings.json` points straight at `hooks/review-loop.sh`, because here
  that file IS the implementation and a shim would only indirect to a stale copy.
- **Installed on itself** as of 2026-08-22: `.claude/settings.json` registers all
  three events against `$CLAUDE_PROJECT_DIR/hooks/review-loop.sh` — its own source,
  no vendored copy, so there is nothing to drift. It had NOT been dogfooded here
  through the entire attribution slice; the tool that nudges about unreviewed work
  was the one checkout it did not watch.
- `chiefofstaff` carries a **vendored** copy at `.claude/hooks/review-loop.sh`
  with a provenance header and a body SHA — edits belong here, not there. It is
  registered on `Stop` only, so it fails open past the turn-window filter until
  its `UserPromptSubmit` registration lands.
- `vitest.config.ts` deliberately has **no `globalSetup`** — the parent repo's
  shared mock-server port was pure contention and cost two aborted runs.

**Done since:** shared-checkout attribution and the message's false authorship
claim. The hook now has **three registrations, one script** — `UserPromptSubmit`
samples the state key into `$TURN_FILE`, `Stop` compares against it and removes
it, `SessionStart` forgets `$STATE_FILE` so a restarted session asks once. That is
a THIRD state file with a THIRD job; the no-coupling warning above covers all
three, and `SessionStart` touches exactly one of them on purpose.

**Seven ways this went SILENT, across seven review rounds.** Silence on unreviewed
work is the only failure this hook cannot have, and every single round found one — the
last two in the *fixes for* the round before:
1. mtime filtering missed `git mv`, `chmod`, new symlinks and nested repos.
2. suppressing on "unchanged since the prompt" alone silenced a session that
   opened on an already-dirty tree (`/clear`, restart, `/tmp` cleared).
3. the re-entry guard exited without poisoning the baseline, so work written
   after a BLOCKED Stop was never asked about again.
4. consuming the baseline before the slow enumeration meant a timeout took the
   ask AND the baseline; and separately a racing prompt could clobber the
   blocked-turn poison. Both ended in permanent silence.
5. `--no-optional-locks`, added to stop index-lock contention, is a TOP-LEVEL git
   option: git < 2.15 rejects the whole invocation, `2>/dev/null` hides it, and
   the tree reads as clean forever. Introduced by a fix, caught by the next round.
6. adding `ln`/`rm` to the preflight list — to make a test honest — gated the
   WHOLE hook on them, so a missing `ln` silenced Stop too. Unlisted, both
   degrade safely on their own. **The preflight list is a kill switch: only put a
   binary in it whose absence would otherwise leak stderr.**
7. `--resume` reuses the session id and `/tmp` survives, so `$STATE_FILE` was
   still there and everything hand-edited while claude was closed got baselined
   away. `/clear` was covered (new id, no state file); resume was not. Fixed with
   a THIRD registration on `SessionStart`, which forgets the session's state on
   every source except `compact`.

**The asymmetry that should decide every one of these calls:** a wrong ASK costs
one line of output; a wrong SILENCE loses the work. When a branch is uncertain —
an unknown `SessionStart` source, a missing binary, a rejected git flag, a killed
process — it must land on the noisy side. Six of the seven above are the same
mistake: a change that looked safe because it was *quieter*.
Each was found by constructing the failing case, not by reading the code. If you
touch the gate, construct one before you believe it is fine.

**The trap that cost this slice a full rewrite: mtime is not git's notion of
"changed".** The first implementation kept dirty paths whose mtime was not older
than a marker. It was silently wrong four ways, all reproduced: `git mv`
(rename(2) leaves mtime alone), `chmod +x`, a NEW symlink to an OLD target
(`-e`/`-ot` dereference, `stat` does not), and a nested repo dirtied in place (a
directory's mtime does not move for an in-place edit inside it). All four passed
the entire suite, because `fire()` never armed a baseline — **every legacy test
ran in the fail-open path.** If you add a filter here, re-run the enumeration
fixtures with it ARMED, or you are testing nothing.

**Every round also found tests that passed for the wrong reason** — six in total.
The recurring shapes: sampling the baseline on a CLEAN tree (`cksum("")` differs
from any dirt at all), firing twice off one prompt (the second `fire()` runs in
the fail-open path), and asserting the ASK direction where only the SILENT
direction can catch the bug. Exactly one test separates the turn gate from the
older ask-once guard; if you delete that gate, only that one test fails.

**Next up, in `TODO.md` order:** GitHub repo + MIT `LICENSE` (`package.json`
already claims MIT with no licence file); versioning with a single source of
truth; and a `setup` script that **merges** into `.claude/settings.json` rather
than overwriting — clobbering a project's commit or push gate would be worse than
anything this tool fixes.

---

## Quick reference

```bash
npm test                    # 129 tests, ~35s, no network, no ports
bash -n hooks/review-loop.sh && ./hooks/review-loop.sh < payload.json
```

Knobs, all optional: `REVIEW_LOOP_PATHS` (default `.`),
`REVIEW_LOOP_PLANS_DIR` (default `$HOME/.claude/plans`),
`REVIEW_LOOP_STATE_DIR` (default `/tmp`), `REVIEW_LOOP_HOOK` (tests only).
