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

// REVIEW_LOOP_SETUP points the suite at a COPY, so a mutation harness never has
// to edit the real file. AGENTS.md requires this and setup lacked it, so today's
// mutation runs edited the working tree — visible to a reviewer as the file
// changing under them mid-review.
const SETUP = process.env.REVIEW_LOOP_SETUP
  ? path.resolve(process.env.REVIEW_LOOP_SETUP)
  : path.resolve(__dirname, "../setup");
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
  // CLAUDECODE is set for anything a Claude session spawns, INCLUDING this test
  // runner. Inheriting it made the whole activation suite green only because of
  // where it happened to run: `env -u CLAUDECODE npx vitest run` went red, so a
  // plain-terminal `npm test` or the first CI job would have failed on a release
  // that passed here. Strip it, and let each test declare the context it means.
  // REVIEW_LOOP_SETUP points at a COPY, whose $SRC resolves to the copy's own
  // directory — which has no hooks/, so the source guard kills every run and a
  // mutation measures nothing. The two mechanisms have to compose or the harness
  // reports 26/29 kills for a one-line change. That is the false-KILLED this file
  // already fixed twice, reappearing in the fixture instead of the script.
  const base: Record<string, string> = {
    ...process.env,
    REVIEW_LOOP_IMPL: impl,
    REVIEW_LOOP_SRC: path.resolve(__dirname, ".."),
  } as Record<string, string>;
  delete base.CLAUDECODE;
  delete base.CLAUDE_CODE_SESSION_ID;
  return spawnSync("bash", [SETUP, ...args], { cwd: repo, encoding: "utf8", env: { ...base, ...env } });
}
const inSession = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" };

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

describe("setup — activation, the thing that made it look broken", () => {
  // Claude Code reads settings.json at STARTUP, so installing mid-session
  // registers nothing that runs. setup used to print "installed." and exit 0.
  //
  // THE CONSTRAINT THAT SHAPES ALL OF THIS: `CLAUDE_PROJECT_DIR` is not exported
  // into a spawned shell, so setup CANNOT know which project the calling session
  // is in. An earlier version compared $TARGET to $PWD and claimed to know. It was
  // wrong three ways, the worst being `cd /B && setup` from a session whose
  // project is /A: the paths match, it says "restart THIS session", and
  // `claude --continue` reopens /A, whose settings were never touched. Told it is
  // active, gets silence — the failure this notice exists to prevent.
  //
  // So the notice NAMES THE DIRECTORY and never asserts which project you are in.

  // The claim is about THE NOTICE, so assert on the notice — not on all of stdout,
  // where the install summary already prints "shim: $TARGET/..." and makes any
  // whole-output assertion pass for free. That is how the first version of this
  // test survived a mutant that stripped the directory from the notice entirely.
  // A FRESH repo per context. Reusing one made the second call a no-op run, so the
  // assertion labelled "in-session" was silently testing the no-op branch — and a
  // mutant deleting $TARGET from the fresh headline survived all 23 tests.
  const freshNotice = (env: Record<string, string> = {}) => {
    const r = fs.mkdtempSync(path.join(tmp, "fresh-"));
    spawnSync("git", ["init", "-q", "."], { cwd: r });
    const res = spawnSync("bash", [SETUP, "--target", r], {
      cwd: r, encoding: "utf8",
      env: (() => { const b: Record<string,string> = { ...process.env, REVIEW_LOOP_IMPL: impl,
                      REVIEW_LOOP_SRC: path.resolve(__dirname, "..") } as Record<string,string>;
                    delete b.CLAUDECODE; delete b.CLAUDE_CODE_SESSION_ID; return { ...b, ...env }; })(),
    });
    return { out: res.stdout, tail: res.stdout.trim().split("\n").slice(-6).join("\n"), dir: r };
  };

  it("always names the directory it installed into", () => {
    // NOTE, corrected: narrowing from whole-stdout to the last 6 lines did NOT buy
    // the coverage an earlier comment here claimed. Both branches print the
    // '$TARGET' command block, so removing the directory from the fresh headline
    // alone still passes. The headline is pinned by the fresh-branch test above.
    const term = freshNotice();
    expect(term.tail, "terminal case must name the target IN THE NOTICE").toContain(term.dir);
    const sess = freshNotice(inSession);
    expect(sess.tail, "in-session FRESH case must name it too").toContain(sess.dir);
  });

  it("the fresh in-session notice HEDGES — it never says you are covered", () => {
    // The assertion this file was missing. A mutant replacing the fresh wording
    // with "this session is now covered and will nudge you from here on" — the
    // precise lie this whole change exists to prevent — passed all 23 tests,
    // because the only guards were negative matches on strings that appear
    // nowhere in setup. Negative-only assertions cannot fail; AGENTS.md calls
    // this out and the file broke the rule anyway.
    const out = freshNotice(inSession).out;
    expect(out, "must say the running session does NOT have it yet")
      .toMatch(/does not have|not have (it|them)|already running/i);
    expect(out, "and must never claim the opposite").not.toMatch(/is now covered|will nudge you from here/i);
  });

  it("prints a command that survives a path with spaces", () => {
    // The whole point of this notice is a RUNNABLE command. Unquoted, a repo at
    // "/x/my repo" printed `cd /x/my repo && claude`, which cds to /x/my.
    const spaced = path.join(tmp, "my repo with spaces");
    fs.mkdirSync(spaced, { recursive: true });
    spawnSync("git", ["init", "-q", "."], { cwd: spaced });
    const res = spawnSync("bash", [SETUP, "--target", spaced], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_IMPL: impl, REVIEW_LOOP_SRC: path.resolve(__dirname, ".."), CLAUDECODE: "" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout, "the path must be quoted or the command does not run")
      .toMatch(/'[^']*my repo with spaces[^']*'/);
  });

  it("never claims to know which project the session is in", () => {
    const out = run([], inSession).stdout;
    // NEGATIVE-ONLY ASSERTIONS CANNOT FAIL, and this file has now produced eight
    // of them. Proven: a mutant that made say_activation print NOTHING left this
    // test green. The positive companion is what gives it teeth.
    expect(out, "the notice must actually be present").toMatch(/registered in/);
    expect(out, "it cannot know this, so it must not assert it")
      .not.toMatch(/NOT ACTIVE IN THIS SESSION|this session will not/i);
  });

  it("from a plain terminal: says how to START, with nothing to exit", () => {
    const out = run().stdout;
    expect(out, "must name the command that starts it").toMatch(/cd .* && claude/);
    expect(out, "must explain that nothing runs until startup")
      .toMatch(/at startup|not active|until you start/i);
    // setup says "exit and run:", so match THAT — the old assertion was on a
    // string that appears nowhere in the script and could never fire.
    expect(out, "nothing to exit from a terminal").not.toMatch(/exit and run/);
  });

  it("from inside a session: offers --continue AND --resume, and says the conversation survives", () => {
    const out = run([], inSession).stdout;
    expect(out, "--continue is the lossless one").toMatch(/claude --continue/);
    expect(out, "--resume is the other option").toMatch(/claude --resume/);
    expect(out, "nobody runs it unless told the transcript survives")
      .toMatch(/keep|preserv|without losing|same conversation/i);
  });

  it("says it LAST, where it will actually be read", () => {
    // This test has now been wrong twice. `/claude\b/` matched the line ABOVE the
    // notice — "commit .claude/ yourself" — so a mutant moving the notice to the
    // top survived all 137 tests. Assert the actual terminal line.
    const lines = run([], inSession).stdout.trim().split("\n").filter(Boolean);
    expect(lines[lines.length - 1], "the notice must be the last thing printed")
      .toMatch(/claude --resume|cd .* && claude/);
  });

  it("does not state as fact what it cannot know, on the no-op path", () => {
    run([], inSession);
    const out = run([], inSession).stdout;
    expect(out, "no-op path must still mention activation").toMatch(/startup|claude/i);
    expect(out, "must hedge rather than assert").toMatch(/if you|already restarted|installed (it )?during/i);
  });

  it("does not claim an UPGRADE is dead when the old registration is live", () => {
    // "fresh" means settings.json changed, NOT "never installed". Re-running with
    // new --paths from a session where the hook is already firing changed the file,
    // and the old wording said "nothing registered here will fire" — flatly false.
    run([], inSession);
    const out = run(["--paths", ". :(exclude)notes.md"], inSession).stdout;
    // Same shape as above: the negative alone survives deleting the whole notice.
    // Assert the FRESH branch was actually taken — that is what the test is named
    // for and what was never checked.
    expect(out, "a settings change takes the fresh branch").toMatch(/registered in/);
    expect(out, "the existing registration IS firing; only the change is pending")
      .not.toMatch(/nothing registered here will fire/i);
  });

  it("refuses a source tree missing the SHIM, without touching the machine copy", () => {
    // The named-cause guard checked only hooks/review-loop.sh. With a $SRC holding
    // the hook but not the shim, setup sailed past it and died at `install:` with
    // no setup: prefix — AND it had already overwritten $IMPL, the single copy
    // every shimmed repo on this machine executes.
    const badSrc = fs.mkdtempSync(path.join(tmp, "badsrc-"));
    fs.mkdirSync(path.join(badSrc, "hooks"));
    fs.writeFileSync(path.join(badSrc, "hooks/review-loop.sh"), "#!/bin/sh\necho impostor\n");
    fs.mkdirSync(path.dirname(impl), { recursive: true });
    fs.writeFileSync(impl, "#!/bin/sh\necho ORIGINAL\n");
    const before = fs.readFileSync(impl, "utf8");
    const res = run([], { REVIEW_LOOP_SRC: badSrc });
    expect(res.status, "must refuse").not.toBe(0);
    expect(res.stderr, "must name the cause, not leave install(1) to explain")
      .toMatch(/setup:.*(shim|review-loop-shim)/i);
    expect(fs.readFileSync(impl, "utf8"), "must not have clobbered the machine copy")
      .toBe(before);
  });

  it("names the source it installed FROM, not just what it installed", () => {
    // REVIEW_LOOP_SRC turns "install from the repo you are in" into "install from
    // anywhere". A stale one left in a profile silently downgrades every repo, and
    // the summary gave no way to see it.
    // The label alone passed against `echo "  source:"` with no value — and the
    // whole point is that a stale REVIEW_LOOP_SRC becomes VISIBLE.
    expect(run().stdout, "the summary must show the source PATH, not just a label")
      .toContain(path.resolve(__dirname, ".."));
  });

  it("survives a --paths value containing a double quote", () => {
    // END TO END, because the weaker version passed against a mangled command.
    // An unescaped value with an ODD number of quotes does not parse at all: the
    // registered command is installed-looking, permanently silent, and committed
    // for everyone who clones. That is the 0.2.2 failure mode made durable.
    // A SINGLE quote, not a double one: the naive `printf "'%s'"` handles doubles
    // fine, so the earlier version exercised the wrapper and never the escape.
    // `don't` is what an ordinary directory name looks like.
    expect(run(["--paths", `. :(exclude)don't-touch/`]).status).toBe(0);
    const cmd = ourHooks("Stop")[0].command as string;
    // Run the registered command for real, with $CLAUDE_PROJECT_DIR pointing at a
    // stub that records that it was invoked and what it was handed.
    const stub = fs.mkdtempSync(path.join(tmp, "stub-"));
    fs.mkdirSync(path.join(stub, ".claude/hooks"), { recursive: true });
    const marker = path.join(stub, "ran");
    fs.writeFileSync(path.join(stub, ".claude/hooks/review-loop.sh"),
      `#!/bin/sh\nprintf '%s' "$REVIEW_LOOP_PATHS" > '${marker}'\n`);  // quoted: a test about quoting must quote
    fs.chmodSync(path.join(stub, ".claude/hooks/review-loop.sh"), 0o755);
    const res = spawnSync("bash", ["-c", cmd], {
      encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: stub },
    });
    expect(res.status, `the registered command must run: ${res.stderr}`).toBe(0);
    expect(fs.existsSync(marker), "the hook was never invoked by its own registration").toBe(true);
    expect(fs.readFileSync(marker, "utf8"), "and the pathspec must arrive intact")
      .toBe(`. :(exclude)don't-touch/`);
  });

  it("quotes the path in the IN-SESSION command too", () => {
    // The spaces test only ever reached the terminal branch, so a mutant dropping
    // the quotes from the in-session line survived all 25 tests.
    const spaced = path.join(tmp, "in session spaces");
    fs.mkdirSync(spaced, { recursive: true });
    spawnSync("git", ["init", "-q", "."], { cwd: spaced });
    const res = spawnSync("bash", [SETUP, "--target", spaced], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_IMPL: impl, REVIEW_LOOP_SRC: path.resolve(__dirname, ".."), ...inSession },
    });
    expect(res.stdout, "in-session line must quote the path")
      .toMatch(/'[^']*in session spaces[^']*'/);
  });

  // SPLIT ON PURPOSE. As one test the corrupt-path assertions DOMINATED the
  // locked-path ones: every ordering mutant that reached the lock tripped the
  // corrupt branch first and died there, so the lock assertions could not fail
  // and were covering nothing. Two refusal paths, two kills.
  const stale = () => {
    run();                                   // establish .claude/ and both files
    const shimPath = path.join(repo, ".claude/hooks/review-loop.sh");
    fs.writeFileSync(shimPath, "#!/bin/sh\necho OLD-SHIM\n");
    fs.writeFileSync(impl, "#!/bin/sh\necho OLD-IMPL\n");
    return shimPath;
  };
  const untouched = (shimPath: string, why: string) => {
    expect(fs.readFileSync(impl, "utf8"), `${why} replaced $IMPL anyway`).toBe("#!/bin/sh\necho OLD-IMPL\n");
    expect(fs.readFileSync(shimPath, "utf8"), `${why} replaced the shim anyway`).toBe("#!/bin/sh\necho OLD-SHIM\n");
  };

  it("the CORRUPT-settings refusal really changes nothing", () => {
    // Both refusal paths printed "nothing was changed" AFTER replacing $IMPL (the
    // machine-global copy every shimmed repo executes) and the repo's committed
    // shim. A stale REVIEW_LOOP_SRC therefore downgraded the machine copy on any
    // run that then refused, while the message said it had not.
    const shimPath = stale();
    fs.writeFileSync(settingsPath(), '{ "hooks": { BROKEN');
    expect(run().status, "corrupt settings must refuse").not.toBe(0);
    untouched(shimPath, "corrupt path");
  });

  it("the HELD-LOCK refusal really changes nothing", () => {
    const shimPath = stale();
    fs.writeFileSync(settingsPath(), "{}");
    fs.mkdirSync(path.join(repo, ".claude/settings.json.lock"), { recursive: true });
    expect(run().status, "held lock must refuse").not.toBe(0);
    untouched(shimPath, "locked path");
  });

  it("the NO-OP path reports what it actually did to the machine copy", () => {
    // The installs sit above the no-op check ON PURPOSE — updating $IMPL is why
    // you re-run setup. The bug was saying "nothing changed" afterwards, with no
    // source: line, on the most common invocation there is. A stale
    // REVIEW_LOOP_SRC silently downgraded the copy every shimmed repo executes,
    // and exited 0.
    run();
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stdout, "must name the source it installed FROM").toContain(path.resolve(__dirname, ".."));
    expect(res.stdout, "must name the implementation it wrote").toContain(impl);
    expect(res.stdout, "must not claim nothing happened when $IMPL was rewritten")
      .not.toMatch(/nothing changed\.$/m);
  });

  it("refuses an unmergeable settings.json before touching anything outside the repo", () => {
    // `jq .` accepts any valid JSON, but the merge indexes it as an object. A
    // top-level array parses and then fails the merge — and that refusal ran
    // AFTER the installs, so it replaced $IMPL and said nothing was changed.
    run();
    const before = fs.readFileSync(impl, "utf8");
    fs.writeFileSync(impl, "#!/bin/sh\necho OLD\n");
    fs.writeFileSync(settingsPath(), "[]");
    const res = run();
    expect(res.status, "must refuse").not.toBe(0);
    expect(fs.readFileSync(impl, "utf8"), "must not have rewritten the machine copy")
      .toBe("#!/bin/sh\necho OLD\n");
    expect(res.stderr, "must not leak a raw jq: line").not.toMatch(/^jq:/m);
    expect(res.stderr, "must name itself").toMatch(/setup:/);
    expect(before.length).toBeGreaterThan(0);
  });

  it("installs into the named target even with CDPATH set", () => {
    // `cd` ECHOES the resolved path when it resolves via $CDPATH, and command
    // substitution concatenates that with pwd — so $TARGET became a two-line
    // string and everything downstream used it. With a mismatched CDPATH the shim
    // and settings.json landed in a DIFFERENT repo while the named one stayed
    // empty, and setup printed "installed." and exited 0.
    const parent = fs.mkdtempSync(path.join(tmp, "cdp-"));
    const named = path.join(parent, "myrepo");
    fs.mkdirSync(named);
    spawnSync("git", ["init", "-q", "."], { cwd: named });
    const res = spawnSync("bash", [SETUP, "--target", "myrepo"], {
      cwd: parent, encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_IMPL: impl,
             REVIEW_LOOP_SRC: path.resolve(__dirname, ".."), CDPATH: ".:/nonexistent" },
    });
    expect(res.status, `setup failed: ${res.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(named, ".claude/settings.json")),
      "the NAMED repo must be the one that got the install").toBe(true);
    expect(fs.readdirSync(parent).filter((f) => f !== "myrepo"),
      "nothing may be created beside it").toEqual([]);
  });

  it("refuses a target it cannot enter, instead of operating on /", () => {
    // `[ -d ]` passes for a directory with no +x. cd then fails, $TARGET becomes
    // "", and setup proceeds against /.claude — which on Linux as root creates a
    // real registration at the filesystem root and reports success.
    const noexec = fs.mkdtempSync(path.join(tmp, "noexec-"));
    fs.chmodSync(noexec, 0o600);
    try {
      const res = run(["--target", noexec]);
      expect(res.status, "must refuse rather than fall back to /").not.toBe(0);
      expect(res.stderr, "must name itself and the cause").toMatch(/setup:.*(enter|cannot)/i);
      expect(res.stderr, "must not leak a bare cd: line").not.toMatch(/^[^s].*cd:/m);
    } finally { fs.chmodSync(noexec, 0o700); }
  });

  it("does not silently strip REVIEW_LOOP_PATHS on a plain re-run", () => {
    // README prescribes "re-run ./setup to update", and doing so rebuilt the
    // command from an empty $PATHS — reverting the repo's committed standard and
    // reporting "installed." with no mention of the removal.
    run(["--paths", ". :(exclude)prototypes/"]);
    const before = ourHooks("Stop")[0].command as string;
    expect(before).toContain("prototypes/");
    expect(run().status).toBe(0);
    expect(ourHooks("Stop")[0].command, "the pathspec must survive a plain re-run")
      .toContain("prototypes/");
  });

  it("refuses when settings.json is not a regular file, instead of moving INTO it", () => {
    // `mv -f "$TMP" "$SETTINGS"` with a DIRECTORY at $SETTINGS moves the temp
    // file inside it and returns 0. setup printed "installed.", printed the
    // activation notice and exited 0, leaving a settings.json Claude Code cannot
    // read — installed-looking and permanently silent, which is the one failure
    // this project exists to prevent. Found while testing the mv failure message.
    const sp = settingsPath();
    fs.mkdirSync(sp, { recursive: true });
    fs.writeFileSync(path.join(sp, "occupied"), "x");

    const res = run();
    expect(res.status, "must refuse rather than report success").not.toBe(0);
    expect(res.stderr, "must say what is wrong").toMatch(/setup:.*settings\.json/);
    expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
    expect(fs.readdirSync(sp), "must not have moved anything into it").toEqual(["occupied"]);
    expect(fs.existsSync(impl), "must refuse BEFORE touching the machine copy").toBe(false);
  });

  // install(1) has mv(1)'s "last arg is a directory -> put it inside" behaviour and
  // returns 0. The settings.json guard fixed ONE of three destinations; these are
  // the two siblings it did not look for. Worse than the original: the result is
  // COMMITTED, every turn then exits 126 leaking bare stderr, and `[ -x ]` is true
  // for a searchable directory so the v0.2.1 shim guard does not catch it either.
  for (const dest of ["impl", "shim"] as const) {
    it(`refuses when the ${dest} destination is a directory, instead of nesting inside it`, () => {
      const p = dest === "impl" ? impl : path.join(repo, ".claude/hooks/review-loop.sh");
      fs.mkdirSync(p, { recursive: true });
      const res = run();
      expect(res.status, "must refuse rather than report success").not.toBe(0);
      expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
      expect(res.stderr, "must say which path is wrong").toContain(p);
      expect(fs.readdirSync(p), "must not have nested anything inside").toEqual([]);
    });
  }

  it("refuses a shim destination symlinked to a directory, without writing outside the repo", () => {
    const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
    const hooks = path.join(repo, ".claude/hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.symlinkSync(outside, path.join(hooks, "review-loop.sh"));
    const res = run();
    expect(res.status, "must refuse").not.toBe(0);
    expect(fs.readdirSync(outside), "nothing may be written outside the target repo").toEqual([]);
  });

  it("carries a prefix forward even when it is not REVIEW_LOOP_PATHS", () => {
    // The fix's own comment says the bug was "a second assignment ahead of it — a
    // STATE DIR, an env wrapper — dropped BOTH". A state-dir-only prefix was still
    // dropped, and the condition was entirely uncovered: broadening it to carry any
    // prefix survived all 43 tests.
    run();
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = "REVIEW_LOOP_STATE_DIR=/var/tmp " + h.command;
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    expect(run().status).toBe(0);
    expect(ourHooks("Stop")[0].command, "a committed standard must survive a plain re-run")
      .toContain("REVIEW_LOOP_STATE_DIR=/var/tmp");
  });

  it("names itself when the SHIM install fails, not just the machine copy", () => {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude/hooks"), "i am a file");
    const res = run();
    expect(res.status).not.toBe(0);
    expect(res.stderr, "must name itself").toMatch(/setup: could not install the shim/);
    expect(res.stderr, "must not leak a bare install:/mkdir: line").not.toMatch(/^(install|mkdir):/m);
  });

  it("names itself when .claude cannot be created", () => {
    fs.writeFileSync(path.join(repo, ".claude"), "i am a file");
    const res = run();
    expect(res.status).not.toBe(0);
    expect(res.stderr, "must name itself").toMatch(/setup:.*\.claude/);
    expect(res.stderr, "must not leak a bare mkdir: line").not.toMatch(/^mkdir:/m);
  });

  it("keeps other committed assignments when --paths is given", () => {
    // The carry-forward was fixed in the `else` branch only. `--paths` — the
    // invocation the README documents — still rebuilt from scratch and discarded a
    // committed REVIEW_LOOP_PLANS_DIR on all three events, silently. Dropping the
    // plans dir silences the plan trigger, and on a clean tree only a plan
    // produces an ask, so those nudges go permanently missing.
    run();
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = "REVIEW_LOOP_PLANS_DIR=/team/plans " + h.command;
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    expect(run(["--paths", ". :(exclude)vendor/"]).status).toBe(0);
    const cmd = ourHooks("Stop")[0].command as string;
    expect(cmd, "the new pathspec must be applied").toContain("vendor/");
    expect(cmd, "and the committed plans dir must survive it").toContain("REVIEW_LOOP_PLANS_DIR=/team/plans");
  });

  it("replaces a previous pathspec out loud rather than silently", () => {
    run(["--paths", "old/"]);
    const res = run(["--paths", "new/"]);
    expect(ourHooks("Stop")[0].command).toContain("new/");
    expect(res.stdout + res.stderr, "a removal must be reported").toMatch(/REVIEW_LOOP_PATHS/);
  });

  it("refuses when the machine copy and the shim are the same file", () => {
    // With $TARGET == $HOME the two destinations collide. Both guards pass (one
    // regular file), the impl is installed, then the shim is installed OVER it —
    // so the shim becomes its own $IMPL, `[ -x ]` is true, and it execs itself
    // until the turn times out. Committed, exit 0, "installed.", never fires.
    const res = run([], { REVIEW_LOOP_IMPL: path.join(repo, ".claude/hooks/review-loop.sh") });
    expect(res.status, "must refuse the collision").not.toBe(0);
    expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
    expect(res.stderr, "must explain the collision").toMatch(/setup:.*same/i);
  });

  it("samples the prefix from a registration that has one", () => {
    // `first` took whichever review-loop command jq reached first in FILE order.
    // A legacy or bare SessionStart entry therefore discarded a prefix committed
    // on the other two events.
    run();
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = "REVIEW_LOOP_PLANS_DIR=/team/plans " + h.command;
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    expect(run().status).toBe(0);
    expect(ourHooks("Stop")[0].command, "a prefix on two of three events must survive")
      .toContain("REVIEW_LOOP_PLANS_DIR=/team/plans");
  });

  it("rebuilds a legacy registration instead of pinning it, when it is sampled first", () => {
    // The test that READS as the legacy-form test stales the LAST Stop entry,
    // while the prefix is sampled from the FIRST match in file order — so it
    // never reached this branch. Put the legacy form where it is actually
    // sampled, or the "never pin a stale command" rule has no test at all.
    run();
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const g of j.hooks.SessionStart)
      for (const h of g.hooks)
        if (String(h.command).includes("review-loop.sh"))
          h.command = "OLD " + h.command;
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    expect(run().status).toBe(0);
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      expect(ourHooks(ev)[0].command, `${ev} must be rebuilt, never pinned`).not.toContain("OLD ");
  });

  it("leaves nothing behind in the repo when a guard refuses", () => {
    fs.mkdirSync(impl, { recursive: true });
    const res = run();
    expect(res.status).not.toBe(0);
    expect(fs.readdirSync(repo).filter((f) => f !== ".git"),
      "a refusal that says 'nothing was changed' must change nothing").toEqual([]);
  });

  it("refuses when .claude/hooks is symlinked onto the machine copy's directory", () => {
    // The collision check resolved $IMPL physically and compared it against a RAW
    // "$TARGET/.claude/hooks" — one operand of two. With .claude/hooks symlinked
    // to ~/.claude/hooks (the "share one hooks dir" dotfiles pattern) the shim was
    // installed OVER the machine-global implementation that every shimmed repo on
    // the machine executes, and then exec'd itself to the 10s timeout. Exit 0.
    const machineHooks = path.dirname(impl);
    fs.mkdirSync(machineHooks, { recursive: true });
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.symlinkSync(machineHooks, path.join(repo, ".claude/hooks"));

    const res = run();
    expect(res.status, "must refuse the collision").not.toBe(0);
    expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
    expect(fs.existsSync(impl), "the machine copy must not be created or replaced").toBe(false);
  });

  it("refuses --paths when an assignment follows the committed pathspec", () => {
    // CARRIED splits on REVIEW_LOOP_PATHS= and keeps only what PRECEDES it, so an
    // assignment AFTER the pathspec was deleted from all three registrations with
    // nothing said. Losing REVIEW_LOOP_PLANS_DIR silences the plan trigger while
    // the git trigger keeps firing and masks it.
    run(["--paths", "old/"]);
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = String(h.command).replace(
              /(REVIEW_LOOP_PATHS='[^']*' )/, "$1REVIEW_LOOP_PLANS_DIR=/team/plans ");
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    const res = run(["--paths", "new/"]);
    expect(res.status, "must refuse rather than delete it silently").not.toBe(0);
    expect(res.stderr, "must name what it cannot safely rewrite").toMatch(/REVIEW_LOOP_PLANS_DIR|after/i);
    expect(ourHooks("Stop")[0].command, "and must have changed nothing")
      .toContain("REVIEW_LOOP_PLANS_DIR=/team/plans");
  });

  for (const [label, prefix] of [["an env(1) wrapper", "env REVIEW_LOOP_PLANS_DIR=/team/plans "],
                                 ["leading whitespace", "  REVIEW_LOOP_PLANS_DIR=/team/plans "]] as const) {
    it(`carries a prefix with ${label} through a plain re-run`, () => {
      // Judging the prefix by its FIRST WORD alone cannot tell `env` from `OLD`,
      // so this regressed forms the previous code carried. `env VAR=x cmd` is a
      // standard idiom and the command is run through a shell, so it works.
      run();
      const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
        for (const g of j.hooks[ev])
          for (const h of g.hooks)
            if (String(h.command).includes("review-loop.sh")) h.command = prefix + h.command;
      fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

      expect(run().status).toBe(0);
      expect(ourHooks("Stop")[0].command, "a committed standard must survive")
        .toContain("REVIEW_LOOP_PLANS_DIR=/team/plans");
    });
  }

  it("rebuilds a legacy command that happens to carry an assignment", () => {
    // The "tail did not match" reset had no test: a legacy ABSOLUTE-path command
    // that also carries an assignment passes the assignment rule, so without the
    // reset its whole body was glued in front of the new tail, writing an
    // unrunnable command to all three events and exiting 0.
    run();
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const g of j.hooks.SessionStart)
      for (const h of g.hooks)
        if (String(h.command).includes("review-loop.sh"))
          h.command = "REVIEW_LOOP_PATHS=stale /abs/legacy/review-loop.sh";
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    expect(run().status).toBe(0);
    const cmd = ourHooks("Stop")[0].command as string;
    expect(cmd, "the legacy body must not be glued in front").not.toContain("/abs/legacy/");
    expect(cmd.startsWith("\"$CLAUDE_PROJECT_DIR") || cmd.includes("REVIEW_LOOP"),
      `must be a runnable command, got: ${cmd}`).toBe(true);
  });

  it("announces a cleared pathspec, not just a replaced one", () => {
    run(["--paths", "old/"]);
    const res = run(["--paths", ""]);
    expect(res.stdout + res.stderr, "the removal must be reported").toMatch(/cleared.*REVIEW_LOOP_PATHS/i);
  });

  it("refuses the collision BEFORE either install runs", () => {
    // The refusal says "Nothing was changed." Below the installs that sentence is
    // false in the worst way: the shim has by then been written over the machine
    // copy, which is the very damage being refused.
    // It asserted on `impl` — a path THIS invocation never writes, because
    // REVIEW_LOOP_IMPL is redirected into the repo. So it passed with the guard
    // moved below the installs, i.e. it could not fail for the ordering it was
    // added to pin. Assert on the destination the run actually targets.
    const dest = path.join(fs.realpathSync(repo), ".claude/hooks/review-loop.sh");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "#!/bin/sh\necho ORIGINAL\n");
    const res = run([], { REVIEW_LOOP_IMPL: dest });
    expect(res.status).not.toBe(0);
    expect(fs.readFileSync(dest, "utf8"), "the collision target must be untouched")
      .toBe("#!/bin/sh\necho ORIGINAL\n");
  });

  it("does not claim it replaced REVIEW_LOOP_PATHS when it only matched a longer name", () => {
    // `${PREFIX%%REVIEW_LOOP_PATHS=*}` is an unanchored substring match, so
    // MY_REVIEW_LOOP_PATHS= split mid-token: the summary announced a replacement
    // of a variable that was never set.
    run();
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = "MY_REVIEW_LOOP_PATHS=team " + h.command;
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    const res = run(["--paths", "src/"]);
    expect(res.status).toBe(0);
    expect(res.stdout + res.stderr, "nothing was replaced").not.toMatch(/replaced the REVIEW_LOOP_PATHS/);
    expect(ourHooks("Stop")[0].command, "and the foreign variable must survive intact")
      .toContain("MY_REVIEW_LOOP_PATHS=team");
  });

  it("refuses a DANGLING .claude/hooks symlink aimed at the machine copy", () => {
    // resolve_dir walked up while `! -d`. A dangling symlink is not -d, so the
    // component was re-appended TEXTUALLY and the paths compared unequal. Then the
    // $IMPL install CREATED the machine hooks dir, which made the symlink live, so
    // the shim install wrote through it onto $IMPL. This is the fresh-clone state
    // of the dotfiles pattern: the symlink is committed, the machine dir is not
    // there yet. The round-11 test only built the already-existing state.
    const machineHooks = path.dirname(impl);
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.symlinkSync(machineHooks, path.join(repo, ".claude/hooks"));   // dangling
    expect(fs.existsSync(machineHooks), "precondition: the target must NOT exist").toBe(false);

    const res = run();
    expect(res.status, "must refuse").not.toBe(0);
    expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
    expect(fs.existsSync(impl), "nothing may be written outside the repo").toBe(false);
  });

  for (const [label, sep] of [["a tab", "\t"], ["a newline", "\n"]] as const) {
    it(`refuses --paths when ${label} separates a following assignment`, () => {
      // The detector knew only about a SPACE separator, so any other whitespace
      // silently deleted the committed assignment from all three registrations.
      run(["--paths", "old/"]);
      const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
      for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
        for (const g of j.hooks[ev])
          for (const h of g.hooks)
            if (String(h.command).includes("review-loop.sh"))
              h.command = String(h.command).replace(
                /(REVIEW_LOOP_PATHS='[^']*') /, `$1${sep}REVIEW_LOOP_PLANS_DIR=/team/plans `);
      fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

      const res = run(["--paths", "new/"]);
      expect(res.status, "must refuse rather than delete it").not.toBe(0);
      expect(ourHooks("Stop")[0].command, "the committed standard must survive")
        .toContain("REVIEW_LOOP_PLANS_DIR=/team/plans");
    });
  }

  it("still allows a PLAIN re-run when an assignment follows the pathspec", () => {
    // The refusal message advertises "re-run without --paths" as the way out. If
    // the refusal ever widened to plain re-runs, that escape hatch would be a lie
    // and every documented upgrade would refuse — and it would ship green.
    run(["--paths", "old/"]);
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = String(h.command).replace(
              /(REVIEW_LOOP_PATHS='[^']*' )/, "$1REVIEW_LOOP_PLANS_DIR=/team/plans ");
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    const res = run();
    expect(res.status, "a plain re-run must still work").toBe(0);
    expect(ourHooks("Stop")[0].command, "and must preserve the command verbatim")
      .toContain("REVIEW_LOOP_PLANS_DIR=/team/plans");
  });

  it("does not call two DIFFERENT files in one directory the same file", () => {
    // The check compared directories and ignored basenames, so a machine copy
    // deliberately placed beside the shim was refused with "resolve to the same
    // file" — of two demonstrably different files.
    const res = run([], { REVIEW_LOOP_IMPL: path.join(repo, ".claude/hooks/machine-impl.sh") });
    expect(res.status, "different basenames are different files").toBe(0);
  });

  it("does not hang on a symlink loop", () => {
    // resolve_dir follows symlinks by hand, so a loop is an infinite walk. The
    // counter is the only thing that stops it; without a test it would ship and
    // hang the install rather than fail it.
    const c = path.join(repo, ".claude");
    fs.mkdirSync(c, { recursive: true });
    fs.symlinkSync(path.join(c, "b"), path.join(c, "hooks"));
    fs.symlinkSync(path.join(c, "hooks"), path.join(c, "b"));
    // OWN TIMEOUT, deliberately: run() uses spawnSync with none, so a regression
    // here blocks the worker forever instead of failing. A test that hangs the
    // suite is not a test — it is an outage that looks like a slow build.
    const res = spawnSync("bash", [SETUP], {
      cwd: repo, encoding: "utf8", timeout: 15000,
      env: { ...process.env, REVIEW_LOOP_IMPL: impl,
             REVIEW_LOOP_SRC: path.resolve(__dirname, "..") },
    });
    expect(res.signal, "must not have been killed for spinning").toBeNull();
    expect(res.status, "must fail, not spin").not.toBe(0);
    expect(res.stderr, "must say it cannot resolve the path").toMatch(/setup:.*resolve/i);
  });

  it("refuses when the MACHINE side cannot be resolved, not just the shim side", () => {
    // `IMPL_RESOLVED=$(resolve_dir …)/$(basename …) || refuse` — an assignment
    // exits with the status of the LAST command substitution, and $(basename) always
    // succeeds, so resolve_dir's `return 1` was discarded. The shim line had no
    // trailing substitution, so its guard worked. One line apart: one is a guard,
    // the other is not code. With it dead, an unresolvable $IMPL compares as a
    // bogus "/review-loop.sh", the collision refusal never fires, and the shim is
    // installed over the machine-global copy.
    const machine = path.join(tmp, "machine");
    fs.mkdirSync(machine, { recursive: true });
    fs.symlinkSync(path.join(machine, "b"), path.join(machine, "hooks"));
    fs.symlinkSync(path.join(machine, "hooks"), path.join(machine, "b"));
    const res = spawnSync("bash", [SETUP], {
      cwd: repo, encoding: "utf8", timeout: 15000,
      env: { ...process.env, REVIEW_LOOP_SRC: path.resolve(__dirname, ".."),
             REVIEW_LOOP_IMPL: path.join(machine, "hooks/review-loop.sh") },
    });
    expect(res.signal, "must not have been killed for spinning").toBeNull();
    expect(res.status, "must refuse").not.toBe(0);
    expect(res.stderr, "must say it cannot resolve the machine copy").toMatch(/setup:.*resolve/i);
    expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
  });

  it("refuses a RELATIVE symlink aimed at the machine copy", () => {
    // Both existing symlink tests use ABSOLUTE links. GNU stow — the tool that
    // produces the "share one hooks dir" arrangement this guard was written for —
    // makes RELATIVE links by default, and that branch had no test at all.
    const machineHooks = path.dirname(impl);
    fs.mkdirSync(machineHooks, { recursive: true });
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.symlinkSync(path.relative(path.join(repo, ".claude"), machineHooks),
                   path.join(repo, ".claude/hooks"));

    const res = run();
    expect(res.status, "a relative link is the same collision").not.toBe(0);
    expect(res.stdout, "must not claim it installed").not.toMatch(/installed\./);
  });

  it("names the real problem when a symlink target strips to empty", () => {
    // This guard was deleted as "unreachable — an empty symlink target is not
    // creatable". False: `ln -s $'\n' x` is creatable, readlink exits 0, and
    // command substitution strips the newline to "". Without the guard the walk
    // returns the symlink's own PARENT, and setup refuses with the WRONG message —
    // it says the two paths "resolve to the same file", sending the reader to fix
    // a collision that does not exist. Both paths refuse, so only the MESSAGE can
    // catch this.
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.mkdirSync(path.dirname(impl), { recursive: true });
    fs.writeFileSync(impl, "OLD-IMPL-CONTENT");
    fs.symlinkSync("\n", path.join(repo, ".claude/hooks"));
    const res = run();
    expect(res.status, "must refuse").not.toBe(0);
    expect(res.stderr, "must say it cannot resolve the path").toMatch(/cannot resolve/);
    // THE LOAD-BEARING ASSERTION. The first version asserted stderr did not say
    // "same file" — dead in this fixture, since that branch needs $IMPL inside the
    // repo, which run() never does. What actually moves is whether the machine
    // copy survives: without the guard setup overwrites $IMPL and only THEN fails.
    expect(fs.readFileSync(impl, "utf8"), "the machine-global copy must be untouched")
      .toBe("OLD-IMPL-CONTENT");
  });

  it("keeps the pathspec when another assignment precedes it", () => {
    // The carry-forward only matched a prefix STARTING with REVIEW_LOOP_PATHS=,
    // so any assignment ahead of it — a state dir, an env wrapper — dropped BOTH
    // and printed the full success summary. Same bug the carry-forward exists to
    // prevent, with the assignments in the other order.
    run(["--paths", ". :(exclude)proto/"]);
    const j = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"])
      for (const g of j.hooks[ev])
        for (const h of g.hooks)
          if (String(h.command).includes("review-loop.sh"))
            h.command = "REVIEW_LOOP_STATE_DIR=/var/tmp " + h.command;
    fs.writeFileSync(settingsPath(), JSON.stringify(j, null, 2));

    expect(run().status).toBe(0);
    const after = ourHooks("Stop")[0].command as string;
    expect(after, "the pathspec must survive").toContain("proto/");
    expect(after, "and so must the assignment that preceded it").toContain("REVIEW_LOOP_STATE_DIR=/var/tmp");
  });

  it("clears the pathspec on --paths '' instead of silently keeping the old one", () => {
    // --paths '' fell into the carry-forward branch, restored the pathspec the
    // user had just asked to drop, and reported "no change to settings.json" —
    // asked for the default, told nothing needed doing.
    run(["--paths", ". :(exclude)proto/"]);
    const res = run(["--paths", ""]);
    expect(res.status).toBe(0);
    expect(ourHooks("Stop")[0].command, "an explicit empty pathspec must clear it")
      .not.toContain("proto/");
    expect(res.stdout, "and it must not claim nothing changed").not.toMatch(/already up to date/);
  });

  it("names the target it could not enter", () => {
    // The message read $TARGET_ARG because $TARGET is empty by then — its own
    // assignment is what failed. Reading $TARGET printed "cannot enter" and
    // named nothing, and the existing assertion could not tell the difference.
    const gone = path.join(tmp, "no-such-dir-here");
    const res = run(["--target", gone]);
    expect(res.status).not.toBe(0);
    expect(res.stderr, "the failing path must appear in the message").toContain(gone);
  });

  it("shows jq's own diagnosis when the merge fails, prefixed", () => {
    // Deleting the entire re-run-and-prefix block survived all 36 tests: the
    // existing assertion checks only that no BARE jq: line appears, which an
    // absent diagnosis satisfies. The point of the fix is unasserted without this.
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), "[]");
    const res = run();
    expect(res.status).not.toBe(0);
    expect(res.stderr, "jq's cause must reach the user").toMatch(/setup: jq: .+/);
    expect(res.stderr, "and never unprefixed").not.toMatch(/^jq:/m);
  });

  it("names itself when an install fails, rather than leaking install(1)", () => {
    // install(1)/mkdir(1) reported the failure themselves — no `setup:` prefix,
    // no mention of what was being installed — and it happens AFTER the merge,
    // so it was the only thing the user saw.
    const ro = fs.mkdtempSync(path.join(tmp, "ro-"));
    fs.chmodSync(ro, 0o500);
    try {
      const res = run([], { REVIEW_LOOP_IMPL: path.join(ro, "sub/impl.sh") });
      expect(res.status, "an unwritable $IMPL must fail the run").not.toBe(0);
      expect(res.stderr, "must name itself and what it was doing")
        .toMatch(/setup: could not install/);
      expect(res.stderr, "must not leak a bare install:/mkdir: line")
        .not.toMatch(/^(install|mkdir):/m);
    } finally { fs.chmodSync(ro, 0o700); }
  });

  it("says the machine copy and the shim were REFRESHED on the no-op path", () => {
    // Dropping "(refreshed)" from either line, or deleting the shim line
    // outright, survived every test — the assertions only looked for the paths
    // as substrings, which the misleading wording also satisfies.
    run();
    const res = run();
    expect(res.stdout).toMatch(/already up to date/);
    expect(res.stdout, "the machine copy was rewritten and must say so").toMatch(/implementation:.*\(refreshed\)/);
    expect(res.stdout, "so was the committed shim").toMatch(/shim:.*\(refreshed\)/);
  });

  it("refuses --target with no value instead of dying on an unbound variable", () => {
    const res = run(["--target"], inSession);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/setup:/);
    expect(res.stderr).not.toMatch(/unbound variable/);
  });

  it("refuses --paths with no value too", () => {
    // The --target half was covered and this one was not, so deleting its guard
    // passed the suite.
    const res = run(["--paths"], inSession);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/setup:/);
    expect(res.stderr).not.toMatch(/unbound variable/);
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
      cwd: repo, encoding: "utf8",
      env: { ...process.env, REVIEW_LOOP_IMPL: impl, REVIEW_LOOP_SRC: path.resolve(__dirname, "..") },
    });
    expect(a.status, "the pair should not both fail").toBe(0);
    expect(() => settings(), "settings.json was left unparseable").not.toThrow();
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      expect(ourHooks(ev).length, `${ev} duplicated by the race`).toBe(1);
    }
  });
});
