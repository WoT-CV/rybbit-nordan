#!/usr/bin/env python3
"""Prepare/build a separate native Rybbit; only an operator may initialize it.

No old-container stop, data deletion, nginx changes, SQL writes or cutover are
implemented here. start-bootstrap invokes native initialization on NEW storage.
Do not invoke that command as an agent: repository policy reserves it for the operator.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import socket
import subprocess
import sys
import tarfile
import time

SOURCE = "58220f65648d91bbb56699233e8e90db82ced302"
LEGACY = "dade9a932e0c5854d2f9bcf5c11d91efece5036f"
PROJECT = "rybbit-wotcv-native"
SERVICES = ("postgres", "clickhouse", "redis", "backend", "client")
VOLUMES = {"postgres": ("postgres-data", "/var/lib/postgresql/data"),
           "clickhouse": ("clickhouse-data", "/var/lib/clickhouse"),
           "redis": ("redis-data", "/data")}
TAGS = {"postgres": "postgres:17.4", "clickhouse": "clickhouse/clickhouse-server:26.3.62.3",
        "redis": "redis:8.6.4-alpine"}
PUBLIC = "https://tracking.wot-cv.com"
ACK = "initialize-empty-rybbit-only"
IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def environment():
    # Shell variables override Compose --env-file. Do not inherit any settings
    # capable of silently substituting old credentials, origins or image tags.
    return {k: v for k, v in os.environ.items() if k in (
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR")}


def run(args, *, cwd=None, data=None, timeout=45, log=None):
    try:
        result = subprocess.run(args, cwd=cwd, input=data, stdout=log or subprocess.PIPE,
                                stderr=log or subprocess.PIPE, timeout=timeout,
                                check=False, env=environment())
    except (OSError, subprocess.TimeoutExpired):
        raise Refused("Command unavailable or timed out; private details withheld") from None
    require(result.returncode == 0, "Command failed; details withheld (see private build log, if present)")
    return result.stdout or b""


def docker(*args, **kwargs):
    return run([*DOCKER, *args], **kwargs)


def json_docker(*args):
    return json.loads(docker(*args))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_write(path, value):
    data = value.encode() if isinstance(value, str) else value
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def write_state(root, state):
    target = root / "state.json"
    temp = root / (".state-" + secrets.token_hex(8))
    private_write(temp, json.dumps(state, indent=2) + "\n")
    os.replace(temp, target)


def state_root(raw):
    path = Path(raw).absolute()
    require(not path.is_symlink() and path.resolve() == path,
            "Release path must be absolute, canonical, and not a symlink")
    require(path.parent == Path("/home/wotcv") and
            re.fullmatch(r"rybbit-fresh-20261102\.[A-Za-z0-9_-]{6,32}", path.name),
            "Release must be a dedicated /home/wotcv/rybbit-fresh-20261102.<random> directory")
    require(path.is_dir() and path.stat().st_mode & 0o077 == 0,
            "Release must exist with private directory permissions")
    return path


def containers():
    ids = docker("ps", "-aq").decode().split()
    return json_docker("inspect", *ids) if ids else []


def legacy_snapshot():
    all_containers = containers()
    selected = []
    for name in SERVICES:
        matches = [c for c in all_containers if c["Name"] == "/" + name]
        require(len(matches) == 1, "Expected exactly five known old Rybbit containers")
        c = matches[0]
        labels = c["Config"].get("Labels") or {}
        require(labels.get("com.docker.compose.project") == "rybbit" and
                labels.get("com.docker.compose.service") == name,
                "Legacy project/service ownership mismatch")
        mounts = []
        if name in VOLUMES:
            key, destination = VOLUMES[name]
            expected = "rybbit_" + key
            actual = c.get("Mounts", [])
            require(len(actual) == 1 and actual[0].get("Name") == expected and
                    actual[0]["Type"] == "volume" and actual[0]["Destination"] == destination,
                    "Legacy storage does not match the approved reset scope")
            v = json_docker("volume", "inspect", expected)[0]
            vl = v.get("Labels") or {}
            require(v["Driver"] == "local" and not v.get("Options") and
                    vl.get("com.docker.compose.project") == "rybbit" and
                    vl.get("com.docker.compose.volume") == key,
                    "Legacy volume ownership/driver/options mismatch")
            users = [x["Id"] for x in all_containers if any(
                m.get("Type") == "volume" and m.get("Name") == expected for m in x.get("Mounts", []))]
            require(users == [c["Id"]], "A legacy volume is shared with another container")
            mounts = [expected]
        else:
            require(not c.get("Mounts"), "Unexpected legacy application mounts")
            require(c["Config"]["Image"].endswith(":sha-" + LEGACY), "Unexpected old source revision")
        selected.append({"name": name, "id": c["Id"], "image": c["Image"], "volumes": mounts})
    return selected


def empty_target():
    require(not docker("ps", "-aq", "--filter", "label=com.docker.compose.project=" + PROJECT).strip(),
            "Fresh project already has containers; inspect state, do not blindly retry initialization")
    require(not docker("volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + PROJECT).strip(),
            "Fresh project already has volumes")
    for key, _ in VOLUMES.values():
        name = PROJECT + "_" + key
        require(not docker("volume", "ls", "-q", "--filter", "name=^" + re.escape(name) + "$").strip(),
                "Fresh physical volume name already exists")
    require(not docker("network", "ls", "-q", "--filter", "name=^" + PROJECT + "_default$").strip(),
            "Fresh network already exists")
    for port in (13001, 13002):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                raise Refused("Fresh application port is in use") from None


def safe_archive(data, destination):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in member.name and
                    (member.isfile() or member.isdir()), "Archive has unsupported paths or links")
        archive.extractall(destination, filter="data")


def prepare(root, repo, overlay):
    require(not (root / "state.json").exists() and not (root / "source").exists(),
            "Release is already prepared; do not overwrite")
    actual = run(["/usr/bin/git", "-C", str(repo), "rev-parse", SOURCE + "^{commit}"]).decode().strip()
    require(actual == SOURCE, "Source commit unavailable")
    require(run(["/usr/bin/git", "-C", str(repo), "ls-remote", "origin", "refs/heads/feat/wotcv"])
            .decode().split()[0] == SOURCE, "Published source moved; review and pin a new release explicitly")
    old = legacy_snapshot()
    empty_target()
    data = run(["/usr/bin/git", "-C", str(repo), "archive", "--format=tar", SOURCE], timeout=120)
    source = root / "source"
    source.mkdir(mode=0o700)
    safe_archive(data, source)
    private_write(source / "ops/minimal/compose.fresh.yml", overlay.read_bytes())
    fresh = {key: secrets.token_hex(32) for key in (
        "BETTER_AUTH_SECRET", "POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "CLICKHOUSE_QUERY_PASSWORD", "REDIS_PASSWORD")}
    private_write(root / "secrets.json", json.dumps(fresh))
    hashes = {str(p.relative_to(source)): digest(p) for p in source.rglob("*") if p.is_file()}
    state = {"version": 1, "source": SOURCE, "project": PROJECT, "phase": "prepared",
             "legacy": old, "sourceFiles": hashes,
             "installerHash": digest(Path(__file__).resolve())}
    write_state(root, state)
    return state


def load(root):
    require(all(not p.is_symlink() for p in root.rglob("*")), "Release symlinks are forbidden")
    for name in ("state.json", "secrets.json"):
        require((root / name).stat().st_mode & 0o077 == 0, "Release state must remain private")
    state = json.loads((root / "state.json").read_text())
    require(state.get("version") == 1 and state.get("source") == SOURCE and
            state.get("project") == PROJECT, "Release state identity mismatch")
    require(state.get("installerHash") == digest(Path(__file__).resolve()), "Installer changed since prepare")
    source = root / "source"
    actual = {str(p.relative_to(source)): digest(p) for p in source.rglob("*") if p.is_file()}
    require(actual == state.get("sourceFiles"), "Release source changed after preparation")
    return state


def env_text(values):
    require(all(re.fullmatch(r"[A-Z_]+", k) for k in values), "Invalid environment key")
    require(all(isinstance(v, str) and not re.search(r"[\r\n\x00'\\$]", v) for v in values.values()),
            "Unsupported environment value")
    return "".join(k + "='" + v + "'\n" for k, v in sorted(values.items()))


def compose(root, *args):
    source = root / "source"
    return docker("compose", "--project-name", PROJECT, "--project-directory", str(source),
                  "--env-file", str(root / "bootstrap.env"), "-f", str(source / "docker-compose.yml"),
                  "-f", str(source / "ops/minimal/compose.fresh.yml"), *args, timeout=180)


def validate_model(config, images):
    require(config.get("name") == PROJECT, "Wrong project")
    require(set(config["services"]) <= {*SERVICES, "caddy"}, "Unexpected profiled service")
    active = {k: v for k, v in config["services"].items() if not v.get("profiles")}
    require(set(active) == set(SERVICES), "Unexpected active services")
    for name, service in active.items():
        require(service.get("image") == images[name] and IMAGE.fullmatch(service["image"]), "Unpinned image")
        require(service.get("pull_policy") == "never", "Unexpected pull policy")
        require(not service.get("container_name") and not service.get("build") and
                not any(service.get(k) for k in ("network_mode", "privileged", "pid", "ipc", "volumes_from",
                    "entrypoint", "cap_add", "devices", "device_cgroup_rules", "secrets", "env_file",
                    "extra_hosts", "security_opt", "userns_mode", "develop", "post_start", "pre_stop")),
                "Shared/privileged runtime or fixed name")
        if name != "redis":
            require(not service.get("command"), "Unexpected command override")
        require(service.get("restart") == ("no" if name == "backend" else "unless-stopped"), "Restart policy")
        require(set(service.get("networks", {})) == {"default"}, "Unexpected networks")
        require(service.get("logging") == {"driver": "json-file", "options": {"max-size": "50m", "max-file": "5"}},
                "Logging rotation mismatch")
        if name in VOLUMES:
            key, target = VOLUMES[name]
            mounts = service.get("volumes", [])
            require(len(mounts) == 1 and mounts[0].get("type") == "volume" and
                    mounts[0].get("source") == key and mounts[0].get("target") == target and
                    not service.get("ports"), "Database storage or exposure mismatch")
            volume = config["volumes"][key]
            require(volume.get("name") == PROJECT + "_" + key and not volume.get("external") and
                    not volume.get("driver_opts") and volume.get("driver", "local") == "local", "Shared volume")
        else:
            require(not service.get("volumes"), "Application mount")
            port = service.get("ports", [])
            expected = (13001, 3001) if name == "backend" else (13002, 3002)
            require(len(port) == 1 and port[0].get("host_ip") == "127.0.0.1" and
                    int(port[0]["published"]) == expected[0] and int(port[0]["target"]) == expected[1] and
                    port[0].get("protocol", "tcp") == "tcp", "Application port mismatch")
    network = config.get("networks", {}).get("default", {})
    require(network.get("name") == PROJECT + "_default" and not network.get("external") and
            not network.get("driver_opts"), "Shared network")
    env = active["backend"]["environment"]
    require(env["BASE_URL"] == "http://127.0.0.1:13002" and env["SERVER_URL"] == "http://127.0.0.1:13001" and
            env["DISABLE_SIGNUP"] == "false" and env["CLOUD"] == "false" and
            env["DISABLE_TELEMETRY"] == "true" and env["CLUSTER_WORKERS"] == "0" and
            active["backend"]["restart"] == "no",
            "Bootstrap configuration mismatch")
    client_env = active["client"]["environment"]
    require(client_env.get("NEXT_PUBLIC_BACKEND_URL") == "http://127.0.0.1:13001" and
            client_env.get("NEXT_PUBLIC_CLOUD") == "false" and
            client_env.get("NEXT_PUBLIC_DISABLE_SIGNUP") == "false", "Client bootstrap configuration")
    require(all(not env.get(k) for k in ("RESEND_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "OPENROUTER_API_KEY")),
            "Unexpected external integration")
    for name in ("postgres", "clickhouse", "redis"):
        require(active["backend"]["depends_on"][name]["condition"] == "service_healthy", "Database readiness")


def image_id(tag):
    result = json_docker("image", "inspect", tag)[0]["Id"]
    require(IMAGE.fullmatch(result), "Invalid local image identity")
    return result


def validate_credentials(config, fresh):
    services = config["services"]
    backend = services["backend"]["environment"]
    for key, value in fresh.items():
        require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) and
                backend.get(key) == value, "Fresh backend credential mismatch")
    for name, key in (("postgres", "POSTGRES_PASSWORD"), ("clickhouse", "CLICKHOUSE_PASSWORD")):
        require(services[name]["environment"].get(key) == fresh[key], "Fresh database credential mismatch")
    command = services["redis"].get("command", [])
    require(command == ["redis-server", "--requirepass", fresh["REDIS_PASSWORD"],
                        "--appendonly", "yes", "--appendfsync", "everysec", "--maxmemory-policy", "noeviction"],
            "Fresh Redis credential or persistence command mismatch")


def build(root, state):
    require(state["phase"] == "prepared", "Build requires prepared phase")
    require(legacy_snapshot() == state["legacy"], "Old Rybbit changed since prepare")
    empty_target()
    state["phase"] = "building"
    write_state(root, state)  # Failed builds require inspection, not a misleading repeat from prepared.
    source = root / "source"
    images = {}
    logpath = root / ("build-" + secrets.token_hex(4) + ".log")
    with os.fdopen(os.open(logpath, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as log:
        for service, tag in TAGS.items():
            docker("pull", tag, timeout=600, log=log)
            images[service] = image_id(tag)
        for kind, dockerfile, origin, signup in (
            ("backend", "server/Dockerfile", None, None),
            ("client-bootstrap", "client/Dockerfile", "http://127.0.0.1:13001", "false"),
            ("client-production", "client/Dockerfile", PUBLIC, "true"),
        ):
            print("Building " + kind + " (private log: " + str(logpath) + ")", flush=True)
            tag = "wotcv-rybbit-fresh:" + SOURCE[:12] + "-" + kind + "-" + root.name.split(".")[-1].lower()
            args = ["build", "--label", "org.opencontainers.image.revision=" + SOURCE,
                    "--label", "wotcv.fresh.kind=" + kind, "-f", dockerfile, "-t", tag]
            if origin:
                for key, value in {"NEXT_PUBLIC_BACKEND_URL": origin, "NEXT_PUBLIC_DISABLE_SIGNUP": signup,
                                   "NEXT_PUBLIC_CLOUD": "false", "NEXT_PUBLIC_DEPLOYMENT": "",
                                   "NEXT_PUBLIC_LITE_DASHBOARD": "false"}.items():
                    args += ["--build-arg", key + "=" + value]
            docker(*args, ".", cwd=source, timeout=1800, log=log)
            images[kind] = image_id(tag)
    images["client"] = images["client-bootstrap"]
    # Explicit entrypoint override: filesystem/dependency checks only, no DB connection/startup.
    js = ("const f=require('fs');for(const p of ['/app/dist/cluster.js','/app/drizzle.config.ts'])f.accessSync(p);"
          "const s=f.readFileSync('/app/docker-entrypoint.sh','utf8');"
          "if(!s.startsWith('#!')||s.includes(String.fromCharCode(13)))process.exit(2);"
          "for(const p of ['pg','drizzle-kit','better-auth'])require.resolve(p)")
    docker("run", "--rm", "--network", "none", "--entrypoint", "node", images["backend"], "-e", js)
    for kind, origin in (("client-bootstrap", "http://127.0.0.1:13001"), ("client-production", PUBLIC)):
        js_client = ("const f=require('fs'),p=require('path');let n=0;"
                     "function scan(d){for(const e of f.readdirSync(d,{withFileTypes:true})){"
                     "const s=p.join(d,e.name);if(e.isDirectory())scan(s);"
                     "else if(e.name.endsWith('.js')&&f.readFileSync(s,'utf8').includes(process.argv[1]))n++}}"
                     "scan('/app/client/.next/static');if(!n)process.exit(3)")
        docker("run", "--rm", "--network", "none", "--entrypoint", "node", images[kind], "-e", js_client, origin)
    values = json.loads((root / "secrets.json").read_text())
    values.update({"WOTCV_" + name.upper().replace("-", "_") + "_IMAGE": images[name] for name in SERVICES})
    values.update({"WOTCV_FRONTEND_URL": "http://127.0.0.1:13002", "WOTCV_API_URL": "http://127.0.0.1:13001",
                   "SOURCE_CODE_URL": "https://github.com/WoT-CV/rybbit-wotcv/tree/" + SOURCE,
                   "DISABLE_SIGNUP": "false", "WOTCV_BACKEND_RESTART": "no",
                   "POSTGRES_DB": "analytics", "POSTGRES_USER": "frog", "CLICKHOUSE_DB": "analytics"})
    private_write(root / "bootstrap.env", env_text(values))
    state.update({"phase": "built", "images": images, "envHash": digest(root / "bootstrap.env")})
    model = json.loads(compose(root, "config", "--format", "json"))
    validate_model(model, images)
    validate_credentials(model, json.loads((root / "secrets.json").read_text()))
    write_state(root, state)
    print("BUILT and configuration verified; NO application or database was started.")
    return state


def check(root, state):
    require(state["phase"] in ("built", "starting", "bootstrap"), "Build must finish first")
    require(digest(root / "bootstrap.env") == state["envHash"], "Bootstrap environment changed")
    require(not (root / "bootstrap.env").stat().st_mode & 0o077, "Bootstrap credentials must remain private")
    for name, identity in state["images"].items():
        require(image_id(identity) == identity, "Missing release image")
    model = json.loads(compose(root, "config", "--format", "json"))
    validate_model(model, state["images"])
    validate_credentials(model, json.loads((root / "secrets.json").read_text()))
    require(legacy_snapshot() == state["legacy"], "Old Rybbit changed; review before continuing")
    print("CHECK PASS: source, images, environment, isolated Compose and legacy identities verified.")


def start(root, state, ack):
    require(hasattr(os, "geteuid") and os.geteuid() == 0,
            "Operator-only initialization requires interactive sudo")
    require(ack == ACK and state["phase"] == "built", "Explicit empty initialization ACK and built phase required")
    check(root, state)
    empty_target()
    state["phase"] = "starting"
    write_state(root, state)  # Failure must not reopen initialization as if it never happened.
    compose(root, "up", "-d", "--no-build", "--pull", "never", *SERVICES)
    # Native entrypoint runs here ONLY on the operator's explicit command.
    for _ in range(90):
        current = containers()
        selected = [c for c in current if (c["Config"].get("Labels") or {}).get("com.docker.compose.project") == PROJECT]
        if len(selected) == 5 and all(c["State"]["Status"] == "running" and
                (c["State"].get("Health", {}).get("Status") == "healthy" or
                 (c["Config"].get("Labels") or {}).get("com.docker.compose.service") == "client") for c in selected):
            state["phase"] = "bootstrap"
            write_state(root, state)
            print("BOOTSTRAP READY on loopback 13001/13002; public old Rybbit unchanged. Create first account via SSH tunnel.")
            return
        time.sleep(2)
    raise Refused("Bootstrap not healthy; state retained as starting. No old services changed; inspect before retry.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "build", "check", "start-bootstrap"))
    parser.add_argument("--release", required=True)
    parser.add_argument("--repo", default="/home/rybbit-wotcv")
    parser.add_argument("--overlay", default=str(Path(__file__).resolve().parent / "compose.fresh.yml"))
    parser.add_argument("--ack")
    parser.add_argument("--expected-state-sha256")
    args = parser.parse_args()
    root = state_root(args.release)
    # Same lock for preparation, image work, checks and operator initialization.
    import fcntl
    lock_path = Path("/home/wotcv/.rybbit-wotcv-native-install.lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("Another fresh-install operation is active") from None
        if args.command == "prepare":
            prepare(root, Path(args.repo).resolve(), Path(args.overlay).resolve())
            print("PREPARED clean pinned source and NEW private secrets; no images built or services started.")
        else:
            if args.command == "start-bootstrap":
                require(re.fullmatch(r"[0-9a-f]{64}", args.expected_state_sha256 or "") and
                        digest(root / "state.json") == args.expected_state_sha256,
                        "Operator must pin the externally reviewed release state SHA256")
            state = load(root)
            if args.command == "build":
                build(root, state)
            elif args.command == "check":
                check(root, state)
            else:
                start(root, state, args.ack)


if __name__ == "__main__":
    try:
        main()
    except Refused as error:
        print("REFUSED: " + str(error) + ". No automatic cleanup or old-data deletion.", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, tarfile.TarError):
        # Errors from subprocess/JSON/paths may contain credentials; never print them.
        print("REFUSED: operation did not complete. Private state/logs retained; no automatic cleanup or old-data deletion.", file=sys.stderr)
        sys.exit(1)
