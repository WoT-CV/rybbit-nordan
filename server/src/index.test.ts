import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const handlers = new Map<string, (...args: any[]) => any>();
  const server = {
    register: vi.fn(),
    addHook: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    log,
    listen: vi.fn(),
    close: vi.fn(),
  };
  return {
    cloud: false,
    cluster: { isWorker: false },
    handlers,
    server,
    fastify: vi.fn(() => server),
    initializeClickhouse: vi.fn(),
    initPostgres: vi.fn(),
    baseline: vi.fn(),
    telemetry: { startTelemetryCron: vi.fn() },
    usage: { startUsageCheckCron: vi.fn(), applyUsageStateMessage: vi.fn() },
    cleanup: { startCleanupCron: vi.fn(), stopCleanupCron: vi.fn() },
    weekly: { startWeeklyReportCron: vi.fn(), stopWeeklyReportCron: vi.fn() },
    lifecycle: { startLifecycleCron: vi.fn() },
    pageviews: { drain: vi.fn() },
    botEvents: { drain: vi.fn() },
    botObservations: { drain: vi.fn() },
    identities: { drainCompletely: vi.fn() },
  };
});

// Isolate every infrastructure import before executing the actual entrypoint.
// Fastify's listen/register are spies, so no socket or route plugin is started.
vi.mock("node:cluster", () => ({ default: harness.cluster }));
vi.mock("fastify", () => ({ default: harness.fastify }));
vi.mock("@fastify/cors", () => ({ default: vi.fn() }));
vi.mock("@fastify/rate-limit", () => ({ default: vi.fn() }));
vi.mock("@fastify/static", () => ({ default: vi.fn() }));
vi.mock("better-auth/node", () => ({ toNodeHandler: vi.fn() }));
vi.mock("./db/clickhouse/clickhouse.js", () => ({ initializeClickhouse: harness.initializeClickhouse }));
vi.mock("./db/postgres/initPostgres.js", () => ({ initPostgres: harness.initPostgres }));
vi.mock("./db/redis/redis.js", () => ({ apiRateLimitRedis: {} }));
vi.mock("./lib/auth-utils.js", () => ({ mapHeaders: vi.fn() }));
vi.mock("./lib/api-errors.js", () => ({ registerApiErrorResponses: vi.fn() }));
vi.mock("./api/routes.js", () => ({ apiRoutes: vi.fn() }));
vi.mock("./lib/auth.js", () => ({ auth: {} }));
vi.mock("./mcp/wellKnown.js", () => ({ oauthWellKnownRoutes: vi.fn() }));
vi.mock("./lib/cors.js", () => ({ createCorsOptionsDelegate: vi.fn(), createRejectUntrustedOriginHook: vi.fn() }));
vi.mock("./lib/const.js", () => ({
  get IS_CLOUD() {
    return harness.cloud;
  },
}));
vi.mock("./lib/logger/logger.js", () => ({ logger: harness.server.log }));
vi.mock("./lib/logger/requestLogging.js", () => ({ registerRequestLogging: vi.fn() }));
vi.mock("./services/tracker/botBlocking/botEventQueue.js", () => ({
  botEventQueue: harness.botEvents,
  botObservationQueue: harness.botObservations,
}));
vi.mock("./services/tracker/identityBackfillQueue.js", () => ({ identityBackfillQueue: harness.identities }));
vi.mock("./services/tracker/pageviewQueue.js", () => ({ pageviewQueue: harness.pageviews }));
vi.mock("./services/tracker/identifyService.js", () => ({ handleIdentify: vi.fn() }));
vi.mock("./services/tracker/trackEvent.js", () => ({ trackEvent: vi.fn() }));
vi.mock("./services/tracker/botBlocking/siteBaseline.js", () => ({ startSiteBaselineRefresh: harness.baseline }));
vi.mock("./services/telemetryService.js", () => ({ telemetryService: harness.telemetry }));
vi.mock("./services/usageService.js", () => ({
  usageService: harness.usage,
  USAGE_STATE_MESSAGE: "usage-state",
  USAGE_STATE_REQUEST_MESSAGE: "request-usage",
}));
vi.mock("./services/sites/unclaimedSiteCleanupService.js", () => ({ unclaimedSiteCleanupService: harness.cleanup }));
vi.mock("./services/weekyReports/weeklyReportService.js", () => ({ weeklyReportService: harness.weekly }));
vi.mock("./services/lifecycleEmails/lifecycleEmailService.js", () => ({ lifecycleEmailService: harness.lifecycle }));

let originalSend: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  harness.cloud = false;
  harness.cluster.isWorker = false;
  harness.handlers.clear();
  harness.initializeClickhouse.mockResolvedValue(undefined);
  harness.initPostgres.mockResolvedValue(undefined);
  harness.server.listen.mockResolvedValue(undefined);
  harness.server.close.mockResolvedValue(undefined);
  harness.pageviews.drain.mockResolvedValue(undefined);
  harness.botEvents.drain.mockResolvedValue(undefined);
  harness.botObservations.drain.mockResolvedValue(undefined);
  harness.identities.drainCompletely.mockResolvedValue(undefined);
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: any[]) => any) => {
    harness.handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  // Unlike cluster's top-level try, index's startup catch ends immediately after
  // exit. Returning here cannot continue startup and avoids an artificial
  // unhandled rejection from its intentionally unawaited start() invocation.
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  originalSend = Object.getOwnPropertyDescriptor(process, "send");
  Object.defineProperty(process, "send", { configurable: true, writable: true, value: vi.fn(() => true) });
});

afterEach(() => {
  if (originalSend) Object.defineProperty(process, "send", originalSend);
  else Reflect.deleteProperty(process, "send");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function startAndWait() {
  await import("./index.js");
  await vi.waitFor(() => expect(harness.server.listen).toHaveBeenCalledOnce());
}

describe("actual server entrypoint with isolated I/O", () => {
  it("starts one self-hosted production weekly scheduler and no marketing scheduler", async () => {
    await startAndWait();
    expect(harness.initializeClickhouse).toHaveBeenCalledOnce();
    expect(harness.initPostgres).toHaveBeenCalledOnce();
    expect(harness.weekly.startWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.server.listen).toHaveBeenCalledWith({ port: 3001, host: "0.0.0.0" });
    expect(harness.fastify).toHaveBeenCalledOnce();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("keeps production cloud lifecycle separate from weekly reporting", async () => {
    harness.cloud = true;
    await startAndWait();
    expect(harness.weekly.startWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.lifecycle.startLifecycleCron).toHaveBeenCalledOnce();
  });

  it("development suppresses weekly and marketing schedulers without changing server startup", async () => {
    harness.cloud = true;
    vi.stubEnv("NODE_ENV", "development");
    await startAndWait();
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.baseline).toHaveBeenCalledOnce();
  });

  it("worker installs IPC listener and applies primary state before listen, without DB/crons", async () => {
    harness.cluster.isWorker = true;
    harness.cloud = true;
    const state = { type: "usage-state", sitesOverLimit: [1], sitesWithoutPlan: [2], sitesWithoutReplay: [3] };
    vi.mocked(process.send!).mockImplementation(() => {
      expect(harness.handlers.has("message")).toBe(true);
      expect(harness.server.listen).not.toHaveBeenCalled();
      harness.handlers.get("message")!(state);
      return true;
    });
    await startAndWait();
    expect(process.send).toHaveBeenCalledWith({ type: "request-usage" });
    expect(harness.usage.applyUsageStateMessage).toHaveBeenCalledWith(state);
    expect(harness.usage.applyUsageStateMessage.mock.invocationCallOrder[0]).toBeLessThan(
      harness.server.listen.mock.invocationCallOrder[0]
    );
    expect(harness.initializeClickhouse).not.toHaveBeenCalled();
    expect(harness.initPostgres).not.toHaveBeenCalled();
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.telemetry.startTelemetryCron).not.toHaveBeenCalled();
    expect(harness.usage.startUsageCheckCron).not.toHaveBeenCalled();
    expect(harness.cleanup.startCleanupCron).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("DB failure exits without starting baseline/crons or listening", async () => {
    harness.initPostgres.mockRejectedValue(new Error("synthetic DB failure"));
    await import("./index.js");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(process.exit).toHaveBeenCalledOnce();
    expect(harness.server.listen).not.toHaveBeenCalled();
    expect(harness.baseline).not.toHaveBeenCalled();
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.telemetry.startTelemetryCron).not.toHaveBeenCalled();
    expect(harness.usage.startUsageCheckCron).not.toHaveBeenCalled();
    expect(harness.cleanup.startCleanupCron).not.toHaveBeenCalled();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
  });

  it("listen failure follows startup error exit without launching a real listener", async () => {
    harness.server.listen.mockRejectedValue(new Error("synthetic listen failure"));
    await import("./index.js");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledExactlyOnceWith(1));
    expect(harness.server.listen).toHaveBeenCalledOnce();
    expect(harness.server.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "synthetic listen failure" })
    );
  });

  it("stops weekly before closing server and drains queues before successful exit", async () => {
    await startAndWait();
    await harness.handlers.get("SIGTERM")!();
    expect(harness.weekly.stopWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.weekly.stopWeeklyReportCron.mock.invocationCallOrder[0]).toBeLessThan(
      harness.server.close.mock.invocationCallOrder[0]
    );
    expect(harness.server.close).toHaveBeenCalledOnce();
    expect(harness.pageviews.drain).toHaveBeenCalledOnce();
    expect(harness.botEvents.drain).toHaveBeenCalledOnce();
    expect(harness.botObservations.drain).toHaveBeenCalledOnce();
    expect(harness.identities.drainCompletely).toHaveBeenCalledOnce();
    expect(harness.identities.drainCompletely.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(process.exit).mock.invocationCallOrder[0]
    );
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close failure still stops weekly and exits failure without draining after failed close", async () => {
    await startAndWait();
    harness.server.close.mockRejectedValue(new Error("synthetic close failure"));
    await harness.handlers.get("SIGINT")!();
    expect(harness.weekly.stopWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.pageviews.drain).not.toHaveBeenCalled();
    expect(harness.identities.drainCompletely).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
