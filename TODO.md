# review-loop — TODO

Spun out of the chiefofstaff prototype after two review rounds. Each item is its
own slice with its own review.

## Shared checkout makes the nudge lie about authorship

**Observed live 2026-08-22.** The hook told one session to run `/code-review` on
17 files a *concurrent* session had edited. It violates the original constraint:
"there will be untracked code in the repo if multiple sessions are going. So that
can't confuse it."

- **Attribution.** Intersect the dirty set with files *this* session wrote, read
  from `transcript_path`. Cost is fine: `jq -rs` on a ~130MB JSONL measures
  **~1.3s** (an earlier 0.24s figure was optimistic and did not reproduce). Still
  affordable inside a 10s timeout; it was `grep -F` at **82s** that was
  catastrophic, not transcript reading. Must also collect Bash `.input.command` strings: agents write files
  via heredoc, so a `Write`/`Edit`-only scan under-detects badly. `PostToolUse`
  capture is the more robust alternative — exact, O(1) at Stop, no transcript
  schema coupling.
- **Wording.** "Just written code?" asserts something about *you* that is false
  in a shared checkout. A nudge that is wrong about what you did erodes
  compliance faster than one that is merely frequent. Length-neutral fix:
  "Unreviewed changes in the tree?"

## The message must not name gstack skills

`/plan-eng-review` and `/code-review` are gstack skills, not built-ins. The
shipped default names commands most users will not have. Make the message text a
knob with a generic default; let a project override it.

Constrained by the `< 13` line cap in the suite, which exists because the message
once reached 25 lines by accreting a clause per review round. **Length is a
feature of it, not a detail.**

## Rules: ship the trigger, not the prose

Three rules were drafted for a host project's instructions file:

1. A plan whose **body** changed after its review is an unreviewed plan.
2. A design review is never the engineering gate.
3. Run the engineering review **last** (competing review skills write the same
   single terminal report section and each requires a VERDICT line — one slot,
   last writer owns it).

**Why they are weak, recorded so it is not rediscovered.** In the origin repo,
every review-gate rule that actually *holds* has a hook behind it: the commit
rule holds because `git commit` is blocked, the eval rule because `git push` is
blocked. The plan-review rule was the only one with **no mechanism**, and it is
the one that failed — it was not ignored, it was satisfied on a technicality.

**This tool must never write to `CLAUDE.md` or `AGENTS.md`.** Those are contested
files: other tools create them, append to them, and `git add CLAUDE.md &&
git commit` them with **no pathspec**, which commits the whole shared index.
Correctness must not depend on prose surviving there. If rules are wanted, ship
an optional file this tool owns and point at it only when it exists.

## Ship it: GitHub, licence, versioning

Mirror how gstack distributes, since that model is already proven on this
machine. Verified from `~/.claude/skills/gstack`:

| gstack does | review-loop needs |
| --- | --- |
| plain-text `VERSION` at repo root (`1.68.3.0`) | same |
| cloned from GitHub; `origin` is an HTTPS remote | `github.com/lukaso/review-loop` |
| `gstack-update-check` curls the REMOTE `VERSION`, compares to local, prints `UPGRADE_AVAILABLE <old> <new>` | same shape, fail-open on network error |
| `gstack-version-bump` / `gstack-next-version` | one bump script |
| `LICENSE` + `CHANGELOG.md` at root | both missing |
| `setup` script that installs into the host project | installs the hook + registers it in `.claude/settings.json` |

### Tasks

- [ ] **Create `github.com/lukaso/review-loop`.** `gh` is installed (2.66.1) and
      authenticated as `lukaso`, so `gh repo create lukaso/review-loop --public
      --source=. --remote=origin` works from the existing local repo.
- [ ] **Add a real `LICENSE` (MIT).** `package.json` **already declares
      `"license": "MIT"` with no LICENSE file present** — that is a false claim
      today. Harmless while unpublished; not harmless once it is on GitHub.
- [ ] **Decide the single source of version truth, then enforce it.**
      `package.json` says `0.1.0`; a gstack-style `VERSION` file would be a
      second copy. Two version strings that can drift is a bug generator. Either
      generate one from the other in the bump script, or pick one and have the
      update check read it. Do NOT hand-maintain both.
- [ ] **`setup` script** that copies `hooks/review-loop.sh` into a target
      project and registers the `Stop` hook in `.claude/settings.json`. It must
      MERGE into an existing hooks array, never overwrite one — other tools
      register Stop hooks too, and clobbering a project's `commit-gate` or
      `verify-build` hook would be a serious regression.
- [ ] **Install into chiefofstaff via that script**, so the install path is
      exercised by its first real user rather than by hand.
- [ ] **`CHANGELOG.md`**, starting at the first tagged release.

### Constraint carried over

The setup script writes to `.claude/settings.json` — which is a **contested
file**, same class as `CLAUDE.md`. Merge, never replace; and never `git add` +
commit on the user's behalf. gstack's own routing injection does exactly that
(`git add CLAUDE.md && git commit`, with no pathspec, which commits the whole
index) and it is a hazard in any repo with concurrent sessions.

## Deferred

- **Fire on plan-mode approval.** `CLAUDE_PLAN_FILE` was probed and is unset, so
  the cheap env shortcut is unavailable; needs a real mechanism.
- **A deleted plan does not fire.** `-newer` cannot see a file that is gone.
  Accepted: deleting a plan is not work that needs review.
