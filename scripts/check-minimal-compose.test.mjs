import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { validateCandidateCompose } from "./check-minimal-compose.mjs";

const project = "rybbit-minimal-candidate";
function fixture() {
  const result = {
    name: project,
    services: {},
    volumes: {},
    networks: { default: { name: `${project}_default` } },
    configs: {},
  };
  for (const [name, published, target, image] of [
    ["backend", 13001, 3001, `ghcr.io/example/backend@sha256:${"a".repeat(64)}`],
    ["client", 13002, 3002, `ghcr.io/example/client@sha256:${"b".repeat(64)}`],
    ["postgres", 15432, 5432, "postgres:17.4"],
    ["redis", 16379, 6379, "redis:8.6.4-alpine"],
    ["clickhouse", 18123, 8123, "clickhouse/clickhouse-server:26.3.62.3"],
  ])
    result.services[name] = {
      image,
      ports: [{ host_ip: "127.0.0.1", published: String(published), target, protocol: "tcp" }],
      logging: { driver: "json-file", options: { "max-size": "50m", "max-file": "5" } },
    };
  for (const [name, source, target] of [
    ["postgres", "postgres-data", "/var/lib/postgresql/data"],
    ["redis", "redis-data", "/data"],
    ["clickhouse", "clickhouse-data", "/var/lib/clickhouse"],
  ]) {
    result.services[name].volumes = [{ type: "volume", source, target }];
    result.volumes[source] = { name: `${project}_${source}` };
  }
  result.services.backend.entrypoint = ["/bin/sh", "/wotcv/candidate-start.sh"];
  result.services.backend.command = ["node", "dist/cluster.js"];
  result.services.backend.restart = "no";
  result.services.backend.volumes = [
    {
      type: "bind",
      source: resolve("ops/minimal/candidate-start.sh"),
      target: "/wotcv/candidate-start.sh",
      read_only: true,
    },
  ];
  result.services.backend.environment = {
    CLOUD: "false",
    DISABLE_TELEMETRY: "true",
    POSTGRES_HOST: "postgres",
    POSTGRES_PORT: "5432",
    REDIS_HOST: "redis",
    REDIS_PORT: "6379",
    CLICKHOUSE_HOST: "http://clickhouse:8123",
    BETTER_AUTH_SECRET: "synthetic-auth-only-".repeat(3),
    POSTGRES_PASSWORD: "synthetic-pg-only-".repeat(2),
    REDIS_PASSWORD: "synthetic-redis-only-".repeat(2),
    CLICKHOUSE_PASSWORD: "synthetic-ch-only-".repeat(2),
    SOURCE_CODE_URL: `https://example.invalid/source/${"c".repeat(40)}`,
  };
  Object.assign(result.services.backend.environment, {
    BASE_URL: "http://127.0.0.1:13002",
    SERVER_URL: "http://127.0.0.1:13001",
  });
  result.services.client.environment = {
    NEXT_PUBLIC_CLOUD: "false",
    NEXT_PUBLIC_BACKEND_URL: "http://127.0.0.1:13001",
  };
  result.services.redis.command = ["redis-server", "--requirepass", result.services.backend.environment.REDIS_PASSWORD];
  result.services.postgres.environment = { POSTGRES_PASSWORD: result.services.backend.environment.POSTGRES_PASSWORD };
  result.services.clickhouse.environment = {
    CLICKHOUSE_PASSWORD: result.services.backend.environment.CLICKHOUSE_PASSWORD,
  };
  result.services.backend.depends_on = { postgres: { condition: "service_healthy" } };
  return result;
}
test("accepts isolated effective candidate model without proving runtime or source publication", () =>
  assert.deepEqual(validateCandidateCompose(fixture()), []));
for (const [name, change] of [
  [
    "production project",
    config => {
      config.name = "rybbit";
    },
  ],
  [
    "fixed name collision",
    config => {
      config.services.backend.container_name = "backend";
    },
  ],
  [
    "public port",
    config => {
      config.services.redis.ports[0].host_ip = "0.0.0.0";
    },
  ],
  [
    "merged production port",
    config => {
      config.services.backend.ports.push({ published: "3001", target: 3001 });
    },
  ],
  [
    "live host DB",
    config => {
      config.services.backend.environment.POSTGRES_HOST = "host.docker.internal";
    },
  ],
  [
    "shared data volume",
    config => {
      config.volumes["postgres-data"].external = true;
    },
  ],
  [
    "production volume name",
    config => {
      config.volumes["postgres-data"].name = "rybbit_postgres-data";
    },
  ],
  [
    "bind mount data",
    config => {
      config.services.postgres.volumes[0].type = "bind";
    },
  ],
  [
    "client secret mount",
    config => {
      config.services.client.volumes = [{ source: "/production" }];
    },
  ],
  [
    "host network",
    config => {
      config.services.backend.network_mode = "host";
    },
  ],
  [
    "extra service",
    config => {
      config.services.worker = {};
    },
  ],
  [
    "external network",
    config => {
      config.networks.default.external = true;
    },
  ],
  [
    "logging drift",
    config => {
      config.services.postgres.logging.options["max-size"] = "100m";
    },
  ],
  [
    "mutable app tag",
    config => {
      config.services.backend.image = "ghcr.io/example/backend:latest";
    },
  ],
  [
    "altered infra image",
    config => {
      config.services.postgres.image = "postgres:18";
    },
  ],
  [
    "build side effect",
    config => {
      config.services.client.build = { context: "." };
    },
  ],
  [
    "opened startup gate",
    config => {
      config.services.backend.environment.WOTCV_CANDIDATE_START_ACK = "empty-isolated-candidate-approved";
    },
  ],
  [
    "guard bypass",
    config => {
      config.services.backend.entrypoint = ["/app/docker-entrypoint.sh"];
    },
  ],
  [
    "guard restart loop",
    config => {
      config.services.backend.restart = "unless-stopped";
    },
  ],
  [
    "production callback URL",
    config => {
      config.services.backend.environment.BASE_URL = "https://tracking.example.invalid";
    },
  ],
  [
    "Redis credential mismatch",
    config => {
      config.services.redis.command[2] = "other-password";
    },
  ],
  [
    "wrong guard source",
    config => {
      config.services.backend.volumes[0].source = "/other/start.sh";
    },
  ],
  [
    "guard writable",
    config => {
      config.services.backend.volumes[0].read_only = false;
    },
  ],
  [
    "unhealthy dependency",
    config => {
      config.services.backend.depends_on.postgres.condition = "service_started";
    },
  ],
  [
    "placeholder auth",
    config => {
      config.services.backend.environment.BETTER_AUTH_SECRET = "REPLACE_WITH_AUTH";
    },
  ],
  [
    "unpublished branch URL",
    config => {
      config.services.backend.environment.SOURCE_CODE_URL = "https://example.invalid/tree/main";
    },
  ],
  [
    "source URL credentials",
    config => {
      config.services.backend.environment.SOURCE_CODE_URL = `https://token@example.invalid/${"c".repeat(40)}`;
    },
  ],
  [
    "caddy enabled",
    config => {
      config.services.caddy = { profiles: ["with-webserver"] };
    },
  ],
])
  test(`refuses ${name}`, () => {
    const config = fixture();
    change(config);
    assert.ok(validateCandidateCompose(config).length > 0);
  });
