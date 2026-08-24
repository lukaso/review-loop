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

**MEASURED 2026-08-24, because the first version of this item was half wrong:**
`/code-review` **IS a Claude Code built-in** — absent from `~/.claude/skills/`,
and `/code-review ultra` is a documented command. Naming it is fine.
`/plan-eng-review` **is a gstack skill** (present in `~/.claude/skills/`) and is
simply not there for a reader without gstack.

**Do not inflate this.** The skill works; it is review-loop that names it. Nothing
executes the message — it is `additionalContext`, text an agent reads — so the
failure is one dead-end instruction beside one that works, and the nudge still
does its job. A wrong instruction in a public tool's user-facing output, through
four releases. Worth fixing; not a broken tool.

**Detect the SKILL, not gstack.** `[ -d "$HOME/.claude/skills/plan-eng-review" ]`
is the actual precondition — *does the command I am about to name exist?* It
survives gstack renaming things, works for someone who has that skill from
elsewhere, and is one predicate at one call site.

**RUNTIME, in the hook — never baked in at install.** Whether a machine has a
skill is a MACHINE fact; `settings.json` is a REPO standard, committed for
everyone who clones. Baking it in would commit one developer's machine state into
the repo, against the split this whole project is built on. A `stat` costs
microseconds against a 10s budget.

**Do NOT recommend gstack from `setup`.** Its output ends with the activation
notice, whose own comment reads "LAST LINE, deliberately. Above the file list it
is not read." Anything appended is unread; anything before it displaces the one
thing that must be. It would also give a correctness tool a marketing dependency
on a third party's naming — the dependency that produced this bug.

**The principle, one level up:** describe the ACTION and name a command only when
it is known to exist. Naming a tool is a convenience; describing the loop is the
contract.

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

- [x] **Create `github.com/lukaso/review-loop`.** Done 2026-08-23, public. `gh` is installed (2.66.1) and
      authenticated as `lukaso`, so `gh repo create lukaso/review-loop --public
      --source=. --remote=origin` works from the existing local repo.
- [x] **Add a real `LICENSE` (MIT).** Done 2026-08-23. `package.json` **already declares
      `"license": "MIT"` with no LICENSE file present** — that is a false claim
      today. Harmless while unpublished; not harmless once it is on GitHub.
- [x] **Decide the single source of version truth, then enforce it.** Done:
      `VERSION` is truth at 3-digit semver, `bin/review-loop-version-bump` writes
      both it and `package.json`, and a test asserts they agree — the test gstack
      does not have, which is why they need a four-state drift classifier.
      `package.json` says `0.1.0`; a gstack-style `VERSION` file would be a
      second copy. Two version strings that can drift is a bug generator. Either
      generate one from the other in the bump script, or pick one and have the
      update check read it. Do NOT hand-maintain both.
- [x] **`setup` script** Done 2026-08-23, with the standard/implementation split.
      Original text kept below for the reasoning.
- [ ] ~~**`setup` script**~~ that copies `hooks/review-loop.sh` into a target
      project and registers the `Stop` hook in `.claude/settings.json`. It must
      MERGE into an existing hooks array, never overwrite one — other tools
      register Stop hooks too, and clobbering a project's `commit-gate` or
      `verify-build` hook would be a serious regression.
- [ ] **Install into chiefofstaff via that script**, so the install path is
      exercised by its first real user rather than by hand.
- [x] **`CHANGELOG.md`**, in gstack's shape. Done 2026-08-23.
- [ ] **`update-check`** — deferred deliberately: its job is comparing against
      published releases and there are none yet. The mechanisms to carry over are
      recorded in the plan (fail LOUD on crash; SHA-pinned raw URL because branch
      raw is stale for minutes after a push; semver-order guard; validate the
      response is a version and not an HTML error page).

### Constraint carried over

The setup script writes to `.claude/settings.json` — which is a **contested
file**, same class as `CLAUDE.md`. Merge, never replace; and never `git add` +
commit on the user's behalf. gstack's own routing injection does exactly that
(`git add CLAUDE.md && git commit`, with no pathspec, which commits the whole
index) and it is a hazard in any repo with concurrent sessions.

## Backlog — rules that want to be features

**The framing, which is the useful part:** a rule I am tempted to write into
`AGENTS.md` is usually a feature request for this tool wearing a disguise. This
project exists because a review-gate rule with no mechanism is the one that fails,
and these rules are all about LOOP behaviour — which is the thing this tool
governs. So they belong in the product, not in prose that competes for attention
with everything else in an instructions file.

Each item below started life as a one-liner I nearly added to `AGENTS.md` today.

### 1. Prose-only changes should not earn a re-review nudge (highest value)

**Observation.** `AGENTS.md` now says *"the re-review trigger is CHANGED CODE, not
a non-empty findings list."* That rule exists because a 23-round loop elsewhere
spent its last two rounds re-reviewing five comment edits, and this repo's own
attribution slice hit seven rounds against a predicted four for the same reason.

**Why it is a feature, not a rule.** The hook ALREADY computes exactly which paths
changed this turn — that is the whole attribution mechanism. It is one step from
knowing that a turn touched only `*.md`, only comments, or only test names.

**Sketch.** When every path in the attributed set is documentation, the nudge
either stays quiet or says something different ("docs only — a review round is
probably not owed"). **Risk, and it is the fatal direction:** silence is this
project's one unacceptable failure, and "only docs changed" is a judgment about
importance, which `AGENTS.md` explicitly forbids the hook from making. A
`.md`-only heuristic is also wrong for a repo whose product IS documentation.
Likely lands as a differently-worded ask rather than silence.

### 2. Changes made WHILE a review is in flight

**Observation.** I launched a review, then found a defect myself, so the review was
reading code I already knew was wrong. That converts one round into two. The
tempting rule was *"launch the review when you stop finding things, not when you
stop typing."*

**Why it is a feature.** The hook's message already opens with "Wait for inflight
actions to complete" — it asserts the problem but cannot detect it. If it knew a
review had been requested, the state key at that moment is a natural marker: a
turn that changes the tree after that point means the in-flight review is now
reviewing a stale tree, and saying so is a fact, not a judgment.

**Risk.** Requires knowing a review started, which means coupling to whatever tool
performs it — the same coupling `TODO.md` already wants removed from the message.
Wants a generic signal, not a hardcoded skill name.

### 3. Mutation testing re-arms the nudge with no content change

**Observation, measured today.** A mutation cycle copies, mutates, runs and
restores. The restore gives the file a fresh mtime, and the state key is paths +
mtime + size, so an identical file re-arms the question. Anyone following the
mutation discipline `AGENTS.md` mandates gets a false ask per run.

**Why it is a feature.** It is an interaction between the tool and the practice the
tool exists to support.

**Partly superseded by #4.** Some of the asks that looked like this were really the
fail-open on nudge-driven turns. The mtime mechanism is still real, but measure
which one is actually biting before acting on either.

**Risk.** The mtime+size key took seven review rounds to get right, and "an edit to
an already-dirty file must re-arm" is a deliberate, tested property — the fix for a
real bug. Do not touch it without reproducing the false ask first and measuring how
often it actually bites. Content hashing is the obvious answer and was rejected
once already on cost.

### 4. The turn window is inert on turns the NUDGE drives (measured, not a bug)

**Observation, and it took a false alarm to find.** A turn triggered by the hook's
own `additionalContext` is not a prompt submission, so `UserPromptSubmit` does not
fire, so no turn baseline is written, so the turn gate is skipped and the hook
falls back to the older ask-once guard. **The attribution feature — seven review
rounds of work — is inert during exactly the fix-review-fix loop this tool exists
to drive.** It only works on turns a human actually started.

**Evidence.** The live transcript records `stop_hook_summary` entries showing this
hook running on every Stop (61-172ms, `hookErrors: []`), and
`hookAdditionalContext` empty on the turns where it stayed silent — so the hook is
healthy. There is no summary subtype for `UserPromptSubmit` at all, so the
transcript cannot confirm or deny it; the turn FILE is the evidence, and it is
absent mid-turn on nudge-driven turns and present on prompted ones. I first read
that as "UserPromptSubmit is not firing, the hook is in permanent fail-open" and
said so. It was wrong — `Stop` consumes the file and no prompt had been submitted
since.

**Why it is not a bug.** Fail-open is the correct direction, and every one of
those turns still gets the older ask-once guard. Nothing is silenced.

**Why it is still worth fixing.** "No baseline exists" and "the baseline says
nothing changed" are different states that currently collapse into the same
behaviour, and the first one is common precisely when the tool is being useful.

**Sketch, with the tension named.** Move consumption from `Stop` to
`UserPromptSubmit`: a human prompt starts a new window, and the nudge-driven turns
that follow inherit it — which is arguably the truer model, since they are all one
human turn's work. **But** round 2 of the attribution slice established that
`UserPromptSubmit` must write ONLY WHEN ABSENT, so a typed-ahead second prompt
cannot re-baseline over work already in flight. Always-overwrite regresses that.
Distinguishing the two needs a "turn closed" marker written by `Stop` — a FOURTH
state file, which the header's no-coupling warning would then have to cover. That
cost is why it is here and not in the hook.

### 5. Prior art already in the repo

**Observation.** The `$TARGET` vs `$PWD` comparison in `setup` repeated a mistake
this repo had already solved and commented, about 200 lines away in
`hooks/review-loop.sh` — resolve both sides with `pwd -P`, test containment, not
equality. I re-derived it instead of finding it.

**Why it is probably NOT this tool.** Surfacing prior art when you touch a
construct is a different product. Recorded here so the idea is not lost, and
because it is a third failure class distinct from the two catalogued: not an
unpinned test, not a missing mechanism, but failing to consult knowledge already
captured.

### 6. Findings outside the change should be RECORDED, not fixed in the loop

**Observation, measured on release 0.2.2.** Round 7 produced nine findings. Four
were pre-existing code committed in `13253a1` (confirmed with `git log -S`),
including the release's worst bug — `TARGET=$(cd "$TARGET" && pwd)`, unchecked
and CDPATH-exposed. Three were introduced by round 6's own fixes. Two were prose.

So the majority of what the loop found was **not in the change under review**. It
got fixed anyway, in the release, which is why a ~12-line activation notice
became 87 lines of new code across eight rounds. The round count reads as "eight
rounds on a small change"; what actually happened is that the review scope
widened, silently, into committed code no earlier round had looked at. That is
how a release grows without anyone deciding it should.

**Proposed change.** The message's disposition clause today only says what to
*drop*: "Consider skipping/rejecting: LOW priority; MEDIUM if the fix costs more
than the problem." Dropping loses the finding. It should say what to *record* —
a finding outside the change goes to the backlog, and the loop stays on the diff.

**The gate this needs, or it causes the failure this project exists to prevent.**
"Out of scope" must NOT be a licence to ship a known-broken release. The CDPATH
P1 was out of scope and still had to be fixed, because it changed state outside
the target repo. The rule has to be severity-gated on the same bar as the
stopping rule: *record it unless it ships broken.* An unconditional "backlog
anything out of scope" would have shipped 0.2.2 installing into the wrong repo —
a quieter loop that loses the work, which is failure class six all over again.

**Constraint — this is the trap, read it before implementing.** AGENTS.md: the
message has a `< 13` line cap enforced by a test, it reached 25 lines once by
accreting a clause per review round, and "length is a feature of it, not a
detail." This must REPLACE the skip/reject clause, not append a fourth. If it
cannot be said in the same budget, it does not go in the message.

### 7. The collision check is a STRING compare, not a same-file test

**Observation, round 13.** `IMPL_RESOLVED` and `SHIM_RESOLVED` are reassembled
textually — `resolve_dir` re-appends the components that do not exist yet — so
two inputs still slip past a guard that is otherwise correct:

- `..` inside the not-yet-existing tail:
  `REVIEW_LOOP_IMPL=$T/.claude/hooks/nope/../review-loop.sh` → `installed.`, and
  the shim is written over `$IMPL`.
- a **case-insensitive volume** (APFS default on macOS):
  `REVIEW_LOOP_IMPL=$T/.claude/hooks/Review-Loop.sh` → `installed.`, one file on
  disk, both names the same inode.

**Why it is parked, not fixed.** Both need a hand-set `REVIEW_LOOP_IMPL`, so
neither clears the release's stopping rule. The honest fix is a same-file test
(device+inode, or `-ef`) rather than more string surgery — and it cannot run
before the parents exist, which collides with "refuse before changing anything".
That trade is a design decision, not a patch, and in Node it is `fs.statSync`
plus an inode compare with no reassembly at all. **Fold this into the port.**

### 8. `--paths` accretes a duplicate assignment per run

**Observation, round 13.** With a foreign variable ahead of ours,
`MY_REVIEW_LOOP_PATHS=team REVIEW_LOOP_PATHS='old/'` plus `--paths new/` emits
`MY_… REVIEW_LOOP_PATHS='old/' REVIEW_LOOP_PATHS='new/' <tail>`. Last assignment
wins in POSIX shell, so the effective pathspec is correct and verified so
end-to-end — but the committed command grows one stale assignment every run, and
the "replaced the REVIEW_LOOP_PATHS" line is not printed because the anchoring
fix correctly decided our variable was not the one it matched.

**Why it is parked.** Behaviour is right, the growth is slow and visible, and the
robust fix is the same one as item 7: parse the assignments properly instead of
splitting strings. Same port.

### 9. `cd "$CWD"` in the hook is CDPATH-vulnerable with a relative payload cwd

**Observation, round 15 (reproduced).** `hooks/review-loop.sh:161` does a bare
`cd "$CWD"`. With an exported `CDPATH` and a RELATIVE `cwd` in the payload, `cd`
resolves into a decoy repo *and echoes the path*, prepending a bare line to
stdout ahead of the JSON:

```
STDOUT: [/private/tmp/.../cdpath/dec2/repo
{"hookSpecificOutput":{...
```

`[ -d "$CWD" ]` tested one directory and `cd` entered another. It is the same
one-of-N-sites shape as the rest of this slice, at a fourth site.

**Why it is recorded and not fixed.** Claude Code always sends an ABSOLUTE `cwd`,
and bash does not consult CDPATH for an absolute operand, so this cannot fire in
production — it does not ship broken. Per backlog item 6 the rule is *record it
unless it ships broken*, and this is the case that rule exists for: fixing it
would be a fourth executable change made in response to a P4, on a release that
has already converged. `CDPATH= cd --` is the one-line fix when the hook is next
opened; it is NOT dead code, because the failing case above is constructible.

### 10. Version BOTH halves, and let the implementation own compatibility

**The shape.** Stamp a version into `$IMPL` at install, and give the committed
shim a **protocol integer**. The shim announces its own with
`REVIEW_LOOP_SHIM_VERSION=<n>` before exec'ing; the implementation carries
`MIN_SHIM_PROTOCOL` and nudges through the existing once-per-session channel when
the repo's shim is behind.

**Why the IMPLEMENTATION owns the check, not the shim.** The two halves change by
completely different mechanisms, and that asymmetry decides everything:

| | changes how | who consents |
|---|---|---|
| `$IMPL` | machine-global refresh from ANY repo | nobody — it just moves |
| shim | a human runs setup AND commits | a person, per repo |

So the half that moves without consent must be the half that detects the
mismatch. A check living in the shim bakes a constant that goes stale in every
consuming repo and can only be corrected by N commits. **The shim stays dumb;
all compatibility logic lives where one fix reaches every repo.**

**Absence is the signal.** An old shim exports nothing, so an unset variable
reads as "older than the first versioned shim" — no bootstrap problem, and it
lands on the noisy side, which is the rule this project decides everything by.

**An INTEGER, not semver.** The protocol bumps only when the shim genuinely must
change — decoupled from the release version, so it moves rarely. `[ "$a" -lt
"$b" ]` has exactly one call site. A semver comparator in POSIX shell would be
the same shape as every defect rounds 9-13 found: a correct rule applied at one
site out of several.

**NEGOTIATION, NOT A GATE — the constraint that decides the whole design.** The
committed-shim pattern has a notorious failure mode: `git-secrets` in a
pre-commit hook, missing on a teammate's machine, blocks every commit. This tool
is already immune to that shape *by exit code* — measured, implementation absent:
`rc=0` on all three events, stderr empty, one Stop-only `additionalContext`
notice with no `decision` field. Nobody is ever blocked.

But the same disease has a different organ here: **stderr or a corrupted stdout
breaks the turn**, and that has been hit twice — `v0.2.1` (a non-executable
implementation leaking `Permission denied`) and [[9]] (a `cd` echoing a bare line
ahead of the JSON). A version check is a new opportunity to reintroduce exactly
that, so:

- a mismatch NEVER prevents the exec — run anyway, degraded
- the note goes through the EXISTING once-per-session Stop channel, never stderr,
  never a second stdout writer
- the implementation must work with the OLDEST shim it will ever meet; the
  protocol number gates only OPTIONAL inputs
- if a new implementation genuinely cannot function with an old shim, the
  protocol bump is the WRONG TOOL — that is rebuilding git-secrets by accident

**The collision to design for.** "Not installed" and "shim too old" are mutually
exclusive by construction (if the implementation is running, it is installed).
But "shim too old" and the ORDINARY NUDGE both come from the implementation, on
one Stop event, into a single `additionalContext` — against a `< 13` line cap
enforced by a test. Accreting a clause is how that message reached 25 lines once.
Decide up front whether the stale note suppresses the nudge, shares its budget,
or waits for a turn with nothing else to say.

**Related:** [[7]] and [[8]] fold into the port; this one does not — it is
useful in bash today and survives the port unchanged.

### 11. Do we need gstack's four install shapes?

gstack detects `global-git`, `local-git`, `vendored` and `vendored-global`, and
upgrades differently for each. review-loop supports one shape (a clone plus
`./setup`), and `chiefofstaff` already carries a **vendored** copy with a
provenance header and a body SHA — so the vendored case exists in practice
whether or not it is supported in design.

**Parked deliberately as overkill for now.** Recorded so the decision is made
once, when there is a second consumer, rather than discovered. The question to
answer then: does a vendored copy get the version stamp and the protocol check
like any other, or does vendoring mean opting out of both?

### 12. The line cap measures the wrong axis: it is lines x FREQUENCY

**The cap is a proxy, and the code already disagrees with it.** Measured today:

| notice | lines | fires |
|---|---|---|
| ordinary nudge | 6 | per turn |
| not-installed | **7** | **once per session** |

The LONGER message is already the RARER one, and the test only caps the nudge.
Nobody wrote that down, so `< 13` reads as a universal law when the actual
constraint is "do not wedge the session with text" — and a once-per-session
notice does not wedge anything. **Per-notice budgets keyed to firing rate**, not
one global line count. AGENTS.md should say why the cap exists, not just what it
is, or the next person deletes it for the wrong reason or defends it for one.

### 13. Split the plan message from the code message

`$PLANS_CHANGED` already exists and already decides the suppression gate
(`hooks/review-loop.sh:530`) — the hook KNOWS which trigger fired and throws it
away, emitting an "or" the reader has to resolve. Splitting them makes each
message shorter AND more actionable, and it directly serves [[12]].

**Do this in the SAME edit as gating `/plan-eng-review`** (the item already queued
as next in AGENTS.md — `/code-review` is a built-in and stays; the gstack skill is
what has shipped broken since v0.2.0). Both rewrite the same
string; doing them separately means writing it twice and reviewing it twice.

**Risk to carry:** two messages are two surfaces for a clause to accrete on. The
25-line incident happened once with ONE message. Whatever replaces the flat cap
has to survive being applied in two places — which is the same "one rule, N call
sites" shape that produced every defect in rounds 9-13.

### 14. Should the nudge be visible to the USER at all?

**The question.** The `< 13` cap exists to stop a wedge of text in the session.
If the text could reach the model WITHOUT rendering to the user, the constraint
dissolves and [[12]] and [[13]] get much cheaper. Whether Claude Code offers such
a channel is an empirical question about the hook output schema — **verify it,
do not recall it.**

**The argument AGAINST hiding it, which should be answered before anyone builds
it.** The visible text is what makes this tool auditable by the human. On
2026-08-23 the assistant twice claimed to have launched a review it had not
launched, and both times the user caught it — once with "you say you launched a
review, but I don't see a review". A model-only channel makes the loop's own
behaviour unobservable to the person it works for, in a tool whose defining
failure is silence that looks like health. The cure for a wedge of text is
fewer, shorter, better-targeted messages ([[12]], [[13]]) — not invisibility.

## Deferred

- **Fire on plan-mode approval.** `CLAUDE_PLAN_FILE` was probed and is unset, so
  the cheap env shortcut is unavailable; needs a real mechanism.
- **A deleted plan does not fire.** `-newer` cannot see a file that is gone.
  Accepted: deleting a plan is not work that needs review.
