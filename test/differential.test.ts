// DIFFERENTIAL HARNESS — bash `setup` vs `node lib/setup.mjs`.
//
// TEMPORARY BY DESIGN. This is the port's primary gate and it has an expiry of
// exactly one commit: backlog items 7 and 8 change behaviour deliberately, so
// parity against bash dies the moment they land. When it does, delete this file —
// do not weaken it. From there the 72 setup tests plus the per-item tests are the
// net.
//
// Every fixture runs in a fresh mkdtemp. NEVER point this at the real repo: doing
// so once performed a live install here, rewrote .claude/settings.json to use a
// shim this repo deliberately does not use, and left a backup behind.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
// The bash original, kept ONLY for this harness. `setup` is now the wrapper, so
// the reference implementation has to live somewhere; it dies with this file.
const BASH = path.join(ROOT, ".baseline/setup-bash");
// Honour the mutation swap point. Hardcoding this meant REVIEW_LOOP_SETUP_LIB
// silently had no effect here, so every mutant "passed" the harness without ever
// being run through it — a measurement of nothing, reported as a result.
const NODE_IMPL = process.env.REVIEW_LOOP_SETUP_LIB
  ? path.resolve(process.env.REVIEW_LOOP_SETUP_LIB)
  : path.join(ROOT, "lib/setup.mjs");

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diff-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Fixture = (repo: string, impl: string) => void;

/** Snapshot everything the run may have touched, with volatile parts normalised. */
function snapshot(repo: string, impl: string) {
  const entries: string[] = [];
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { entries.push(`L ${r} -> ${fs.readlinkSync(p)}`); continue; }
      if (st.isDirectory()) { entries.push(`D ${r}`); walk(p, r); continue; }
      // .bak names carry a second-resolution timestamp; the CONTENT still matters.
      const name = r.replace(/\.bak\.\d{14}$/, ".bak.<stamp>");
      const mode = (st.mode & 0o777).toString(8);
      entries.push(`F ${name} ${mode} ${fs.readFileSync(p, "utf8")}`);
    }
  };
  walk(path.join(repo, ".claude"), ".claude");
  // $IMPL may be a directory or a symlink in a refusal fixture — describe it,
  // do not assume it is readable as a file.
  let implDesc = "IMPL absent";
  try {
    const st = fs.lstatSync(impl);
    if (st.isSymbolicLink()) implDesc = `IMPL -> ${fs.readlinkSync(impl)}`;
    else if (st.isDirectory()) implDesc = `IMPL dir [${fs.readdirSync(impl).sort().join(",")}]`;
    else implDesc = `IMPL ${(st.mode & 0o777).toString(8)} ${fs.readFileSync(impl, "utf8").length}`;
  } catch { /* absent */ }
  entries.push(implDesc);
  return entries.join("\n");
}

function runOne(which: "bash" | "node", fx: Fixture, args: string[], env: Record<string, string>) {
  const base = fs.mkdtempSync(path.join(tmp, which + "-"));
  const repo = path.join(base, "repo");
  const impl = path.join(base, "machine", "review-loop.sh");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "."], { cwd: repo });
  fx(repo, impl);

  const cmd = which === "bash" ? ["bash", [BASH, ...args]] : ["node", [NODE_IMPL, ...args]];
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    REVIEW_LOOP_IMPL: impl,
    REVIEW_LOOP_SRC: ROOT,
    // A fixture cannot know its own temp root, but some cases (a REVIEW_LOOP_IMPL
    // that points THROUGH a symlink) can only be expressed in terms of it.
    ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.split("<BASE>").join(base)])),
  };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_SESSION_ID;
  const res = spawnSync(cmd[0] as string, cmd[1] as string[], {
    cwd: repo, encoding: "utf8", env: e, timeout: 20000,
  });
  // The two runs live in different temp roots; normalise so only real
  // differences survive. Order matters: repo is nested under base.
  const norm = (s: string) =>
    (s ?? "")
      // LONGEST FIRST, and the /private forms BEFORE the bare ones — macOS reports
      // /private/var for /var, and normalising the bare path first left a
      // "/private<REPO>" artifact that hid real differences behind a fake one.
      .split("/private" + impl).join("<IMPL>")
      .split("/private" + path.dirname(impl)).join("<MACHINE>")
      .split("/private" + repo).join("<REPO>")
      .split("/private" + base).join("<BASE>")
      .split(impl).join("<IMPL>")
      .split(path.dirname(impl)).join("<MACHINE>")
      .split(repo).join("<REPO>")
      .split(base).join("<BASE>")
      // The backup filename carries a SECOND-resolution timestamp and appears in
      // stdout as well as on disk. Normalising it only in the snapshot made the
      // harness fail whenever the two runs straddled a second boundary — a flake
      // that looked like a port divergence, on a different test each time.
      .replace(/\.bak\.\d{14}/g, ".bak.<stamp>");
  return {
    status: res.status,
    stdout: norm(res.stdout),
    stderr: norm(res.stderr),
    tree: norm(snapshot(repo, impl)),
  };
}

/** Run the same fixture through both implementations and compare everything. */
function parity(fx: Fixture, args: string[] = [], env: Record<string, string> = {}) {
  const b = runOne("bash", fx, args, env);
  const n = runOne("node", fx, args, env);
  return { b, n };
}

const expectParity = (label: string, fx: Fixture, args: string[] = [], env: Record<string, string> = {}) => {
  const { b, n } = parity(fx, args, env);
  expect(n.status, `${label}: exit code`).toBe(b.status);
  expect(n.stderr, `${label}: stderr`).toBe(b.stderr);
  expect(n.stdout, `${label}: stdout`).toBe(b.stdout);
  expect(n.tree, `${label}: filesystem state`).toBe(b.tree);
};

const noop: Fixture = () => {};
const withSettings = (json: string): Fixture => (repo) => {
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude/settings.json"), json);
};

describe("differential — bash setup vs node lib/setup.mjs", () => {
  it("a fresh repo", () => expectParity("fresh", noop));

  it("a fresh repo, in a Claude session", () =>
    expectParity("in-session", noop, [], { CLAUDECODE: "1" }));

  it("a second run (the no-op path)", () => {
    // Two runs inside one implementation, then compare across implementations.
    const fx: Fixture = (repo, impl) => {
      spawnSync("bash", [BASH], {
        cwd: repo, env: { ...process.env, REVIEW_LOOP_IMPL: impl, REVIEW_LOOP_SRC: ROOT } as any,
      });
    };
    expectParity("no-op", fx);
  });

  for (const [label, spec] of [
    ["plain", ". :(exclude)proto/"],
    ["single quote", ". :(exclude)don't-touch/"],
    ["double quote", 'a"b'],
    ["backslash", "back\\slash"],
    ["dollar", "$HOME/x"],
    ["backtick", "`whoami`"],
    ["semicolon", ";rm -rf /tmp/nope;"],
    ["unicode", "héllo→/"],
  ] as const) {
    it(`--paths: ${label}`, () => expectParity(`paths-${label}`, noop, ["--paths", spec]));
  }

  it("--paths '' clears", () => expectParity("clear", withSettings(JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "REVIEW_LOOP_PATHS='old/' \"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", timeout: 10 }] }] },
  }, null, 2)), ["--paths", ""]));

  it("preserves a foreign hook sharing our matcher group", () =>
    expectParity("foreign", withSettings(JSON.stringify({
      hooks: { Stop: [{ hooks: [
        { type: "command", command: "other-tool --check", timeout: 5 },
        { type: "command", command: "\"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", timeout: 10 },
      ] }] },
      permissions: { allow: ["Bash"] },
    }, null, 2))));

  it("carries an env prefix forward on a plain re-run", () =>
    expectParity("carry", withSettings(JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "REVIEW_LOOP_PLANS_DIR=/team/plans \"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", timeout: 10 }] }] },
    }, null, 2))));

  it("rebuilds a legacy registration", () =>
    expectParity("legacy", withSettings(JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "OLD \"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", timeout: 10 }] }] },
    }, null, 2))));

  it("refuses an assignment after the pathspec", () =>
    expectParity("after", withSettings(JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "REVIEW_LOOP_PATHS='a' REVIEW_LOOP_PLANS_DIR=/p \"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh\"", timeout: 10 }] }] },
    }, null, 2)), ["--paths", "new/"]));

  it("refuses unparseable JSON", () => expectParity("bad-json", withSettings('{ "hooks": { BROKEN')));

  for (const [label, dest] of [["impl", "impl"], ["shim", "shim"]] as const) {
    it(`refuses a ${label} destination that is a directory`, () =>
      expectParity(`dir-${label}`, (repo, impl) => {
        fs.mkdirSync(dest === "impl" ? impl : path.join(repo, ".claude/hooks/review-loop.sh"), { recursive: true });
      }));
  }

  it("refuses a dangling .claude/hooks symlink", () =>
    expectParity("dangling", (repo, impl) => {
      fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
      fs.symlinkSync(path.dirname(impl), path.join(repo, ".claude/hooks"));
    }));

  it("a RELATIVE readlink target containing ..", () =>
    // The blind spot that let P1-2 through: 27 fixtures and not one relative
    // readlink target with a `..` in it. bash lets the KERNEL resolve
    // `$(dirname)/$target`; path.join collapses it lexically, and the two answers
    // diverge exactly when a symlink sits in the traversed path. Result was exit 0
    // "installed." with the shim installed as its own $IMPL — same inode.
    expectParity("rel-dotdot", (repo, impl) => {
      const base = path.dirname(path.dirname(impl));
      fs.mkdirSync(path.join(base, "a"), { recursive: true });
      fs.mkdirSync(path.join(repo, "deep"), { recursive: true });
      fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
      fs.symlinkSync(path.join(repo, "deep"), path.join(base, "a/link"));
      fs.symlinkSync("../.claude/hooks", path.join(repo, "deep/sub"));
    }, [], { REVIEW_LOOP_IMPL: "<BASE>/a/link/sub/review-loop.sh" }));

  it("refuses a symlink loop", () =>
    expectParity("loop", (repo) => {
      const c = path.join(repo, ".claude");
      fs.mkdirSync(c, { recursive: true });
      fs.symlinkSync(path.join(c, "b"), path.join(c, "hooks"));
      fs.symlinkSync(path.join(c, "hooks"), path.join(c, "b"));
    }));

  it("refuses a settings.json that is a directory", () =>
    expectParity("settings-dir", (repo) => {
      const p = path.join(repo, ".claude/settings.json");
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, "occupied"), "x");
    }));

  it("refuses a target it cannot enter", () => {
    const gone = path.join(tmp, "no-such-target");
    expectParity("no-target", noop, ["--target", gone]);
  });

  it("refuses an unknown argument", () => expectParity("unknown", noop, ["--wat"]));
  it("--target with no value", () => expectParity("target-arity", noop, ["--target"]));
  it("--paths with no value", () => expectParity("paths-arity", noop, ["--paths"]));
  it("--help", () => expectParity("help", noop, ["--help"]));
});
