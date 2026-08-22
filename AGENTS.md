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

- Committed at `dc3f599` on `main`. **No remote, nothing pushed.**
- **65 tests green.** 19 distinct guards mutation-tested here, all killed; the
  review agent's own harness reported 25 across four rounds, also all killed —
  that second number is its measurement, not one reproduced in this repo.
- Not installed anywhere yet. `chiefofstaff` still runs its own older copy.
- `vitest.config.ts` deliberately has **no `globalSetup`** — the parent repo's
  shared mock-server port was pure contention and cost two aborted runs.

**Next up, in `TODO.md` order:** shared-checkout attribution (the hook currently
tells you to review a *concurrent session's* diff — observed live during
development, once on a 17-file diff belonging entirely to another session);
the message's false authorship claim; GitHub repo + MIT `LICENSE` (`package.json`
already claims MIT with no licence file); versioning with a single source of
truth; and a `setup` script that **merges** into `.claude/settings.json` rather
than overwriting — clobbering a project's commit or push gate would be worse than
anything this tool fixes.

---

## Quick reference

```bash
npm test                    # 65 tests, ~15s, no network, no ports
bash -n hooks/review-loop.sh && ./hooks/review-loop.sh < payload.json
```

Knobs, all optional: `REVIEW_LOOP_PATHS` (default `.`),
`REVIEW_LOOP_PLANS_DIR` (default `$HOME/.claude/plans`),
`REVIEW_LOOP_STATE_DIR` (default `/tmp`), `REVIEW_LOOP_HOOK` (tests only).
