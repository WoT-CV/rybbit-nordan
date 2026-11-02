import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const clusterHandlers = new Map<string, (...args: any[]) => any>();
  return {
    cloud: false,
    handlers,
    clusterHandlers,
    cluster: {
      isPrimary: true,
      isWorker: false,
      workers: {} as Record<string, any>,
      fork: vi.fn(),
      on: vi.fn((event, handler) => clusterHandlers.set(event, handler)),
    },
    initializeClickhouse: vi.fn(),
    initPostgres: vi.fn(),
    indexImported: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    telemetry: { startTelemetryCron: vi.fn(), stopTelemetryCron: vi.fn() },
    usage: {
      startUsageCheckCron: vi.fn(),
      stopUsageCheckCron: vi.fn(),
      onUsageUpdated: vi.fn(),
      refreshOrganizationWithRetry: vi.fn(),
      getUsageStateMessage: vi.fn(() => ({
        type: "usage-state",
        sitesOverLimit: [],
        sitesWithoutPlan: [],
        sitesWithoutReplay: [],
      })),
    },
    cleanup: { startCleanupCron: vi.fn(), stopCleanupCron: vi.fn() },
    weekly: { startWeeklyReportCron: vi.fn(), stopWeeklyReportCron: vi.fn() },
    lifecycle: { startLifecycleCron: vi.fn(), stopLifecycleCron: vi.fn() },
    sessions: { close: vi.fn() },
  };
});

vi.mock("node:cluster", () => ({ default: harness.cluster }));
vi.mock("./db/clickhouse/clickhouse.js", () => ({ initializeClickhouse: harness.initializeClickhouse }));
vi.mock("./db/postgres/initPostgres.js", () => ({ initPostgres: harness.initPostgres }));
vi.mock("./lib/const.js", () => ({
  get IS_CLOUD() {
    return harness.cloud;
  },
}));
vi.mock("./lib/logger/logger.js", () => ({ createServiceLogger: () => harness.logger }));
vi.mock("./services/telemetryService.js", () => ({ telemetryService: harness.telemetry }));
vi.mock("./services/usageService.js", () => ({
  usageService: harness.usage,
  REFRESH_ORGANIZATION_USAGE_MESSAGE: "refresh-usage",
  USAGE_STATE_REQUEST_MESSAGE: "request-usage",
}));
vi.mock("./services/sites/unclaimedSiteCleanupService.js", () => ({ unclaimedSiteCleanupService: harness.cleanup }));
vi.mock("./services/weekyReports/weeklyReportService.js", () => ({ weeklyReportService: harness.weekly }));
vi.mock("./services/lifecycleEmails/lifecycleEmailService.js", () => ({ lifecycleEmailService: harness.lifecycle }));
vi.mock("./services/sessions/sessionsService.js", () => ({ sessionsService: harness.sessions }));

class ExitSentinel extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`mock process.exit(${code})`);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CLUSTER_WORKERS", "2");
  harness.cloud = false;
  harness.cluster.isPrimary = true;
  harness.cluster.isWorker = false;
  harness.cluster.workers = {};
  harness.handlers.clear();
  harness.clusterHandlers.clear();
  // Re-register this factory per case: resetModules does not clear Vitest's
  // mock-factory cache, but each branch must prove a fresh delegated import.
  vi.doMock("./index.js", () => {
    harness.indexImported();
    return {};
  });
  harness.initializeClickhouse.mockResolvedValue(undefined);
  harness.initPostgres.mockResolvedValue(undefined);
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: any[]) => any) => {
    harness.handlers.set(event, handler);
    return process;
  }) as typeof process.on);
  // A returning exit mock would let a failed primary initialize crons/fork.
  vi.spyOn(process, "exit").mockImplementation(code => {
    throw new ExitSentinel(code);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("actual cluster entrypoint with isolated I/O", () => {
  it.each([undefined, "", "0"])("delegates %s workers to index without primary initialization", async workers => {
    vi.stubEnv("CLUSTER_WORKERS", workers);
    await import("./cluster.js");
    await vi.dynamicImportSettled();
    expect(harness.indexImported).toHaveBeenCalledOnce();
    expect(harness.initializeClickhouse).not.toHaveBeenCalled();
    expect(harness.initPostgres).not.toHaveBeenCalled();
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.cluster.fork).not.toHaveBeenCalled();
  });

  it("runs one production weekly scheduler on the self-hosted primary before forking", async () => {
    await import("./cluster.js");
    expect(harness.initializeClickhouse).toHaveBeenCalledOnce();
    expect(harness.initPostgres).toHaveBeenCalledOnce();
    expect(harness.weekly.startWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.weekly.startWeeklyReportCron.mock.invocationCallOrder[0]).toBeLessThan(
      harness.cluster.fork.mock.invocationCallOrder[0]
    );
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.cluster.fork).toHaveBeenCalledTimes(2);
    expect(harness.indexImported).not.toHaveBeenCalled();
  });

  it("retains cloud marketing gating and development scheduler suppression", async () => {
    harness.cloud = true;
    await import("./cluster.js");
    expect(harness.lifecycle.startLifecycleCron).toHaveBeenCalledOnce();
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    await import("./cluster.js");
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.cluster.fork).toHaveBeenCalledTimes(2);
  });

  it("waits for both database initializers before starting weekly or forking", async () => {
    let finishPostgres!: () => void;
    harness.initPostgres.mockReturnValue(
      new Promise<void>(resolve => {
        finishPostgres = resolve;
      })
    );
    const importing = import("./cluster.js");
    await vi.waitFor(() => expect(harness.initPostgres).toHaveBeenCalledOnce());
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.cluster.fork).not.toHaveBeenCalled();
    finishPostgres();
    await importing;
    expect(harness.weekly.startWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.cluster.fork).toHaveBeenCalledTimes(2);
  });

  it("worker delegates to index without starting primary crons or databases", async () => {
    harness.cluster.isPrimary = false;
    harness.cluster.isWorker = true;
    await import("./cluster.js");
    await vi.dynamicImportSettled();
    expect(harness.indexImported).toHaveBeenCalledOnce();
    expect(harness.initializeClickhouse).not.toHaveBeenCalled();
    expect(harness.initPostgres).not.toHaveBeenCalled();
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.telemetry.startTelemetryCron).not.toHaveBeenCalled();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.usage.startUsageCheckCron).not.toHaveBeenCalled();
    expect(harness.cleanup.startCleanupCron).not.toHaveBeenCalled();
  });

  it("aborts primary startup on DB failure without cron or fork continuation", async () => {
    harness.initPostgres.mockRejectedValue(new Error("synthetic DB failure"));
    await expect(import("./cluster.js")).rejects.toMatchObject({ code: 1 });
    expect(process.exit).toHaveBeenCalledOnce();
    expect(harness.weekly.startWeeklyReportCron).not.toHaveBeenCalled();
    expect(harness.telemetry.startTelemetryCron).not.toHaveBeenCalled();
    expect(harness.usage.startUsageCheckCron).not.toHaveBeenCalled();
    expect(harness.cleanup.startCleanupCron).not.toHaveBeenCalled();
    expect(harness.lifecycle.startLifecycleCron).not.toHaveBeenCalled();
    expect(harness.cluster.fork).not.toHaveBeenCalled();
  });

  it("stops weekly before killing workers and registers every exit listener before any kill", async () => {
    const order: string[] = [];
    const workers = [1, 2].map(id => {
      let onExit: (() => void) | undefined;
      return {
        isDead: () => false,
        on: vi.fn((event, callback) => {
          expect(event).toBe("exit");
          order.push(`listen${id}`);
          onExit = callback;
        }),
        process: {
          pid: id,
          kill: vi.fn(signal => {
            expect(signal).toBe("SIGTERM");
            order.push(`kill${id}`);
            onExit?.();
          }),
        },
      };
    });
    harness.cluster.workers = { 1: workers[0], 2: workers[1] };
    await import("./cluster.js");
    await expect(harness.handlers.get("SIGTERM")!()).rejects.toMatchObject({ code: 0 });
    expect(order).toEqual(["listen1", "listen2", "kill1", "kill2"]);
    expect(harness.weekly.stopWeeklyReportCron).toHaveBeenCalledOnce();
    expect(harness.weekly.stopWeeklyReportCron.mock.invocationCallOrder[0]).toBeLessThan(
      workers[0].process.kill.mock.invocationCallOrder[0]
    );
    expect(harness.lifecycle.stopLifecycleCron).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
