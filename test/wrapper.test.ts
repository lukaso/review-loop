// The bash wrapper: finding node, and failing loudly when it cannot.
//
// These paths have no equivalent in the bash implementation, so the differential
// harness cannot cover them and the 72 ported tests never reach them. They are
// also the paths where a mistake looks exactly like the failure this project
// exists to prevent: a tool that is installed, reports nothing, and does nothing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SETUP = process.env.REVIEW_LOOP_SETUP
  ? path.resolve(process.env.REVIEW_LOOP_SETUP)
  : path.join(ROOT, "setup");

let tmp: string, repo: string, bin: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrap-"));
  repo = path.join(tmp, "repo");
  bin = path.join(tmp, "bin");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  spawnSync("git", ["init", "-q", "."], { cwd: repo });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Put a fake `node` first on PATH. */
function fakeNode(body: string) {
  const p = path.join(bin, "node");
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", [SETUP, ...args], {
    cwd: repo, encoding: "utf8", timeout: 20000,
    // env is built from scratch, so REVIEW_LOOP_SETUP_LIB never reached the child
    // and a wrapper-mutation run read as "killed by 3 wrapper tests" it never
    // touched. Forward it when set.
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, REVIEW_LOOP_SRC: ROOT,
      ...(process.env.REVIEW_LOOP_SETUP_LIB
        ? { REVIEW_LOOP_SETUP_LIB: process.env.REVIEW_LOOP_SETUP_LIB } : {}),
      ...env,
    },
  });
}

describe("the wrapper — node resolution", () => {
  it("refuses with exit 6 when node reports a version below the floor", () => {
    // Exit 6 is its own code ON PURPOSE: 2/3/4/5 are refusal, lock, parse and
    // write, all load-bearing. Reusing one would make "no node" indistinguishable
    // from "your settings.json is broken".
    fakeNode('#!/bin/sh\ncase "$*" in *versions.node*) exit 1 ;; esac\nexit 0\n');
    const res = run();
    expect(res.status, "node too old must be its own exit code").toBe(6);
    expect(res.stderr, "must name itself and the floor").toMatch(/setup:.*Node 18/);
    expect(res.stdout, "must not claim anything was installed").not.toMatch(/installed\./);
  });

  it("does not leak a bare loader error when node resolves but cannot run", () => {
    // "Found" is not "runnable". A node that cannot load its libraries prints a
    // bare `dyld[401]: Library not loaded:` and nothing else — the same
    // bare-stderr class the wrapper's own messages exist to close, reintroduced
    // by the mechanism that closes it.
    fakeNode('#!/bin/sh\necho "dyld[401]: Library not loaded: libfoo" >&2\nexit 133\n');
    const res = run();
    expect(res.status).toBe(6);
    expect(res.stderr, "must explain it itself").toMatch(/setup:.*cannot run this/);
    expect(res.stderr, "and must not leak the loader's own line").not.toMatch(/^dyld/m);
  });

  it("scrubs NODE_OPTIONS", () => {
    // NODE_OPTIONS=--inspect prints "Debugger listening on…" to stderr on EVERY
    // run, unprefixed.
    fs.rmSync(path.join(bin, "node"), { force: true });
    const res = spawnSync("bash", [SETUP, "--help"], {
      cwd: repo, encoding: "utf8", timeout: 20000,
      env: { ...process.env, REVIEW_LOOP_SRC: ROOT, NODE_OPTIONS: "--inspect" },
    });
    expect(res.stderr, "no debugger banner may reach the user").not.toMatch(/Debugger listening/);
    expect(res.status, "and --help still works").toBe(0);
  });

  it("refuses when it cannot find its own implementation", () => {
    // SELF_DIR (where lib/ lives) and REVIEW_LOOP_SRC (where hooks/ lives) are
    // different things. Conflating them made a test that points REVIEW_LOOP_SRC
    // at a shim-less tree fail with the wrong message — one variable doing two
    // jobs, which is the shape of every defect in rounds 9-13.
    const copy = path.join(tmp, "setup-copy");
    fs.copyFileSync(SETUP, copy);
    fs.chmodSync(copy, 0o755);
    const res = spawnSync("bash", [copy], {
      cwd: repo, encoding: "utf8", timeout: 20000,
      env: { PATH: "/usr/bin:/bin", HOME: tmp },   // no REVIEW_LOOP_SRC, no lib/ beside it
    });
    expect(res.status, "must refuse").not.toBe(0);
    expect(res.stderr, "must say what it could not find").toMatch(/setup:.*lib\/setup\.mjs/);
  });
});
