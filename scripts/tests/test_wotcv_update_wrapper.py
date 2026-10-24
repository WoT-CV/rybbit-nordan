"""Run the real updater against fake Git/Docker/HTTP; never deploy an app."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SHA = "a" * 40


@unittest.skipUnless(os.name == "posix" and shutil.which("bash"), "Linux Bash required for hermetic wrapper fixtures")
class UpdateWrapperTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        outer = Path(self.directory.name)
        self.repo = outer / "repository"
        (self.repo / ".git").mkdir(parents=True)
        (self.repo / "scripts").mkdir()
        self.bin = outer / "bin"
        self.bin.mkdir()
        self.calls = outer / "calls"
        self.env = {
            **os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "RYBBIT_REPO_DIR": str(self.repo), "RYBBIT_UPDATE_LOG_DIR": str(outer / "logs"),
            "RYBBIT_UPDATE_LOCK": str(outer / "update.lock"), "RYBBIT_PUBLIC_HEALTH_URL": "https://synthetic.invalid/api/health",
            "WOTCV_REMOTE": "origin", "WOTCV_BRANCH": "feat/wotcv", "FAKE_SHA": SHA,
            "FAKE_STATE_TAG": "sha-" + SHA, "FAKE_CALLS": str(self.calls),
            "WOTCV_COMPOSE_PROJECT_NAME": "rybbit", "WOTCV_EXPECTED_COMPOSE_PROJECT_NAME": "rybbit",
            "COMPOSE_PROJECT_NAME": "rybbit",
        }
        for name in ("IMAGE_TAG", "WOTCV_EXPECTED_SHA", "FAKE_GIT_DIRTY", "FAKE_LOCK_BUSY", "FAKE_NO_STATE", "BASH_ENV"):
            self.env.pop(name, None)
        self.script(self.bin / "git", r'''
case "$*" in
  "status --short --branch") printf '%s\n' '## feat/wotcv' ;;
  "status --porcelain") if [[ ${FAKE_GIT_DIRTY:-0} == 1 ]]; then printf '%s\n' ' M docker-compose.yml'; fi ;;
  "log -1 --oneline") printf '%s\n' "$FAKE_SHA fixture" ;;
  "rev-parse origin/feat/wotcv") printf '%s\n' "$FAKE_SHA" ;;
  "show-ref --verify --quiet refs/heads/feat/wotcv") exit 0 ;;
  "fetch origin --prune"|"switch feat/wotcv"|"merge --ff-only origin/feat/wotcv") printf 'git %s\n' "$*" >>"$FAKE_CALLS" ;;
  *) printf 'Unexpected fake git command\n' >&2; exit 9 ;;
esac
''')
        self.script(self.bin / "docker", r'''
printf 'docker %s tag=%s\n' "$*" "${IMAGE_TAG:-missing}" >>"$FAKE_CALLS"
[[ ${IMAGE_TAG:-} == "$FAKE_STATE_TAG" ]] || { printf 'immutable image tag missing\n' >&2; exit 7; }
[[ $* == 'compose -f docker-compose.yml -f docker-compose.wotcv.yml -f docker-compose.wotcv.branch-build.yml ps' ]] || exit 8
''')
        self.script(self.bin / "curl", 'printf "http-probe\\n" >>"$FAKE_CALLS"\nprintf \'{"status":"ok"}\\n\'\n')
        self.script(self.bin / "flock", '[[ ${FAKE_LOCK_BUSY:-0} != 1 ]]\n')
        self.script(self.repo / "scripts/wotcv-branch-build-deploy.sh", r'''
printf 'branch expected=%s\n' "${WOTCV_EXPECTED_SHA:-missing}" >>"$FAKE_CALLS"
if [[ ${FAKE_NO_STATE:-0} != 1 ]]; then
  printf 'LAST_IMAGE_TAG=%s\n' "$FAKE_STATE_TAG" > "$RYBBIT_REPO_DIR/.wotcv-deployment.env"
fi
''')

    def script(self, path, content):
        path.write_text("#!/bin/bash\nset -Eeuo pipefail\n" + content, encoding="utf-8")
        path.chmod(0o700)

    def run_wrapper(self, **env):
        # Production rejects root. CI fixtures can run as root in an isolated
        # container: override only this early check in the temporary script.
        source = (ROOT / "scripts/update_rybbit_wotcv.sh").read_text()
        if os.getuid() == 0:
            source = source.replace('if [[ "${EUID}" -eq 0 ]]; then', 'if false; then', 1)
        script = self.bin / "under-test.sh"
        script.write_text(source)
        return subprocess.run(["bash", str(script)], env={**self.env, **env},
                              capture_output=True, text=True, timeout=15)

    def call_log(self):
        return self.calls.read_text() if self.calls.exists() else ""

    def test_exports_completed_deployment_tag_before_compose_ps(self):
        result = self.run_wrapper()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.call_log()
        self.assertIn("branch expected=" + SHA, calls)
        self.assertIn("ps tag=sha-" + SHA, calls)
        self.assertLess(calls.index("git merge --ff-only"), calls.index("branch expected="))
        self.assertLess(calls.index("branch expected="), calls.index("docker compose"))
        self.assertEqual(calls.count("http-probe"), 2)

    def test_dirty_tree_stops_before_fetch_or_application(self):
        result = self.run_wrapper(FAKE_GIT_DIRTY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("working tree must be clean", result.stdout)
        self.assertEqual(self.call_log(), "")

    def test_busy_lock_stops_before_repository_or_application(self):
        result = self.run_wrapper(FAKE_LOCK_BUSY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.call_log(), "")

    def test_expected_sha_mismatch_stops_before_fast_forward_or_application(self):
        result = self.run_wrapper(WOTCV_EXPECTED_SHA="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match expected", result.stdout)
        self.assertIn("git fetch", self.call_log())
        self.assertNotIn("git merge", self.call_log())
        self.assertNotIn("branch expected", self.call_log())

    def test_missing_deployment_state_never_runs_compose_with_blank_tag(self):
        result = self.run_wrapper(FAKE_NO_STATE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("branch expected", self.call_log())
        self.assertNotIn("docker compose", self.call_log())


if __name__ == "__main__":
    unittest.main()
