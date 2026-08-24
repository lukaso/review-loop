// review-loop setup — the implementation. `setup` is a bash wrapper that finds
// node and execs this.
//
// PORTED FROM BASH, BYTE-IDENTICAL BY CONSTRUCTION. Every message, exit code and
// side effect matches the bash version it replaces; the differential harness is
// the proof. Behaviour changes land in LATER commits, so that a port bug can
// never be mistaken for an intended fix.
//
// settings.json IS A CONTESTED FILE. Rules, unchanged by the port:
//   1. merge, never replace; preserve every item we did not write
//   2. refuse a file we cannot parse — never "repair" it
//   3. back up before the first mutation
//   4. never `git add`, never commit
//   5. hold a lock: setup runs on EVERY update, so a lost update is not rare
//   6. refuse before changing anything
//   7. never write outside $TARGET and $IMPL
//   8. the registered command stays $CLAUDE_PROJECT_DIR-relative
//   9. replace by RENAME, never truncate in place
//  10. release the lock on EVERY exit path
//
// BUILTINS ONLY. A fresh clone has no node_modules; vitest is a devDependency.
// Importing anything else makes `git clone && ./setup` fail.

import { existsSync, lstatSync, statSync, readlinkSync, mkdirSync, rmSync,
         readFileSync, writeFileSync, renameSync, chmodSync, copyFileSync,
         unlinkSync, realpathSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const EXIT = { CONTROL: 1, REFUSE: 2, LOCK: 3, PARSE: 4, WRITE: 5, NODE: 6 };

/** @param {...string} lines */
const err = (...lines) => { for (const l of lines) process.stderr.write(l + "\n"); };
/** @param {...string} lines */
const out = (...lines) => { for (const l of lines) process.stdout.write(l + "\n"); };

// ── cleanup registry ─────────────────────────────────────────────────────────
// ONE registry, not three: the lock, the shim's temp and the settings temp are
// all released here, on every ORDINARY exit path. Signals are NOT wired — see the
// note below `process.on("exit")`, which explains why wiring them was worse than
// not wiring them.
const cleanups = new Set();
/** @param {() => void} fn @returns {() => void} */
const addCleanup = (fn) => { cleanups.add(fn); return fn; };
/** @param {() => void} fn */
const dropCleanup = (fn) => cleanups.delete(fn);
const runCleanups = () => {
  for (const fn of cleanups) { try { fn(); } catch { /* best effort */ } }
  cleanups.clear();
};
process.on("exit", runCleanups);
// NO SIGNAL HANDLERS, and that is a decision rather than an omission. An earlier
// version registered SIGINT/SIGTERM/SIGHUP/SIGQUIT handlers to release the lock,
// mirroring bash's `trap … EXIT`. Measured against a spinning fixture: all three
// signals were SWALLOWED and the process survived every one — this script is
// 100% synchronous from here to process.exit(), so a JS handler can never be
// scheduled. They were not a safety net; they were dead code that also took away
// the user's ability to Ctrl-C a stuck setup, which bash never did.
// So: default disposition, and the 30s stale-lock takeover is what covers a
// signal death. `process.on("exit")` above is what actually releases the lock on
// every ordinary path — mutating it away kills 24 tests in the setup suite, 41
// with the differential harness. (Corrected once already: the figure was made
// stale by the very change that corrected it, which added a test to that set.)
/** @param {number} code @param {...string} lines @returns {never} */
const die = (code, ...lines) => { err(...lines); process.exit(code); };

// ── arguments ────────────────────────────────────────────────────────────────
let TARGET = process.cwd();
let PATHS = "";
let PATHS_GIVEN = false;               // `--paths ''` means CLEAR; absent means CARRY FORWARD
const TIMEOUT = 10;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--target") {
    const v = argv[i + 1];
    if (v === undefined) die(EXIT.REFUSE, "setup: --target needs a directory");
    TARGET = v; i++;
  } else if (a === "--paths") {
    const v = argv[i + 1];
    if (v === undefined) die(EXIT.REFUSE, "setup: --paths needs a pathspec string");
    PATHS = v; PATHS_GIVEN = true; i++;
  } else if (a === "-h" || a === "--help") {
    out(
      "review-loop setup — install the review nudge into a repo.",
      "",
      "Usage: ./setup [--target <repo>] [--paths \"<git pathspecs>\"]",
      "",
      "  --target <repo>   repo to install into (default: current directory)",
      "  --paths \"<spec>\"  REVIEW_LOOP_PATHS for this repo, e.g.",
      "                    \". :(exclude)prototypes/ :(exclude)notes.md\"",
      "                    Applied identically to all three registrations.",
      "",
      "Installs the implementation to $REVIEW_LOOP_IMPL (default",
      "~/.claude/hooks/review-loop.sh) and commits nothing.");
    process.exit(0);
  } else {
    die(EXIT.REFUSE, `setup: unknown argument: ${a}`);
  }
}

// ── source tree ──────────────────────────────────────────────────────────────
// REVIEW_LOOP_SRC lets a COPY find the real source tree. Without it a mutation
// copy resolves $SRC to its own directory, finds no hooks/, and dies — so every
// mutant reports a kill it never earned. A false KILLED reads as better news
// than the truth, which makes it worse than a false SURVIVED.
// fileURLToPath, NOT .pathname: `.pathname` is PERCENT-ENCODED, so a checkout at
// "/tmp/my checkout" became "/tmp/my%20checkout" and setup refused with "cannot
// find hooks/review-loop.sh". Any space, %, # or non-ASCII in the path killed it.
// The differential harness cannot see this — it sets REVIEW_LOOP_SRC on all 28
// fixtures, so the derived branch never runs.
const SRC = process.env.REVIEW_LOOP_SRC || resolve(dirname(fileURLToPath(import.meta.url)), "..");

// BOTH files, and BEFORE any install runs. Checking only the hook left the shim
// to be reported by install(1) with no `setup:` prefix — and by then $IMPL had
// ALREADY been overwritten.
for (const f of ["hooks/review-loop.sh", "hooks/review-loop-shim.sh"]) {
  // isFile(), not existsSync(): bash used `[ -f ]`, and `existsSync` is true for a
  // FIFO — after which `copyFileSync` blocks FOREVER, with the lock taken and
  // .claude created. A hang is the worst shape of silence this tool can produce.
  let srcOk = false;
  try { srcOk = statSync(join(SRC, f)).isFile(); } catch { srcOk = false; }
  if (!srcOk) {
    die(EXIT.REFUSE,
      `setup: cannot find ${f} under ${SRC}`,
      "setup: if this is a copy of the script, set REVIEW_LOOP_SRC to the repo root.");
  }
}

// ── target ───────────────────────────────────────────────────────────────────
// process.chdir, NOT realpathSync: measured, realpathSync ACCEPTS a directory
// with no +x that bash's `cd` refuses, and existsSync swallows EACCES so the
// refusal would arrive later with the wrong message. chdir is the usability test
// `cd` gave for free.
const TARGET_ARG = TARGET;
try {
  process.chdir(TARGET_ARG);
  TARGET = process.cwd();
} catch {
  die(EXIT.REFUSE, `setup: cannot enter ${TARGET_ARG}`);
}

const HOME = process.env.HOME || "";
const IMPL = process.env.REVIEW_LOOP_IMPL || (HOME ? join(HOME, ".claude/hooks/review-loop.sh") : "/.claude/hooks/review-loop.sh");
if (!HOME && !process.env.REVIEW_LOOP_IMPL) die(EXIT.REFUSE, "setup: no HOME and no REVIEW_LOOP_IMPL");

// ── shell quoting ────────────────────────────────────────────────────────────
// The registered command is a shell string. A pathspec containing a double quote
// produced one that mangles its own value or does not parse — a settings.json
// that looks installed, never fires, and is committed for everyone who clones.
/** @param {unknown} s */
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// ── the activation notice ────────────────────────────────────────────────────
// Claude Code reads settings.json at STARTUP. An install performed mid-session
// registers nothing that will fire, and this script used to print "installed."
// and exit 0. This repo did exactly that: installed, declared working, had not
// fired once.
//
// WHAT THIS CANNOT KNOW: which project the calling session is in. So it NAMES THE
// DIRECTORY and lets the reader match it against where they are.
/** @param {"fresh"|"noop"} kind */
function sayActivation(kind = "fresh") {
  out("");
  if (kind === "noop") {
    out("setup: If you installed DURING the current session,",
        "setup: Claude Code read its hooks at startup and does not have them yet —",
        "setup: if you have restarted since, it is already live and there is",
        "setup: nothing to do.");
  } else {
    out(`setup: registered in ${TARGET}. Claude Code reads hooks at startup, so a`,
        "setup: session already running does not have this registration yet.");
  }
  out("");
  if (process.env.CLAUDECODE) {
    out(`    to pick it up in ${shq(TARGET)}, exit and run:`,
        "        claude --continue     # keeps the same conversation",
        "        claude --resume       # pick a different session");
  } else {
    out(`    cd ${shq(TARGET)} && claude`);
  }
  out("");
}

// ── every destination we write, one predicate ────────────────────────────────
// `mv -f` and `install(1)` both nest a file INSIDE a directory destination and
// return 0. All three destinations were exposed. `-f` follows symlinks on
// purpose: a symlink to a REGULAR FILE still installs; a symlink to a DIRECTORY
// is the hazard.
/** @param {string} p */
function regularOrAbsent(p) {
  let st;
  try { st = statSync(p); } catch { return; }          // ENOENT (and EACCES) => absent
  if (!st.isFile()) die(EXIT.REFUSE, `setup: ${p} exists and is not a regular file; nothing was changed.`);
}

const SETTINGS = join(TARGET, ".claude/settings.json");
const SHIM_DEST = join(TARGET, ".claude/hooks/review-loop.sh");

// ── path resolution ──────────────────────────────────────────────────────────
// A PORT OF resolve_dir's LOOP, not a replacement for it. existsSync and
// realpathSync both FOLLOW links, so a DANGLING symlink reads as absent and the
// walk steps straight through it — reproducing the defect where the paths
// compared unequal, the $IMPL install created the target, the link went live,
// and the shim was written through it onto the machine-global $IMPL.
//
// TRAILING NEWLINES: bash's $( ) strips them and readlinkSync does not, so
// `readlink` of a "\n" symlink is "" in bash and "\n" here. Without stripping,
// the empty-target guard never fires and $IMPL is overwritten.
/** @param {string} s */
const chomp = (s) => s.replace(/\n+$/, "");

/** @param {string} start @returns {string|null} */
function resolveDir(start) {          // physical path, or null when unresolvable
  let d = start, rest = "", n = 0;
  while (d && d !== "/" && d !== ".") {
    if (++n > 64) return null;                          // symlink loop
    let st;
    try { st = lstatSync(d); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      let t;
      try { t = chomp(readlinkSync(d)); } catch { return null; }
      if (!t) return null;
      // CONCATENATE, do not join(). `path.join` collapses `..` LEXICALLY; bash
      // builds `$(dirname "$_d")/$_t` and lets the KERNEL resolve it. With a
      // relative readlink target containing `..`, the lexical answer and the
      // kernel's answer differ whenever a symlink sits in the traversed path — and
      // the collision guard then compared unequal, exited 0 "installed.", and left
      // the shim as its own $IMPL. Reproduced: same inode, both destinations.
      d = t.startsWith("/") ? t : chomp(dirname(d)) + "/" + t;
      continue;
    }
    if (st && st.isDirectory()) break;
    rest = "/" + chomp(basename(d)) + rest;
    d = chomp(dirname(d));
  }
  // THE `pwd -P` HALF. bash ends with `cd -- "$_d" && pwd -P`, so the BASE comes
  // back physical. Returning the unresolved string instead made /var/... never
  // match /private/var/..., and the $IMPL-equals-shim collision went undetected —
  // the walk was ported and its last line was not.
  // realpathSync is correct HERE and wrong in the loop above: here the path is
  // known to exist, which is the one condition under which it agrees with `cd`.
  // TWO-STEP, and both halves are required. bash's `cd` is -L: it collapses `..`
  // lexically AND falls back to the operand as given when that chdir fails. Plain
  // `realpathSync` implements only the first half and THROWS ENOENT on a path that
  // exists; `.native` is POSIX and resolves the symlink first. Neither alone
  // reproduces bash.
  let base;
  try {
    base = realpathSync(d);
  } catch (e) {
    if (/** @type {any} */ (e)?.code === "ENOENT") {
      try { base = realpathSync.native(d); } catch { return null; }
    } else { return null; }
  }
  try { if (!statSync(base).isDirectory()) return null; } catch { return null; }
  return base + rest;
}

const implDir = resolveDir(dirname(IMPL));
if (implDir === null) die(EXIT.REFUSE, `setup: cannot resolve ${IMPL} (a broken symlink?). Nothing was changed.`);
const shimDir = resolveDir(join(TARGET, ".claude/hooks"));
if (shimDir === null) die(EXIT.REFUSE, `setup: cannot resolve ${SHIM_DEST} (a broken symlink?). Nothing was changed.`);
const IMPL_RESOLVED = join(implDir, basename(IMPL));
const SHIM_RESOLVED = join(shimDir, "review-loop.sh");

regularOrAbsent(SETTINGS);
regularOrAbsent(IMPL);
regularOrAbsent(SHIM_DEST);

// $IMPL AND THE SHIM CAN BE THE SAME FILE — with $TARGET == $HOME they are, and a
// symlinked .claude/hooks gets there too. The shim then becomes its own $IMPL,
// `[ -x ]` is true because it IS itself, and it execs itself until the turn
// times out.
if (IMPL_RESOLVED === SHIM_RESOLVED) {
  die(EXIT.REFUSE,
    "setup: the machine copy and the committed shim resolve to the same file:",
    `setup:   ${IMPL}`,
    `setup:   ${SHIM_DEST}`,
    "setup: they must differ, or the shim runs itself. Nothing was changed.");
}

try { mkdirSync(join(TARGET, ".claude"), { recursive: true }); }
catch { die(EXIT.REFUSE, `setup: could not create ${join(TARGET, ".claude")}`); }

// ── the lock ─────────────────────────────────────────────────────────────────
// `mkdir` is the primitive: atomic on every POSIX filesystem.
const LOCK = SETTINGS + ".lock";
const lockAge = () => {
  try { return Math.floor((Date.now() - statSync(LOCK).mtimeMs) / 1000); } catch { return 0; }
};
let haveLock = false;
try { mkdirSync(LOCK); haveLock = true; } catch { /* held */ }
if (!haveLock) {
  const age = lockAge();
  if (age > 30) {
    try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ }
    try { mkdirSync(LOCK); } catch { die(EXIT.LOCK, `setup: could not take over the stale lock at ${LOCK}`); }
    out(`setup: took over a stale lock (${age}s old)`);
  } else {
    die(EXIT.LOCK,
      `setup: settings.json is locked by another run (${age}s old): ${LOCK}`,
      "setup: nothing was changed. Retry, or remove that directory if no setup is running.");
  }
}
addCleanup(() => { try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── read the current settings ────────────────────────────────────────────────
let CURRENT_TEXT = null, CURRENT;
if (existsSync(SETTINGS) && statSync(SETTINGS).isFile()) {
  CURRENT_TEXT = readFileSync(SETTINGS, "utf8");
  try { CURRENT = JSON.parse(CURRENT_TEXT); }
  catch {
    die(EXIT.PARSE,
      `setup: cannot parse ${SETTINGS} — refusing to touch it.`,
      "setup: fix the JSON (or move it aside) and re-run. Nothing was changed.");
  }
  // A NON-OBJECT ROOT must refuse. `const c = JSON.parse("[]"); c.hooks = {…}`
  // does not throw — a naive merge ACCEPTS a top-level array, silently discards
  // all three registrations, writes `[]` and prints "installed."
  if (CURRENT === null || typeof CURRENT !== "object" || Array.isArray(CURRENT)) {
    die(EXIT.WRITE,
      `setup: ${SETTINGS} root is not a JSON object; refusing to merge into it.`,
      "setup: failed to build the merged settings; nothing was changed.");
  }
} else {
  CURRENT = {};
}


// ── the env prefix a re-run must not silently discard ─────────────────────────
// A committed command is `<assignments> <tail>`, and the assignments ARE the
// repo's standard. Three consecutive review rounds each dropped some of them and
// printed "installed." anyway. Extracted ONCE, above every branch, because the
// recurring defect was never the rule — it was having more than one place to
// apply it.
const OURS = /review-loop\.sh/;

// settings.json is ARBITRARY user JSON, so `any` here is honest rather than lazy:
// the whole point of the guards below is that nothing about its shape is known.
/** @param {any} root @returns {string[]} */
function ourCommands(root) {
  /** @type {string[]} */
  const found = [];
  const hooks = root && typeof root === "object" ? root.hooks : undefined;
  if (!hooks || typeof hooks !== "object") return found;
  for (const groups of Object.values(hooks)) {
    if (!groups || typeof groups !== "object") continue;
    for (const group of Object.values(groups)) {
      const items = group && typeof group === "object" ? group.hooks : undefined;
      if (!items || typeof items !== "object") continue;
      for (const item of Object.values(items)) {
        const c = item && typeof item === "object" ? item.command : undefined;
        if (typeof c === "string" && OURS.test(c)) found.push(c);
      }
    }
  }
  return found;
}

let CMD = '"$CLAUDE_PROJECT_DIR/.claude/hooks/review-loop.sh"';

const candidates = ourCommands(CURRENT);
// Prefer a registration that HAS a prefix. Plain "first" took whichever command
// came first in FILE order, so one bare or legacy event discarded the prefix the
// other two carried.
const EXISTING = candidates.find((c) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(c)) ?? candidates[0] ?? "";

let PREFIX = EXISTING.endsWith(CMD) ? EXISTING.slice(0, EXISTING.length - CMD.length) : "";
// A stripped prefix is only an ENV PREFIX if it CONTAINS an assignment. A legacy
// `OLD <tail>` also ends in today's tail, so slicing left "OLD " behind and it got
// carried forward — pinning exactly the stale form this branch exists to rebuild.
if (!PREFIX.includes("=")) PREFIX = "";

// We always emit REVIEW_LOOP_PATHS last, so whatever sits AHEAD of it is somebody
// else's and must survive every branch below.
const pathsAt = PREFIX.indexOf("REVIEW_LOOP_PATHS=");
let CARRIED = pathsAt === -1 ? PREFIX : PREFIX.slice(0, pathsAt);
let HAD_PATHS = pathsAt !== -1;
// An unanchored match split MY_REVIEW_LOOP_PATHS= mid-token and the summary
// announced replacing a variable that was never set. A real assignment starts the
// prefix or follows a space.
if (!(CARRIED === "" || CARRIED.endsWith(" "))) { CARRIED = PREFIX; HAD_PATHS = false; }

// CARRIED keeps only what PRECEDES the pathspec, because finding where a shell
// quoted value ENDS is not something this can do safely. So an assignment written
// AFTER it was deleted from all three registrations with nothing said. REFUSE
// instead of guessing: a wrong ask costs a line, a wrong silence loses the work.
if (HAD_PATHS && PATHS_GIVEN) {
  const after = PREFIX.slice(pathsAt + "REVIEW_LOOP_PATHS=".length);
  if (/\s[A-Za-z_][A-Za-z0-9_]*=/.test(after)) {
    die(EXIT.REFUSE,
      "setup: the registered command has an assignment AFTER REVIEW_LOOP_PATHS:",
      `setup:   ${PREFIX}`,
      "setup: rewriting the pathspec would delete it. Re-run without --paths,",
      "setup: or move that assignment ahead of REVIEW_LOOP_PATHS. Nothing was changed.");
  }
}

if (PATHS) {
  CMD = `${CARRIED}REVIEW_LOOP_PATHS=${shq(PATHS)} ${CMD}`;
  if (HAD_PATHS) out("setup: replaced the REVIEW_LOOP_PATHS already registered.");
} else if (PATHS_GIVEN) {
  CMD = `${CARRIED}${CMD}`;              // --paths '' means CLEAR, not "unspecified"
  if (HAD_PATHS) out("setup: cleared the REVIEW_LOOP_PATHS already registered.");
} else {
  CMD = `${PREFIX}${CMD}`;               // nothing said => keep what is committed
}

// ── merge ────────────────────────────────────────────────────────────────────
// Identity is INTRINSIC — an item is ours iff its command names review-loop.sh.
// Not a tag we write: Claude Code strips unknown keys when it rewrites this file.
//
// `stripOurs` removes our ITEMS, not their groups: a group shared with a foreign
// hook keeps the foreign hook and loses only us. Dropping whole groups would
// delete somebody else's gate, which is the worst thing this script could do.
const mergeFailed = () =>
  die(EXIT.WRITE, "setup: failed to build the merged settings; nothing was changed.");

/** @param {any} groups @returns {any[]} */
function stripOurs(groups) {
  if (!Array.isArray(groups)) {
    if (groups && typeof groups === "object") groups = Object.values(groups);
    else mergeFailed();
  }
  const kept = [];
  for (const g of groups) {
    if (!g || typeof g !== "object" || Array.isArray(g)) mergeFailed();
    let items = g.hooks ?? [];
    if (!Array.isArray(items)) {
      if (items && typeof items === "object") items = Object.values(items);
      else mergeFailed();
    }
    const survivors = items.filter((/** @type {any} */ it) => {
      if (!it || typeof it !== "object") mergeFailed();
      const c = it.command ?? "";
      if (typeof c !== "string") mergeFailed();
      return !OURS.test(c);
    });
    if (survivors.length > 0) kept.push({ ...g, hooks: survivors });
  }
  return kept;
}

/** @type {any} */
const UPDATED = structuredClone(CURRENT);
if (UPDATED.hooks === undefined || UPDATED.hooks === null) UPDATED.hooks = {};
if (typeof UPDATED.hooks !== "object" || Array.isArray(UPDATED.hooks)) mergeFailed();
for (const ev of ["SessionStart", "UserPromptSubmit", "Stop"]) {
  UPDATED.hooks[ev] = [
    ...stripOurs(UPDATED.hooks[ev] ?? []),
    { hooks: [{ type: "command", command: CMD, timeout: TIMEOUT }] },
  ];
}

// ── never silently rewrite what we did not write ─────────────────────────────
// ORDER IS THE WHOLE POINT, and the first version got it wrong. This is a
// REFUSAL, so it belongs with every other refusal: ABOVE both installs. Placed
// below them it wrote $IMPL — the machine-global copy every shimmed repo execs —
// and created a committed-looking shim, then printed "Nothing was changed." The
// bash original carries this scar in a comment at the same site; the port added a
// NEW refusal path and did not apply the rule to it. One site out of several.
// Gated on the no-op comparison so a plain refresh, which writes no settings, is
// unaffected.
// JSON.parse/JSON.stringify canonicalises NUMBER LITERALS: 1.50 becomes 1.5, and
// an integer above 2^53 loses precision outright. jq preserves literals; this
// cannot. settings.json is committed and contested, and invariant 1 is "preserve
// every item we did not write" — a rewritten value shows up in the user's git
// diff as OUR change. So: verify rather than preserve. Refuse when a literal in
// the file would not survive the round trip.
/** @param {string} text @returns {string[]} */
function badNumberLiterals(text) {
  /** @type {string[]} */
  const bad = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;          // noUncheckedIndexedAccess: prove the bound
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i;
      while (j < text.length && /[-+0-9.eE]/.test(text[j] ?? "")) j++;
      const tok = text.slice(i, j);
      if (/^-?\d/.test(tok) && String(Number(tok)) !== tok) bad.push(tok);
      i = j - 1;
    }
  }
  return bad;
}

const IS_NOOP = canon(CURRENT) === canon(UPDATED);
/**
 * Integer-like keys are REORDERED by a JSON round trip — JS puts them first, in
 * ascending numeric order, regardless of where they appeared. jq preserved input
 * order. Measured: {"10":…,"2":…} comes back as {"2":…,"10":…}. That is the same
 * silent rewrite of foreign data as the number literals, at a site the literal
 * scanner cannot see, so it refuses the same way.
 *
 * DELIBERATELY OVER-BROAD, and the cost is stated rather than hidden: an object
 * whose integer keys are ALREADY ascending does not reorder, and this refuses it
 * anyway. Narrowing it precisely needs the textual key order, which means parsing
 * the JSON a second way — more surface than the case is worth. A scan of 23 real
 * settings.json files found ZERO integer-like keys anywhere. The direction is the
 * safe one (refuse, change nothing), but a repo that DID have such a key could
 * never install or update until it was removed.
 * @param {any} v @returns {string[]}
 */
function integerLikeKeys(v) {
  /** @type {string[]} */
  const hits = [];
  const walk = (/** @type {any} */ x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== "object") return;
    for (const k of Object.keys(x)) {
      if (/^(0|[1-9]\d*)$/.test(k)) hits.push(k);
      walk(x[k]);
    }
  };
  walk(v);
  return hits;
}

if (CURRENT_TEXT !== null && !IS_NOOP) {
  const keys = integerLikeKeys(CURRENT);
  if (keys.length > 0) {
    die(EXIT.WRITE,
      `setup: ${SETTINGS} holds integer-like keys whose order a rewrite would change:`,
      `setup:   ${keys.slice(0, 5).join(" ")}`,
      "setup: merging would silently reorder entries it did not write. Nothing was changed.");
  }
  const bad = badNumberLiterals(CURRENT_TEXT);
  if (bad.length > 0) {
    die(EXIT.WRITE,
      `setup: ${SETTINGS} holds number literals this cannot rewrite without changing them:`,
      `setup:   ${bad.slice(0, 5).join(" ")}`,
      "setup: merging would silently alter values it did not write. Nothing was changed.");
  }
}


// ── the installs ─────────────────────────────────────────────────────────────

// RENAME, NEVER TRUNCATE IN PLACE. $IMPL is machine-global and every shimmed repo
// execs it PER TURN; fs.copyFileSync truncates in place (inode unchanged), so a
// hook mid-read resumes at its old offset inside new content. The temp lives in
// dirname(dest) because renameSync throws EXDEV across filesystems, and the mode
// is set with an explicit chmodSync because writeFileSync({mode}) is masked by
// umask — measured, {mode:0o755} under `umask 077` yields 0700, which is
// literally the bug v0.2.1 fixed.
/** @param {string} from @param {string} to @returns {boolean} */
function installFile(from, to) {
  const dir = dirname(to);
  try { mkdirSync(dir, { recursive: true }); } catch { return false; }
  // The temp lands INSIDE the repo for the shim, in the directory the user is told
  // to `git add`. It is unlinked on success, on failure, and by the exit handler.
  // UNREACHABLE THROUGH THE SUITE, and said out loud rather than tested vacuously:
  // reaching it needs copyFileSync or renameSync to fail after the temp exists,
  // which needs a read-only mount or a race the harness cannot construct.
  const tmp = join(dir, basename(to) + ".tmp." + process.pid);
  const rm = addCleanup(() => { try { unlinkSync(tmp); } catch { /* gone */ } });
  try {
    copyFileSync(from, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, to);
    dropCleanup(rm);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* gone */ }
    dropCleanup(rm);
    return false;
  }
}

if (!installFile(join(SRC, "hooks/review-loop.sh"), IMPL))
  die(EXIT.REFUSE, `setup: could not install the implementation to ${IMPL}`);
if (!installFile(join(SRC, "hooks/review-loop-shim.sh"), SHIM_DEST))
  die(EXIT.REFUSE, `setup: could not install the shim into ${join(TARGET, ".claude/hooks")}`);

// ── no-op? ───────────────────────────────────────────────────────────────────
// Canonical comparison (jq -S -c), not textual: key order and whitespace must not
// make an identical registration look like a change.
/** @param {any} v @returns {string} */
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object")
    return "{" + Object.keys(v).sort().map((/** @type {string} */ k) =>
      JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

if (IS_NOOP) {
  out("setup: registrations already up to date — no change to settings.json.",
      `  source:         ${SRC}`,
      `  implementation: ${IMPL}  (refreshed)`,
      `  shim:           ${join(TARGET, ".claude/hooks/review-loop.sh")}  (refreshed)`);
  sayActivation("noop");
  process.exit(0);
}

// ── write ────────────────────────────────────────────────────────────────────
if (CURRENT_TEXT !== null) {
  const d = new Date();
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const BAK = `${SETTINGS}.bak.${stamp}`;
  try { copyFileSync(SETTINGS, BAK); }
  catch { die(EXIT.WRITE, `setup: could not back up ${SETTINGS}; nothing was changed.`); }
  out(`setup: backed up ${SETTINGS} -> ${basename(BAK)}`);
}

const TMP = `${SETTINGS}.tmp.${process.pid}`;
const rmTmp = addCleanup(() => { try { unlinkSync(TMP); } catch { /* gone */ } });
try { writeFileSync(TMP, JSON.stringify(UPDATED, null, 2) + "\n"); }
catch { die(EXIT.WRITE, `setup: could not write ${TMP}`); }
try { renameSync(TMP, SETTINGS); dropCleanup(rmTmp); }
catch { die(EXIT.WRITE, `setup: could not replace ${SETTINGS} (a backup is beside it)`); }

out("setup: installed.",
    `  source:         ${SRC}`,
    `  implementation: ${IMPL}`,
    `  shim:           ${join(TARGET, ".claude/hooks/review-loop.sh")}`,
    "  registered:     SessionStart, UserPromptSubmit, Stop",
    "setup: nothing was staged or committed — commit .claude/ yourself when ready.");
sayActivation();
process.exit(0);
