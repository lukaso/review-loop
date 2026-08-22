# review-loop — TODO

Spun out of the chiefofstaff prototype after two review rounds. Each item is its
own slice with its own review.

## ~~Shared checkout makes the nudge lie about authorship~~ — DONE 2026-08-22

Shipped as a turn comparison. `UserPromptSubmit` samples the hook's own state key
into `$TURN_FILE`; `Stop` recomputes it and stays quiet when it is unchanged.
Fails open with no baseline, so a checkout registered on `Stop` alone behaves
byte-for-byte as before.

**Not a timestamp test, and that distinction is the whole slice.** The first cut
filtered dirty paths by mtime and was silently wrong on `git mv`, `chmod +x`, a
new symlink to an old target, and a nested repo dirtied in place — git's notion
of "changed" is not mtime, so mtime cannot decide what git saw. Comparing the
same key the hook already trusts decides it exactly, and costs one extra
`git status` per prompt (measured **0.00-0.01s** in a monorepo with 13 dirty entries; the whole hook, end to end, is under a tenth of a second — see README for the range and why it is a range).

**The approach this file used to propose was measured and refuted. Do not
re-propose it.** Intersecting the dirty set with files this session wrote, read
from `transcript_path`, was tested against the real incident (17 dirty files, all
another session's):

| signal | dirty files attributed | verdict |
| --- | --- | --- |
| `Write`/`Edit`/`NotebookEdit` `file_path` | 3 / 17 | refuted |
| `file-history-snapshot.trackedFileBackups` | 3 / 17 | refuted, same set |
| \+ regex-extracted `Bash` write targets | 7 / 17, plus 490 junk "paths" | refuted |
| turn comparison (shipped) | 11 of 17 predate the prompt and go unseen | adopted |

The mechanism: that session ran **`Bash` roughly 10x more often than
`Write`+`Edit`** — 2460 against 231 when sampled on 2026-08-22. Treat the ratio
as the finding, not the counts: the session was still live, and re-running the
same count later gives 2572 Bash against the same 231, because only the Bash side
keeps growing. Files land via heredoc, `sed -i` and scripts, and shell is not
parseable by regex.

Cost was never the blocker either way. Measured here: extracting Write/Edit paths
with `jq` is **0.24s** over a 32MB transcript, and a tool-name scan of a 126MB one
is **0.83s**.

**These are not the same measurement an earlier note retracted.** That note said
"~1.3s (an earlier 0.24s figure was optimistic and did not reproduce)" — different
file, different query. Both numbers above were taken in one sitting and are
reproducible; neither reinstates the retracted one. Transcript reading is
affordable. It just does not answer the question.

And the subset argument, which does not depend on that ratio: a file written by
`Write`/`Edit` **during this turn is already inside the window**, so path capture
adds nothing the window does not already have.

Two measured facts that killed the other candidates:
- **Transcript birth time is not session start.** Sessions are resumed: one was
  born 08-20 and still being appended 08-22, another born 08-14. Excluding files
  older than session start would have excluded 4 of 17.
- The comparison cannot exclude a concurrent write that lands *inside* our own
  turn. That session was **active 72% of 49.9h wall-clock**, and 6 of the 17
  files moved inside its turns, so it would still be asked on those turns. This
  narrows the lie; it does not end it. A worktree per session is the real fix.

**Wording** — done in the same slice: "Just written code or a plan?" asserted
something about *you* that is false in a shared checkout. Now "Unreviewed changes
in the tree?", same line count.

**Still open, deliberately deferred:** plan-file attribution. `~/.claude/plans` is
shared across sessions too, so the plan trigger has the same bug. It is untouched
here because the plan path has a documented deadlock history and deserves its own
slice.

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
