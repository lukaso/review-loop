/**
 * `setup` — installs the standard into a repo and the implementation onto the machine.
 *
 *   ~/.claude/hooks/review-loop.sh          the implementation (machine, 1 copy)
 *   <repo>/.claude/hooks/review-loop.sh     the shim               (committed)
 *   <repo>/.claude/settings.json            3 registrations        (committed)
 *
 * settings.json is a CONTESTED FILE. chiefofstaff's already carries commit-gate,
 * push-eval-gate and verify-build-gate; another tool in this ecosystem does
 * `git add CLAUDE.md && git commit` with no pathspec and commits the whole index.
 * So the rules here are: merge never replace, preserve everything we did not
 * write, refuse a file we cannot parse, and never touch git.
 *
 * The lock is not ceremony: setup runs on EVERY update, so its write frequency
 * scales with adoption, and a lost update silently deletes somebody's gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SETUP = path.resolve(__dirname, "../setup");
let tmp: string, repo: string, impl: string;

const settingsPath = () => path.join(repo, ".claude/settings.json");
const settings = () => JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
const ourHooks = (ev: string) =>
  (settings().hooks?.[ev] ?? []).flatMap((m: any) => m.hooks ?? [])
    .filter((h: any) => (h.command ?? "").includes("review-loop"));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
  repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  impl = path.join(tmp, "machine", "review-loop.sh");
  spawnSync("git", ["init", "-q", "."], { cwd: repo });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", [SETUP, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, REVIEW_LOOP_IMPL: impl, ...env },
  });
}

describe("setup — a fresh repo", () => {
  it("installs the implementation, the shim, and all three registrations", () => {
    const res = run();
    expect(res.status, `setup failed: ${res.stderr}`).toBe(0);
    expect(fs.existsSync(impl), "machine implementation").toBe(true);
    expect(fs.existsSync(path.join(repo, ".claude/hooks/review-loop.sh")), "committed shim").toBe(true);
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      expect(ourHooks(ev).length, `${ev} registration`).toBe(1);
    }
  });

  it("registers a $CLAUDE_PROJECT_DIR-relative command, never an absolute path", () => {
    // gstack baked its own absolute directory into settings.json; deleting that
    // directory left dead hooks erroring on every AskUserQuestion until v1.67 and
    // needed a repair tool to undo. A relative command cannot rot that way, and
    // it is also the only form that is correct for a teammate or CI.
    run();
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const cmd = ourHooks(ev)[0].command as string;
      expect(cmd, `${ev} must be project-relative`).toContain("$CLAUDE_PROJECT_DIR");
      expect(cmd, `${ev} leaked an absolute path`).not.toContain(os.homedir());
      expect(cmd, `${ev} leaked the temp repo path`).not.toContain(repo);
    }
  });

  it("gives all three registrations the SAME env and timeout", () => {
    // The round-7 finding, as a test: a state dir differing on the SessionStart
    // line alone silently reopens the --resume hole, and a differing
    // REVIEW_LOOP_PATHS makes the two keys incomparable so attribution does
    // nothing. Presence is not enough — they must be equal.
    run(["--paths", ". :(exclude)notes.md"]);
    const cmds = ["SessionStart", "UserPromptSubmit", "Stop"].map((ev) => ourHooks(ev)[0]);
    expect(new Set(cmds.map((h) => h.command)).size, "commands differ across events").toBe(1);
    expect(new Set(cmds.map((h) => h.timeout)).size, "timeouts differ across events").toBe(1);
    expect(cmds[0].command).toContain(':(exclude)notes.md');
  });
});

describe("setup — merging into a contested file", () => {
  const foreign = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/verify-build-gate.sh", timeout: 15 }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./commit-gate.sh" }] }],
    },
    permissions: { allow: ["Bash(npm test)"] },
  };
  const writeForeign = () => {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(foreign, null, 2) + "\n");
  };

  it("preserves every entry it did not write", () => {
    writeForeign();
    expect(run().status).toBe(0);
    const s = settings();
    expect(s.permissions?.allow, "unrelated top-level key dropped").toEqual(["Bash(npm test)"]);
    expect(JSON.stringify(s.hooks.PreToolUse), "foreign event dropped").toContain("commit-gate");
    expect(JSON.stringify(s.hooks.Stop), "foreign Stop hook dropped").toContain("verify-build-gate");
    expect(ourHooks("Stop").length, "and ours was added alongside").toBe(1);
  });

  it("keeps a foreign hook that SHARES a matcher group with ours", () => {
    // The fixture above never puts a foreign hook and ours in one group, so it
    // cannot catch a merge that strips whole groups instead of our items. That
    // mutant survived the entire suite until this test existed — and the damage
    // it does is deleting somebody else's gate, the worst outcome available here.
    // Shared groups are real: a hand-merge or another tool appending produces one.
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/verify-build-gate.sh", timeout: 15 },
            { type: "command", command: "OLD $CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh", timeout: 10 },
          ],
        }],
      },
    }, null, 2) + "\n");
    expect(run().status).toBe(0);
    const stop = JSON.stringify(settings().hooks.Stop);
    expect(stop, "a foreign gate sharing our group was deleted").toContain("verify-build-gate");
    expect(ourHooks("Stop").length, "our stale item was not replaced cleanly").toBe(1);
    expect(ourHooks("Stop")[0].command).not.toContain("OLD ");
  });

  it("is a true no-op on a second run", () => {
    run();
    const before = fs.readFileSync(settingsPath(), "utf8");
    const backupsBefore = fs.readdirSync(path.join(repo, ".claude")).filter((f) => f.includes(".bak")).length;
    const res = run();
    expect(res.status).toBe(0);
    expect(fs.readFileSync(settingsPath(), "utf8"), "second run rewrote the file").toBe(before);
    const backupsAfter = fs.readdirSync(path.join(repo, ".claude")).filter((f) => f.includes(".bak")).length;
    expect(backupsAfter, "second run made a pointless backup").toBe(backupsBefore);
  });

  it("updates a stale registration in place instead of duplicating it", () => {
    run();
    // Simulate an older install: same event, our command, different payload.
    const s = settings();
    s.hooks.Stop[s.hooks.Stop.length - 1].hooks[0].command = "OLD $CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh";
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
    expect(run().status).toBe(0);
    expect(ourHooks("Stop").length, "duplicated instead of updating").toBe(1);
    expect(ourHooks("Stop")[0].command).not.toContain("OLD ");
  });

  it("backs the file up before the first mutation", () => {
    writeForeign();
    run();
    const baks = fs.readdirSync(path.join(repo, ".claude")).filter((f) => f.startsWith("settings.json.bak"));
    expect(baks.length, "no backup written").toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(path.join(repo, ".claude", baks[0]), "utf8")), "backup is not the original")
      .toEqual(foreign);
  });

  it("REFUSES a settings.json it cannot parse, and leaves it alone", () => {
    // Fail closed. "Repairing" a corrupt file means guessing at content someone
    // else owns, and the guess is unreviewable.
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    const junk = '{ "hooks": { "Stop": [ BROKEN';
    fs.writeFileSync(settingsPath(), junk);
    const res = run();
    expect(res.status, "must not exit 0 on a corrupt file").not.toBe(0);
    expect(res.stderr + res.stdout, "must say what is wrong").toMatch(/pars|corrupt|invalid/i);
    expect(fs.readFileSync(settingsPath(), "utf8"), "corrupt file was modified").toBe(junk);
  });

  it("never touches git", () => {
    run();
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).stdout;
    expect(staged.trim(), "setup staged files on the user's behalf").toBe("");
    const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" });
    expect(log.stdout.trim(), "setup committed on the user's behalf").toBe("");
  });
});

describe("setup — the lock", () => {
  const lockDir = () => path.join(repo, ".claude/settings.json.lock");

  it("refuses to run while a fresh lock is held, and says so", () => {
    // gstack SKIPS the mutation and warns, because its system is convergent. Ours
    // is not: a skipped install that reports success is a silent failure, and the
    // user walks away believing the hook is registered.
    run(); // establish .claude/
    fs.mkdirSync(lockDir(), { recursive: true });
    const res = run();
    expect(res.status, "a held lock must not look like success").not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/lock/i);
  });

  it("takes over a lock older than 30 seconds", () => {
    run();
    fs.mkdirSync(lockDir(), { recursive: true });
    const old = Date.now() / 1000 - 120;
    fs.utimesSync(lockDir(), old, old);
    const res = run();
    expect(res.status, `stale lock should have been taken over: ${res.stderr}`).toBe(0);
  });

  it("leaves no lock behind on a normal run", () => {
    expect(run().status).toBe(0);
    expect(fs.existsSync(lockDir()), "lock leaked; the next run would block forever").toBe(false);
  });

  it("survives two runs racing, leaving exactly one registration per event", () => {
    const a = spawnSync("bash", ["-c", `"${SETUP}" & "${SETUP}" & wait`], {
      cwd: repo, encoding: "utf8", env: { ...process.env, REVIEW_LOOP_IMPL: impl },
    });
    expect(a.status, "the pair should not both fail").toBe(0);
    expect(() => settings(), "settings.json was left unparseable").not.toThrow();
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      expect(ourHooks(ev).length, `${ev} duplicated by the race`).toBe(1);
    }
  });
});
