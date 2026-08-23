/**
 * The shim — the committed half of the install.
 *
 *   <repo>/.claude/hooks/review-loop.sh   this shim, committed, ~stable forever
 *        │  exec, passing stdin/args/env straight through
 *        ▼
 *   ~/.claude/hooks/review-loop.sh        the real hook, updated per machine
 *
 * Splitting them is what makes "commit the standard" affordable: the repo commits
 * a few lines that almost never change, and updating the tool costs no commits in
 * any consuming repo.
 *
 * Its whole risk surface is what happens when the machine copy is ABSENT. The
 * answer has to differ per event, because the events have different contracts:
 * Stop may speak, UserPromptSubmit and SessionStart must emit zero bytes. And it
 * must never speak on stderr — that breaks the turn, which is why the hook's own
 * suite asserts stderr === "" on every call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SHIM = path.resolve(__dirname, "../hooks/review-loop-shim.sh");
const REAL = path.resolve(__dirname, "../hooks/review-loop.sh");

let tmp: string, repo: string, stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shim-test-"));
  stateDir = fs.mkdtempSync(path.join(tmp, "state-"));
  repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  spawnSync("git", ["init", "-q", "."], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fire(
  opts: { event?: string; impl?: string | null; session?: string; env?: Record<string, string> } = {},
) {
  const env: Record<string, string> = {
    ...process.env,
    REVIEW_LOOP_STATE_DIR: stateDir,
    REVIEW_LOOP_PLANS_DIR: path.join(tmp, "no-plans"),
    ...(opts.env ?? {}),
  };
  // null = simulate "not installed on this machine" by pointing at a missing path
  env.REVIEW_LOOP_IMPL = opts.impl === undefined ? REAL : (opts.impl ?? path.join(tmp, "absent.sh"));
  const res = spawnSync("bash", [SHIM], {
    input: JSON.stringify({
      session_id: opts.session ?? "shim-1",
      cwd: repo,
      hook_event_name: opts.event ?? "Stop",
      stop_hook_active: false,
    }),
    encoding: "utf8",
    env,
  });
  expect(res.status, `shim must always exit 0; stderr: ${res.stderr}`).toBe(0);
  expect(res.stderr, `shim must never write stderr; got: ${res.stderr}`).toBe("");
  return res.stdout;
}

describe("shim — with the implementation present", () => {
  it("produces byte-identical output to running the hook directly", () => {
    // Each run gets its OWN state dir. Sharing one means whichever runs second
    // sees an unchanged key and stays quiet, and the test then compares a nudge
    // against silence — passing only if you assert the wrong thing.
    const shimState = fs.mkdtempSync(path.join(tmp, "s1-"));
    const directState = fs.mkdtempSync(path.join(tmp, "s2-"));
    const viaShim = fire({ event: "Stop", env: { REVIEW_LOOP_STATE_DIR: shimState } });
    const direct = spawnSync("bash", [REAL], {
      input: JSON.stringify({ session_id: "shim-1", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_STATE_DIR: directState, REVIEW_LOOP_PLANS_DIR: path.join(tmp, "no-plans") },
    }).stdout;
    expect(viaShim, "the shim must be transparent, not merely similar").toBe(direct);
    expect(viaShim, "and the fixture must be one that actually asks").toContain("/code-review");
  });

  it("stays silent on the events whose contract is zero bytes", () => {
    expect(fire({ event: "UserPromptSubmit" })).toBe("");
    expect(fire({ event: "SessionStart" })).toBe("");
  });
});

describe("shim — with the implementation MISSING", () => {
  it("says so in-band on Stop, rather than going quiet", () => {
    // Loud, not silent: a registration pointing at nothing is the same shape as
    // an uninstalled tool, and this repo's rule is that a wrong ask costs a line
    // while a wrong silence loses the work.
    const out = fire({ event: "Stop", impl: null });
    expect(out, "must use the ordinary nudge channel").toContain("hookSpecificOutput");
    const msg = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(msg).toContain("review-loop");
    expect(msg, "must name the fix, not just the problem").toMatch(/setup|install/i);
    expect(JSON.parse(out).decision, "a shim must never block either").toBeUndefined();
  });

  it("still emits ZERO bytes on the prompt and session events", () => {
    // A missing implementation must not change those contracts. Anything on
    // stdout at UserPromptSubmit is injected into the user's prompt.
    expect(fire({ event: "UserPromptSubmit", impl: null })).toBe("");
    expect(fire({ event: "SessionStart", impl: null })).toBe("");
  });

  it("says it ONCE per session, not every turn", () => {
    // Otherwise the not-installed notice becomes the wallpaper the hook's own
    // line cap exists to prevent — and it would arrive on every single turn.
    expect(fire({ event: "Stop", impl: null }), "first turn tells you").not.toBe("");
    expect(fire({ event: "Stop", impl: null }), "second turn does not").toBe("");
    expect(fire({ event: "Stop", impl: null }), "nor the third").toBe("");
    // POSITIVE COMPANION: a different session is told once too.
    expect(fire({ event: "Stop", impl: null, session: "shim-2" }), "a new session is told").not.toBe("");
  });

  it("survives an environment with no HOME", () => {
    // The default implementation path is under $HOME, and two spawn sites in the
    // hook's own suite replace the environment wholesale with no HOME at all.
    const res = spawnSync("bash", [SHIM], {
      input: JSON.stringify({ session_id: "nohome", cwd: repo, hook_event_name: "Stop", stop_hook_active: false }),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", REVIEW_LOOP_STATE_DIR: stateDir },
    });
    expect(res.status, "must not crash under set -u with HOME unset").toBe(0);
    expect(res.stderr).toBe("");
  });

  it("sanitises the session id before using it in a path", () => {
    fire({ event: "Stop", impl: null, session: "../../evil sess" });
    expect(fs.existsSync(path.join(stateDir, "review-loop-uninstalled-______evil_sess")), "sanitised").toBe(true);
  });
});
