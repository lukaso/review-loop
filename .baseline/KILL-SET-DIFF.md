# Kill-set diff: bash `setup` vs `lib/setup.mjs`

Recorded BEFORE the port (bash) and after (node), because *71/72 tests pass
unmodified* can be satisfied by a port that quietly hollows out assertions: once
`jq`/`install`/`mkdir`/`cd` are gone, several `not.toMatch(/^tool:/)` checks
become unfalsifiable. AGENTS.md: **a DOMINATED assertion is as dead as an
uncoverable guard.** Any test that stopped killing its mutant is a finding.

| mutant | bash kills | node kills (AS FOUND) | verdict |
|---|---|---|---|
| `impl-install-msg-bare` | 1 | 1 | same |
| `shim-install-msg-bare` | 1 | 1 | same |
| `mkdir-claude-msg-bare` | 1 | 1 | same |
| `loop-counter-off` | 2 | 1 | **REGRESSED — fixed** |
| `empty-readlink-guard` | 1 | 1 | same |
| `collision-never-fires` | 5 | 5 | same |
| `regular-or-absent-off` | 5 | 4 | **REGRESSED — fixed** |

## The one real regression, and what it cost

`regular-or-absent-off` killed **5** tests against bash and **4** against Node.
The missing one is *refuses when the impl destination is a directory*: against
bash, `install(1)` NESTED the file inside the directory and exited 0, so the
guard was the only thing that refused. Node's `copyFileSync`+`renameSync` throws
instead, so the run still failed — and the test passed **for a different
reason**, silently ceasing to pin the guard.

Fixed by asserting the guard's own message (`/is not a regular file/`) rather
than any failure. Kill set restored to 5.

## A second regression the diff surfaced

`loop-counter-off` did not fail the suite against Node — it **hung** it. A JS
signal handler is never scheduled during synchronous work, so a spinning Node
`setup` cannot be killed by SIGTERM at all (measured: `timeout 10` failed to end
it); bash processes traps between commands and dies. The test's `spawnSync`
timeout could therefore never fire, and a missing guard read as a slow suite.
Fixed with `killSignal: "SIGKILL"`, which cannot be handled — at BOTH sites that
spawn against a symlink-loop fixture. The first fix covered one of two, which is
the one-rule-N-call-sites shape all over again, this time in the tests.

**That interruptibility difference is a real property of the port, not just a
test artifact**: a user cannot Ctrl-C a spinning `setup`. The 64-hop counter is
now the only thing standing between a symlink loop and an unkillable process,
which makes it considerably more load-bearing than it was in bash.
