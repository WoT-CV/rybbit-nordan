import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE = "e69e843db903581a097500926147549f35d5306f";
export const BOUNDARIES = Object.freeze([
  "server/src/db/postgres/schema.ts",
  "server/src/db/postgres/initPostgres.ts",
  "server/src/db/clickhouse/schema/core.ts",
  "server/src/services/userId/userIdService.ts",
  "server/src/services/replay/sessionReplayIngestService.ts",
  "server/src/services/replay/sessionReplayQueryService.ts",
  "server/src/services/storage/r2StorageService.ts",
  "client/src/components/replay/replayStore.ts",
  "client/src/components/replay/player/ReplayPlayerCore.tsx",
  "server/docker-entrypoint.sh",
  "pnpm-lock.yaml",
]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const journalPath = "server/drizzle/meta/_journal.json";

export function readJournal(git, revision) {
  const raw = git(["show", `${revision}:${journalPath}`]);
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Journal too large");
  const journal = JSON.parse(raw.toString());
  if (
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0 ||
    journal.entries.length > 256
  )
    throw new Error("Unsupported journal");
  const entries = journal.entries.map((entry, idx) => {
    if (
      entry.idx !== idx ||
      typeof entry.tag !== "string" ||
      entry.tag.length > 160 ||
      !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      Number(entry.tag.slice(0, 4)) !== idx ||
      !Number.isSafeInteger(entry.when) ||
      entry.when < 0 ||
      entry.version !== "7" ||
      typeof entry.breakpoints !== "boolean"
    )
      throw new Error("Invalid journal entry");
    const sql = git(["show", `${revision}:server/drizzle/${entry.tag}.sql`]);
    return {
      idx,
      tag: entry.tag,
      when: entry.when,
      version: entry.version,
      breakpoints: entry.breakpoints,
      sqlSha256: hash(sql),
    };
  });
  return { sha256: hash(raw), entries };
}

export function compareJournals(left, right) {
  const differences = [];
  for (let idx = 0; idx < Math.max(left.entries.length, right.entries.length); idx++) {
    const a = left.entries[idx] ?? null,
      b = right.entries[idx] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ idx, legacy: a, candidate: b });
  }
  return differences;
}

export function makeReport(legacy, candidate, baseline) {
  const journalDifferences = compareJournals(legacy.journal, candidate.journal);
  const candidateJournalMatchesNative =
    /^[a-f0-9]{64}$/.test(candidate.journal.sha256 ?? "") &&
    candidate.journal.sha256 === baseline.journal.sha256 &&
    compareJournals(candidate.journal, baseline.journal).length === 0;
  const boundaries = BOUNDARIES.map(path => ({
    path,
    legacySha256: legacy.hashes[path],
    candidateSha256: candidate.hashes[path],
    nativeSha256: baseline.hashes[path],
    candidateMatchesNative:
      /^[a-f0-9]{64}$/.test(candidate.hashes[path] ?? "") && candidate.hashes[path] === baseline.hashes[path],
  }));
  return {
    observedAt: new Date().toISOString(),
    scope: "committed-source-only",
    readOnly: true,
    legacySha: legacy.sha,
    candidateSha: candidate.sha,
    nativeBaseSha: BASE,
    worktreesInspected: false,
    liveDeploymentSha: null,
    journal: {
      legacyEntries: legacy.journal.entries.length,
      candidateEntries: candidate.journal.entries.length,
      legacySha256: legacy.journal.sha256,
      candidateSha256: candidate.journal.sha256,
      candidateMatchesNative: candidateJournalMatchesNative,
      differences: journalDifferences,
    },
    boundaries,
    sourceBoundaryMatchesNative: candidateJournalMatchesNative && boundaries.every(row => row.candidateMatchesNative),
    deploymentStatus: "HOLD",
    dataStrategy: "NOT_SELECTED",
    verification: Object.fromEntries(
      [
        "runtimeRevision",
        "runtimeSchema",
        "historyCoverage",
        "identityContinuity",
        "objectStorage",
        "restoreDrill",
        "oldWriterCompatibility",
        "compiledImages",
        "sourcePublication",
        "nginxCdn",
        "liveGrafana",
        "mailGscSql",
        "physicalIPhone",
        "approvedWindowAndRollback",
      ].map(key => [key, "NOT_VERIFIED"])
    ),
    warning:
      "Source equality is not data compatibility or deployment approval. Do not start native migrations on legacy storage.",
  };
}

export function parseArgs(args) {
  if (args.length !== 4 || args[0] !== "--legacy-repo" || args[2] !== "--candidate-repo" || !args[1] || !args[3])
    throw new Error("Explicit repository paths required");
  return { legacy: args[1], candidate: args[3] };
}

function gitReader(directory) {
  const root = realpathSync(resolve(directory));
  const git = args =>
    execFileSync("git", gitArguments(root, args), {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
      env: gitEnvironment(process.env),
    });
  const top = realpathSync(git(["rev-parse", "--show-toplevel"]).toString().trim());
  if (top !== root) throw new Error("Repository root required");
  const sha = git(["rev-parse", "--verify", "HEAD^{commit}"]).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Commit required");
  return { root, sha, git };
}

export function gitArguments(root, args) {
  if (!["show", "rev-parse", "cat-file"].includes(args[0])) throw new Error("Read-only Git commands required");
  return ["--no-replace-objects", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-C", root, ...args];
}

export function gitEnvironment(env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function inspectSnapshot(reader, sha = reader.sha) {
  return {
    sha,
    journal: readJournal(reader.git, sha),
    hashes: Object.fromEntries(BOUNDARIES.map(path => [path, hash(reader.git(["show", `${sha}:${path}`]))])),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const legacy = gitReader(args.legacy),
    candidate = gitReader(args.candidate);
  if (legacy.root === candidate.root) throw new Error("Distinct repositories required");
  candidate.git(["cat-file", "-e", `${BASE}^{commit}`]);
  const report = makeReport(inspectSnapshot(legacy), inspectSnapshot(candidate), inspectSnapshot(candidate, BASE));
  console.log(JSON.stringify(report, null, 2));
  // There is deliberately no flag/evidence file which can turn this source-only tool green.
  process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error(
      "Source inventory refused: explicit distinct Git roots, complete pinned history and supported source files are required. No runtime inspection or mutation was attempted."
    );
    process.exitCode = 1;
  }
}
