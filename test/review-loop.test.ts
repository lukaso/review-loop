/**
 * hooks/review-loop.sh — the code-review nudge.
 *
 * A Stop hook with ONE job: ask whether the uncommitted code has had a review that
 * came back clean, and ask again after anything changes. It is not responsible for
 * the quality of those reviews, and it knows nothing about tests passing. It NEVER
 * blocks: it emits hookSpecificOutput.additionalContext, or nothing.
 *
 *   payload{cwd,session_id} ──> dirty? ──> state changed? ──> ask
 *                                 │            │
 *                                 │            └── paths + mtimes, so an edit to an
 *                                 │                already-dirty file re-arms it
 *                                 └── git status --porcelain -uall -z
 *
 * Tests drive the REAL script against throwaway git repos, with the state dir
 * redirected by env. REVIEW_LOOP_HOOK lets a mutation harness point this suite at
 * a COPY: concurrent sessions share this checkout, and a harness killed mid-run
 * otherwise leaves its mutant in a file another session is executing.
 *
 * TEST DISCIPLINE: every "-> silent" assertion carries a positive companion in the
 * same test. Without one, a hook that never emits anything passes the silent half
 * of this suite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK = process.env.REVIEW_LOOP_HOOK
  ? path.resolve(process.env.REVIEW_LOOP_HOOK)
  : path.resolve(__dirname, "../hooks/review-loop.sh");
const BASE = 1_700_000_000; // fixed epoch: mtime comparisons must not race the clock

let tmp: string;
let repo: string;
let stateDir: string;
let plansDir: string;

const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: repo, encoding: "utf8" });

function makeRepo(): string {
  const r = fs.mkdtempSync(path.join(tmp, "repo-"));
  fs.mkdirSync(path.join(r, "packages/x/src"), { recursive: true });
  fs.writeFileSync(path.join(r, "packages/x/src/committed.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(r, "TODO.md"), "# todo\n");
  repo = r;
  git("init", "-q", ".");
  commitAll();
  return r;
}

/** Commit via plumbing: this repo's commit-gate hook denies `git commit` without
 *  a user approval phrase, which would fail the suite in any checkout. */
function commitAll() {
  git("add", "-A");
  const tree = git("write-tree").stdout.trim();
  // `git rev-parse HEAD` on a repo with no commits ECHOES "HEAD" to stdout while
  // failing, so trusting stdout alone yields the literal string "HEAD" as a parent
  // and `commit-tree -p HEAD` then fails silently, leaving the fixture uncommitted.
  const head = git("rev-parse", "--verify", "HEAD");
  const parent = head.status === 0 ? head.stdout.trim() : "";
  const made = parent
    ? git("commit-tree", tree, "-p", parent, "-m", "wip")
    : git("commit-tree", tree, "-m", "init");
  const commit = made.stdout.trim();
  expect(commit, `commit-tree failed: ${made.stderr}`).toMatch(/^[0-9a-f]{40}$/);
  const upd = git("update-ref", "HEAD", commit);
  expect(upd.status, `update-ref failed: ${upd.stderr}`).toBe(0);
  git("reset", "-q");
}

const setMtime = (abs: string, epoch: number) => fs.utimesSync(abs, epoch, epoch);

/** Write a file with a pinned mtime. Filesystem granularity is one second, so two
 *  edits in the same second would otherwise look identical to the state check. */
function edit(rel: string, body: string, epoch = BASE) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  setMtime(abs, epoch);
}

/** Write a plan OUTSIDE the repo, with a pinned mtime. The trigger compares plan
 *  mtimes against the state file's mtime, so both ends must be pinned or the test
 *  races the clock. */
function plan(name: string, body: string, epoch = BASE) {
  const abs = path.join(plansDir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  setMtime(abs, epoch);
  return abs;
}

/** Pin the BASELINE file's mtime. It is a separate file from the state key, on
 *  purpose: coupling them deadlocked plan detection entirely on GNU find. This is
 *  how a test says "this plan is older/newer than the last look" without
 *  sleeping. */
function stampState(session: string, epoch: number) {
  const f = path.join(stateDir, `review-loop-baseline-${session}`);
  // Assert, don't assume: if the preceding fire() was silent there is no state
  // file, and a bare utimesSync would throw ENOENT — a confusing failure that
  // hides WHICH expectation broke. Tolerating a missing file instead would be
  // worse: the baseline would silently stay at "now" and every following
  // assertion would pass for the wrong reason.
  expect(fs.existsSync(f), "no baseline file — the hook creates one every turn").toBe(true);
  setMtime(f, epoch);
}

function fire(
  opts: {
    cwd?: string; session?: string; stopActive?: boolean;
    plansDir?: string; env?: Record<string, string>; transcript?: string;
  } = {},
): string | null {
  const res = spawnSync("bash", [HOOK], {
    input: JSON.stringify({
      session_id: opts.session ?? "sess-1",
      cwd: opts.cwd ?? repo,
      hook_event_name: "Stop",
      stop_hook_active: opts.stopActive ?? false,
      ...(opts.transcript ? { transcript_path: opts.transcript } : {}),
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      REVIEW_LOOP_STATE_DIR: stateDir,
      REVIEW_LOOP_PLANS_DIR: opts.plansDir ?? plansDir,
      ...(opts.env ?? {}),
    },
  });
  expect(res.status, `hook must always exit 0; stderr: ${res.stderr}`).toBe(0);
  // A hook that writes to stderr on a normal turn is a broken hook. This lived
  // only in the four raw-spawn tests, which left two `set -u` guards uncovered:
  // both survived mutation while 50/50 stayed green.
  expect(res.stderr, `hook must stay silent on stderr; got: ${res.stderr}`).toBe("");
  const out = res.stdout.trim();
  if (out === "") return null;
  const j = JSON.parse(out);
  // The safety property: a nudge is never a block, under any input.
  expect(j.decision, "nudge must never block").toBeUndefined();
  expect(j.hookSpecificOutput?.hookEventName).toBe("Stop");
  return j.hookSpecificOutput.additionalContext as string;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-nudge-test-"));
  stateDir = fs.mkdtempSync(path.join(tmp, "state-"));
  // Every spawn site gets this. Without it the suite reads the developer's REAL
  // ~/.claude/plans, so a plan written by any concurrent session would arm tests
  // at random. Test "honours the PLANS_DIR knob" is what proves it is wired.
  plansDir = fs.mkdtempSync(path.join(tmp, "plans-"));
  makeRepo();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  // Three tests deliberately force the state dir OUTSIDE `tmp` — into /tmp, via
  // the in-repo containment fallback — so the per-test rmSync above cannot reach
  // what they leave behind. They leaked one file per run, on PASSING runs, and
  // their own cleanups sat after the expects with no try/finally so a failing run
  // leaked too: 381 files had accumulated by the time this was noticed. Sweeping
  // centrally covers the failure path as well, which is the half that was missing.
  for (const f of fs.readdirSync("/tmp")) {
    if (/^review-loop-(baseline-|turn-)?[a-z]+-?\d*$/.test(f) && f.endsWith(String(process.pid))) {
      fs.rmSync(path.join("/tmp", f), { force: true });
    }
  }
});

describe("asking", () => {
  it("asks when there is uncommitted code", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const msg = fire();
    expect(msg).toContain("/code-review");
  });

  it("is silent on a clean tree — and asks as soon as there is code", () => {
    expect(fire(), "clean tree").toBeNull();
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire(), "now dirty").not.toBeNull();
  });

  it("asks only once per state", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire()).not.toBeNull();
    expect(fire(), "nothing changed").toBeNull();
    expect(fire(), "still nothing changed").toBeNull();
  });

  it("asks AGAIN after a fix — this is the loop", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    // A fix to an ALREADY-dirty file: the status line is byte-identical, so only
    // the mtime distinguishes it. Without mtimes the loop asks once and never again.
    edit("packages/x/src/committed.ts", "export const a = 3;\n", BASE + 60);
    expect(fire(), "after resolving a finding").not.toBeNull();
  });

  it("goes quiet once the code is committed", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire()).not.toBeNull();
    commitAll();
    expect(fire(), "committing is what ends the loop").toBeNull();
  });

  it("ignores dirt a project excluded — but not code beside it", () => {
    // The default watches the WHOLE tree; a released tool cannot ship one repo's
    // exclude list. This exercises the knob a project actually configures.
    const paths = ". :(exclude)prototypes/ :(exclude)notes.md";
    edit("notes.md", "# changed\n");
    edit("prototypes/x.html", "<p>hi</p>");
    expect(fire({ env: { REVIEW_LOOP_PATHS: paths } }), "excluded paths only").toBeNull();
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire({ env: { REVIEW_LOOP_PATHS: paths } }), "a watched file joins them").not.toBeNull();
  });

  it("watches everything by default — including the paths a project might exclude", () => {
    // The companion to the knob test: without configuration, nothing is ignored.
    // A default that silently skipped files would hide unreviewed work.
    edit("notes.md", "# changed\n");
    expect(fire(), "no excludes configured, so this counts").not.toBeNull();
  });

  it("watches packages/ai/src/prompts/*.md — PromptLoader reads them at runtime", () => {
    // An earlier revision excluded `*.md` wholesale and hid all of them. A git
    // exclude beats a later positive pathspec, so it could not be walked back.
    edit("packages/ai/src/prompts/email-analysis.md", "# prompt\n");
    expect(fire()).not.toBeNull();
  });
});

describe("enumeration — each case is a REGRESSION against a measured bug", () => {
  it("sees a whole new untracked module, contents included (requires -uall)", () => {
    // Without -uall this collapses to `?? packages/new/`, so a nudge still fires —
    // asserting only "it nudges" proves nothing. What is lost is the files
    // themselves: the collapsed entry never changes, so the loop cannot re-arm.
    edit("packages/new/src/deep/b.ts", "export const b = 1;\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    edit("packages/new/src/deep/b.ts", "export const b = 2;\n", BASE + 60);
    expect(fire(), "an edit inside the new module must re-arm").not.toBeNull();
  });

  it("sees a deleted tracked file", () => {
    fs.rmSync(path.join(repo, "packages/x/src/committed.ts"));
    expect(fire(), "a deleted tracked file must be seen").not.toBeNull();
  });

  it("survives a whole-directory deletion", () => {
    edit("packages/old/src/a.ts", "export const a = 1;\n");
    edit("packages/old/src/b.ts", "export const b = 1;\n");
    commitAll();
    fs.rmSync(path.join(repo, "packages/old"), { recursive: true, force: true });
    expect(fire(), "a whole-directory deletion must still be seen").not.toBeNull();
  });

  it("consumes the old path of a WORK-TREE rename, not just an index one", () => {
    // An index rename is "R "; a work-tree rename is " R" (also " C", "DR", "DC").
    // Matching only R*|C* leaves the old path unconsumed, so it is parsed as a
    // status line: its first two chars become XY and the rest a phantom path. When
    // the old path starts with R or C — README.md, CHANGELOG.md, CONTRIBUTING.md
    // all sit in a repo root — that phantom XY itself matches the rename pattern
    // and SWALLOWS THE NEXT REAL ENTRY, dropping that file from the state key for
    // the whole session while the hook keeps exiting 0.
    //
    // A previous round deleted this test on the stated grounds that the
    // consumption was unobservable from outside. That was asserted, not measured,
    // and it was wrong.
    edit("README.md", "readme\n", BASE);
    commitAll();
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.renameSync(path.join(repo, "README.md"), path.join(repo, "docs/README.md"));
    git("add", "-N", "docs/README.md");
    // The entry that must survive being swallowed.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    edit("packages/x/src/committed.ts", "export const a = 33333;\n", BASE + 60);
    expect(fire(), "the entry after a rename must not be swallowed").not.toBeNull();
  });

  it("does not let a rename's old path leak an EXCLUDED file into the state", () => {
    // The other half of the same bug, and it survives the fix above. With no
    // consumption at all the old path is still parsed as a status line, and its
    // phantom path is the old path minus three characters — which can name a REAL
    // file. Rename "xy/TODO.md" and the phantom is "TODO.md", a file this hook
    // deliberately excludes. Its mtime then drives the state key, so editing an
    // excluded file re-arms the nudge.
        // TODO.md is excluded HERE, explicitly: the default now watches everything, so
    // this test must configure the exclusion whose leak it is guarding against.
    const paths = ". :(exclude)TODO.md";
    fs.mkdirSync(path.join(repo, "xy"), { recursive: true });
    edit("xy/TODO.md", "old\n", BASE);
    commitAll();
    fs.renameSync(path.join(repo, "xy/TODO.md"), path.join(repo, "packages/x/src/renamed.md"));
    git("add", "-N", "packages/x/src/renamed.md");
    expect(fire({ env: { REVIEW_LOOP_PATHS: paths } }), "first ask").not.toBeNull();
    // Touch ONLY the excluded file. Nothing watched has changed.
    edit("TODO.md", "# changed, and much longer than before\n", BASE + 60);
    expect(
      fire({ env: { REVIEW_LOOP_PATHS: paths } }),
      "an excluded file must not re-arm the nudge",
    ).toBeNull();
  });

  it("consumes the old path of an INDEX rename too (git mv, the common shape)", () => {
    // Both other rename tests stage with `git add -N`, which produces only
    // work-tree renames (" R"). That leaves the [RC]? half of the pattern
    // untested: narrowing it to ?[RC] — a plausible "simplification" — passed the
    // whole suite while reintroducing the bug for STAGED renames, which `git mv`
    // produces and which are the common shape here.
        // TODO.md is excluded HERE, explicitly: the default now watches everything, so
    // this test must configure the exclusion whose leak it is guarding against.
    const paths = ". :(exclude)TODO.md";
    fs.mkdirSync(path.join(repo, "xy"), { recursive: true });
    edit("xy/TODO.md", "old\n", BASE);
    commitAll();
    git("mv", "xy/TODO.md", "packages/x/src/renamed.md"); // index rename: "R "
    expect(fire({ env: { REVIEW_LOOP_PATHS: paths } }), "first ask").not.toBeNull();
    // Phantom path would be the old path minus three chars = "TODO.md", excluded.
    edit("TODO.md", "# changed, and rather longer than it was\n", BASE + 60);
    expect(
      fire({ env: { REVIEW_LOOP_PATHS: paths } }),
      "an excluded file must not re-arm the nudge",
    ).toBeNull();
  });

  it("re-arms when a broken symlink is re-pointed", () => {
    // `-e` dereferences, so a broken symlink is false under it and contributes no
    // mtime/size; its status line does not change when re-pointed, so the loop
    // goes silent. `stat` does not dereference on either flavour, so only the
    // gate loses it.
    fs.symlinkSync("/does/not/exist", path.join(repo, "packages/x/src/link.ts"));
    fs.lutimesSync(path.join(repo, "packages/x/src/link.ts"), BASE, BASE);
    expect(fire(), "first ask").not.toBeNull();
    fs.unlinkSync(path.join(repo, "packages/x/src/link.ts"));
    fs.symlinkSync("/also/does/not/exist/at/all", path.join(repo, "packages/x/src/link.ts"));
    fs.lutimesSync(path.join(repo, "packages/x/src/link.ts"), BASE + 60, BASE + 60);
    expect(fire(), "re-pointing a broken symlink must re-arm").not.toBeNull();
  });

  it("survives a repo-root path beginning with a dash", () => {
    // Such a path reaches `stat` as a bare argument and is read as an option; the
    // whole batch then yields nothing, MTIMES is empty, and the re-arm loop is
    // SILENTLY dead for the rest of the session — the exact failure the mtime
    // machinery exists to prevent. GNU getopt permutes, so position does not save
    // you. `--` terminates stat's options.
    edit("-weird.ts", "one\n", BASE);
    edit("packages/x/src/ok.ts", "one\n", BASE);
    commitAll();
    // Git skips content comparison when a file's mtime AND size both match the
    // index — the same collision this hook's own state key documents. Writing
    // same-length content at a pinned mtime made git report the tree CLEAN, so an
    // earlier version of this test failed for a reason that had nothing to do with
    // dashes. Change the length, and move the mtime.
    edit("-weird.ts", "changed content\n", BASE + 30);
    edit("packages/x/src/ok.ts", "changed content\n", BASE + 30);
    expect(fire(), "first ask").not.toBeNull();
    edit("packages/x/src/ok.ts", "changed again, longer\n", BASE + 60);
    expect(fire(), "a dash-leading path must not kill the batch").not.toBeNull();
  });

  it("handles filenames with spaces and non-ASCII (requires -z)", () => {
    // Without -z these arrive quoted and octal-escaped, and a strip-the-prefix
    // parse hands stat a literal quote.
    edit("packages/x/src/te st.ts", "one\n", BASE);
    edit("packages/x/src/tëst.ts", "one\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    edit("packages/x/src/te st.ts", "two\n", BASE + 60);
    expect(fire(), "a spaced filename must be in the state").not.toBeNull();
  });
});

describe("state key", () => {
  it("re-arms on a same-second content change", () => {
    // mtime has one-second resolution and the status line is byte-identical for
    // " M" -> " M", so mtime alone made a same-second edit invisible — realistic in
    // fast autonomous loops where the next edit lands in the sampled second.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    edit("packages/x/src/committed.ts", "export const a = 333333;\n", BASE); // same second
    expect(fire(), "same-second edit must still re-arm").not.toBeNull();
  });

  it("re-arms when one dirty path is swapped for another at the same mtime", () => {
    // Exercises the PATH half of the key. Hashing mtimes alone passes every other
    // test, and would then treat "delete A, create B with A's mtime" as unchanged.
    edit("packages/x/src/alpha.ts", "export const a = 1;\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    fs.rmSync(path.join(repo, "packages/x/src/alpha.ts"));
    edit("packages/x/src/beta.ts", "export const a = 1;\n", BASE); // same mtime, same size
    expect(fire(), "a different path is a different state").not.toBeNull();
  });

  it("does NOT re-arm merely because the change was staged", () => {
    // `git add` flips XY from " M" to "M ". Keying on it re-opened a question that
    // had just been answered YES, on code that had not changed.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    expect(fire(), "first ask").not.toBeNull();
    git("add", "-A");
    expect(fire(), "staging is not a code change").toBeNull();
  });

  it("does not record state when the message was never emitted", () => {
    // The ordering this pins: state is written AFTER jq succeeds. An earlier
    // version of this test used a NONEXISTENT state dir, so the write failed in
    // both orderings and it passed against the exact bug it existed to guard —
    // verified by moving the write back before the emission: 32/32 still green.
    // A writable dir plus a failing jq is what actually discriminates.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    const shim = fs.mkdtempSync(path.join(tmp, "badjq-"));
    // MUST match the hook's own dependency list. Omitting one (it was `cat`) makes
    // the hook bail at the payload read, so every assertion about a later stage
    // passes vacuously — which is how the previous version of this test passed
    // against the very bug it guards.
    for (const b of ["bash", "cat", "git", "xargs", "cksum", "cut", "tr", "stat", "find", "ln", "rm"]) {
      const real = spawnSync("command", ["-v", b], { shell: true, encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(shim, b));
    }
    // jq answers the payload reads, then fails on the final emission.
    const realJq = spawnSync("command", ["-v", "jq"], { shell: true, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(
      path.join(shim, "jq"),
      `#!/bin/sh\ncase "$*" in *hookSpecificOutput*) exit 1 ;; esac\nexec ${realJq} "$@"\n`,
    );
    fs.chmodSync(path.join(shim, "jq"), 0o755);
    const res = spawnSync(path.join(shim, "bash"), [HOOK], {
      input: JSON.stringify({ session_id: "nojq", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status, "must never break a turn").toBe(0);
    expect(res.stdout.trim(), "nothing was emitted").toBe("");
    expect(
      fs.readdirSync(stateDir).filter((f) => !f.startsWith("review-loop-baseline-")),
      "state must not be recorded for an ask that was never made",
    ).toHaveLength(0);

    // POSITIVE COMPANION, under the SAME shim PATH. Without it, any early exit —
    // a missing binary, a bad payload — satisfies the two assertions above and the
    // test proves nothing. This proves the shim itself is sound.
    fs.unlinkSync(path.join(shim, "jq"));
    fs.symlinkSync(realJq, path.join(shim, "jq"));
    const ok = spawnSync(path.join(shim, "bash"), [HOOK], {
      input: JSON.stringify({ session_id: "nojq", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(ok.stdout.trim(), "with a working jq the same shim DOES ask").not.toBe("");
    expect(
      fs.readdirSync(stateDir).filter((f) => !f.startsWith("review-loop-baseline-")),
      "and records state",
    ).toHaveLength(1);
  });

  it("exits quietly when a binary used in an UNSILENCED pipeline is missing", () => {
    // The preflight list earns its place for exactly three binaries — cksum, cut
    // and tr — which sit in pipelines with no 2>/dev/null (the session-id
    // sanitiser and the state key). Without the preflight, a missing one prints
    // "command not found" to stderr and breaks the turn instead of standing down.
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const shim = fs.mkdtempSync(path.join(tmp, "nocut-"));
    for (const b of ["bash", "cat", "jq", "git", "xargs", "cksum", "tr", "stat", "find", "ln", "rm"]) {
      const real = spawnSync("command", ["-v", b], { shell: true, encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(shim, b));
    }
    const res = spawnSync(path.join(shim, "bash"), [HOOK], {
      input: JSON.stringify({ session_id: "nocut", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status, "a missing binary must not break the turn").toBe(0);
    expect(res.stderr, `leaked: ${res.stderr}`).toBe("");
    expect(res.stdout.trim(), "and it says nothing").toBe("");

    // POSITIVE COMPANION under the same shim: restore cut and it asks again, which
    // proves the shim is otherwise sound and the silence above was the preflight.
    const realCut = spawnSync("command", ["-v", "cut"], { shell: true, encoding: "utf8" }).stdout.trim();
    fs.symlinkSync(realCut, path.join(shim, "cut"));
    const ok = spawnSync(path.join(shim, "bash"), [HOOK], {
      input: JSON.stringify({ session_id: "nocut2", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(ok.stdout.trim(), "with cut present the same shim DOES ask").not.toBe("");
  });

  it("does not leak stderr when the state file cannot be written", () => {
    // `> "$FILE" 2>/dev/null` opens the file BEFORE applying the redirect, so an
    // unopenable path still printed to the real stderr. Two other tests assert
    // stderr is empty; this path escaped that discipline.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "leak", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: "/nonexistent-state-dir", REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim(), "still asks").not.toBe("");
    expect(res.stderr, `leaked: ${res.stderr}`).toBe("");
  });

});

describe("nested repositories", () => {
  it("re-arms when a nested repo gains a file", () => {
    // git status does not recurse into a nested repo — it emits one `?? sub/`
    // entry. With `[ -f ]` that contributed no mtime, so the key was constant and
    // nothing inside ever re-armed. Reachable via `git worktree add` and in any
    // repo with submodules.
    const sub = path.join(repo, "packages/x/src/sub");
    fs.mkdirSync(sub, { recursive: true });
    spawnSync("git", ["init", "-q", "."], { cwd: sub });
    fs.writeFileSync(path.join(sub, "s.ts"), "export const s = 1;\n");
    setMtime(sub, BASE);
    expect(fire(), "first ask").not.toBeNull();
    fs.writeFileSync(path.join(sub, "s2.ts"), "export const s2 = 2;\n");
    setMtime(sub, BASE + 60); // adding an entry moves the directory's mtime
    expect(fire(), "a new file inside the nested repo must re-arm").not.toBeNull();
  });
});

describe("message", () => {
  it("says what to run, and when another round is due", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    // Flatten first: the message is hard-wrapped, so asserting on phrases that
    // straddle a line break tests the wrap position rather than the meaning.
    const msg = fire()!.replace(/\s+/g, " ");
    // Code OR a plan. The hook only sees dirty paths and plan mtimes, so it cannot
    // tell which — it offers both rather than guessing. It used to say "Just
    // written code or a plan?", which additionally asserted that YOU wrote it; in
    // a shared checkout that is false, so the claim is gone and the choice stays.
    expect(msg).toContain("/code-review on the diff");
    // THE PLAN LINE IS ABSENT HERE. This fixture seeds only a code edit, so
    // PLANS_CHANGED is empty. It used to assert "/plan-eng-review on the plan" on
    // this same message — an "or" the reader had to resolve, on a turn where the
    // hook already knew the answer.
    expect(msg, "no plan changed, so no plan line").not.toContain("A plan has changed");
    // /plan-eng-review is a gstack skill, not a Claude Code built-in — measured
    // 2026-08-24. Naming it told most readers to run a command they do not have.
    expect(msg, "must not name a command most readers lack").not.toContain("/plan-eng-review");
    // A fix is code nobody has reviewed, so fixes — not findings — are what make
    // another round due. Every round of this change's own review found a bug
    // introduced while fixing the previous round.
    expect(msg, "fixes are what require another round")
      .toContain("If there are fixes, review again");
    // Severity is guidance, not a rule: LOW is skippable, MEDIUM is a cost call.
    expect(msg).toContain("LOW priority");
    expect(msg).toContain("MEDIUM priority if the fix costs more than the problem");
    // Without this, a turn with a review still running matches "just written code?"
    // and the instruction becomes "start a second review" — this repo's learnings
    // record concurrent reviewers editing the same files and overwriting each other.
    expect(msg, "must not invite a concurrent round").toContain("Wait for inflight actions");
  });

  it("stays short enough to be read", () => {
    // The message accreted a clause per review round until it was 25 lines, which
    // is how a nudge becomes wallpaper. It is the entire product surface; length
    // is a feature of it, not a detail.
    // BOTH PARTS ARMED — the worst case. Both cap tests used a code-only fixture,
    // which after the split measures the shape that got SHORTER while the longest
    // one goes uncapped: a correct rule applied at the wrong site.
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    seedBaseline(BASE);
    plan("p.md", "v2", BASE + 100);
    const msg = fire()!;
    // MEASURED: code-only 9, plan-only 10, both 12. A bound of 20 would let it
    // nearly double before firing, which is no guard against the accretion it
    // exists to catch — it reached 25 lines once already.
    // 12 against 13 is ZERO SPARE, and that is the point: the next accreted clause
    // fails immediately. Do not raise the bound to buy room.
    expect(msg.split("\n").length, "message should stay compact").toBeLessThan(13);
  });

  it("tells the fixer HOW at the moment it applies: failing test first, seen red", () => {
    // PLAN-review-fix-discipline (liveapp, 2026-08-29): a counted session's defects all came
    // from fixes whose tests were written AFTER the code — born green, never once seen red —
    // and the Stop moment is exactly the fix-a-finding moment. So the one rule that kills the
    // class rides the existing "Just completed a review?" part, within the cap above; the rest
    // of the workflow stays in AGENTS.md (a pointer arrives on time, rules do not accrete here).
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const msg = fire()!;
    expect(msg).toContain("failing");
    expect(msg, "red before green is the load-bearing half").toContain("watch it fail");
  });

});

describe("scale", () => {
  it("forks a constant number of times, not once per file", () => {
    // A wall-clock bound is the obvious test and the wrong one: it flakes under
    // concurrent load and a bound loose enough to be safe stops discriminating.
    // Counting execs is deterministic. Linear forking hits the hook's 10s timeout
    // on a large diff and dies SILENTLY — no nudge, on the biggest changes.
    const shim = fs.mkdtempSync(path.join(tmp, "counters-"));
    const counts = path.join(shim, "counts");
    for (const bin of ["stat", "git", "cksum"]) {
      const real = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" }).stdout.trim();
      if (!real) continue;
      fs.writeFileSync(path.join(shim, bin), `#!/bin/sh\necho ${bin} >> ${counts}\nexec ${real} "$@"\n`);
      fs.chmodSync(path.join(shim, bin), 0o755);
    }
    for (let i = 0; i < 300; i++) edit(`packages/big/src/f${i}.ts`, `export const v${i} = ${i};\n`);
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "fork", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim(), "must still ask at scale").not.toBe("");
    const lines = fs.existsSync(counts)
      ? fs.readFileSync(counts, "utf8").trim().split("\n").filter(Boolean) : [];
    // Measured 7 for the three shimmed binaries at 300 files (3 git, 3 stat,
    // 1 cksum) — an earlier comment said ~3, which was wrong. A bound of 20 would
    // let per-directory forking
    // through; this is tight enough to catch a regression and loose enough not to
    // flake on an extra probe.
    // 7 today; 12 leaves room for a constant-time probe without licensing a
    // per-file regression, which at 300 files would blow past this by 40x.
    expect(lines.length, `${lines.length} forks for 300 files`).toBeLessThan(12);
  });

  it("detects one changed file among many (batching must not lose a file)", () => {
    for (let i = 0; i < 50; i++) edit(`packages/big/src/f${i}.ts`, `export const v${i} = ${i};\n`, BASE);
    expect(fire(), "first ask").not.toBeNull();
    edit("packages/big/src/f37.ts", "export const v37 = 999;\n", BASE + 60);
    expect(fire(), "one file among 50 must re-arm").not.toBeNull();
  });
});

describe("the file itself", () => {
  it("is syntactically valid bash", () => {
    // Two production breakages came from patches that left the file unparseable:
    // a shebang pushed to line 24, and an apostrophe inside the single-quoted jq
    // program. Both were invisible to behavioural tests, which assert on OUTPUT —
    // and a hook that cannot parse produces none, which the silent tests accept.
    const res = spawnSync("bash", ["-n", HOOK], { encoding: "utf8" });
    expect(res.stderr, `bash -n: ${res.stderr}`).toBe("");
    expect(res.status).toBe(0);
  });

  it("starts with a bash shebang", () => {
    expect(fs.readFileSync(HOOK, "utf8").split("\n")[0]).toBe("#!/usr/bin/env bash");
  });

  it("runs correctly when EXECUTED directly, not just passed to bash", () => {
    // The distinction that hid the shebang bug: `bash [HOOK]` ignores the shebang,
    // the harness execs the file. Without one the kernel falls back to /bin/sh,
    // which has no process substitution, and `done < <(git status …)` is a syntax
    // error in production only.
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = spawnSync(HOOK, [], {
      input: JSON.stringify({ session_id: "direct", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.error, `spawn failed: ${res.error?.message}`).toBeUndefined();
    expect(res.stderr, "no interpreter errors").toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).not.toBe("");
  });
});

describe("robustness — a nudge must never break a turn", () => {
  const raw = (input: string) =>
    spawnSync("bash", [HOOK], {
      input, encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });

  it("exits silently when cwd is absent, rather than judging the wrong repo", () => {
    // `cd ""` SUCCEEDS (it is a no-op), so without the [ -n "$CWD" ] guard the
    // hook would evaluate whatever repo the hook PROCESS happens to sit in — a
    // different project's diff, reported as yours.
    const other = fs.mkdtempSync(path.join(tmp, "otherrepo-"));
    spawnSync("git", ["init", "-q", "."], { cwd: other });
    fs.writeFileSync(path.join(other, "leak.ts"), "export const secret = 1;\n");
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "nocwd", hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      cwd: other,
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim(), "no cwd means no opinion").toBe("");

    // Companion: the same dirty repo DOES ask when it is named properly.
    const ok = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "yescwd", cwd: other, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(ok.stdout.trim(), "named explicitly, it asks").not.toBe("");
  });

  it("exits silently on a malformed payload", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = raw("not json at all");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(fire(), "a well-formed payload still asks").not.toBeNull();
  });

  it("exits silently on an empty payload", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = raw("");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(fire(), "a well-formed payload still asks").not.toBeNull();
  });

  it("exits silently when cwd is not a git repo", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const notRepo = fs.mkdtempSync(path.join(tmp, "plain-"));
    expect(fire({ cwd: notRepo }), "non-git cwd").toBeNull();
    expect(fire(), "real repo still asks").not.toBeNull();
  });

  it("defers while another hook is holding the turn open", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire({ stopActive: true }), "stop_hook_active").toBeNull();
    expect(fire({ stopActive: false }), "survives for the clean stop").not.toBeNull();
  });

  it("exits silently rather than sharing state when session_id is missing", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = raw(JSON.stringify({ cwd: repo, hook_event_name: "Stop" }));
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    expect(fire(), "a payload WITH a session id still asks").not.toBeNull();
  });

  it("works when the session cwd is a subdirectory", () => {
    // Git pathspecs resolve against the CURRENT directory; AGENTS.md tells you to
    // `cd packages/ai` for prompt work, and from there an unnormalised pathspec
    // matches nothing and the hook is inert for the whole session.
    // The dirty file must live OUTSIDE the session's cwd. With the file inside it,
    // pathspec "." matches from either directory and the test cannot discriminate.
    edit("packages/y/src/elsewhere.ts", "export const b = 2;\n");
    expect(
      fire({ cwd: path.join(repo, "packages/x/src") }),
      "code outside the cwd must still be seen",
    ).not.toBeNull();
  });
});

describe("isolation", () => {
  it("keeps state separate per session", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire({ session: "sess-A" }), "A asks").not.toBeNull();
    expect(fire({ session: "sess-A" }), "A does not repeat").toBeNull();
    expect(fire({ session: "sess-B" }), "B asks independently").not.toBeNull();
  });

  it("sanitises a hostile session id into a flat, writable filename", () => {
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire({ session: "../../etc/passwd" }), "first ask").not.toBeNull();
    const entries = fs.readdirSync(stateDir);
    // Two flat files now: the git key and the plan baseline. What matters is that
    // NEITHER escaped the directory — the traversal is what this test guards.
    expect(entries, "flat files only, no traversal").toHaveLength(2);
    expect(entries[0]).not.toContain("/");
    // The real harm of an unsanitised id is not traversal — the write fails into
    // the redirect's own `2>/dev/null` — it is that state never persists, so it
    // asks every turn, forever.
    expect(fire({ session: "../../etc/passwd" }), "must not re-ask").toBeNull();
  });
});

/** Put a state file on disk carrying the hook's OWN git key, then pin its mtime.
 *  A test cannot hand-write that file: its CONTENTS must be the real cksum or the
 *  git guard fires on every call and masks whatever the test is really asking.
 *  So make the hook write it — hand it a plan touched after session start, which
 *  it must ask about — then remove the bait and pin the baseline. */
function seedBaseline(epoch: number, session = "sess-1") {
  const tr = path.join(tmp, `t-${session}.jsonl`);
  fs.writeFileSync(tr, "{}\n"); // born now = session start
  const bait = plan(`__seed-${session}.md`, "x");
  setMtime(bait, Math.floor(Date.now() / 1000) + 5);
  expect(fire({ session, transcript: tr }), "seed must ask, or there is no baseline").not.toBeNull();
  fs.unlinkSync(bait); // a deletion never fires, so this cannot arm the next call
  stampState(session, epoch);
}

describe("plans — the phase git cannot see", () => {
  // A plan lives OUTSIDE the repo (~/.claude/plans), so a planning turn produces no
  // diff at all. The hook watched only `git status`, which made the one phase where
  // a plan review is mandatory the one phase it was blind to. Measured: zero fires
  // across 8.5 hours containing a design review, two scope changes and a full plan
  // rewrite.
  //
  //   STATE_FILE    contents = the git cksum key. Written only on an ask.
  //   BASELINE_FILE mtime    = the plan cut-off. Advanced EVERY turn.

  it("asks when a plan changed, on a repo with nothing to commit", () => {
    seedBaseline(BASE);
    plan("p.md", "v1", BASE - 100);
    expect(fire(), "nothing newer than the baseline").toBeNull();

    // A quiet turn ADVANCES the baseline to now — "last time I looked" is now.
    // Correct in production; in a test with pinned epochs it must be re-pinned.
    stampState("sess-1", BASE);
    plan("p.md", "v2", BASE + 100);
    const askMsg = fire();
    expect(askMsg, "a changed plan must ask").toContain("A plan has changed");
    // SOLE KILLER for the `TOTAL > 0` conjunct. The tree is CLEAN here, so the code
    // line must be absent — without that conjunct the message would say "Code has
    // changed since the last review" about a tree with nothing in it.
    expect(askMsg, "clean tree: no code line").not.toContain("/code-review");
  });

  it("does not claim code changed on the turn after a commit", () => {
    // THE SOLE KILLER for the `TOTAL > 0` conjunct, and the clean-tree fixture above
    // is NOT it: there STATE already equals STORED, so the conjunct is redundant and
    // dropping it changes nothing. The distinguishing case needs TOTAL=0 while
    // STATE != STORED — which is exactly the turn after a commit: the stored key is
    // the old DIRTY one, the live key is cksum(""). Without `TOTAL > 0` the message
    // would announce "Code has changed since the last review" about a tree with
    // nothing in it.
    seedBaseline(BASE);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire(), "dirty tree asks, and stores the dirty key").toContain("Code has changed");
    commitAll();

    // A plan change is what carries us past the guards to the emit at all — with a
    // clean tree and no plan change the hook exits before saying anything, which is
    // why the naive "commit then fire" version of this test passes against every
    // mutation while asserting nothing.
    stampState("sess-1", BASE);
    plan("p.md", "v2", BASE + 100);
    const after = fire();
    expect(after, "the plan still asks").toContain("A plan has changed");
    expect(after, "but the tree is clean — do not announce code").not.toContain("Code has changed");
  });

  it("does not re-assert the code line when only a plan moved", () => {
    // SOLE KILLER for the `STATE != STORED` conjunct, and the fixture the suite did
    // not have. $TOTAL is a LEVEL — non-zero while the tree is dirty for ANY reason,
    // including code this session already asked about. So gating the code line on
    // $TOTAL alone would re-assert "Code has changed since the last review" on every
    // subsequent plan turn, about a diff that was reviewed and has not moved.
    // Today's vague "or" was honest ambiguity; the split would have made it a lie.
    // ORDER MATTERS: seedBaseline() fires the hook itself, to make it write a real
    // cksum rather than a hand-written one. Dirtying the tree BEFORE it means that
    // ask is already consumed and turn 1 below is silent — the test then passes for
    // the wrong reason, or fails confusingly. Dirty it AFTER.
    seedBaseline(BASE);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire(), "turn 1: dirty tree must ask").toContain("Code has changed");

    // Turn 2: the plan moves, the tree does NOT.
    stampState("sess-1", BASE);
    plan("p.md", "v2", BASE + 100);
    const msg = fire();
    expect(msg, "a changed plan must still ask").toContain("A plan has changed");
    expect(msg, "the code has not moved since the last ask — do not re-assert it")
      .not.toContain("Code has changed");
  });

  it("says BOTH when code and a plan both moved", () => {
    // The worst case, and the one the cap now measures. Each part carries its own
    // claim, so both are true simultaneously and neither has to be hedged.
    seedBaseline(BASE);
    edit("packages/x/src/committed.ts", "export const a = 3;\n");
    plan("p.md", "v2", BASE + 100);
    const msg = fire();
    expect(msg, "code moved").toContain("Code has changed since the last review");
    expect(msg, "and so did a plan").toContain("A plan has changed");
  });

  it("re-arms on a SECOND plan change — the git-only key guard", () => {
    // THE test for this feature. `STATE` is cksum(paths + mtimes) over the GIT set
    // only, so on a clean tree it is cksum("") — a constant. The key guard
    // compares it and exits, so unless BOTH the dirty-set guard and the key guard consult the plan set, the
    // trigger fires exactly once per session, ever. The single-change test above
    // passes against that bug; only a second change catches it.
    seedBaseline(BASE);

    plan("p.md", "v2", BASE + 100);
    expect(fire(), "first plan change").not.toBeNull();
    stampState("sess-1", BASE + 100);

    plan("p.md", "v3", BASE + 200);
    expect(fire(), "second plan change must ask too").not.toBeNull();
  });

  it("does not fire for a DELETED plan — and still fires for a live one", () => {
    // `-newer` cannot see a file that is gone. Accepted: deleting a plan is not
    // work that needs review. The companion is what stops a dead hook passing.
    seedBaseline(BASE);
    const doomed = plan("gone.md", "x", BASE - 100);
    plan("stays.md", "x", BASE - 100);

    fs.unlinkSync(doomed);
    expect(fire(), "a deletion is not reviewable work").toBeNull();

    stampState("sess-1", BASE); // the quiet turn above moved the baseline
    plan("stays.md", "edited", BASE + 100);
    expect(fire(), "but a live plan still arms it").not.toBeNull();
  });

  it("uses session start as the cut-off before the first ask", () => {
    // Before any ask there is no state file, so there is no "since last time" to
    // compare against. The transcript file's BIRTH time is session start.
    // Rejected: firing unconditionally on the first Stop — a guaranteed
    // contentless question at the most salient moment of every session.
    const tr = path.join(tmp, "transcript.jsonl");
    fs.writeFileSync(tr, "{}\n"); // born now

    // ORDERING IS THE WHOLE TEST:
    //   birth(transcript)  <  mtime(plan)  <  mtime(transcript)
    // The CLI appends to the transcript after every message, so in production its
    // mtime is always ~now. Only BIRTH time marks session start. Pinning the plan
    // into that window is what distinguishes -newermB from -newer; with the plan
    // merely "after everything", both agree and swapping them passes the suite.
    // NOT plan(), which pins mtime to BASE (2023) — that would sit before the
    // transcript's birth and never match. This needs a real, natural mtime.
    fs.writeFileSync(path.join(plansDir, "during.md"), "x");
    fs.appendFileSync(tr, '{"later":true}\n');

    expect(fire({ transcript: tr }), "a plan touched this session").not.toBeNull();
  });

  it("ignores plans that predate the session — and still reports code", () => {
    const tr = path.join(tmp, "transcript.jsonl");
    plan("ancient.md", "x", BASE); // 2023, long before this transcript exists
    fs.writeFileSync(tr, "{}\n");

    expect(fire({ transcript: tr }), "a plan older than session start").toBeNull();

    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire({ transcript: tr }), "code still asks").not.toBeNull();
  });

  it("says nothing about plans when there is no transcript to date them", () => {
    // No baseline AND no transcript: guessing would mean asking about every plan
    // on the machine. The git half must be unaffected.
    plan("p.md", "x", BASE);
    expect(fire(), "cannot date the plan, so stay quiet").toBeNull();
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire(), "code is unaffected").not.toBeNull();
  });

  it("follows a SYMLINKED plans dir", () => {
    // Without -H, find lstat()s the start point and never descends: no output,
    // exit 0, NO STDERR — byte-identical to "no plan changed". ~/.claude symlinked
    // into a dotfiles repo is common, so this must not depend on the author's
    // machine happening to use a real directory.
    const real = fs.mkdtempSync(path.join(tmp, "realplans-"));
    const link = path.join(tmp, "plans-link");
    fs.symlinkSync(real, link);
    const p1 = path.join(real, "p.md");
    fs.writeFileSync(p1, "x"); setMtime(p1, BASE);

    // Seed against the SAME symlinked dir, so the baseline is comparable.
    const tr = path.join(tmp, "t.jsonl");
    fs.writeFileSync(tr, "{}\n");
    setMtime(p1, Math.floor(Date.now() / 1000) + 5);
    expect(fire({ plansDir: link, transcript: tr }), "seed must ask").not.toBeNull();
    stampState("sess-1", BASE);
    fs.writeFileSync(p1, "edited"); setMtime(p1, BASE + 100);

    expect(fire({ plansDir: link }), "a symlinked dir must still arm it").not.toBeNull();
  });

  it("honours the PLANS_DIR knob instead of $HOME", () => {
    // Replaces "the real ~/.claude/plans is never read", which is a negative over
    // an unbounded space and cannot fail. This CAN: point HOME at a decoy holding a
    // newer plan. A hook that ignored the knob fires and the test goes red.
    const decoy = fs.mkdtempSync(path.join(tmp, "home-"));
    fs.mkdirSync(path.join(decoy, ".claude/plans"), { recursive: true });
    const d = path.join(decoy, ".claude/plans/decoy.md");
    fs.writeFileSync(d, "x"); setMtime(d, BASE + 999);

    seedBaseline(BASE);
    expect(fire({ env: { HOME: decoy } }), "the decoy under $HOME must be ignored").toBeNull();

    stampState("sess-1", BASE); // the quiet turn above moved the baseline
    plan("real.md", "x", BASE + 100);
    expect(fire({ env: { HOME: decoy } }), "but the knob's dir arms it").not.toBeNull();
  });

  it("is silent, and quiet on stderr, when the plans dir is missing", () => {
    // NOTE what this does and does not cover. With no state file AND no
    // transcript_path the hook takes the "cannot date plans" branch and never
    // calls find at all — so this is a test of that branch, not of find's stderr.
    // The two paths that DO call find are covered separately, each found by a
    // mutation that survived this test.
    const gone = path.join(tmp, "no-such-plans");
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "missing", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: gone },
    });
    expect(res.status).toBe(0);
    expect(res.stderr, `find leaked: ${res.stderr}`).toBe("");

    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const ok = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "missing2", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: gone },
    });
    expect(ok.stdout.trim(), "code still asks with no plans dir").not.toBe("");
    expect(ok.stderr).toBe("");
  });

  it("stays quiet on stderr when the plans dir vanishes AFTER the first ask", () => {
    // Found by a SURVIVING mutation: removing `2>/dev/null` from the -newer call
    // killed nothing, because the missing-dir test above has no state file yet and
    // so takes the session-start branch instead. This constructs the uncovered
    // path — baseline present, plans dir gone — where find errors to stderr.
    seedBaseline(BASE);
    fs.rmSync(plansDir, { recursive: true, force: true });
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "sess-1", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status).toBe(0);
    expect(res.stderr, `find leaked: ${res.stderr}`).toBe("");
  });

  it("survives an environment with no HOME and no knob at all", () => {
    // PLANS_DIR defaults to ${HOME:-}/.claude/plans. `set -u` makes a BARE $HOME
    // fatal, and no other test omits BOTH HOME and the knob — so the guard that
    // prevents `HOME: unbound variable` was load-bearing and completely uncovered.
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "nohome", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", REVIEW_LOOP_STATE_DIR: stateDir }, // no HOME, no knob
    });
    expect(res.status, `exit ${res.status}: ${res.stderr}`).toBe(0);
    expect(res.stderr, `leaked: ${res.stderr}`).toBe("");
    expect(res.stdout.trim(), "and the git half still works").not.toBe("");
  });

  it("stays quiet on stderr when dating plans against session start fails", () => {
    // The session-start branch: transcript present, NO baseline yet, plans dir
    // missing. find errors on the missing start point. The other missing-dir test
    // cannot reach here — with no transcript it takes the else branch and never
    // calls find at all, so this whole branch had zero stderr coverage.
    const tr = path.join(tmp, "t.jsonl");
    fs.writeFileSync(tr, "{}\n");
    const gone = path.join(tmp, "no-such-plans");
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({
        session_id: "startfail", cwd: repo, stop_hook_active: false, transcript_path: tr,
      }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: gone },
    });
    expect(res.status).toBe(0);
    expect(res.stderr, `find leaked: ${res.stderr}`).toBe("");
  });

  it("recovers on the NEXT turn where -newermB is unavailable (GNU find)", () => {
    // THE regression test for the deadlock. The baseline used to BE the state
    // file, which is written only when the hook asks — and on a clean tree only a
    // plan can make it ask. On GNU find, where -newermB does not exist, plan
    // detection could therefore never start: measured 5 consecutive stops with the
    // plan rewritten between each, silent every time, forever.
    //
    // The baseline is now its own file, advanced every turn, so turn 1 is the only
    // casualty. Simulated with a find that rejects -newermB exactly as findutils
    // 4.10.0 does ("invalid predicate", exit 1).
    const shim = fs.mkdtempSync(path.join(tmp, "gnufind-"));
    for (const b of ["bash", "cat", "jq", "git", "xargs", "cksum", "cut", "tr", "stat", "ln", "rm"]) {
      const real = spawnSync("command", ["-v", b], { shell: true, encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(shim, b));
    }
    fs.writeFileSync(
      path.join(shim, "find"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-newermB" ] && { echo "find: invalid predicate '-newermB'" >&2; exit 1; }; done\nexec /usr/bin/find "$@"\n`,
    );
    fs.chmodSync(path.join(shim, "find"), 0o755);

    const tr = path.join(tmp, "t.jsonl");
    fs.writeFileSync(tr, "{}\n");
    const run = () =>
      spawnSync(path.join(shim, "bash"), [HOOK], {
        input: JSON.stringify({
          session_id: "gnu", cwd: repo, stop_hook_active: false, transcript_path: tr,
        }),
        encoding: "utf8",
        env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
      });

    fs.writeFileSync(path.join(plansDir, "p.md"), "v1");
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim(), "turn 1 cannot date the plan — the accepted cost").toBe("");

    fs.writeFileSync(path.join(plansDir, "p.md"), "v2 — longer than before");
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout.trim(), "turn 2 MUST ask; forever-silent is the bug").not.toBe("");
  });

  it("keeps one state file when STATE_DIR is relative and the cwd moves", () => {
    // The path is consumed BEFORE the hook cd's to the repo root and again after,
    // so a relative value read one file and wrote another — and the hook then
    // asked on every single turn. Launch from somewhere that is not the repo.
    const launch = fs.mkdtempSync(path.join(tmp, "launch-"));
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const run = () =>
      spawnSync("bash", [HOOK], {
        input: JSON.stringify({ session_id: "rel", cwd: repo, stop_hook_active: false }),
        encoding: "utf8",
        cwd: launch,
        env: { ...process.env, REVIEW_LOOP_STATE_DIR: ".relstate", REVIEW_LOOP_PLANS_DIR: plansDir },
      });
    fs.mkdirSync(path.join(launch, ".relstate"));
    expect(run().stdout.trim(), "first ask").not.toBe("");
    expect(run().stdout.trim(), "nothing changed, so it must go quiet").toBe("");
  });

  it("does NOT consume a plan change on a turn that failed to emit", () => {
    // The condition on the quiet advance is load-bearing: advancing
    // unconditionally would swallow a pending plan change on any turn that exits
    // before emitting, and that nudge is gone for good — nothing touches the plan
    // again until after the review nobody asked for. Drop the condition and this
    // test is the only thing that notices.
    const shim = fs.mkdtempSync(path.join(tmp, "badjq2-"));
    for (const b of ["bash", "cat", "git", "xargs", "cksum", "cut", "tr", "stat", "find", "ln", "rm"]) {
      const real = spawnSync("command", ["-v", b], { shell: true, encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(shim, b));
    }
    const realJq = spawnSync("command", ["-v", "jq"], { shell: true, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(
      path.join(shim, "jq"),
      `#!/bin/sh\ncase "$*" in *hookSpecificOutput*) exit 1 ;; esac\nexec ${realJq} "$@"\n`,
    );
    fs.chmodSync(path.join(shim, "jq"), 0o755);
    const run = () =>
      spawnSync(path.join(shim, "bash"), [HOOK], {
        input: JSON.stringify({ session_id: "retry", cwd: repo, stop_hook_active: false }),
        encoding: "utf8",
        env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
      });

    seedBaseline(BASE, "retry");
    plan("p.md", "v2", BASE + 100);

    expect(run().stdout.trim(), "jq refuses the emission, so nothing is said").toBe("");
    // Restore jq. The SAME unchanged plan must still be pending.
    fs.unlinkSync(path.join(shim, "jq"));
    fs.symlinkSync(realJq, path.join(shim, "jq"));
    expect(run().stdout.trim(), "the dropped ask must be retried, not lost").not.toBe("");
  });

  it("falls back to /tmp when the state dir is inside the repo", () => {
    // The default pathspec watches everything, so state files written inside the
    // tree are themselves dirt — and the baseline is rewritten every turn, so its
    // own mtime moves and the key never settles. Measured before the fallback:
    // 5 asks in 5 turns on a PRISTINE checkout with nothing else happening.
    const inside = path.join(repo, ".rlstate");
    fs.mkdirSync(inside);
    const session = `inrepo-${process.pid}`;
    const run = () =>
      spawnSync("bash", [HOOK], {
        input: JSON.stringify({ session_id: session, cwd: repo, stop_hook_active: false }),
        encoding: "utf8",
        env: { ...process.env, REVIEW_LOOP_STATE_DIR: inside, REVIEW_LOOP_PLANS_DIR: plansDir },
      });
    run();
    run();
    expect(run().stdout.trim(), "a pristine tree must go quiet, not nag forever").toBe("");
    expect(fs.readdirSync(inside), "nothing may be written inside the repo").toHaveLength(0);
  });

  it("passes pathspecs to git unexpanded — git's * crosses / and the shell's does not", () => {
    // `set -f`. Without it the shell expands `src/*.ts` to the concrete files that
    // happen to sit directly in src/, and git never sees the pathspec — so a dirty
    // file NESTED under src/ becomes invisible. That is unreviewed code the hook
    // silently never asks about.
    const paths = "src/*.ts";
    edit("src/shallow.ts", "export const a = 1;\n");
    commitAll();
    edit("src/deep/d.ts", "export const b = 2;\n");
    expect(
      fire({ env: { REVIEW_LOOP_PATHS: paths } }),
      "git's pathspec matches across /, so the nested file counts",
    ).not.toBeNull();
  });

  it("does not walk below the plans dir", () => {
    // PLANS_DIR is a user knob. Without -maxdepth 1 the hook walks an arbitrary
    // tree on EVERY Stop and arms on any nested .md it finds.
    seedBaseline(BASE);
    fs.mkdirSync(path.join(plansDir, "archive"), { recursive: true });
    const nested = path.join(plansDir, "archive/old.md");
    fs.writeFileSync(nested, "x");
    setMtime(nested, BASE + 500);
    expect(fire(), "a nested plan must not arm it").toBeNull();

    stampState("sess-1", BASE);
    plan("top.md", "x", BASE + 100);
    expect(fire(), "but a top-level one does").not.toBeNull();
  });

  it("treats a state dir EQUAL to the repo root as inside it", () => {
    // The trailing `/` on the subject is load-bearing. Without it, `$TOPLEVEL/*`
    // does not match `$TOPLEVEL`, so pointing the state dir AT the repo root —
    // e.g. REVIEW_LOOP_STATE_DIR=$CLAUDE_PROJECT_DIR, a very easy thing to write —
    // writes both state files into the root and reinstates the nag-forever bug.
    const session = `atroot-${process.pid}`;
    const run = () =>
      spawnSync("bash", [HOOK], {
        input: JSON.stringify({ session_id: session, cwd: repo, stop_hook_active: false }),
        encoding: "utf8",
        env: { ...process.env, REVIEW_LOOP_STATE_DIR: repo, REVIEW_LOOP_PLANS_DIR: plansDir },
      });
    run();
    run();
    const dirt = git("status", "--porcelain", "-uall").stdout;
    expect(dirt, `state files leaked into the repo root: ${dirt}`).not.toMatch(/review-loop/);
    // POSITIVE HALF. Without it a hook that does nothing at all passes: "no dirt"
    // is satisfied by silence. The tree here is CLEAN, so no ask happens and no
    // state key is written — the baseline is the artifact that proves the hook ran
    // and chose /tmp.
    expect(
      fs.existsSync(`/tmp/review-loop-baseline-${session}`),
      "the baseline must have been written to the /tmp fallback",
    ).toBe(true);
    fs.rmSync(`/tmp/review-loop-${session}`, { force: true });
    fs.rmSync(`/tmp/review-loop-baseline-${session}`, { force: true });
  });

  it("handles a repo path containing glob metacharacters", () => {
    // `case` patterns are NOT literal: an unquoted $TOPLEVEL turns `[y]` in a repo
    // path into a character class, the containment test misfires, and state files
    // land in the tree.
    const odd = path.join(tmp, "x[y]z");
    fs.mkdirSync(odd, { recursive: true });
    const saved = repo;
    repo = odd;
    git("init", "-q", ".");
    fs.writeFileSync(path.join(odd, "a.ts"), "export const a = 1;\n");
    commitAll();
    fs.writeFileSync(path.join(odd, "a.ts"), "export const a = 2;\n");
    const session = `glob-${process.pid}`;
    // A SUBDIRECTORY, not the repo root. Using the root made this incidentally an
    // equality case too, so it killed the equality mutant as well and the two
    // tests overlapped — which is how coverage gaps hide behind a fixture detail.
    const st = path.join(odd, ".st");
    fs.mkdirSync(st);
    spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: session, cwd: odd, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: st, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    const dirt = git("status", "--porcelain", "-uall").stdout;
    repo = saved;
    expect(dirt, `leaked into a repo whose path has metacharacters: ${dirt}`).not.toMatch(/review-loop/);
    expect(fs.existsSync(`/tmp/review-loop-${session}`), "fell back to /tmp").toBe(true);
    fs.rmSync(`/tmp/review-loop-${session}`, { force: true });
    fs.rmSync(`/tmp/review-loop-baseline-${session}`, { force: true });
  });

  it("does NOT hijack a sibling dir that merely shares the repo's prefix", () => {
    // The `/` inside the pattern is load-bearing in the other direction: without
    // it, `<repo>-state` looks contained and a perfectly valid configuration is
    // silently discarded in favour of /tmp.
    const sibling = `${repo}-state`;
    fs.mkdirSync(sibling, { recursive: true });
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "sib", cwd: repo, stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: sibling, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(
      fs.readdirSync(sibling),
      "a sibling is outside the repo; its configuration must be honoured",
    ).not.toHaveLength(0);
  });

  it("bounds the walk on the session-start branch too", () => {
    // The -newer branch got a -maxdepth test; the -newermB branch did not. Same
    // asymmetry that hid a stderr gap two rounds ago: two find calls, a fix
    // applied to one of them.
    const tr = path.join(tmp, "t.jsonl");
    fs.writeFileSync(tr, "{}\n");
    fs.mkdirSync(path.join(plansDir, "archive"), { recursive: true });
    fs.writeFileSync(path.join(plansDir, "archive/old.md"), "x"); // born after the transcript
    expect(fire({ transcript: tr }), "a nested plan must not arm the first Stop").toBeNull();

    fs.writeFileSync(path.join(plansDir, "top.md"), "x");
    expect(fire({ transcript: tr }), "but a top-level one does").not.toBeNull();
  });

  it("resolves a relative PLANS_DIR against the launch cwd, like STATE_DIR", () => {
    // The find runs AFTER the hook cd's to the repo root, so a relative value
    // would resolve against the repo — silently, and differently from STATE_DIR.
    const launch = fs.mkdtempSync(path.join(tmp, "launch2-"));
    fs.mkdirSync(path.join(launch, "relplans"));
    fs.writeFileSync(path.join(launch, "relplans/p.md"), "x");
    const tr = path.join(tmp, "t2.jsonl");
    fs.writeFileSync(tr, "{}\n");
    fs.writeFileSync(path.join(launch, "relplans/p.md"), "x2"); // after the transcript's birth
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({
        session_id: "relplans", cwd: repo, stop_hook_active: false, transcript_path: tr,
      }),
      encoding: "utf8",
      cwd: launch,
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: "relplans" },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim(), "the launch cwd's plans dir is the one meant").not.toBe("");
  });

  it("is silent when the plans dir is empty — and asks when code is dirty", () => {
    seedBaseline(BASE);
    expect(fire(), "an empty plans dir arms nothing").toBeNull();
    stampState("sess-1", BASE);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    expect(fire(), "code still asks").not.toBeNull();
  });

  it("emits ONE message when both a plan and the code changed", () => {
    seedBaseline(BASE);
    plan("p.md", "v2", BASE + 100);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const msg = fire();
    expect(msg, "both changed").not.toBeNull();
    expect(msg!.match(/Wait for inflight/g) ?? [], "exactly one message").toHaveLength(1);
  });
});

/**
 * ATTRIBUTION — what changed during THIS turn.
 *
 * A shared checkout means `git status` shows other sessions' work. The hook used
 * to nudge about all of it: measured live, it told a READING session to review 17
 * files another session had written.
 *
 * Path-based attribution was measured and refuted before this was built. Against
 * that same incident, Write/Edit file_paths from the transcript explained 3 of 17
 * dirty files, and regex-extracted Bash write targets 7 of 17 with heavy junk —
 * the writer session called Bash ~10x more often than Write+Edit (2460 against 231
 * when sampled; the session was live, so treat the ratio as the finding, not the
 * counts). Under-attribution
 * is the fatal direction: a nudge that goes quiet stops covering real work.
 *
 * The FIRST attempt at this filtered dirty paths by mtime against a marker file,
 * and was wrong in four silent ways — `git mv`, `chmod +x`, a new symlink to an
 * old target, and a nested repo dirtied in place. git's notion of "changed" is
 * not mtime, so mtime cannot decide what git saw. Each has a test below.
 *
 *   UserPromptSubmit ──> cksum of the dirty set ──> $TURN_FILE  (turn baseline)
 *                                                        │
 *   Stop ──> the same cksum now ──> differs from it? ──> ask
 *
 * THREE FILES, THREE JOBS. $TURN_FILE is written by UserPromptSubmit ONLY WHEN
 * ABSENT and removed by Stop as soon as it is read — that pair is what stops a
 * second prompt (typed ahead, or after an interrupt) from re-baselining over work
 * already in flight.
 */
const turnPath = (session = "sess-1") =>
  path.join(stateDir, `review-loop-turn-${session}`);
const turnKey = (session = "sess-1") => fs.readFileSync(turnPath(session), "utf8");

/** Fire the hook as a UserPromptSubmit. Asserts the whole contract: exit 0, no
 *  stdout, no stderr. A marker hook that prints anything corrupts the prompt. */
function submitPrompt(
  opts: { cwd?: string; session?: string; event?: string; source?: string; env?: Record<string, string> } = {},
): void {
  const res = spawnSync("bash", [HOOK], {
    input: JSON.stringify({
      session_id: opts.session ?? "sess-1",
      cwd: opts.cwd ?? repo,
      hook_event_name: opts.event ?? "UserPromptSubmit",
      ...(opts.source ? { source: opts.source } : {}),
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      REVIEW_LOOP_STATE_DIR: stateDir,
      REVIEW_LOOP_PLANS_DIR: plansDir,
      ...(opts.env ?? {}),
    },
  });
  expect(res.status, `must exit 0; stderr: ${res.stderr}`).toBe(0);
  expect(res.stderr, `must stay silent on stderr; got: ${res.stderr}`).toBe("");
  expect(res.stdout.trim(), "the marker branch must emit nothing").toBe("");
}

describe("attribution — what changed during this turn", () => {
  it("fails open when there is no baseline at all", () => {
    // The whole pre-attribution suite runs in this mode. Stated as its own
    // assertion so a regression fails by name instead of scattering across 65.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    expect(fs.existsSync(turnPath()), "no baseline written").toBe(false);
    expect(fire(), "unfiltered, exactly as before").not.toBeNull();
  });

  it("ignores dirt that was already there — and asks about work done since", () => {
    // Each fire() CONSUMES the baseline, so every turn under test re-arms with its
    // own submitPrompt(). Firing twice off one prompt would put the second call in
    // the fail-open path, where it passes whether or not attribution works at all.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    // The FIRST ask of a session is never suppressed — see the /clear test below.
    // Only after it has asked once does pre-existing dirt become old news.
    submitPrompt();
    expect(fire(), "first ask of the session is never suppressed").not.toBeNull();
    submitPrompt();
    expect(fire(), "another session's file, present before our prompt").toBeNull();
    // POSITIVE COMPANION, same fixture: a hook that emits nothing at all would
    // pass the assertion above.
    submitPrompt();
    edit("packages/x/src/ours.ts", "export const b = 1;\n", BASE + 200);
    expect(fire(), "written during our turn").not.toBeNull();
  });

  it("asks when a NEW session opens on an already-dirty tree", () => {
    // The regression that nearly shipped. Suppressing on "unchanged since the
    // prompt" ALONE means a session that opens on unreviewed work baselines it and
    // never asks: /clear mid-work, restarting claude on a dirty checkout, --resume
    // after a reboot cleared /tmp. Measured before the fix: three consecutive
    // silent turns on the user's own unreviewed diff, where a Stop-only install
    // asks. The session boundary is a new session id and no state file.
    edit("packages/x/src/unreviewed.ts", "export const a = 1;\n", BASE);
    submitPrompt({ session: "after-clear" });
    expect(
      fire({ session: "after-clear" }),
      "never asked in THIS session, so the dirt is not old news",
    ).not.toBeNull();
    // POSITIVE COMPANION: and once it HAS asked, it settles down.
    submitPrompt({ session: "after-clear" });
    expect(fire({ session: "after-clear" }), "now it is old news").toBeNull();
  });

  it("never silences work written after a BLOCKED Stop", () => {
    // A sibling Stop hook blocks, the model keeps working, and the continuation
    // Stop arrives with stop_hook_active=true. That work belongs to this turn but
    // lands after the Stop that already consumed the baseline — so without the
    // poison the next prompt samples a tree that already contains it and every
    // later Stop compares equal. Measured before the fix: the second file was
    // never asked about while `git status` still showed it.
    submitPrompt();
    edit("packages/x/src/first.ts", "export const a = 1;\n", BASE);
    expect(fire(), "asks about the first file").not.toBeNull();

    // The block: model keeps going, writes more, continuation Stop is a no-op ask.
    edit("packages/x/src/second.ts", "export const b = 1;\n", BASE + 10);
    expect(fire({ stopActive: true }), "a continuation Stop never asks").toBeNull();

    submitPrompt();
    expect(
      fire(),
      "the file written during the block is unreviewed and must still be asked about",
    ).not.toBeNull();
    // POSITIVE COMPANION: and it settles down straight after, rather than nagging.
    submitPrompt();
    expect(fire(), "once asked, quiet again").toBeNull();
  });

  it("asks again after --resume, when the id and the state file both survive", () => {
    // The /clear case below is a DIFFERENT shape and does not cover this one:
    // /clear mints a new session id, so there is no state file and round 2's guard
    // fires on its own. `--resume` reuses the id and /tmp normally survives, so the
    // state file is still there — and everything hand-edited while claude was
    // closed is already in the tree when the first resumed prompt baselines it.
    // Measured before SessionStart was wired: three silent resumed turns on the
    // user's own diff.
    submitPrompt();
    edit("packages/x/src/agent.ts", "export const a = 1;\n", BASE);
    expect(fire(), "the agent's own edit, asked about").not.toBeNull();

    // claude is closed. The user edits by hand — no prompt, no Stop.
    edit("packages/x/src/handwritten.ts", "export const b = 1;\n", BASE + 50);

    submitPrompt({ event: "SessionStart", source: "resume" });
    submitPrompt();
    expect(fire(), "a restarted session must ask before it settles").not.toBeNull();
    // POSITIVE COMPANION: it settles immediately after, rather than nagging.
    submitPrompt();
    expect(fire(), "and then it is quiet").toBeNull();
  });

  it("resets on a source it has never heard of, rather than staying quiet", () => {
    // The asymmetry: resetting wrongly costs one ask, failing to reset loses the
    // work for good. So an unknown source — a new Claude Code value, or a payload
    // missing the field — must land on the noisy side of that trade.
    submitPrompt();
    edit("packages/x/src/ours.ts", "export const a = 1;\n", BASE);
    expect(fire(), "asked once").not.toBeNull();
    edit("packages/x/src/handwritten.ts", "export const b = 1;\n", BASE + 50);
    submitPrompt({ event: "SessionStart", source: "teleported" });
    submitPrompt();
    expect(fire(), "unknown source is treated as a restart").not.toBeNull();
  });

  it("does not reset on compaction, which is not a break in the work", () => {
    submitPrompt();
    edit("packages/x/src/ours.ts", "export const a = 1;\n", BASE);
    expect(fire(), "asked once").not.toBeNull();
    edit("packages/x/src/theirs.ts", "export const b = 1;\n", BASE + 50);
    submitPrompt({ event: "SessionStart", source: "compact" });
    submitPrompt();
    expect(fire(), "compaction is mid-session; the gate still applies").toBeNull();
  });

  it("fails open on a second Stop with no prompt between them", () => {
    // Stop closes the turn and consumes the baseline, so a further Stop has none.
    // Pinned deliberately: the fallback is to ask, never to go quiet.
    edit("packages/x/src/theirs.ts", "export const a = 2;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask of the session").not.toBeNull();
    submitPrompt();
    expect(fire(), "baseline armed, nothing of ours changed").toBeNull();
    expect(fs.existsSync(turnPath()), "consumed").toBe(false);
    edit("packages/x/src/theirs.ts", "export const a = 3;\n", BASE + 5);
    expect(fire(), "no baseline left — ask rather than risk silence").not.toBeNull();
  });

  it("suppresses a CONCURRENT session's write that landed before our prompt", () => {
    // THE test for this feature, and the only shape that separates the turn gate
    // from the pre-existing "ask once per distinct state" guard. Every other
    // silent case is already suppressed by that guard, so it passes with the turn
    // gate deleted — verified. Here the key HAS moved since our last ask, so the
    // ask-once guard does not fire; only "it did not move during our turn" can.
    edit("packages/x/src/ours.ts", "export const a = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "our work, asked about").not.toBeNull();

    // Another session in the same checkout writes while we sit idle.
    edit("packages/x/src/theirs.ts", "export const b = 1;\n", BASE + 50);
    submitPrompt();
    expect(fire(), "not ours, and it predates our prompt").toBeNull();

    // POSITIVE COMPANION: our own next edit still re-arms.
    submitPrompt();
    edit("packages/x/src/ours.ts", "export const a = 2;\n", BASE + 100);
    expect(fire(), "ours, during our turn").not.toBeNull();
  });

  it("stays SILENT on an idle turn after a productive one", () => {
    submitPrompt();
    edit("packages/x/src/ours.ts", "export const b = 1;\n", BASE + 200);
    expect(fire(), "we wrote something").not.toBeNull();

    submitPrompt();
    expect(fire(), "idle turn — nothing of ours moved").toBeNull();
    submitPrompt();
    expect(fire(), "still idle, still baselined").toBeNull();

    submitPrompt();
    edit("packages/x/src/ours.ts", "export const b = 2;\n", BASE + 400);
    expect(fire(), "and it re-arms on the next real edit").not.toBeNull();
  });

  // ── The four classes an mtime filter got silently wrong ────────────────────
  // Every one of these is a change git reports while the file's mtime stays put.

  it("asks about a `git mv` — rename(2) does not move mtime", () => {
    edit("packages/x/src/movable.ts", "export const c = 1;\n", BASE);
    commitAll();
    // ARMED. Firing only the session's FIRST Stop makes this vacuous: $STATE_FILE
    // does not exist yet, so the turn gate is off and the ask-once guard compares a
    // non-empty cksum against "" — which always differs, so the hook asks whatever
    // the key contains. Verified: a mutant whose key is the constant cksum("")
    // survived all four of these while 24 other tests killed it. Ask once first so
    // $STATE_FILE exists, and sample the baseline on an ALREADY-dirty tree.
    edit("packages/x/src/decoy.ts", "export const d = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask, on the decoy").not.toBeNull();
    submitPrompt();
    git("mv", "packages/x/src/movable.ts", "packages/x/src/moved.ts");
    expect(git("status", "--porcelain").stdout, "fixture must really be a rename")
      .toMatch(/^R/m);
    expect(fire(), "a rename is unreviewed work").not.toBeNull();
  });

  it("asks about a mode change — chmod does not move mtime either", () => {
    edit("packages/x/src/tool.sh", "#!/bin/sh\n", BASE);
    commitAll();
    // ARMED. Firing only the session's FIRST Stop makes this vacuous: $STATE_FILE
    // does not exist yet, so the turn gate is off and the ask-once guard compares a
    // non-empty cksum against "" — which always differs, so the hook asks whatever
    // the key contains. Verified: a mutant whose key is the constant cksum("")
    // survived all four of these while 24 other tests killed it. Ask once first so
    // $STATE_FILE exists, and sample the baseline on an ALREADY-dirty tree.
    edit("packages/x/src/decoy.ts", "export const d = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask, on the decoy").not.toBeNull();
    submitPrompt();
    fs.chmodSync(path.join(repo, "packages/x/src/tool.sh"), 0o755);
    setMtime(path.join(repo, "packages/x/src/tool.sh"), BASE); // mtime pinned back
    expect(git("status", "--porcelain").stdout, "fixture must show a modification")
      .toMatch(/M/);
    expect(fire(), "a mode change is a change").not.toBeNull();
  });

  it("asks about a NEW symlink pointing at an OLD target", () => {
    // `-e` and `-ot` dereference; `stat` does not. An mtime test therefore read
    // the TARGET's timestamp and dropped the link.
    edit("packages/x/src/ancient.ts", "export const d = 1;\n", BASE);
    commitAll();
    // ARMED. Firing only the session's FIRST Stop makes this vacuous: $STATE_FILE
    // does not exist yet, so the turn gate is off and the ask-once guard compares a
    // non-empty cksum against "" — which always differs, so the hook asks whatever
    // the key contains. Verified: a mutant whose key is the constant cksum("")
    // survived all four of these while 24 other tests killed it. Ask once first so
    // $STATE_FILE exists, and sample the baseline on an ALREADY-dirty tree.
    edit("packages/x/src/decoy.ts", "export const d = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask, on the decoy").not.toBeNull();
    submitPrompt();
    fs.symlinkSync("ancient.ts", path.join(repo, "packages/x/src/fresh-link.ts"));
    expect(fire(), "a new symlink is new work").not.toBeNull();
  });

  it("asks when a nested repo first appears", () => {
    // git emits ONE directory entry and will not recurse. The entry appearing is
    // what must arm the question; an mtime test on the directory dropped it.
    // ARMED. Firing only the session's FIRST Stop makes this vacuous: $STATE_FILE
    // does not exist yet, so the turn gate is off and the ask-once guard compares a
    // non-empty cksum against "" — which always differs, so the hook asks whatever
    // the key contains. Verified: a mutant whose key is the constant cksum("")
    // survived all four of these while 24 other tests killed it. Ask once first so
    // $STATE_FILE exists, and sample the baseline on an ALREADY-dirty tree.
    edit("packages/x/src/decoy.ts", "export const d = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask, on the decoy").not.toBeNull();
    submitPrompt();
    const sub = path.join(repo, "packages/x/sub");
    fs.mkdirSync(sub, { recursive: true });
    spawnSync("git", ["init", "-q", "."], { cwd: sub, encoding: "utf8" });
    fs.writeFileSync(path.join(sub, "inner.ts"), "export const e = 1;\n");
    setMtime(sub, BASE);
    expect(fire(), "a nested repo appeared this turn").not.toBeNull();
  });

  it("still asks for a plan when the git side is unchanged", () => {
    // The plan path is deliberately untouched by attribution: plans live outside
    // the repo and the turn comparison must not reach them.
    edit("packages/x/src/theirs.ts", "export const a = 2;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask of the session").not.toBeNull();
    submitPrompt();
    expect(fire(), "arms the baseline, git side identical").toBeNull();
    stampState("sess-1", BASE + 300);
    // RE-ARM. Without this the next fire() runs in the fail-open path, where it
    // asks regardless — and the assertion below would pass against a turn guard
    // that ignores plans entirely. Verified: that mutant survived until this line.
    submitPrompt();
    plan("p.md", "# plan\n", BASE + 400);
    expect(fire(), "a plan changed, even though the git side did not").not.toBeNull();
  });
});

/** A `git` that stalls on `status`, so a kill or a race has a real window to land
 *  in. Everything else passes straight through to the real binary. */
function slowGitShim(seconds = 2): string {
  const shim = fs.mkdtempSync(path.join(tmp, "slowgit-"));
  const real = spawnSync("command", ["-v", "git"], { shell: true, encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(
    path.join(shim, "git"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = "status" ] && sleep ${seconds}; done\nexec ${real} "$@"\n`,
  );
  fs.chmodSync(path.join(shim, "git"), 0o755);
  return shim;
}

describe("attribution — losing a turn without losing the work", () => {
  it("a hook killed before it can ask leaves the baseline intact", () => {
    // The hook runs under a timeout. If the baseline were consumed BEFORE the slow
    // enumeration, a SIGTERM in that window would take the ask AND the baseline:
    // $STATE_FILE still holds the old key, so the next prompt would sample the
    // un-asked work as its own baseline and the gate would be quiet on it for
    // good. Consumed at the terminal points instead, a kill costs one ask.
    submitPrompt();
    edit("packages/x/src/asked.ts", "export const a = 1;\n", BASE);
    expect(fire(), "turn 1 asks, so $STATE_FILE exists").not.toBeNull();

    submitPrompt();
    edit("packages/x/src/unasked.ts", "export const b = 1;\n", BASE + 10);
    const killed = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "sess-1", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      timeout: 400, // dies inside the stalled `git status`
      env: { ...process.env, PATH: `${slowGitShim()}:${process.env.PATH}`, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(killed.stdout ?? "", "it never got as far as asking").toBe("");

    submitPrompt(); // must NOT re-baseline over the un-asked work
    expect(fire(), "the killed turn's work is still unreviewed").not.toBeNull();
  });

  it("a poison written mid-prompt is not clobbered by the prompt's own write", async () => {
    // `[ ! -f ]` and the write are separated by the enumeration, so a continuation
    // Stop can poison the file inside that gap. With a clobbering write the prompt
    // would overwrite the poison with a key that already contains the blocked
    // turn's work — round 3's defect, restored by a race. A create-if-absent `ln`
    // loses that write instead, which is the direction that keeps the work.
    const child = spawn("bash", [HOOK], {
      env: { ...process.env, PATH: `${slowGitShim()}:${process.env.PATH}`, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    child.stdin.end(JSON.stringify({ session_id: "sess-1", cwd: repo, hook_event_name: "UserPromptSubmit" }));
    await new Promise((r) => setTimeout(r, 500)); // inside collect_state
    fs.writeFileSync(turnPath(), ""); // the continuation Stop poisons
    await new Promise((r) => child.on("exit", r));
    expect(fs.readFileSync(turnPath(), "utf8"), "the poison must survive").toBe("");
  });

  it("still asks when `ln` is missing, rather than disabling itself", () => {
    // `ln` writes the baseline and `rm` consumes the turn, so both are dependencies
    // — but adding them to the hook's preflight list gates the WHOLE hook on them,
    // Stop included, and a missing one then exits 0 before doing anything. Measured
    // when they were briefly listed: a dirty tree went completely silent. Unlisted,
    // the baseline write just fails, and the Stop side fails open and asks.
    const shim = fs.mkdtempSync(path.join(tmp, "noln-"));
    for (const b of ["bash", "cat", "jq", "git", "xargs", "cksum", "cut", "tr", "find", "stat", "rm", "sh"]) {
      const real = spawnSync("command", ["-v", b], { shell: true, encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(shim, b));
    }
    expect(fs.existsSync(path.join(shim, "ln")), "ln must be absent").toBe(false);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = spawnSync(path.join(shim, "bash"), [HOOK], {
      input: JSON.stringify({ session_id: "noln", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status, "never blocks").toBe(0);
    expect(res.stderr, "and stays quiet on stderr").toBe("");
    expect(res.stdout.trim(), "unreviewed work must still be asked about").not.toBe("");
  });

  it("still works on a git too old for --no-optional-locks", () => {
    // --no-optional-locks is a TOP-LEVEL git option added in 2.15, so an older git
    // REJECTS THE WHOLE INVOCATION (exit 129) rather than ignoring it. Every git
    // call here is 2>/dev/null, so that rejection is invisible: the enumeration
    // returns nothing, TOTAL is 0, the key is the constant cksum("") and the hook
    // never asks again, in any session. RHEL 7 still ships git 1.8.3.1.
    //
    // This is not hypothetical caution — the flag was added for lock contention
    // and shipped WITHOUT this probe, and a dirty tree then went silent forever.
    const shim = fs.mkdtempSync(path.join(tmp, "oldgit-"));
    const real = spawnSync("command", ["-v", "git"], { shell: true, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(
      path.join(shim, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--no-optional-locks" ] && { echo "error: unknown option" >&2; exit 129; }; done\nexec ${real} "$@"\n`,
    );
    fs.chmodSync(path.join(shim, "git"), 0o755);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "oldgit", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status, "never blocks").toBe(0);
    expect(res.stderr, "and never leaks the rejection").toBe("");
    expect(res.stdout.trim(), "must fall back to plain git status and still ask").not.toBe("");
  });

  it("reads git status without taking the index lock", () => {
    // This enumeration now runs TWICE per turn, in a checkout the feature exists
    // BECAUSE it is shared with concurrent sessions. Plain `git status`
    // opportunistically rewrites .git/index and takes .git/index.lock to do it, so
    // a collision makes another session's `git add` fail outright.
    const shim = fs.mkdtempSync(path.join(tmp, "argv-"));
    const log = path.join(shim, "argv.log");
    const real = spawnSync("command", ["-v", "git"], { shell: true, encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(shim, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${real} "$@"\n`);
    fs.chmodSync(path.join(shim, "git"), 0o755);
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "lock", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.stdout.trim(), "must still ask").not.toBe("");
    const argv = fs.readFileSync(log, "utf8");
    expect(argv, "status must run").toContain("status");
    for (const line of argv.split("\n").filter((l) => l.includes("status"))) {
      expect(line, "every status call must waive the optional lock").toContain("--no-optional-locks");
    }
  });
});

describe("attribution — the turn boundary", () => {
  it("consumes the baseline at Stop, so the next prompt takes a fresh one", () => {
    submitPrompt();
    const first = turnKey();
    expect(fire(), "clean tree, nothing changed this turn").toBeNull();
    expect(fs.existsSync(turnPath()), "Stop must consume it").toBe(false);
    // POSITIVE COMPANION: the next turn re-baselines against the NEW reality, so
    // work done in the previous turn is not re-asked about forever.
    edit("packages/x/src/a.ts", "export const a = 1;\n", BASE);
    submitPrompt();
    expect(turnKey(), "a fresh sample, not the old one").not.toBe(first);
    expect(fire(), "first ask of the session, on the new dirt").not.toBeNull();
    submitPrompt();
    expect(fire(), "and nothing since THAT prompt").toBeNull();
  });

  it("does NOT re-baseline when a second prompt arrives before any Stop", () => {
    // Typed ahead, or the user interrupted and retyped — Stop does not fire on an
    // interrupt. Re-baselining here would swallow work already written this turn.
    submitPrompt();
    const original = turnKey();
    edit("packages/x/src/inflight.ts", "export const a = 1;\n", BASE + 100);
    submitPrompt();
    expect(turnKey(), "baseline must not move mid-turn").toBe(original);
    expect(fire(), "in-flight work must still be asked about").not.toBeNull();
  });
});

describe("attribution — the UserPromptSubmit branch", () => {
  it("writes the baseline and emits nothing", () => {
    submitPrompt();
    expect(fs.existsSync(turnPath()), "baseline written").toBe(true);
    expect(turnKey(), "and it is a key, not an empty marker").toMatch(/^\d+$/);
  });

  it("sanitises the session id in the baseline path, like every other state file", () => {
    submitPrompt({ session: "../../evil sess" });
    // tr -c 'A-Za-z0-9_-' '_' — dots and slashes and spaces all collapse to _.
    expect(fs.existsSync(path.join(stateDir, "review-loop-turn-______evil_sess")), "sanitised").toBe(true);
    expect(fs.existsSync(path.join(stateDir, "../../evil sess")), "escaped the state dir").toBe(false);
  });

  it("is inert on an unrelated hook event", () => {
    // The fixture MUST be dirty. On a clean tree a fall-through to the Stop path
    // is silent for the ordinary reason, so the test would pass against a hook
    // that does not dispatch at all — verified: that exact mutant survived.
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    submitPrompt({ event: "PreToolUse" });
    expect(fs.existsSync(turnPath()), "no baseline for a foreign event").toBe(false);
    // POSITIVE COMPANION: proves the branch can fire at all in this fixture.
    submitPrompt();
    expect(fs.existsSync(turnPath()), "and the real event still writes one").toBe(true);
  });

  it("stays silent on stderr when there is no usable stat(1)", () => {
    // The probe runs BEFORE the dispatch, because both events need it — so its
    // failure arm would otherwise print to stderr on every prompt, for as long as
    // the misconfiguration lasts. On UserPromptSubmit stderr reaches the user
    // mid-sentence, and this branch's whole contract is to say nothing.
    //
    // A PATH carrying every preflight binary EXCEPT stat: with one missing the
    // hook bails at the preflight instead, and the assertion goes vacuous.
    const shim = fs.mkdtempSync(path.join(tmp, "nostat-"));
    // `bash` too: spawnSync resolves the interpreter through this PATH, so without
    // it the spawn fails with ENOENT and the assertions never run. `ln` and `rm`
    // are here for a DIFFERENT reason: they are deliberately NOT on the hook's
    // preflight list (listing them would gate the whole hook on them — see "still
    // asks when `ln` is missing"), so without them in the shim the baseline write
    // fails for that reason instead and this test passes without isolating `stat`
    // at all. Do not trim them.
    for (const bin of ["bash", "cat", "jq", "git", "xargs", "cksum", "cut", "tr", "find", "sh", "ln", "rm"]) {
      const real = spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(shim, bin));
    }
    expect(fs.existsSync(path.join(shim, "stat")), "stat must be absent").toBe(false);
    expect(fs.existsSync(path.join(shim, "git")), "git must be present").toBe(true);
    // submitPrompt() asserts exit 0, empty stdout AND empty stderr.
    submitPrompt({ env: { PATH: shim } });
    expect(fs.existsSync(turnPath()), "no stat means no baseline, and that is fine").toBe(false);

    // POSITIVE COMPANION: the same misconfiguration on Stop DOES report itself,
    // because there the diagnostic is worth having and interrupts nobody.
    const res = spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "sess-1", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, PATH: shim, REVIEW_LOOP_STATE_DIR: stateDir, REVIEW_LOOP_PLANS_DIR: plansDir },
    });
    expect(res.status, "still never blocks").toBe(0);
    expect(res.stderr, "Stop says why it disabled itself").toContain("no usable stat");
  });

  it("resets through the SAME state-dir fallback the other two events use", () => {
    // All three registrations must land on one state dir or the reset deletes a
    // file nobody reads. Nothing pinned this: a mutant computing the SessionStart
    // paths straight from $REVIEW_LOOP_STATE_DIR, skipping the symlink resolution
    // and the in-repo fallback, survived the whole suite. On macOS the /tmp ->
    // /private/var resolution alone is enough to make the two paths differ.
    const inside = path.join(repo, "state");
    fs.mkdirSync(inside, { recursive: true });
    const session = `sess-reset-${process.pid}`;
    const env = { REVIEW_LOOP_STATE_DIR: inside };
    try {
      submitPrompt({ session, env });
      edit("packages/x/src/agent.ts", "export const a = 1;\n", BASE);
      expect(fire({ session, env }), "the agent's edit").not.toBeNull();
      edit("packages/x/src/handwritten.ts", "export const b = 1;\n", BASE + 50);
      submitPrompt({ session, env, event: "SessionStart", source: "resume" });
      submitPrompt({ session, env });
      expect(
        fire({ session, env }),
        "the reset must have removed the file the Stop branch actually reads",
      ).not.toBeNull();
    } finally {
      for (const f of ["turn-", "", "baseline-"]) {
        fs.rmSync(path.join("/tmp", `review-loop-${f}${session}`), { force: true });
      }
    }
  });

  it("agrees with the Stop branch on the baseline path when the state dir is inside the repo", () => {
    // Both branches fall back to /tmp, and they must land on the SAME path. If
    // they diverge the baseline silently never applies — which looks exactly like
    // fail-open, so nothing else in this suite would catch it.
    const inside = path.join(repo, "state");
    fs.mkdirSync(inside, { recursive: true });
    const session = `agree-${process.pid}`;
    const shared = path.join("/tmp", `review-loop-turn-${session}`);
    fs.rmSync(shared, { force: true });
    try {
      edit("packages/x/src/theirs.ts", "export const a = 2;\n", BASE);
      submitPrompt({ session, env: { REVIEW_LOOP_STATE_DIR: inside } });
      expect(fs.existsSync(shared), "baseline fell back to /tmp").toBe(true);
      expect(
        fire({ session, env: { REVIEW_LOOP_STATE_DIR: inside } }),
        "first ask of the session",
      ).not.toBeNull();
      submitPrompt({ session, env: { REVIEW_LOOP_STATE_DIR: inside } });
      expect(
        fire({ session, env: { REVIEW_LOOP_STATE_DIR: inside } }),
        "Stop read the SAME fallback baseline and compared against it",
      ).toBeNull();
      submitPrompt({ session, env: { REVIEW_LOOP_STATE_DIR: inside } });
      edit("packages/x/src/ours.ts", "export const b = 1;\n", BASE + 200);
      expect(
        fire({ session, env: { REVIEW_LOOP_STATE_DIR: inside } }),
        "and still asks for work done in the turn",
      ).not.toBeNull();
    } finally {
      // "turn-", with the hyphen: it was "turn" for a while, which silently matched
      // nothing and left one file per run in /tmp (four were found).
      for (const f of ["turn-", "", "baseline-"]) {
        fs.rmSync(path.join("/tmp", `review-loop-${f}${session}`), { force: true });
      }
    }
  });
});

/**
 * The legacy fixtures, re-run with a baseline ARMED.
 *
 * Every one of the 65 tests written before attribution existed runs in the
 * no-baseline fail-open path, because fire() never calls submitPrompt(). All four
 * of the mtime bugs above would have stayed green through that whole suite. These
 * re-drive the load-bearing enumeration cases with the turn comparison live.
 */
describe("attribution — the enumeration cases, with a baseline armed", () => {
  it("attributes a rename against a non-empty baseline", () => {
    edit("packages/x/src/README.ts", "export const a = 1;\n", BASE);
    edit("packages/x/src/after.ts", "export const b = 1;\n", BASE);
    commitAll();
    // The baseline MUST be sampled on an already-dirty tree. Sampled clean it is
    // cksum(""), which any dirt at all differs from.
    //
    // SCOPE, honestly: this does NOT cover rename CONSUMPTION. Removing the
    // `[RC]` old-path read leaves this green, because the outcome asserted is
    // "asks" and a leaked phantom still changes the key. Consumption is owned by
    // the two `enumeration` tests and by the armed leak test below, which assert
    // the SILENT direction — that is what a phantom actually breaks.
    edit("packages/x/src/decoy.ts", "export const d = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask, on the decoy").not.toBeNull();
    submitPrompt();
    git("mv", "packages/x/src/README.ts", "packages/x/src/renamed.ts");
    expect(git("status", "--porcelain").stdout, "fixture must really be a rename")
      .toMatch(/^R/m);
    expect(fire(), "the rename, against a non-empty baseline").not.toBeNull();
  });

  it("does not let a rename's phantom path leak in, with a baseline armed", () => {
    // The armed twin of the legacy leak test. Without consumption the old path is
    // parsed as a status line and its phantom — the old path minus three chars —
    // can name a REAL, EXCLUDED file, whose mtime then drives the key. Asserting
    // the SILENT direction is what catches it: touching only the excluded file
    // must not re-arm.
    const paths = ". :(exclude)TODO.md";
    fs.mkdirSync(path.join(repo, "xy"), { recursive: true });
    edit("xy/TODO.md", "old\n", BASE);
    commitAll();
    fs.renameSync(path.join(repo, "xy/TODO.md"), path.join(repo, "packages/x/src/renamed.md"));
    git("add", "-N", "packages/x/src/renamed.md");
    submitPrompt({ env: { REVIEW_LOOP_PATHS: paths } });
    expect(fire({ env: { REVIEW_LOOP_PATHS: paths } }), "first ask").not.toBeNull();
    submitPrompt({ env: { REVIEW_LOOP_PATHS: paths } });
    edit("TODO.md", "# touched\n", BASE + 500);
    expect(
      fire({ env: { REVIEW_LOOP_PATHS: paths } }),
      "an EXCLUDED file moved; a leaked phantom would re-arm on it",
    ).toBeNull();
  });

  it("re-arms on chmod of an ALREADY-dirty file — the key carries mode", () => {
    // Finding 7 of round 2. When chmod moves a CLEAN file into the dirty set the
    // path itself is new, so any key notices. The case that needs mode in the key
    // is a file that was ALREADY dirty: same path, same mtime, same size.
    edit("packages/x/src/tool.sh", "#!/bin/sh\necho hi\n", BASE);
    commitAll();
    edit("packages/x/src/tool.sh", "#!/bin/sh\necho bye\n", BASE);
    submitPrompt();
    expect(fire(), "first ask, file already dirty").not.toBeNull();
    submitPrompt();
    fs.chmodSync(path.join(repo, "packages/x/src/tool.sh"), 0o755);
    setMtime(path.join(repo, "packages/x/src/tool.sh"), BASE); // mtime and size unmoved
    expect(fire(), "only the mode changed, and it is reviewable").not.toBeNull();
  });

  it("still discriminates filenames with spaces and non-ASCII", () => {
    // Both files exist in the baseline; only one of them then changes. A hook that
    // mangled -z paths would compute a key that cannot track either of them.
    edit("packages/x/src/te st.ts", "export const a = 1;\n", BASE);
    edit("packages/x/src/tëst.ts", "export const b = 1;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask covers both").not.toBeNull();
    submitPrompt();
    expect(fire(), "neither moved").toBeNull();
    submitPrompt();
    edit("packages/x/src/tëst.ts", "export const b = 22;\n", BASE);
    expect(fire(), "the non-ASCII one moved, same second").not.toBeNull();
  });

  it("still re-arms on a same-second edit to an already-dirty file", () => {
    // Equal size AND the same second is the documented blind spot, so the fixture
    // changes length: this asserts the mtime+size key still discriminates with the
    // turn comparison layered on top, not that the blind spot was closed.
    edit("packages/x/src/committed.ts", "export const a = 2;\n", BASE);
    submitPrompt();
    expect(fire(), "first ask of the session").not.toBeNull();
    submitPrompt();
    expect(fire(), "baseline matches").toBeNull();
    submitPrompt();
    edit("packages/x/src/committed.ts", "export const a = 30;\n", BASE);
    expect(fire(), "same second, different size").not.toBeNull();
  });
});

describe("the message", () => {
  it("does not claim the user wrote the code", () => {
    // In a shared checkout "Just written code?" asserts something about YOU that
    // is false, and stays false for the concurrent writes the turn window cannot
    // exclude. A nudge that is wrong about what you did erodes compliance faster
    // than one that is merely frequent.
    edit("packages/x/src/committed.ts", "export const a = 2;\n");
    const msg = fire()!;
    expect(msg, "false authorship claim").not.toContain("Just written");
    // THE HEADER IS DELETED. "Unreviewed changes in the tree?" was unconditional
    // while the code LINE became conditional, so a plan-only turn on a clean tree
    // still asserted it — a question with nothing under it. Each part is now a
    // complete sentence carrying its own claim.
    expect(msg, "the header must not have survived").not.toContain("Unreviewed changes in the tree?");
    expect(msg).toContain("Code has changed since the last review");
    expect(msg.split("\n").length, "the line cap still stands").toBeLessThan(13);
  });
});
