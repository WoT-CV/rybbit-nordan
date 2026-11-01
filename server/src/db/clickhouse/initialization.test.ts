import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ core: vi.fn(), hourly: vi.fn(), queryUser: vi.fn(), lite: vi.fn() }));
vi.mock("../../lib/const.js", () => ({ IS_CLOUD: false, LITE_DASHBOARD: false }));
vi.mock("./client.js", () => ({
  clickhouse: { query: async () => ({ json: async () => [{ timezone: "UTC" }] }) },
  clickhouseQuery: {},
}));
vi.mock("./initUtils.js", () => ({ clickhouseInitLogger: { warn: vi.fn() } }));
vi.mock("./schema/core.js", () => ({ initializeCoreTables: calls.core }));
vi.mock("./schema/cloud.js", () => ({ initializeCloudTables: calls.hourly }));
vi.mock("./schema/liteDashboard.js", () => ({ initializeLiteDashboardMVs: calls.lite }));
vi.mock("./queryUser.js", () => ({ provisionQueryUser: calls.queryUser }));
import { initializeClickhouse } from "./clickhouse.js";

it("initializes native hourly observations and preserves SQL-user provisioning on self-hosted", async () => {
  await initializeClickhouse();
  expect(calls.core).toHaveBeenCalledOnce();
  expect(calls.hourly).toHaveBeenCalledOnce();
  expect(calls.queryUser).toHaveBeenCalledOnce();
  expect(calls.core.mock.invocationCallOrder[0]).toBeLessThan(calls.hourly.mock.invocationCallOrder[0]);
  expect(calls.lite).not.toHaveBeenCalled();
});
