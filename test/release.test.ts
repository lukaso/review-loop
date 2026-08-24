/**
 * Release invariants — the ones that rot silently between releases.
 *
 * gstack keeps its version in TWO places (VERSION at 4 digits, package.json at 3)
 * and needed a 528-line classifier with four drift states and a `repair` verb to
 * manage the gap. The cheap thing they do not have is a test. One assertion here
 * retires that entire class before it can start.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const pkg = () => JSON.parse(read("package.json"));

describe("version — one source of truth", () => {
  it("has a VERSION file holding a bare 3-digit semver", () => {
    // 3 digits, not gstack's 4: their fourth allocates slots in a PR queue, and
    // this repo has no queue. A trailing newline is fine; anything else is not.
    expect(read("VERSION").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("keeps package.json in step with VERSION", () => {
    // THE anti-drift test. VERSION is truth; the bump script writes both. If this
    // ever fails, one of them was hand-edited — which is the exact state gstack
    // built DRIFT_STALE_PKG to detect after the fact.
    expect(pkg().version, "package.json drifted from VERSION").toBe(read("VERSION").trim());
  });
});

describe("licence — the claim must be backed by a file", () => {
  it("ships the LICENSE that package.json claims", () => {
    // package.json has declared MIT since the first commit with no LICENSE file
    // present. Harmless while this was a private directory; a false claim the
    // moment it is on GitHub, which is the next item in TODO.md.
    expect(pkg().license, "no licence claimed").toBeTruthy();
    expect(fs.existsSync(path.join(ROOT, "LICENSE")), "claims a licence with no LICENSE file").toBe(true);
    expect(read("LICENSE")).toContain("MIT");
    expect(read("LICENSE"), "a licence with no copyright line is not a licence").toMatch(/Copyright \(c\) \d{4}/);
  });

  it("ships the files a consumer actually needs", () => {
    // `files` gates what npm publishes. The shim and LICENSE are part of the
    // product now, so leaving them out ships a package that cannot install.
    const files: string[] = pkg().files;
    for (const needed of ["hooks/", "lib/", "setup", "README.md", "LICENSE"]) {
      expect(files, `package.json files[] omits ${needed}`).toContain(needed);
    }
  });
});

/**
 * The bump script. gstack's equivalent is 528 lines with a four-state drift
 * classifier and a `repair` verb, because two hand-maintained copies of a version
 * drift. This writes both from one source and the test above asserts they agree,
 * which is the cheap way to never need the classifier.
 */
describe("version bump", () => {
  const BUMP = path.resolve(ROOT, "bin/review-loop-version-bump");
  let tmp: string, fixture: string;

  const git = (args: string[], cwd = fixture) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const bump = (level: string) =>
    spawnSync("bash", [BUMP, level], { cwd: fixture, encoding: "utf8" });
  const readIn = (f: string) => fs.readFileSync(path.join(fixture, f), "utf8");

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bump-test-"));
    fixture = fs.mkdtempSync(path.join(tmp, "repo-"));
    git(["init", "-q", "."]);
    fs.writeFileSync(path.join(fixture, "VERSION"), "1.4.9\n");
    fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "x", version: "1.4.9" }, null, 2) + "\n");
    git(["add", "-A"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("bumps patch, minor and major, writing BOTH files", () => {
    expect(bump("patch").status).toBe(0);
    expect(readIn("VERSION").trim()).toBe("1.4.10");
    expect(JSON.parse(readIn("package.json")).version, "package.json left behind").toBe("1.4.10");
  });

  it("resets the lower components, as semver requires", () => {
    expect(bump("minor").status).toBe(0);
    expect(readIn("VERSION").trim()).toBe("1.5.0");
  });

  it("resets both lower components on a major bump", () => {
    expect(bump("major").status).toBe(0);
    expect(readIn("VERSION").trim()).toBe("2.0.0");
  });

  it("refuses to bump twice on the same branch", () => {
    // The single worst footgun in gstack's ship flow, by their own comment:
    // re-bumping a branch that already carries a bump. Refuse, do not guess.
    expect(bump("patch").status).toBe(0);
    const res = bump("patch");
    expect(res.status, "a second bump must not silently double-bump").not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/already/i);
    expect(readIn("VERSION").trim(), "and it must not have moved").toBe("1.4.10");
  });

  it("refuses an unknown level rather than guessing", () => {
    const res = bump("sideways");
    expect(res.status).not.toBe(0);
    expect(readIn("VERSION").trim()).toBe("1.4.9");
  });
});
