import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: "ready",
  replayBudgetCharge: vi.fn(),
}));

vi.mock("../../db/redis/redis.js", () => ({
  replayBudgetRedis: {
    get status() {
      return mocks.status;
    },
  },
  replayBudgetCharge: mocks.replayBudgetCharge,
}));

import {
  chargeReplaySessionBudget,
  MAX_FALLBACK_REPLAY_RESERVATIONS,
  MAX_REPLAY_BATCH_RESERVATIONS_PER_SESSION,
  MAX_REPLAY_BATCH_STORAGE_ATTEMPTS,
  ReplayBudgetUnavailableError,
  resetReplayBudgetFallback,
} from "./replaySessionBudget.js";

describe("chargeReplaySessionBudget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReplayBudgetFallback();
    mocks.status = "ready";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the shared Redis budget when Redis is ready", async () => {
    mocks.replayBudgetCharge.mockResolvedValue({ accepted: false, usedBytes: 2000 });

    expect(await chargeReplaySessionBudget(42, "s1", 10, "batch-a", 1000)).toEqual({
      accepted: false,
      usedBytes: 2000,
    });
    expect(mocks.replayBudgetCharge).toHaveBeenCalledWith(
      "replay:budget:42:s1",
      "batch-a",
      10,
      1000,
      expect.any(Number),
      MAX_REPLAY_BATCH_RESERVATIONS_PER_SESSION,
      MAX_REPLAY_BATCH_STORAGE_ATTEMPTS
    );
  });

  it("keeps enforcing the cap in-process when Redis is down", async () => {
    mocks.status = "reconnecting";

    expect(await chargeReplaySessionBudget(42, "s1", 600, "batch-a", 1000)).toEqual({ accepted: true, usedBytes: 600 });
    expect(await chargeReplaySessionBudget(42, "s1", 600, "batch-b", 1000)).toEqual({
      accepted: true,
      usedBytes: 1200,
    });
    expect(await chargeReplaySessionBudget(42, "s1", 600, "batch-b", 1000)).toEqual({
      accepted: true,
      usedBytes: 1200,
    });
    expect(await chargeReplaySessionBudget(42, "s1", 1, "batch-c", 1000)).toEqual({ accepted: false, usedBytes: 1200 });
    // Other sessions keep their own budget.
    expect(await chargeReplaySessionBudget(42, "s2", 1, "batch-a", 1000)).toEqual({ accepted: true, usedBytes: 1 });
    expect(mocks.replayBudgetCharge).not.toHaveBeenCalled();
  });

  it("falls back in-process when the Redis call fails", async () => {
    mocks.replayBudgetCharge.mockRejectedValue(new Error("timeout"));

    expect(await chargeReplaySessionBudget(42, "s1", 600, "batch-a", 1000)).toEqual({ accepted: true, usedBytes: 600 });
    expect(await chargeReplaySessionBudget(42, "s1", 600, "batch-a", 1000)).toEqual({ accepted: true, usedBytes: 600 });
  });

  it("accepts everything when the cap is disabled", async () => {
    expect(await chargeReplaySessionBudget(42, "s1", 10_000, "batch-a", 0)).toEqual({ accepted: true, usedBytes: 0 });
    expect(mocks.replayBudgetCharge).not.toHaveBeenCalled();
  });

  it("does not share a fallback budget across sites", async () => {
    mocks.status = "reconnecting";
    expect(await chargeReplaySessionBudget(42, "same-session", 1000, "batch-a", 1000)).toEqual({
      accepted: true,
      usedBytes: 1000,
    });
    expect(await chargeReplaySessionBudget(43, "same-session", 1, "batch-a", 1000)).toEqual({
      accepted: true,
      usedBytes: 1,
    });
    expect(await chargeReplaySessionBudget(42, "same-session", 1, "batch-b", 1000)).toEqual({
      accepted: false,
      usedBytes: 1000,
    });
  });

  it("slides fallback expiry on refused batches so an active capped session does not reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
    mocks.status = "reconnecting";
    const hour = 60 * 60 * 1000;

    expect(await chargeReplaySessionBudget(42, "s1", 1000, "batch-a", 1000)).toEqual({
      accepted: true,
      usedBytes: 1000,
    });
    vi.setSystemTime(Date.now() + hour);
    expect(await chargeReplaySessionBudget(42, "s1", 1, "batch-b", 1000)).toEqual({ accepted: false, usedBytes: 1000 });
    vi.setSystemTime(Date.now() + hour + 1);
    expect(await chargeReplaySessionBudget(42, "s1", 1, "batch-b", 1000)).toEqual({ accepted: false, usedBytes: 1000 });
    vi.setSystemTime(Date.now() + 2 * hour + 1);
    expect(await chargeReplaySessionBudget(42, "s1", 1, "batch-b", 1000)).toEqual({ accepted: true, usedBytes: 1 });
  });

  it("does not replace Redis reservation-state loss with a new fallback allowance", async () => {
    mocks.replayBudgetCharge.mockResolvedValue({ accepted: false, usedBytes: 1000, unavailable: true });
    await expect(chargeReplaySessionBudget(42, "s1", 10, "batch-a", 1000)).rejects.toBeInstanceOf(
      ReplayBudgetUnavailableError
    );
  });

  it("allows only three total fallback attempts, not an initial attempt plus three retries", async () => {
    mocks.status = "reconnecting";
    expect(MAX_REPLAY_BATCH_STORAGE_ATTEMPTS).toBe(3);
    for (let attempt = 0; attempt < MAX_REPLAY_BATCH_STORAGE_ATTEMPTS; attempt++) {
      expect(await chargeReplaySessionBudget(42, "s1", 1100, "batch-a", 1000)).toEqual({
        accepted: true,
        usedBytes: 1100,
      });
    }
    await expect(chargeReplaySessionBudget(42, "s1", 1100, "batch-a", 1000)).rejects.toMatchObject({ statusCode: 503 });
    expect(await chargeReplaySessionBudget(42, "s1", 1, "batch-b", 1000)).toEqual({ accepted: false, usedBytes: 1100 });
  });

  it("keeps an accepted fallback retry valid after Redis recovers with an exhausted budget", async () => {
    mocks.status = "reconnecting";
    expect(await chargeReplaySessionBudget(42, "s1", 1000, "batch-a", 1000)).toEqual({
      accepted: true,
      usedBytes: 1000,
    });
    mocks.status = "ready";
    mocks.replayBudgetCharge.mockResolvedValue({ accepted: false, usedBytes: 1000 });

    expect(await chargeReplaySessionBudget(42, "s1", 1000, "batch-a", 1000)).toEqual({
      accepted: true,
      usedBytes: 1000,
    });
    expect(mocks.replayBudgetCharge).not.toHaveBeenCalled();
    expect(await chargeReplaySessionBudget(42, "s1", 1, "batch-b", 1000)).toEqual({ accepted: false, usedBytes: 1000 });
  });

  it("backpressures zero-byte batches at the per-session bound without evicting accepted retries", async () => {
    mocks.status = "reconnecting";
    for (let index = 0; index < MAX_REPLAY_BATCH_RESERVATIONS_PER_SESSION; index++) {
      await chargeReplaySessionBudget(42, "s1", 0, String(index), 1000);
    }

    await expect(chargeReplaySessionBudget(42, "s1", 0, "next", 1000)).rejects.toMatchObject({ statusCode: 503 });
    expect(await chargeReplaySessionBudget(42, "s1", 0, "0", 1000)).toEqual({ accepted: true, usedBytes: 0 });
    await expect(chargeReplaySessionBudget(42, "s1", 1, "0", 1000)).rejects.toBeInstanceOf(
      ReplayBudgetUnavailableError
    );
  });

  it("bounds total fallback fingerprints without evicting live sessions and reclaims expired entries", async () => {
    vi.useFakeTimers();
    mocks.status = "reconnecting";
    for (let index = 0; index < MAX_FALLBACK_REPLAY_RESERVATIONS; index++) {
      await chargeReplaySessionBudget(42, String(index), 0, "batch-a", 1000);
    }
    await expect(chargeReplaySessionBudget(42, "next", 0, "batch-a", 1000)).rejects.toMatchObject({ statusCode: 503 });
    expect(await chargeReplaySessionBudget(42, "0", 0, "batch-a", 1000)).toEqual({ accepted: true, usedBytes: 0 });

    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000 + 1);
    expect(await chargeReplaySessionBudget(42, "next", 0, "batch-a", 1000)).toEqual({ accepted: true, usedBytes: 0 });
  });
});
