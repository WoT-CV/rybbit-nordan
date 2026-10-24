import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  auditReplayRuntime,
  boundedText,
  classifyReplayRuntime,
  hasMetadataTrackerTag,
  inspectBeArtifact,
} from "../audit-replay-runtime.mjs";

const sha = "a".repeat(40),
  digest = `sha256:${"b".repeat(64)}`;
const observation = (gzip = true) => {
  const config = {
    sessionReplay: true,
    replayTransport: { version: 1, gzip },
    networkReplay: {
      maxBodySizeBytes: 1000000,
      bodyReadTimeoutMs: 1000,
      maxNetworkEventSizeBytes: 2500000,
      maxReplayBatchSizeBytes: 7000000,
    },
  };
  return {
    localHealth: { status: "ok", gitSha: sha, imageDigest: digest },
    publicHealth: { status: "ok", gitSha: sha, imageDigest: digest },
    version: "2.9.1",
    localConfig: structuredClone(config),
    publicConfig: structuredClone(config),
    frontendMetadataTag: true,
    cors: {
      status: 204,
      origin: "https://wot-cv.com",
      credentials: null,
      headers: "Content-Type, Content-Encoding",
      methods: "GET, POST, OPTIONS",
    },
    beArtifact: {
      runtimeSha: "c".repeat(7),
      checkoutSha: "c".repeat(40),
      runtimeSourceSha: "c".repeat(40),
      runtimeSourceClean: true,
    },
    containers: ["backend", "client", "clickhouse", "postgres", "redis"].map(name => ({
      name,
      status: "running",
      health: name === "client" ? undefined : "healthy",
      restarts: 0,
      oomKilled: false,
      imageId: digest,
      gitSha: sha,
      imageTag: `ghcr.io/wot-cv/rybbit-wotcv-${name}:sha-${sha}`,
      gzip: String(gzip),
    })),
  };
};

test("enabled capability is separate from traffic and body coverage proof", () => {
  const report = classifyReplayRuntime(observation());
  assert.equal(report.ok, true);
  assert.equal(report.gzip, "enabled");
  assert.equal(report.actualCompressedTrafficMeasured, false);
  assert.equal(report.durableHttpBodyCoverageConfirmed, false);
  assert.deepEqual(report.warnings, []);
});

test("disabled, missing and mismatched capabilities are not conflated", () => {
  const disabled = classifyReplayRuntime(observation(false));
  assert.equal(disabled.gzip, "disabled");
  assert.ok(disabled.warnings.includes("gzip_disabled"));
  const missing = observation();
  delete missing.publicConfig.replayTransport;
  assert.equal(classifyReplayRuntime(missing).gzip, "unknown");
  assert.equal(classifyReplayRuntime(missing).ok, false);
  const mismatched = observation();
  mismatched.publicConfig.replayTransport.gzip = false;
  assert.equal(classifyReplayRuntime(mismatched).gzip, "mismatch");
  const unknown = observation();
  delete unknown.containers[0].gzip;
  assert.equal(classifyReplayRuntime(unknown).gzip, "unknown");
});

test("unavailable health, increased limits, wrong image and CORS fail closed", () => {
  for (const mutate of [
    o => (o.localHealth = null),
    o => o.localConfig.networkReplay.maxBodySizeBytes++,
    o => (o.containers[0].imageId = "private-image"),
    o => (o.cors.origin = "*"),
    o => (o.cors.headers = "X-Content-Encoding"),
    o => (o.containers[0].oomKilled = true),
    o => (o.publicConfig.sessionReplay = false),
    o => (o.version = null),
    o => o.publicConfig.networkReplay.maxBodySizeBytes--,
  ]) {
    const o = observation();
    mutate(o);
    assert.equal(classifyReplayRuntime(o).ok, false);
  }
});

test("runtime JAR is not silently substituted by server checkout and output is allowlisted", () => {
  const o = observation();
  o.beArtifact.checkoutSha = "d".repeat(40);
  assert.equal(classifyReplayRuntime(o).beArtifact.provenance, "mismatch");
  o.beArtifact.runtimeSha = "private-value";
  o.version = "private-version";
  o.containers[0].status = "private-state";
  const report = classifyReplayRuntime(o);
  assert.equal(report.beArtifact.provenance, "unknown");
  assert.equal(report.applicationVersion, null);
  assert.ok(!JSON.stringify(report).includes("private"));
  assert.equal(classifyReplayRuntime({}).ok, false);
});

test("verified runtime worktree does not disguise an older canonical checkout", () => {
  const o = observation();
  o.beArtifact.checkoutSha = "d".repeat(40);
  const report = classifyReplayRuntime(o);
  assert.equal(report.beArtifact.provenance, "mismatch");
  assert.equal(report.beArtifact.runtimeSourceSha, "c".repeat(40));
  assert.equal(report.beArtifact.runtimeSourceClean, true);
  assert.equal(report.beArtifact.runtimeSourceVerified, true);
  assert.ok(report.warnings.includes("be_checkout_differs_runtime_source_verified"));
  assert.ok(!report.warnings.includes("be_checkout_runtime_mismatch"));
});

test("runtime source verification requires a full matching SHA and a strict clean boolean", () => {
  for (const changes of [
    { runtimeSourceClean: false },
    { runtimeSourceClean: null },
    { runtimeSourceClean: "true" },
    { runtimeSourceClean: 1 },
    { runtimeSourceSha: "c".repeat(7) },
    { runtimeSourceSha: "d".repeat(40) },
    { runtimeSourceSha: "C".repeat(40) },
    { runtimeSha: "c".repeat(6) },
    { runtimeSha: "d".repeat(40) },
    { runtimeSourceSha: null },
  ]) {
    const o = observation();
    Object.assign(o.beArtifact, changes, { checkoutSha: "e".repeat(40) });
    const report = classifyReplayRuntime(o);
    assert.equal(report.beArtifact.runtimeSourceVerified, false, JSON.stringify(changes));
    assert.notEqual(report.beArtifact.provenance, "matches");
    assert.ok(!report.warnings.includes("be_checkout_differs_runtime_source_verified"));
    assert.ok(report.warnings.some(w => ["be_runtime_source_unavailable", "be_runtime_source_unverified"].includes(w)));
  }
});

test("matching full runtime SHA is verified without changing canonical provenance semantics", () => {
  const o = observation();
  o.beArtifact.runtimeSha = "c".repeat(40);
  const report = classifyReplayRuntime(o);
  assert.equal(report.beArtifact.provenance, "matches");
  assert.equal(report.beArtifact.runtimeSourceVerified, true);
  assert.deepEqual(report.warnings, []);
});

test("malicious artifact/source fields are dropped from inspector and classifier output", () => {
  const artifact = inspectBeArtifact(() =>
    JSON.stringify({
      runtimeSha: "private-runtime",
      checkoutSha: "private-checkout",
      runtimeSourceSha: "/private/source/path",
      runtimeSourceClean: "private-state",
      runtimeSourcePath: "/private/credentials",
      applicationYaml: "private-token",
    })
  );
  assert.deepEqual(artifact, {
    runtimeSha: null,
    checkoutSha: null,
    runtimeSourceSha: null,
    runtimeSourceClean: null,
  });
  const o = observation();
  o.beArtifact = { ...artifact, privateEnvironment: "private-value", runtimeSourceVerified: true };
  const report = classifyReplayRuntime(o);
  assert.equal(report.beArtifact.runtimeSourceVerified, false);
  assert.ok(!JSON.stringify(report).includes("private"));
});

function inspectArtifactFixture(changes = {}) {
  let script;
  inspectBeArtifact((command, args) => {
    assert.equal(command, "python3");
    assert.equal(args[0], "-c");
    script = args[1];
    return "{}";
  });
  const fixture = {
    runtime: "c".repeat(7),
    checkout: "d".repeat(40),
    source: "c".repeat(40),
    exists: true,
    ...changes,
  };
  // Execute the real embedded inspector against fake Python filesystem/process
  // APIs. No fixture git index, real JAR, command, repository or file is touched.
  const harness = `
import json,os,pathlib,subprocess,zipfile
from unittest.mock import patch
from types import SimpleNamespace
case=json.loads(${JSON.stringify(JSON.stringify(fixture))})
repo='/home/wotcv/prod/wot-cv-be'
root='/home/wotcv/runtime-sources/wot-cv-be'
worktree=root+'/'+case['source']
calls=[]
class FakePath:
 def __init__(self,value): self.value=str(value)
 def __str__(self): return self.value
 def __fspath__(self): return self.value
 def __truediv__(self,value): return FakePath(self.value+'/'+str(value))
 def __eq__(self,other): return self.value==str(other)
 def resolve(self,strict=False):
  if self.value==worktree and case.get('symlink'): return FakePath('/private/forbidden')
  return self
 def is_relative_to(self,parent): return self.value.startswith(str(parent)+'/')
 def read_bytes(self):
  assert self.value=='/proc/4242/cmdline'
  return b'java\\0-jar\\0/home/wotcv/prod/wot-cv-be/application/target/application.jar\\0'
 def iterdir(self):
  assert self.value=='/proc/4242/fd'
  return iter([FakePath('/proc/4242/fd/3')])
 def exists(self):
  assert self.value==worktree
  return case['exists']
 def is_symlink(self): return bool(case.get('symlink'))
 def is_dir(self): return not case.get('not_directory',False)
class FakeZip:
 def __init__(self,path): assert str(path)=='/proc/4242/fd/3'
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def getinfo(self,name):
  assert name=='BOOT-INF/classes/git.properties'
  return SimpleNamespace(file_size=100)
 def read(self,info): return ('git.commit.id='+case['runtime']+'\\n').encode()
def command(args,**options):
 calls.append(args)
 if args[0]=='systemctl': return '4242\\n'
 assert args[:8]==['git','--no-optional-locks','--no-replace-objects','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C']
 assert options['env']['GIT_OPTIONAL_LOCKS']=='0'
 assert options['env']['GIT_NO_LAZY_FETCH']=='1'
 assert options['env']['GIT_TERMINAL_PROMPT']=='0'
 directory=args[8]
 operation=args[9:]
 assert directory in (repo,worktree), 'forbidden path'
 if operation==['rev-parse','--verify',case['runtime']+'^{commit}']:
  if case.get('missing_object'): raise subprocess.CalledProcessError(1,args)
  return case['source']+'\\n'
 if operation==['rev-parse','HEAD']:
  return (case['checkout'] if directory==repo else case.get('head',case['source']))+'\\n'
 if operation==['rev-parse','--show-toplevel']: return case.get('top',worktree)+'\\n'
 if operation==['rev-parse','--path-format=absolute','--git-common-dir']:
  return (case.get('common',repo+'/.git') if directory==worktree else repo+'/.git')+'\\n'
 if operation==['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none']:
  if case.get('status_error'): raise subprocess.CalledProcessError(1,args)
  return case.get('status','')
 raise AssertionError('Unexpected command')
with patch.object(pathlib,'Path',FakePath),patch.object(subprocess,'check_output',command),patch.object(zipfile,'ZipFile',FakeZip),patch.object(os,'readlink',return_value='/home/wotcv/prod/wot-cv-be/application/target/application.jar'):
 exec(${JSON.stringify(script)},{})
assert all(args[0] in ('git','systemctl') for args in calls)
`;
  const output = execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", harness], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

test("real artifact inspector resolves existing runtime object and verifies only its exact clean worktree", () => {
  const artifact = inspectArtifactFixture();
  assert.deepEqual(artifact, {
    runtimeSha: "c".repeat(7),
    checkoutSha: "d".repeat(40),
    runtimeSourceSha: "c".repeat(40),
    runtimeSourceClean: true,
  });
  const o = observation();
  o.beArtifact = artifact;
  const report = classifyReplayRuntime(o);
  assert.equal(report.beArtifact.provenance, "mismatch");
  assert.equal(report.beArtifact.runtimeSourceVerified, true);
});

test("real artifact inspector rejects dirty, wrong and aliased runtime source without leaking paths", () => {
  for (const changes of [
    { status: " M application/unsafe.java\n" },
    { status: "?? private-credentials\n" },
    { head: "e".repeat(40) },
    { common: "/private/unrelated/.git" },
    { top: "/private/unrelated" },
    { symlink: true },
    { not_directory: true },
  ]) {
    const artifact = inspectArtifactFixture(changes);
    assert.equal(artifact.runtimeSourceClean, false, JSON.stringify(changes));
    assert.equal(artifact.runtimeSourceSha, "c".repeat(40));
    assert.ok(!JSON.stringify(artifact).includes("private"));
  }
});

test("real artifact inspector distinguishes missing source/worktree and failed inspection", () => {
  for (const changes of [{ missing_object: true }, { exists: false }, { status_error: true }]) {
    const artifact = inspectArtifactFixture(changes);
    assert.equal(artifact.runtimeSourceClean, null);
    assert.equal(artifact.runtimeSourceSha, changes.missing_object ? null : "c".repeat(40));
    assert.equal(artifact.runtimeSha, "c".repeat(7));
    assert.equal(artifact.checkoutSha, "d".repeat(40));
  }
  const wrongObject = inspectArtifactFixture({ source: "e".repeat(40) });
  assert.equal(wrongObject.runtimeSourceSha, null);
  assert.equal(wrongObject.runtimeSourceClean, null);
});

test("metadata tag must be on the actual published tracker, not a comment or other script", () => {
  const tag = '<script src="https://tracking.wot-cv.com/api/script.js" data-replay-network-mode="metadata">';
  assert.equal(hasMetadataTrackerTag(tag), true);
  assert.equal(hasMetadataTrackerTag(`<!-- ${tag} -->`), false);
  assert.equal(hasMetadataTrackerTag(tag.replace("tracking.wot-cv.com", "evil.example")), false);
  assert.equal(hasMetadataTrackerTag(tag.replace("metadata", "full")), false);
});

test("HTTP body collection is bounded and cancels the stream", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  await assert.rejects(boundedText(response, 32), /exceeds bound/);
  assert.equal(cancelled, true);
});

test("transport failures remain unknown and do not print exception data", async () => {
  const report = await auditReplayRuntime(
    async () => {
      throw new Error("private-response");
    },
    {
      containers: () => {
        throw new Error("private-env");
      },
      beArtifact: () => null,
    }
  );
  assert.equal(report.ok, false);
  assert.equal(report.gzip, "unknown");
  assert.ok(!JSON.stringify(report).includes("private"));
});

test("live adapter performs only bounded GET and OPTIONS and drops extra server fields", async () => {
  const o = observation(),
    methods = [];
  const fetcher = async (url, options) => {
    methods.push(options.method ?? "GET");
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": o.cors.origin,
          "access-control-allow-headers": o.cors.headers,
          "access-control-allow-methods": o.cors.methods,
        },
      });
    if (url.endsWith("/api/health")) return Response.json({ ...o.localHealth, privateToken: "private-value" });
    if (url.includes("/tracking-config/")) return Response.json(o.localConfig);
    if (url.endsWith("/api/version")) return Response.json({ version: o.version });
    if (url === "https://wot-cv.com")
      return new Response(
        '<script src="https://tracking.wot-cv.com/api/script.js" data-replay-network-mode="metadata">'
      );
    throw new Error("Unexpected URL");
  };
  const report = await auditReplayRuntime(fetcher, { containers: () => o.containers, beArtifact: () => o.beArtifact });
  assert.equal(report.ok, true);
  assert.equal(report.gzip, "enabled");
  assert.deepEqual(methods.sort(), ["GET", "GET", "GET", "GET", "GET", "GET", "OPTIONS"]);
  assert.ok(!JSON.stringify(report).includes("private"));
});
