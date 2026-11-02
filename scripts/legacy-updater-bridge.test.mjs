import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./wotcv-branch-build-deploy.sh", import.meta.url));
const source = readFileSync(script, "utf8");

// Do not allow shell startup injection into this isolated test harness. The
// bridge's contract covers deployment configuration, not a compromised Bash.
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|BASH_FUNC_.*)$/i.test(key))
);
const candidates =
  process.platform === "win32"
    ? ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files/Git/usr/bin/bash.exe", "bash"]
    : ["/bin/bash", "/usr/bin/bash", "bash"];
const bash = candidates.find(candidate => {
  const result = spawnSync(candidate, ["--noprofile", "--norc", "-c", "builtin exit 0"], {
    env: cleanEnvironment,
    encoding: "utf8",
    timeout: 10000,
  });
  return !result.error && result.status === 0;
});

test("legacy entry point is LF-only and consists solely of unconditional builtin refusal", () => {
  assert(source.startsWith("#!/bin/bash\n"));
  assert(!source.includes("\r"), "Bash bridge must retain LF line endings");
  const executable = source
    .split("\n")
    .filter(line => !line.startsWith("#"))
    .join("\n");
  assert.match(executable, /^builtin printf '%s\\n' \\\n(?:  '[^'\r\n]*' \\\n)*  '[^'\r\n]*' >&2\nbuiltin exit 78\n$/);
  assert(!/[$`]/.test(executable), "No environment, argument or command expansion is allowed");
});

test(
  "actual Bash refuses every approval/apply configuration without invoking external commands",
  {
    skip: bash ? false : "Bash is not available; unconditional source-contract test still runs",
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "rybbit-legacy-bridge-test-"));
    const marker = join(directory, "external-command-was-called");
    const commands = [
      "git",
      "docker",
      "docker-compose",
      "psql",
      "clickhouse-client",
      "redis-cli",
      "npm",
      "pnpm",
      "node",
      "curl",
      "sudo",
      "systemctl",
      "env",
      "sh",
      "source",
      "wotcv_enter_maintenance",
      "wotcv_drain_backend",
      "wotcv_auth_prepare_cutover",
    ];
    try {
      for (const command of commands)
        writeFileSync(
          join(directory, command),
          "#!/bin/bash\nbuiltin printf 'called\\n' >> external-command-was-called\nbuiltin exit 99\n",
          { mode: 0o755 }
        );
      const environment = {
        ...Object.fromEntries(Object.entries(cleanEnvironment).filter(([key]) => key.toUpperCase() !== "PATH")),
        PATH: directory,
        WOTCV_CANDIDATE_START_ACK: "empty-isolated-candidate-approved",
        WOTCV_APPROVE: "1",
        WOTCV_APPLY: "1",
        WOTCV_FORCE: "1",
        WOTCV_EXPECTED_SHA: "a".repeat(40),
        WOTCV_COMPOSE_PROJECT_NAME: "rybbit",
        COMPOSE_PROJECT_NAME: "rybbit",
        RYBBIT_REPO_DIR: directory,
        BASH_ENV: "",
        ENV: "",
      };
      const bashDirectory =
        process.platform === "win32"
          ? directory.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
          : directory;
      // Set PATH after Bash initializes: Git Bash otherwise prepends its own
      // utilities. Source executes the actual file, including its exit, in Bash.
      const run = (command, args = []) =>
        spawnSync(bash, ["--noprofile", "--norc", "-c", command, "legacy-bridge-test", bashDirectory, ...args], {
          cwd: directory,
          env: environment,
          encoding: "utf8",
          timeout: 10000,
        });
      // Positive control: prove that PATH sentinels really are executable in this
      // Bash (including Git Bash on Windows), then clear only the test marker.
      const control = run('PATH="$1"; git');
      assert.ifError(control.error);
      assert.equal(control.status, 99, control.stderr);
      assert(existsSync(marker));
      rmSync(marker);

      for (const args of [
        [],
        ["--apply"],
        ["--approve", "--force", "--reset", "--ack", "empty-isolated-candidate-approved"],
        ["deploy", "WOTCV_CANDIDATE_START_ACK=empty-isolated-candidate-approved"],
      ]) {
        const result = run('PATH="$1"; shift; builtin source "$@"', [script.replaceAll("\\", "/"), ...args]);
        assert.ifError(result.error);
        assert.equal(result.status, 78, result.stderr);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^HOLD: legacy -> minimal transition/m);
        assert.match(result.stderr, /^HOLD: przejscie ze starej produkcji/m);
        assert.match(result.stderr, /separate data decision and approved isolated rehearsal/);
        assert.match(result.stderr, /release remains HOLD/);
        assert(!existsSync(marker), "Bridge must not invoke any external command");
        assert(!existsSync(join(directory, ".wotcv-deployment.env")));
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
