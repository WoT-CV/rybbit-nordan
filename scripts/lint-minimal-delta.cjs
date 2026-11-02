// Compare only this fork's client source against the pinned native baseline.
// This is NOT a claim that inherited upstream lint debt has been repaired.
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const BASE = "e69e843db903581a097500926147549f35d5306f";
const ROOT = path.resolve(__dirname, "..");
function sourcePaths(...lists) {
  return [...new Set(lists.flatMap(list => list.split("\0")))]
    .filter(file => /^client\/src\/.+\.tsx?$/.test(file) && !file.split("/").includes(".."))
    .sort();
}
function signature(message, source) {
  return JSON.stringify([
    message.ruleId,
    message.message.split("\n")[0],
    source.split(/\r?\n/)[message.line - 1]?.trim(),
  ]);
}
function compareMessages(before, original, after, actual) {
  const allowance = new Map();
  for (const message of before.filter(message => message.severity === 2)) {
    const key = signature(message, original);
    allowance.set(key, (allowance.get(key) || 0) + 1);
  }
  let inheritedErrors = 0;
  const newErrors = [];
  const warnings = [];
  for (const message of after) {
    if (message.severity !== 2) {
      warnings.push(message);
      continue;
    }
    const key = signature(message, actual);
    if (allowance.get(key)) {
      inheritedErrors++;
      allowance.set(key, allowance.get(key) - 1);
    } else newErrors.push(message);
  }
  return { inheritedErrors, newErrors, warnings };
}
const exitStatus = result => (result.newErrors.length ? 1 : 0);

async function main() {
  const git = args =>
    execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
  // A shallow/missing baseline is an infrastructure failure, never an empty baseline.
  git(["cat-file", "-e", `${BASE}^{commit}`]);
  const baselinePaths = new Set(git(["ls-tree", "-r", "--name-only", "-z", BASE]).split("\0"));
  const files = sourcePaths(
    git(["diff", "--name-only", "--diff-filter=ACMR", "-z", BASE, "--", "client/src"]),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", "client/src"])
  );
  const requireClient = createRequire(path.join(ROOT, "client/package.json"));
  const { ESLint } = requireClient("eslint");
  const lint = new ESLint({
    cwd: path.join(ROOT, "client"),
    overrideConfigFile: true,
    overrideConfig: requireClient("eslint-config-next/core-web-vitals"),
  });
  const result = { base: BASE, files: files.length, inheritedErrors: 0, newErrors: [], warnings: [] };
  for (const file of files) {
    const actual = readFileSync(path.join(ROOT, file), "utf8");
    const original = baselinePaths.has(file) ? git(["show", `${BASE}:${file}`]) : "";
    const filePath = path.join(ROOT, file);
    const before = original ? (await lint.lintText(original, { filePath }))[0].messages : [];
    const after = (await lint.lintText(actual, { filePath }))[0].messages;
    const delta = compareMessages(before, original, after, actual);
    result.inheritedErrors += delta.inheritedErrors;
    for (const kind of ["newErrors", "warnings"])
      result[kind].push(
        ...delta[kind].map(message => ({ file, line: message.line, rule: message.ruleId, message: message.message }))
      );
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitStatus(result);
}
module.exports = { BASE, sourcePaths, signature, compareMessages, exitStatus };
if (require.main === module)
  main().catch(() => {
    console.error("Lint delta could not be verified (baseline, dependencies or source unavailable).");
    process.exitCode = 2;
  });
