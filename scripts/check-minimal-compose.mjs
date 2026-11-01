import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const project = "rybbit-minimal-candidate";
const services = ["backend", "client", "postgres", "redis", "clickhouse"];
const ports = {
  backend: [13001, 3001],
  client: [13002, 3002],
  postgres: [15432, 5432],
  redis: [16379, 6379],
  clickhouse: [18123, 8123],
};
const images = {
  postgres: "postgres:17.4",
  redis: "redis:8.6.4-alpine",
  clickhouse: "clickhouse/clickhouse-server:26.3.62.3",
};
const storage = {
  postgres: ["postgres-data", "/var/lib/postgresql/data"],
  redis: ["redis-data", "/data"],
  clickhouse: ["clickhouse-data", "/var/lib/clickhouse"],
};
const digest = /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Checks the effective model, not a handwritten approximation of Compose merge. */
export function validateCandidateCompose(config, repo = root) {
  const errors = [];
  const check = (condition, reason) => {
    if (!condition) errors.push(reason);
  };
  check(config?.name === project, "candidate project name");
  const all = config?.services ?? {};
  check(
    Object.keys(all).every(key => [...services, "caddy"].includes(key)),
    "unexpected service"
  );
  for (const name of services) {
    const service = all[name];
    check(!!service, `${name}: missing service`);
    if (!service) continue;
    check(!service.container_name && !service.profiles?.length, `${name}: fixed container name/profile`);
    check(
      !service.network_mode && !service.privileged && !service.pid && !service.ipc,
      `${name}: shared/privileged runtime`
    );
    check(!service.build, `${name}: build must be separate from candidate startup`);
    check(
      Object.keys(service.networks ?? { default: {} }).length === 1 &&
        "default" in (service.networks ?? { default: {} }),
      `${name}: network isolation`
    );
    check(
      service.ports?.length === 1 &&
        service.ports[0].host_ip === "127.0.0.1" &&
        Number(service.ports[0].published) === ports[name][0] &&
        Number(service.ports[0].target) === ports[name][1] &&
        (service.ports[0].protocol ?? "tcp") === "tcp",
      `${name}: loopback candidate port`
    );
    check(
      service.logging?.driver === "json-file" &&
        service.logging.options?.["max-size"] === "50m" &&
        service.logging.options?.["max-file"] === "5" &&
        Object.keys(service.logging.options).length === 2,
      `${name}: logging rotation`
    );
    check(
      name in images ? service.image === images[name] : digest.test(service.image ?? ""),
      `${name}: immutable/approved image`
    );
    if (name in storage) {
      const [source, target] = storage[name];
      check(
        service.volumes?.length === 1 &&
          service.volumes[0].type === "volume" &&
          service.volumes[0].source === source &&
          service.volumes[0].target === target &&
          !service.volumes[0].read_only,
        `${name}: isolated native data volume`
      );
    }
  }
  for (const [key, volume] of Object.entries(config?.volumes ?? {})) {
    check(
      !volume?.external &&
        !volume?.driver_opts &&
        (!volume?.driver || volume.driver === "local") &&
        volume?.name === `${project}_${key}`,
      "project-scoped volume definitions"
    );
  }
  for (const key of Object.values(storage).map(value => value[0]))
    check(!!config?.volumes?.[key], `missing volume definition: ${key}`);
  const networks = config?.networks ?? {};
  check(
    Object.keys(networks).length === 1 &&
      networks.default?.name === `${project}_default` &&
      !networks.default?.external &&
      !networks.default?.driver_opts,
    "project-scoped default network"
  );
  check(
    Object.values(config?.configs ?? {}).every(
      value => !value.external && !value.file && typeof value.content === "string"
    ),
    "inline native CH configs only"
  );
  const backend = all.backend ?? {},
    client = all.client ?? {};
  check(
    backend.entrypoint?.join(" ") === "/bin/sh /wotcv/candidate-start.sh" &&
      backend.command?.join(" ") === "node dist/cluster.js",
    "candidate startup guard"
  );
  check(backend.restart === "no", "closed startup gate must not restart-loop");
  check(
    backend.volumes?.length === 1 &&
      backend.volumes[0].type === "bind" &&
      backend.volumes[0].read_only === true &&
      backend.volumes[0].target === "/wotcv/candidate-start.sh" &&
      resolve(backend.volumes[0].source) === resolve(repo, "ops/minimal/candidate-start.sh"),
    "only repository candidate guard may be bind-mounted"
  );
  check(!client.volumes?.length, "client must not mount host data");
  const env = backend.environment ?? {};
  check(
    env.CLOUD === "false" && env.DISABLE_TELEMETRY === "true" && client.environment?.NEXT_PUBLIC_CLOUD === "false",
    "self-hosted flags"
  );
  check(!env.WOTCV_CANDIDATE_START_ACK, "preflight requires the startup gate to remain CLOSED");
  check(
    env.POSTGRES_HOST === "postgres" &&
      String(env.POSTGRES_PORT) === "5432" &&
      env.REDIS_HOST === "redis" &&
      String(env.REDIS_PORT) === "6379" &&
      env.CLICKHOUSE_HOST === "http://clickhouse:8123",
    "internal database wiring"
  );
  check(
    env.BASE_URL === "http://127.0.0.1:13002" &&
      env.SERVER_URL === "http://127.0.0.1:13001" &&
      client.environment?.NEXT_PUBLIC_BACKEND_URL === "http://127.0.0.1:13001",
    "loopback-only candidate URLs (compiled client checked separately)"
  );
  for (const [service, key] of [
    ["postgres", "POSTGRES_PASSWORD"],
    ["redis", "REDIS_PASSWORD"],
    ["clickhouse", "CLICKHOUSE_PASSWORD"],
  ]) {
    const value = env[key];
    check(
      typeof value === "string" && value.length >= 16 && !/REPLACE|changeme|^frog$/.test(value),
      `new candidate credential required: ${key}`
    );
    if (service !== "redis")
      check(all[service]?.environment?.[key] === value, `consistent candidate credential: ${key}`);
  }
  const redisCommand = all.redis?.command ?? [];
  check(
    Array.isArray(redisCommand) &&
      redisCommand.indexOf("--requirepass") >= 0 &&
      redisCommand[redisCommand.indexOf("--requirepass") + 1] === env.REDIS_PASSWORD,
    "consistent candidate Redis credential"
  );
  check(
    typeof env.BETTER_AUTH_SECRET === "string" &&
      env.BETTER_AUTH_SECRET.length >= 32 &&
      !env.BETTER_AUTH_SECRET.includes("REPLACE"),
    "new candidate auth secret required"
  );
  try {
    const source = new URL(env.SOURCE_CODE_URL);
    check(
      env.SOURCE_CODE_URL.length <= 2048 &&
        source.href.length <= 2048 &&
        !/[\s\\?#]/.test(env.SOURCE_CODE_URL) &&
        source.protocol === "https:" &&
        !source.username &&
        !source.password &&
        !source.search &&
        !source.hash &&
        /\/[a-f0-9]{40}\/?$/.test(source.pathname),
      "source URL must identify a published commit (publication checked separately)"
    );
  } catch {
    check(false, "valid source revision URL required");
  }
  check(backend.depends_on?.postgres?.condition === "service_healthy", "PostgreSQL readiness");
  if (all.caddy)
    check(
      all.caddy.profiles?.length === 1 &&
        all.caddy.profiles[0] === "unused-candidate-webserver" &&
        !all.caddy.container_name,
      "candidate webserver stays inactive"
    );
  return errors;
}

export function checkCandidateCompose(envFile, standalone) {
  const binary = standalone ?? "docker";
  const prefix = standalone ? [] : ["compose"];
  const args = [
    ...prefix,
    "--project-name",
    project,
    "--env-file",
    resolve(envFile),
    "-f",
    resolve(root, "docker-compose.yml"),
    "-f",
    resolve(root, "docker-compose.wotcv-minimal.yml"),
    "config",
  ];
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, COMPOSE_PROFILES: "" },
    stdio: ["ignore", "pipe", "pipe"],
  };
  let config;
  try {
    execFileSync(binary, [...args, "--quiet"], options);
    config = JSON.parse(execFileSync(binary, [...args, "--format", "json"], options));
  } catch {
    throw new Error(
      "Compose configuration unavailable/invalid; details withheld because interpolation may contain secrets"
    );
  }
  const errors = validateCandidateCompose(config);
  if (errors.length) throw new Error(`Candidate configuration refused: ${errors.join("; ")}`);
  return {
    status: "PASS",
    project,
    startupGate: "CLOSED",
    runtimeVerified: false,
    compiledClientVerified: false,
    sourcePublicationVerified: false,
    services: services.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (
      ![3, 5].includes(process.argv.length) ||
      (process.argv.length === 5 && process.argv[3] !== "--compose-binary")
    ) {
      throw new Error(
        "Usage: node scripts/check-minimal-compose.mjs <private-env-file> [--compose-binary <standalone-path>]"
      );
    }
    console.log(JSON.stringify(checkCandidateCompose(process.argv[2], process.argv[4])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
