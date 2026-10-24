import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const auditSource = readFileSync(join(repo, "client/scripts/audit-polish-coverage.mjs"), "utf8");

function audit(source, polish, args = []) {
  const fixture = mkdtempSync(join(tmpdir(), "rybbit-polish-audit-"));
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, "messages"));
  const script = join(fixture, "scripts/audit-polish-coverage.mjs");
  writeFileSync(script, auditSource);
  writeFileSync(join(fixture, "messages/en.json"), JSON.stringify(source));
  writeFileSync(join(fixture, "messages/pl.json"), JSON.stringify(polish));
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
}

test("image workflow invokes existing client scripts, not stale quality commands", () => {
  const { scripts } = JSON.parse(readFileSync(join(repo, "client/package.json"), "utf8"));
  const workflow = readFileSync(join(repo, ".github/workflows/build-wotcv-images.yml"), "utf8");
  const clientStep = workflow.split("- name: Verify WoT-CV client code")[1]?.split("- name:")[0];
  assert.ok(clientStep, "client verification step must exist");
  for (const [, command] of clientStep.matchAll(/\bpnpm ([\w:-]+)/g)) {
    assert.equal(typeof scripts[command], "string", `missing pnpm ${command}`);
  }
  assert.match(scripts.knip, /--config knip\.wotcv\.json/);
  assert.match(scripts["lint:wotcv"], /src\/components\/replay/);
  assert.match(scripts["format:check:wotcv"], /src\/components\/replay/);
  assert.equal(scripts["audit:polish"], "node scripts/audit-polish-coverage.mjs");
  assert.match(workflow, /node --test scripts\/tests\/\*\.test\.mjs/);
  assert.match(workflow, /wotcv_validate_compose_ports "\$\{RUNNER_TEMP\}\/wotcv-compose\.json"/);
});

test("complete Polish catalog keeps interpolation and plural variables", () => {
  const result = audit(
    { hello: "Hello {name}", count: "{count, plural, one {item} other {items}}" },
    { hello: "Cześć {name}", count: "{count, plural, one {element} other {elementy}}" }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("plural arms may differ while nested arguments and quoted text stay distinct", () => {
  const result = audit(
    { count: "{count, plural, one {{name}: item} other {{name}: items}} '{example}'" },
    { count: "{count, plural, one {{name}: element} few {{name}: elementy} other {{name}: elementów}} '{przykład}'" }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    audit(
      { select: "{gender, select, male {{name}} other {{name}}}" },
      { select: "{gender, select, male {{id}} other {{id}}}" }
    ).status,
    1
  );
});

for (const [label, source, polish] of [
  ["missing key", { hello: "Hello" }, {}],
  ["extra key", { hello: "Hello" }, { hello: "Cześć", extra: "Dodatkowy" }],
  ["empty value", { hello: "Hello" }, { hello: " " }],
  ["non-string value", { hello: "Hello" }, { hello: false }],
  ["placeholder mismatch", { hello: "Hello {name}" }, { hello: "Cześć {id}" }],
]) {
  test(`Polish audit fails on ${label}`, () => {
    const result = audit(source, polish);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  });
}

test("untranslated strings remain visible and strict mode fails without hiding them", () => {
  const result = audit({ hello: "Hello" }, { hello: "Hello" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Identyczne wartości wymagające przeglądu: 1/);
  assert.equal(audit({ hello: "Hello" }, { hello: "Hello" }, ["--strict-identical"]).status, 1);
  assert.equal(audit({ json: "JSON" }, { json: "JSON" }, ["--strict-identical"]).status, 0);
});
