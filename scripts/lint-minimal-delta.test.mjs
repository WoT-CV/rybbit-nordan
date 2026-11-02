import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const { BASE, sourcePaths, compareMessages, exitStatus } = createRequire(import.meta.url)("./lint-minimal-delta.cjs");
const error = (line = 1, message = "An error\nposition-dependent frame", ruleId = "rule/a") => ({
  line,
  message,
  ruleId,
  severity: 2,
});

test("pins the native baseline, selects source TS/TSX, handles NUL and duplicate/untracked paths", () => {
  assert.equal(BASE, "e69e843db903581a097500926147549f35d5306f");
  assert.deepEqual(
    sourcePaths(
      "client/src/a.ts\0client/src/a.ts\0client/src/[site]/b.tsx\0",
      "client/src/new.ts\0client/.next/x.ts\0server/src/x.ts\0client/src/../secret.ts\0client/src/a.js\0"
    ),
    ["client/src/[site]/b.tsx", "client/src/a.ts", "client/src/new.ts"]
  );
});
test("moving unchanged offending code does not invent a new error", () => {
  const result = compareMessages([error()], "bad();", [error(3, "An error\nnew frame")], "// added\n\n  bad();\n");
  assert.equal(result.inheritedErrors, 1);
  assert.equal(exitStatus(result), 0);
});
test("uses multiplicity, not a set which could hide a duplicate regression", () => {
  const result = compareMessages([error()], "bad();", [error(), error(2)], "bad();\nbad();");
  assert.equal(result.inheritedErrors, 1);
  assert.equal(result.newErrors.length, 1);
  assert.equal(exitStatus(result), 1);
});
test("changed code, rule or message cannot consume the old allowance", () => {
  for (const [message, source] of [
    [error(), "worse();"],
    [error(1, "New error"), "bad();"],
    [error(1, "An error", "rule/b"), "bad();"],
  ])
    assert.equal(compareMessages([error()], "bad();", [message], source).newErrors.length, 1);
});
test("new files have no baseline allowance; removed errors and warnings stay separate", () => {
  assert.equal(compareMessages([], "", [error()], "bad();").newErrors.length, 1);
  const warning = { ...error(), severity: 1 };
  const result = compareMessages([error()], "bad();", [warning], "bad();");
  assert.equal(result.inheritedErrors, 0);
  assert.deepEqual(result.warnings, [warning]);
  assert.equal(exitStatus(result), 0);
});
test("unavailable Git/baseline fails closed with infrastructure exit 2 and sanitized output", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./lint-minimal-delta.cjs", import.meta.url))], {
    env: { PATH: "" },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr.trim(),
    "Lint delta could not be verified (baseline, dependencies or source unavailable)."
  );
});
