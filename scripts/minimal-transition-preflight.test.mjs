import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BASE,
  BOUNDARIES,
  readJournal,
  compareJournals,
  makeReport,
  parseArgs,
  gitArguments,
  gitEnvironment,
} from "./minimal-transition-preflight.mjs";

const entry = { idx: 0, version: "7", when: 1234, tag: "0000_fixture", breakpoints: true };
function source(entries = [entry], sql = "SELECT 1;") {
  return args => {
    assert.equal(args[0], "show");
    if (args[1].endsWith("_journal.json"))
      return Buffer.from(JSON.stringify({ version: "7", dialect: "postgresql", entries }));
    assert.match(args[1], /:server\/drizzle\/\d{4}_[a-z0-9_]+\.sql$/);
    if (sql === null) throw new Error("Synthetic missing blob");
    return Buffer.from(sql);
  };
}
const journal = () => readJournal(source(), BASE);
const snapshot = () => ({
  sha: BASE,
  journal: journal(),
  hashes: Object.fromEntries(BOUNDARIES.map(p => [p, "a".repeat(64)])),
});

test("Git runner cannot substitute pinned objects, lazy-fetch, monitor hooks or inherit another repository", () => {
  assert.deepEqual(gitArguments("/fixture with spaces", ["show", `${BASE}:file`]), [
    "--no-replace-objects",
    "--no-lazy-fetch",
    "-c",
    "core.fsmonitor=false",
    "-C",
    "/fixture with spaces",
    "show",
    `${BASE}:file`,
  ]);
  assert.throws(() => gitArguments("/fixture", ["fetch"]));
  const env = gitEnvironment({
    PATH: "/tools",
    GIT_DIR: "/wrong",
    Git_WORK_TREE: "/wrong",
    GIT_NO_LAZY_FETCH: "0",
    GIT_REPLACE_REF_BASE: "refs/substitute",
    GIT_CONFIG_COUNT: "2",
    GIT_OBJECT_DIRECTORY: "/wrong",
  });
  assert.deepEqual(env, {
    PATH: "/tools",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
});

test("hashes raw SQL bytes, not migration names alone", () => {
  const a = journal(),
    b = readJournal(source([entry], "SELECT 2;"), BASE);
  assert.equal(a.entries[0].tag, b.entries[0].tag);
  assert.notEqual(a.entries[0].sqlSha256, b.entries[0].sqlSha256);
  assert.equal(compareJournals(a, b).length, 1);
});
test("detects tag/time/breakpoint/length differences even with equal SQL", () => {
  for (const patch of [{ when: 9999 }, { tag: "0000_other" }, { breakpoints: false }])
    assert.equal(compareJournals(journal(), readJournal(source([{ ...entry, ...patch }]), BASE)).length, 1);
  const extended = readJournal(source([entry, { ...entry, idx: 1, tag: "0001_fixture" }]), BASE);
  assert.equal(compareJournals(journal(), extended)[0].idx, 1);
  assert.equal(compareJournals(journal(), extended)[0].legacy, null);
  assert.deepEqual(compareJournals(journal(), journal()), []);
});
test("rejects malicious tags, duplicates, invalid timestamps/schema before reading SQL", () => {
  for (const patch of [
    { tag: "../../.env" },
    { tag: "0000_/secret" },
    { idx: 1 },
    { when: NaN },
    { when: -1 },
    { version: "8" },
    { breakpoints: "true" },
    { tag: `0000_${"x".repeat(200)}` },
  ])
    assert.throws(() => readJournal(source([{ ...entry, ...patch }]), BASE));
  assert.throws(() => readJournal(source([entry, entry]), BASE));
  assert.throws(() => readJournal(source([]), BASE));
  assert.throws(() => readJournal(source(Array(257).fill(entry)), BASE));
});
test("missing or oversized source cannot become an empty/compatible baseline", () => {
  assert.throws(() => readJournal(source([entry], null), BASE));
  assert.throws(() => readJournal(() => Buffer.alloc(1024 * 1024 + 1), BASE));
  assert.throws(() => readJournal(() => Buffer.from("{}"), BASE));
});
test("even identical source leaves every runtime/data/release gate unverified and HOLD", () => {
  const result = makeReport(snapshot(), snapshot(), snapshot());
  assert.equal(result.sourceBoundaryMatchesNative, true);
  assert.equal(result.deploymentStatus, "HOLD");
  assert.equal(result.dataStrategy, "NOT_SELECTED");
  assert.equal(result.liveDeploymentSha, null);
  assert.equal(result.worktreesInspected, false);
  assert(Object.values(result.verification).every(v => v === "NOT_VERIFIED"));
});
test("native boundary drift is distinct from a matching migration journal", () => {
  const candidate = snapshot();
  candidate.hashes[BOUNDARIES[0]] = "b".repeat(64);
  const result = makeReport(snapshot(), candidate, snapshot());
  assert.equal(result.journal.candidateMatchesNative, true);
  assert.equal(result.sourceBoundaryMatchesNative, false);
  assert.equal(result.deploymentStatus, "HOLD");
  delete candidate.hashes[BOUNDARIES[0]];
  const baseline = snapshot();
  delete baseline.hashes[BOUNDARIES[0]];
  assert.equal(makeReport(snapshot(), candidate, baseline).sourceBoundaryMatchesNative, false);
});
test("native journal equality requires the full raw journal hash too", () => {
  const candidate = snapshot();
  candidate.journal.sha256 = "b".repeat(64);
  const result = makeReport(snapshot(), candidate, snapshot());
  assert.equal(result.journal.candidateMatchesNative, false);
  assert.equal(result.sourceBoundaryMatchesNative, false);
  assert.equal(result.deploymentStatus, "HOLD");
});
test("requires exact explicit argument structure and accepts no approval/apply flags", () => {
  assert.deepEqual(parseArgs(["--legacy-repo", "/old", "--candidate-repo", "/new"]), {
    legacy: "/old",
    candidate: "/new",
  });
  for (const args of [[], ["--apply"], ["--legacy-repo", "/old", "--candidate-repo", "/new", "--approve"]])
    assert.throws(() => parseArgs(args));
});
test("CLI invalid input returns sanitized exit1, no partial JSON or filesystem paths", () => {
  const run = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./minimal-transition-preflight.mjs", import.meta.url)), "--apply"],
    { encoding: "utf8", timeout: 10000 }
  );
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /^Source inventory refused:/);
  assert(!run.stderr.includes(process.cwd()));
});
