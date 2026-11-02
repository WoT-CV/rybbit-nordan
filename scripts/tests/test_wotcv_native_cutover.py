"""Offline regression tests: never run Docker, SSH, native startup or migrations.

The nginx fixture is deliberately synthetic and pinned to its own SHA in tests.
It exercises the transformation, not provenance of the production vhost bytes.
"""

from copy import deepcopy
from contextlib import ExitStack
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error

import test_wotcv_private_phase as private_tests


SCRIPT = Path(__file__).resolve().parents[1] / "wotcv-native-cutover.py"
SPEC = importlib.util.spec_from_file_location("wotcv_native_cutover_under_test", SCRIPT)
phase = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(phase)
installer = private_tests.installer
private = private_tests.phase

ORIGINAL = '''server {
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/tracking/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tracking/privkey.pem;
    add_header X-Robots-Tag "noindex, nofollow, nosnippet, noimageindex" always;
    location ^~ /api/session-replay/record/ {
        proxy_pass http://127.0.0.1:3001;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
    }
    location / {
        proxy_pass http://127.0.0.1:3002;
    }
    location = /robots.txt { return 410; }
    location = /sitemap.xml { return 410; }
}
'''


def public_fixture():
    config, images, credentials = private_tests.closed_fixture()
    config["services"]["backend"]["environment"].update({
        "BASE_URL": phase.PUBLIC, "SERVER_URL": phase.PUBLIC,
    })
    config["services"]["backend"]["restart"] = "unless-stopped"
    config["services"]["client"]["environment"]["NEXT_PUBLIC_BACKEND_URL"] = phase.PUBLIC
    images["client"] = config["services"]["client"]["image"] = phase.PUBLIC_CLIENT
    return config, images, credentials


class OfflineTestCase(unittest.TestCase):
    def setUp(self):
        # A mistaken test setup cannot reach the machine or the network.
        for target, name in ((installer, "docker"), (installer, "run"),
                             (phase.urllib.request, "build_opener")):
            guard = patch.object(target, name, side_effect=AssertionError("Real I/O forbidden in offline tests"))
            guard.start()
            self.addCleanup(guard.stop)


class NginxCandidateTests(OfflineTestCase):
    def setUp(self):
        super().setUp()
        guard = patch.object(phase, "ORIGINAL_SHA", hashlib.sha256(ORIGINAL.encode()).hexdigest())
        guard.start()
        self.addCleanup(guard.stop)

    def test_hashguard_rejects_even_one_unreviewed_byte(self):
        for public in (False, True):
            with self.subTest(public=public), self.assertRaisesRegex(ValueError, "changed"):
                phase.nginx_candidate(ORIGINAL + "\n", public=public)

    def test_rollback_restores_exact_original_bytes_without_permanent_native_namespace(self):
        self.assertEqual(phase.nginx_candidate(ORIGINAL), ORIGINAL)
        self.assertEqual(phase.PREFIX, "/api")
        self.assertNotIn("expose-producer", phase.ACKS)

    def test_canonical_replay_and_config_accept_only_fresh_site_and_reject_encoded_replay(self):
        public = phase.nginx_candidate(ORIGINAL, public=True)
        expressions = re.findall(r'if \(\$uri !~ "([^"\n]+)"\)', public)
        self.assertEqual(len(expressions), 2)
        for expression, prefix in zip(expressions, ("/api/site/tracking-config/", "/api/session-replay/record/")):
            for site in ("1", phase.SITE):
                with self.subTest(prefix=prefix, site=site):
                    self.assertIsNotNone(re.search(expression, prefix + site))
            for site in ("", "2", "3e894930d08d", "01", "1/", phase.SITE + "/extra", "other"):
                with self.subTest(prefix=prefix, site=site):
                    self.assertIsNone(re.search(expression, prefix + site))
        encoding = re.search(r'if \(\$http_content_encoding !~\* "([^"\n]+)"\) \{ return 415;', public).group(1)
        for value in ("", "identity", "IDENTITY"):
            self.assertIsNotNone(re.search(encoding, value, re.I))
        for value in ("gzip", "br", "gzip, identity", "identity, gzip", "deflate", " identity "):
            self.assertIsNone(re.search(encoding, value, re.I))
        self.assertIn("proxy_request_buffering off;", public)
        self.assertIn("client_max_body_size 50M;", public)

    def test_public_uses_canonical_native_routes_keeps_tls_and_marks_assets_uncached(self):
        public = phase.nginx_candidate(ORIGINAL, public=True)
        self.assertNotIn("http://127.0.0.1:3001", public)
        self.assertNotIn("http://127.0.0.1:3002", public)
        self.assertIn("proxy_pass http://127.0.0.1:13002;", public)
        self.assertNotIn("native-20261102", public)
        assets = re.search(r'location ~ (\^/api/[^\s]+) \{([^}]+)\}', public)
        for endpoint in ("script.js", "replay.js"):
            self.assertIsNotNone(re.search(assets.group(1), "/api/" + endpoint))
        for endpoint in ("track", "identify", "scriptXjs", "script.js/", "script.js/extra"):
            self.assertIsNone(re.search(assets.group(1), "/api/" + endpoint))
        self.assertIn('Cache-Control "no-store" always;', assets.group(2))
        self.assertIn('X-Robots-Tag "' + phase.NOINDEX + '" always;', assets.group(2))
        self.assertIn('ssl_certificate_key /etc/letsencrypt/live/tracking/privkey.pem;', public)
        self.assertEqual(public.count("location ^~ /api/session-replay/record/ {"), 1)
        self.assertIn("location /api/ {\n        proxy_pass http://127.0.0.1:13001;", public)

    def test_structure_guard_refuses_missing_or_duplicate_legacy_anchor(self):
        anchor = "    location ^~ /api/session-replay/record/ {"
        for original in (ORIGINAL.replace(anchor, "    location /record/ {"), ORIGINAL + anchor):
            with self.subTest(original=original), patch.object(phase, "ORIGINAL_SHA", hashlib.sha256(original.encode()).hexdigest()):
                with self.assertRaisesRegex(ValueError, "structure"):
                    phase.nginx_candidate(original, public=True)


class PublicConfigurationTests(OfflineTestCase):
    def test_public_normalization_accepts_isolated_model_without_mutating_any_input(self):
        config, images, credentials = public_fixture()
        before = deepcopy((config, images, credentials))
        phase.validate_public(installer, private, config, images, credentials)
        self.assertEqual((config, images, credentials), before)

    def test_requires_exact_public_origins_and_native_backend_restart(self):
        for service, field in (("backend", "BASE_URL"), ("backend", "SERVER_URL"),
                               ("client", "NEXT_PUBLIC_BACKEND_URL")):
            for bad in ("http://127.0.0.1:13001", phase.PUBLIC + "/", "https://evil.example"):
                with self.subTest(service=service, field=field, bad=bad):
                    config, images, credentials = public_fixture()
                    config["services"][service]["environment"][field] = bad
                    with self.assertRaises(installer.Refused):
                        phase.validate_public(installer, private, config, images, credentials)
        config, images, credentials = public_fixture()
        config["services"]["backend"]["restart"] = "always"
        with self.assertRaises(installer.Refused):
            phase.validate_public(installer, private, config, images, credentials)

    def test_normalization_cannot_hide_isolation_signup_image_or_credential_regressions(self):
        def mutate(config, kind):
            services = config["services"]
            if kind == "public-port":
                services["backend"]["ports"][0]["host_ip"] = "0.0.0.0"
            elif kind == "old-volume":
                config["volumes"]["postgres-data"]["name"] = "legacy_postgres-data"
            elif kind == "extra-service":
                services["worker"] = {}
            elif kind == "signup":
                services["backend"]["environment"]["DISABLE_SIGNUP"] = "false"
            elif kind == "mutable-image":
                services["client"]["image"] = "rybbit:latest"
            else:
                services["backend"]["environment"]["BETTER_AUTH_SECRET"] = "f" * 64
        for kind in ("public-port", "old-volume", "extra-service", "signup", "mutable-image", "credentials"):
            with self.subTest(kind=kind):
                config, images, credentials = public_fixture()
                mutate(config, kind)
                with self.assertRaises(installer.Refused):
                    phase.validate_public(installer, private, config, images, credentials)


class PublicRuntimeTests(OfflineTestCase):
    def runtime_fixture(self):
        config, images, _credentials = public_fixture()
        live = {}
        for name, service in config["services"].items():
            mounts = []
            if name in installer.VOLUMES:
                key, target = installer.VOLUMES[name]
                mounts = [{"Type": "volume", "Name": installer.PROJECT + "_" + key, "Destination": target}]
            live[name] = {
                "Id": "native-" + name, "Image": images[name], "Mounts": mounts,
                "State": {"Status": "running", "Health": {"Status": "healthy"}},
                "Config": {"Env": [key + "=" + value for key, value in service.get("environment", {}).items()]},
                "HostConfig": {"RestartPolicy": {"Name": service["restart"]}},
            }
        private_runtime = SimpleNamespace(
            snapshot=Mock(return_value=live), check_live=private.check_live,
            account_guard=Mock(), PROFILE=deepcopy(private.PROFILE),
        )
        db_ids = {name: live[name]["Id"] for name in installer.VOLUMES}
        return live, images, private_runtime, db_ids

    @staticmethod
    def set_env(live, service, field, value):
        env = [item for item in live[service]["Config"]["Env"] if not item.startswith(field + "=")]
        if value is not None:
            env.append(field + "=" + value)
        live[service]["Config"]["Env"] = env

    def test_public_runtime_validates_real_inspect_model_without_mutation_or_commands(self):
        live, images, private_runtime, db_ids = self.runtime_fixture()
        before = deepcopy(live)
        self.assertIs(phase.verify_public_live(installer, private_runtime, images, db_ids), live)
        self.assertEqual(live, before)
        private_runtime.snapshot.assert_called_once_with(installer)
        private_runtime.account_guard.assert_called_once_with(installer)

    def test_runtime_requires_actual_public_origins_signup_and_profile_not_only_compose_input(self):
        cases = (("backend", "BASE_URL", "http://127.0.0.1:13002"),
                 ("backend", "SERVER_URL", "https://evil.example"),
                 ("backend", "DISABLE_SIGNUP", "false"),
                 ("backend", "DISABLE_SIGNUP", "TRUE"),
                 ("client", "NEXT_PUBLIC_BACKEND_URL", "http://127.0.0.1:13001"),
                 ("client", "NEXT_PUBLIC_DISABLE_SIGNUP", "false"),
                 ("client", "NEXT_PUBLIC_DISABLE_SIGNUP", None),
                 ("backend", "WOTCV_REPLAY_CORRELATION_JSON", "null"),
                 ("backend", "WOTCV_REPLAY_CORRELATION_JSON", "[]"))
        for service, field, bad in cases:
            with self.subTest(service=service, field=field, value=bad):
                live, images, private_runtime, db_ids = self.runtime_fixture()
                self.set_env(live, service, field, bad)
                with self.assertRaises(installer.Refused):
                    phase.verify_public_live(installer, private_runtime, images, db_ids)
        for field, bad in (("siteIds", [True]), ("siteIds", [2]), ("siteIds", ["1"]),
                           ("orgId", True), ("requestOrigin", "https://evil.example")):
            with self.subTest(field=field, value=bad):
                live, images, private_runtime, db_ids = self.runtime_fixture()
                profile = deepcopy(private.PROFILE)
                profile[0][field] = bad
                self.set_env(live, "backend", "WOTCV_REPLAY_CORRELATION_JSON", json.dumps(profile))
                with self.assertRaises(installer.Refused):
                    phase.verify_public_live(installer, private_runtime, images, db_ids)

    def test_runtime_rejects_database_replacement_restart_drift_and_account_guard_failure(self):
        for kind in ("db-replaced", "restart", "account"):
            with self.subTest(kind=kind):
                live, images, private_runtime, db_ids = self.runtime_fixture()
                if kind == "db-replaced":
                    live["postgres"]["Id"] = "replacement-db"
                elif kind == "restart":
                    live["backend"]["HostConfig"]["RestartPolicy"]["Name"] = "no"
                else:
                    private_runtime.account_guard.side_effect = installer.Refused("account drift")
                with self.assertRaises(installer.Refused):
                    phase.verify_public_live(installer, private_runtime, images, db_ids)


class ProducerHtmlTests(OfflineTestCase):
    def native_tag(self):
        return '<script src="' + phase.PUBLIC + phase.PREFIX + '/script.js?siteId=' + phase.SITE + '" data-site-id="' + phase.SITE + '"></script>'

    def check(self, html, status=200):
        with patch.object(phase, "http", return_value=(status, html.encode(), {})) as http:
            phase.producer_html_guard(installer)
        http.assert_called_once_with("https://wot-cv.com/")

    def test_requires_one_real_native_script_for_the_correct_site(self):
        self.check("<!doctype html><head>" + self.native_tag() + "</head>")
        for html in ("", self.native_tag() * 2, self.native_tag().replace(phase.SITE, "2"),
                     self.native_tag() + '<script src="https://tracking.wot-cv.com/api/script.js"></script>',
                     self.native_tag().replace("?siteId=" + phase.SITE, ""),
                     self.native_tag().replace("<script", '<script type="application/ld+json"'),
                     self.native_tag().replace("src=", "data-src="),
                     "<!--" + self.native_tag() + "-->"):
            with self.subTest(html=html), self.assertRaises(installer.Refused):
                self.check(html)

    def test_http_error_cannot_count_as_deployed_html(self):
        with self.assertRaises(installer.Refused):
            self.check(self.native_tag(), status=503)


class ProbeTests(OfflineTestCase):
    @staticmethod
    def healthy(url, **kwargs):
        headers = {"Cache-Control": "no-store", "X-Robots-Tag": phase.NOINDEX}
        if url in (phase.PUBLIC + "/api/site/tracking-config/1", phase.PUBLIC + "/api/site/tracking-config/" + phase.SITE):
            headers["Access-Control-Allow-Origin"] = "https://wot-cv.com"
            config = {"sessionReplay": True, "webVitals": True, "trackErrors": True,
                      "requestCorrelation": {"origins": ["https://api.wot-cv.com"]}}
            return 200, json.dumps(config).encode(), headers
        if url in (phase.PUBLIC + phase.PREFIX + "/script.js?siteId=" + phase.SITE, phase.PUBLIC + phase.PREFIX + "/replay.js"):
            return 200, b"x" * 1001, headers
        if url == phase.PUBLIC + "/api/session-replay/record/" + phase.SITE and kwargs.get("headers", {}).get("Content-Encoding") == "gzip":
            return 415, b"", headers
        if url == phase.PUBLIC + "/api/health":
            return 200, b"OK", headers
        if url == phase.PUBLIC + "/api/config":
            return 200, b'{"disableSignup":true}', headers
        if url in (phase.PUBLIC + "/", phase.PUBLIC + "/login"):
            return 200, b"login", headers
        if url == phase.PUBLIC + "/api/sites/1/session-replay/correlation-config":
            return 403, b"", headers
        return 410, b"", headers

    def test_producer_probe_checks_cors_and_canonical_uncached_assets(self):
        with patch.object(phase, "http", side_effect=self.healthy) as http:
            phase.producer_probe(installer)
        self.assertEqual(http.call_count, 3)
        self.assertEqual(http.call_args_list[0].kwargs, {"headers": {"Origin": "https://wot-cv.com"}})
        self.assertTrue(http.call_args_list[1].args[0].endswith("/api/script.js?siteId=" + phase.SITE))
        self.assertTrue(http.call_args_list[-1].args[0].endswith("/api/replay.js"))

    def test_producer_probe_rejects_incomplete_features_cors_cache_and_noindex(self):
        cases = ("cors", "feature", "origins", "small-asset", "cache", "noindex")
        for kind in cases:
            def response(url, **kwargs):
                status, body, headers = self.healthy(url, **kwargs)
                if "/site/tracking-config/" in url:
                    if kind == "cors":
                        headers["Access-Control-Allow-Origin"] = "*"
                    config = json.loads(body)
                    if kind == "feature":
                        config["sessionReplay"] = False
                    if kind == "origins":
                        config["requestCorrelation"]["origins"] = ["https://evil.example"]
                    body = json.dumps(config).encode()
                if "/script.js?" in url:
                    if kind == "small-asset":
                        body = b"404"
                    if kind == "cache":
                        headers.pop("Cache-Control")
                    if kind == "noindex":
                        headers.pop("X-Robots-Tag")
                return status, body, headers
            with self.subTest(kind=kind), patch.object(phase, "http", side_effect=response):
                with self.assertRaises(installer.Refused):
                    phase.producer_probe(installer)

    def test_public_probe_accepts_only_closed_native_panel_and_retired_legacy_paths(self):
        with patch.object(phase, "http", side_effect=self.healthy) as http:
            phase.public_probe(installer)
        urls = {call.args[0] for call in http.call_args_list}
        for path in ("/api/script.js?siteId=" + phase.SITE, "/api/site/tracking-config/2", "/api/session-replay/record/2", "/robots.txt", "/sitemap.xml", "/login"):
            self.assertIn(phase.PUBLIC + path, urls)
        for bad_path in ("/api/health", "/api/config", "/login", "/api/site/tracking-config/2", "/api/session-replay/record/2",
                         "/api/session-replay/record/" + phase.SITE, "/api/sites/1/session-replay/correlation-config"):
            def response(url, **kwargs):
                if url == phase.PUBLIC + bad_path:
                    return 200, b'{"disableSignup":false}', {}
                return self.healthy(url, **kwargs)
            with self.subTest(path=bad_path), patch.object(phase, "http", side_effect=response):
                with self.assertRaises(installer.Refused):
                    phase.public_probe(installer)

    def test_http_is_bounded_disables_proxies_and_does_not_follow_redirects(self):
        response = Mock(status=200, headers={})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"OK"
        opener = Mock()
        opener.open.return_value = response
        with patch.object(phase.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(phase.http("https://example.invalid/", method="POST", data=b"x"), (200, b"OK", {}))
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], phase.NoRedirect)
        self.assertIsNone(phase.NoRedirect().redirect_request(None, None, None, None, None, None))
        response.read.assert_called_once_with(2 * 1024 * 1024 + 1)
        self.assertEqual(opener.open.call_args.kwargs, {"timeout": 15})
        response.read.return_value = b"x" * (2 * 1024 * 1024 + 1)
        with patch.object(phase.urllib.request, "build_opener", return_value=opener):
            with self.assertRaisesRegex(RuntimeError, "bounded probe"):
                phase.http("https://example.invalid/")

    def test_http_error_status_is_returned_for_explicit_probe_assertions(self):
        error = urllib.error.HTTPError("https://example.invalid/", 410, "Gone", {"Cache-Control": "no-store"}, io.BytesIO(b"retired"))
        opener = Mock()
        opener.open.side_effect = error
        with patch.object(phase.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(phase.http("https://example.invalid/"), (410, b"retired", error.headers))


class ExecutePreflightTests(OfflineTestCase):
    def tool_fixture(self):
        return SimpleNamespace(
            require=installer.require, Refused=installer.Refused,
            load=Mock(return_value={"phase": "bootstrap", "legacy": []}),
            private_write=Mock(side_effect=AssertionError("Unexpected persistent write")),
            docker=Mock(side_effect=AssertionError("Unexpected Docker mutation")),
            json_docker=Mock(side_effect=AssertionError("Unexpected image inspection")),
            digest=Mock(return_value=phase.ORIGINAL_SHA),
            legacy_snapshot=Mock(return_value=[]), SOURCE=installer.SOURCE,
            VOLUMES=installer.VOLUMES, SERVICES=installer.SERVICES, LEGACY=installer.LEGACY,
        )

    def staged_fixture(self, stack, root, command):
        """Create phase receipts as inert fixture data, never call native operations."""
        tool = self.tool_fixture()
        stack.enter_context(patch.object(phase, "ROOT", root))
        stack.enter_context(patch.object(phase, "ORIGINAL_SHA", hashlib.sha256(ORIGINAL.encode()).hexdigest()))
        tool.digest.side_effect = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        vhost = root / "vhost.conf"
        stack.enter_context(patch.object(phase, "VHOST", vhost))
        mode = command in ("retire", "cleanup")
        vhost.write_bytes(phase.nginx_candidate(ORIGINAL, public=mode).encode())
        (root / "cutover-public-ready.json").write_text(json.dumps({"images": {}, "dbIds": {}}))
        (root / "cutover-legacy-retired.json").write_text("{}")
        if command != "promote":
            (root / "cutover-promote-attempt.json").write_text('{"legacyVolumes": {}}')
        stack.enter_context(patch.object(phase, "legacy_volumes", return_value={}))
        stack.enter_context(patch.object(phase, "paths_guard"))
        stack.enter_context(patch.object(phase, "original_config", return_value=ORIGINAL))
        stack.enter_context(patch.object(phase, "private_guard", return_value=({}, {})))
        for name in ("producer_probe", "producer_html_guard", "native_data_guard", "public_probe", "verify_public_live"):
            stack.enter_context(patch.object(phase, name))
        image = {"Id": phase.PUBLIC_CLIENT, "Config": {"Labels": {
            "org.opencontainers.image.revision": installer.SOURCE,
            "wotcv.fresh.kind": "client-production",
        }}}
        tool.json_docker.side_effect = None
        tool.json_docker.return_value = [image]
        return tool, vhost

    def test_unknown_operation_refuses_before_loading_any_operator_state(self):
        tool = self.tool_fixture()
        with self.assertRaisesRegex(installer.Refused, "Unknown"):
            phase.execute(tool, private, "not-a-phase", False, None, None)
        tool.load.assert_not_called()
        tool.private_write.assert_not_called()

    def test_every_later_check_phase_preserves_files_and_cannot_mutate_services(self):
        for command in ("promote", "retire", "rollback", "cleanup"):
            if command not in phase.ACKS:
                continue
            with self.subTest(command=command), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                root = Path(temp)
                tool, _vhost = self.staged_fixture(stack, root, command)
                compose = stack.enter_context(patch.object(phase, "compose"))
                replace = stack.enter_context(patch.object(phase, "replace_nginx"))
                stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
                before = {p.name: p.read_bytes() for p in root.iterdir()}
                phase.execute(tool, private, command, False, None, None)
                self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, before)
                tool.private_write.assert_not_called()
                tool.docker.assert_not_called()
                compose.assert_not_called()
                replace.assert_not_called()

    def test_promote_retire_cleanup_require_actual_acceptance_before_first_write(self):
        for command in ("promote", "retire", "cleanup"):
            if command not in phase.ACKS:
                continue
            with self.subTest(command=command), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                tool, _vhost = self.staged_fixture(stack, Path(temp), command)
                compose = stack.enter_context(patch.object(phase, "compose"))
                replace = stack.enter_context(patch.object(phase, "replace_nginx"))
                with self.assertRaises(installer.Refused):
                    phase.execute(tool, private, command, True, phase.ACKS[command], None)
                tool.private_write.assert_not_called()
                tool.docker.assert_not_called()
                compose.assert_not_called()
                compose.assert_not_called()
                replace.assert_not_called()

    def test_promote_requires_pinned_client_identity_source_and_build_kind(self):
        for field, bad in (("Id", "sha256:" + "f" * 64),
                           ("org.opencontainers.image.revision", "old-source"),
                           ("wotcv.fresh.kind", "client-private-closed")):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                tool, _vhost = self.staged_fixture(stack, Path(temp), "promote")
                image = tool.json_docker.return_value[0]
                if field == "Id":
                    image[field] = bad
                else:
                    image["Config"]["Labels"][field] = bad
                compose = stack.enter_context(patch.object(phase, "compose"))
                with self.assertRaisesRegex(installer.Refused, "Wrong public client"):
                    phase.execute(tool, private, "promote", True, phase.ACKS["promote"], None)
                tool.private_write.assert_not_called()
                tool.docker.assert_not_called()
                compose.assert_not_called()

    def test_phase_retries_and_unresolved_rollback_refuse_without_any_mutation(self):
        cases = (("promote", "cutover-promote-attempt.json"),
                 ("promote", "cutover-rollback-attempt.json"),
                 ("retire", "cutover-retire-attempt.json"),
                 ("rollback", "cutover-rollback-attempt.json"),
                 ("rollback", "cutover-cleanup-attempt.json"),
                 ("cleanup", "cutover-cleanup-attempt.json"),
                 ("cleanup", "cutover-rollback-attempt.json"),
                 ("cleanup", "cutover-rolled-back.json"))
        for command, marker in cases:
            if command not in phase.ACKS:
                continue
            with self.subTest(command=command, marker=marker), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                root = Path(temp)
                tool, _vhost = self.staged_fixture(stack, root, command)
                (root / marker).write_text("{}")
                compose = stack.enter_context(patch.object(phase, "compose"))
                accepted = {"promote": "private-login-verified-frontend-ready",
                            "retire": "public-login-replay-grafana-verified",
                            "cleanup": "new-production-accepted-old-test-data-discarded"}.get(command)
                with self.assertRaises(installer.Refused):
                    phase.execute(tool, private, command, True, phase.ACKS[command], accepted)
                tool.private_write.assert_not_called()
                tool.docker.assert_not_called()

    def test_mocked_promotion_orders_config_validation_startup_and_public_receipt_without_cleanup(self):
        for probe_succeeds in (False, True):
            with self.subTest(probe_succeeds=probe_succeeds), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                root = Path(temp)
                tool, _vhost = self.staged_fixture(stack, root, "promote")
                (root / "cutover-public-ready.json").unlink()
                (root / "secrets.json").write_text("{}")
                events = []
                images = {name: "sha256:" + "a" * 64 for name in installer.SERVICES}
                before = {name: {"Id": "native-" + name} for name in installer.VOLUMES}
                stack.enter_context(patch.object(phase, "private_guard", return_value=(before, images)))
                tool.env_text = Mock(return_value="OFFLINE_FIXTURE=value\n")
                def write(path, content):
                    events.append(("write", path.name))
                    if isinstance(content, bytes):
                        path.write_bytes(content)
                    else:
                        path.write_text(content)
                tool.private_write.side_effect = write
                def compose(_tool, env, *args):
                    events.append(("compose", args[0]))
                    return "{}"
                stack.enter_context(patch.object(phase, "compose", side_effect=compose))
                stack.enter_context(patch.object(phase, "validate_public", side_effect=lambda *args: events.append(("validate", "config"))))
                stack.enter_context(patch.object(phase, "verify_public_live", side_effect=lambda *args: events.append(("verify", "live"))))
                stack.enter_context(patch.object(phase, "replace_nginx", side_effect=lambda *args: events.append(("nginx", "replace"))))
                def public_probe(_tool):
                    events.append(("probe", "public"))
                    if not probe_succeeds:
                        raise installer.Refused("simulated public failure")
                stack.enter_context(patch.object(phase, "public_probe", side_effect=public_probe))
                stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
                if probe_succeeds:
                    phase.execute(tool, private, "promote", True, phase.ACKS["promote"], "private-login-verified-frontend-ready")
                else:
                    with self.assertRaisesRegex(installer.Refused, "simulated public failure"):
                        phase.execute(tool, private, "promote", True, phase.ACKS["promote"], "private-login-verified-frontend-ready")
                expected = [("write", "nginx-original.conf"), ("write", "production.env"), ("compose", "config"), ("validate", "config"),
                            ("write", "cutover-promote-attempt.json"), ("compose", "up"), ("verify", "live"),
                            ("nginx", "replace"), ("probe", "public")]
                if probe_succeeds:
                    expected.append(("write", "cutover-public-ready.json"))
                self.assertEqual(events, expected)
                tool.docker.assert_not_called()  # no retire, rm, volume rm or implicit cleanup
                self.assertEqual((root / "cutover-public-ready.json").exists(), probe_succeeds)
                if probe_succeeds:
                    receipt = json.loads((root / "cutover-public-ready.json").read_text())
                    self.assertIs(receipt["producerVerified"], False)
                if not probe_succeeds:
                    events.clear()
                    with self.assertRaises(FileNotFoundError):
                        phase.execute(tool, private, "retire", True, phase.ACKS["retire"], "public-login-replay-grafana-verified")
                    self.assertEqual(events, [])
                    tool.docker.assert_not_called()

    def test_mocked_retirement_stops_exact_legacy_ids_in_dependency_order_never_removes_data(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            tool, _vhost = self.staged_fixture(stack, Path(temp), "retire")
            legacy = [{"name": name, "id": "legacy-" + name} for name in installer.SERVICES]
            tool.load.return_value["legacy"] = legacy
            tool.legacy_snapshot.return_value = deepcopy(legacy)
            events = []
            tool.private_write.side_effect = lambda path, content: events.append(("journal", path.name))
            tool.docker.side_effect = lambda *args, **kwargs: events.append(args)
            def inspect(*args):
                self.assertEqual(args[0], "inspect")
                events.append(("inspect", args[1]))
                return [{"Id": args[1], "State": {"Status": "exited", "ExitCode": 0},
                         "HostConfig": {"RestartPolicy": {"Name": "no"}}}]
            tool.json_docker.side_effect = inspect
            stack.enter_context(patch.object(phase, "public_probe", side_effect=lambda *args: events.append(("probe", "public"))))
            stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
            phase.execute(tool, private, "retire", True, phase.ACKS["retire"], "public-login-replay-grafana-verified")
            expected = [("probe", "public"), ("journal", "cutover-retire-attempt.json")]
            for name in ("backend", "client", "redis", "clickhouse", "postgres"):
                expected.extend([("update", "--restart=no", "legacy-" + name),
                                 ("stop", "--time", "60", "legacy-" + name), ("inspect", "legacy-" + name)])
            expected.extend([("probe", "public"), ("journal", "cutover-legacy-retired.json")])
            self.assertEqual(events, expected)

    def test_mocked_rollback_restores_original_routing_and_exact_policies_but_not_native_producer(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            tool, _vhost = self.staged_fixture(stack, root, "rollback")
            legacy = [{"name": name, "id": "legacy-" + name} for name in installer.SERVICES]
            tool.load.return_value["legacy"] = legacy
            tool.legacy_snapshot.return_value = deepcopy(legacy)
            policies = {name: {"Name": "unless-stopped", "MaximumRetryCount": 0} for name in installer.SERVICES}
            policies["backend"] = {"Name": "on-failure", "MaximumRetryCount": 4}
            (root / "cutover-promote-attempt.json").write_text(json.dumps({"oldRestart": policies}))
            events = []
            receipts = {}
            def write(path, content):
                events.append(("journal", path.name))
                receipts[path.name] = json.loads(content)
            tool.private_write.side_effect = write
            tool.docker.side_effect = lambda *args, **kwargs: events.append(args)
            def inspect(*args):
                self.assertEqual(args[0], "inspect")
                name = args[1].removeprefix("legacy-")
                return [{"Id": args[1], "Name": "/" + name,
                         "State": {"Status": "running", "Health": {"Status": "healthy"}},
                         "HostConfig": {"RestartPolicy": policies[name]}}]
            tool.json_docker.side_effect = inspect
            replace = stack.enter_context(patch.object(phase, "replace_nginx", side_effect=lambda _tool, content: events.append(("nginx", content))))
            stack.enter_context(patch.object(phase, "http", return_value=(200, json.dumps({"gitSha": installer.LEGACY}).encode(), {})))
            stdout = stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
            phase.execute(tool, private, "rollback", True, phase.ACKS["rollback"], None)
            expected = [("journal", "cutover-rollback-attempt.json")]
            for old in legacy:
                name = "on-failure:4" if old["name"] == "backend" else "unless-stopped"
                expected.extend([("update", "--restart=" + name, old["id"]), ("start", old["id"])])
            expected.extend([("nginx", ORIGINAL), ("journal", "cutover-rolled-back.json")])
            self.assertEqual(events, expected)
            replace.assert_called_once_with(tool, ORIGINAL)
            self.assertIs(receipts["cutover-rolled-back.json"]["nativeProducerKept"], False)
            self.assertIs(receipts["cutover-rolled-back.json"]["frontendRollbackRequired"], True)
            self.assertIs(receipts["cutover-rolled-back.json"]["databasesDeleted"], False)
            self.assertIn("new producer does not collect", stdout.getvalue())

    def test_cleanup_refuses_changed_physical_volume_identity_before_any_deletion(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            tool, _vhost = self.staged_fixture(stack, Path(temp), "cleanup")
            stack.enter_context(patch.object(phase, "legacy_volumes", return_value={"postgres-data": {"CreatedAt": "changed"}}))
            with self.assertRaisesRegex(installer.Refused, "physical volume metadata changed"):
                phase.execute(tool, private, "cleanup", True, phase.ACKS["cleanup"], "new-production-accepted-old-test-data-discarded")
            tool.private_write.assert_not_called()
            tool.docker.assert_not_called()

    def test_modified_vhost_refuses_every_later_phase_without_mutation(self):
        for command in ("promote", "retire", "rollback", "cleanup"):
            if command not in phase.ACKS:
                continue
            with self.subTest(command=command, marker="modified vhost"), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                tool, vhost = self.staged_fixture(stack, Path(temp), command)
                vhost.write_text(vhost.read_text() + "# external modification")
                with self.assertRaises(installer.Refused):
                    phase.execute(tool, private, command, True, phase.ACKS[command], None)
                tool.private_write.assert_not_called()
                tool.docker.assert_not_called()

    def test_missing_or_wrong_ack_refuses_every_apply_before_preflight_or_writes(self):
        for command in phase.ACKS:
            for ack in (None, "wrong", phase.ACKS["rollback"] if command != "rollback" else phase.ACKS["promote"]):
                with self.subTest(command=command, ack=ack):
                    tool = self.tool_fixture()
                    with patch.object(phase, "paths_guard"), patch.object(phase, "private_guard") as private_guard, \
                            patch.object(phase, "original_config") as original, patch.object(phase, "replace_nginx") as replace:
                        with self.assertRaises(installer.Refused):
                            phase.execute(tool, private, command, True, ack, None)
                    private_guard.assert_not_called()
                    original.assert_not_called()
                    replace.assert_not_called()
                    tool.private_write.assert_not_called()
                    tool.docker.assert_not_called()
                    tool.json_docker.assert_not_called()

    def test_private_guard_failure_cannot_write_receipts_or_touch_nginx(self):
        tool = self.tool_fixture()
        with patch.object(phase, "paths_guard"), \
                patch.object(phase, "private_guard", side_effect=installer.Refused("private incomplete")), \
                patch.object(phase, "replace_nginx") as replace:
            with self.assertRaisesRegex(installer.Refused, "private incomplete"):
                phase.execute(tool, private, "promote", True, phase.ACKS["promote"], None)
        tool.private_write.assert_not_called()
        tool.docker.assert_not_called()
        replace.assert_not_called()

    def test_promote_preflight_does_not_require_impossible_public_html_or_native_data(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp)
            tool, _vhost = self.staged_fixture(stack, root, "promote")
            for marker in ("cutover-public-ready.json", "cutover-legacy-retired.json"):
                (root / marker).unlink()
            guards = {name: stack.enter_context(patch.object(phase, name, side_effect=AssertionError("Public producer cannot be required before canonical cutover")))
                      for name in ("producer_probe", "producer_html_guard", "native_data_guard", "public_probe")}
            stack.enter_context(patch("sys.stdout", new_callable=io.StringIO))
            phase.execute(tool, private, "promote", False, None, None)
            for guard in guards.values():
                guard.assert_not_called()
            tool.private_write.assert_not_called()
            tool.docker.assert_not_called()

    def test_retirement_refuses_without_actual_new_frontend_and_replay_data(self):
        for name in ("producer_html_guard", "native_data_guard"):
            with self.subTest(guard=name), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                tool, _vhost = self.staged_fixture(stack, Path(temp), "retire")
                guard = stack.enter_context(patch.object(phase, name, side_effect=installer.Refused("producer not verified")))
                with self.assertRaisesRegex(installer.Refused, "producer not verified"):
                    phase.execute(tool, private, "retire", True, phase.ACKS["retire"], "public-login-replay-grafana-verified")
                guard.assert_called_once_with(tool)
                tool.private_write.assert_not_called()
                tool.docker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
