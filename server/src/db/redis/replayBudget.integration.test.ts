import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPLAY_BUDGET_LUA } from "./replayBudgetLua.js";

// Behavioral tests for the replay budget Lua, executed for real by ioredis-mock's
// embedded Lua runtime.

const KEY = "replay:budget:42:session-1";
const RESERVATIONS_KEY = `${KEY}:batches`;
const CAP = 1000;
const TTL_MS = 60_000;

interface BudgetMockRedis {
  replayBudgetCharge(
    key: string,
    reservationsKey: string,
    fingerprint: string,
    bytes: number,
    capBytes: number,
    ttlMs: number,
    maxReservations: number,
    maxAttempts: number
  ): Promise<[number, number]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hlen(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  flushall(): Promise<unknown>;
  disconnect(): void;
}

let redis: BudgetMockRedis;

let sequence = 0;
function charge(bytes: number, fingerprint = `batch-${sequence++}`, maxReservations = 4096) {
  return redis.replayBudgetCharge(KEY, RESERVATIONS_KEY, fingerprint, bytes, CAP, TTL_MS, maxReservations, 3);
}

describe("replayBudgetCharge Lua script", () => {
  beforeEach(async () => {
    const client = new RedisMock();
    client.defineCommand("replayBudgetCharge", { numberOfKeys: 2, lua: REPLAY_BUDGET_LUA });
    redis = client as unknown as BudgetMockRedis;
    await redis.flushall();
    sequence = 0;
  });

  afterEach(() => {
    redis.disconnect();
  });

  it("accepts batches under the cap and adds them up", async () => {
    expect(await charge(400)).toEqual([1, 400]);
    expect(await charge(400)).toEqual([1, 800]);
  });

  it("accepts the batch that crosses the cap, then refuses without charging", async () => {
    await charge(800);
    expect(await charge(500)).toEqual([1, 1300]);
    expect(await charge(10)).toEqual([0, 1300]);
    expect(await redis.get(KEY)).toBe("1300");
  });

  it("slides the TTL on refused batches too", async () => {
    await charge(CAP);
    await redis.pexpire(KEY, 5);
    await redis.pexpire(RESERVATIONS_KEY, 5);
    expect(await charge(10)).toEqual([0, CAP]);
    expect(await redis.pttl(KEY)).toBeGreaterThan(5);
    expect(await redis.pttl(RESERVATIONS_KEY)).toBeGreaterThan(5);
  });

  it("reuses an accepted reservation after the cap without charging again", async () => {
    await charge(900, "earlier");
    expect(await charge(200, "retryable")).toEqual([1, 1100]);
    expect(await charge(200, "retryable")).toEqual([2, 1100]);
    expect(await charge(1, "new")).toEqual([0, 1100]);
    expect(await redis.get(KEY)).toBe("1100");
  });

  it("atomically charges one batch only once and bounds concurrent storage attempts", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => charge(600, "same")));
    expect(results.filter(([outcome]) => outcome === 1)).toHaveLength(1);
    expect(results.filter(([outcome]) => outcome === 2)).toHaveLength(2);
    expect(results.filter(([outcome]) => outcome === -1)).toHaveLength(17);
    expect(await redis.get(KEY)).toBe("600");
    expect(await redis.hlen(RESERVATIONS_KEY)).toBe(1);
  });

  it("never allows a fourth accepted attempt of the same fingerprint", async () => {
    expect(await charge(1100, "same")).toEqual([1, 1100]);
    expect(await charge(1100, "same")).toEqual([2, 1100]);
    expect(await charge(1100, "same")).toEqual([2, 1100]);
    expect(await charge(1100, "same")).toEqual([-1, 1100]);
    expect(await charge(1, "new")).toEqual([0, 1100]);
  });

  it("serializes concurrent distinct reservations across the cap", async () => {
    await charge(900, "earlier");
    const results = await Promise.all([charge(200, "a"), charge(200, "b")]);
    expect(results.filter(([outcome]) => outcome === 1)).toHaveLength(1);
    expect(results.filter(([outcome]) => outcome === 0)).toHaveLength(1);
    expect(await redis.get(KEY)).toBe("1100");
  });

  it("backpressures a full zero-byte reservation hash but keeps old retries valid", async () => {
    expect(await charge(0, "a", 2)).toEqual([1, 0]);
    expect(await charge(0, "b", 2)).toEqual([1, 0]);
    expect(await charge(0, "c", 2)).toEqual([-1, 0]);
    expect(await charge(0, "a", 2)).toEqual([2, 0]);
    expect(await charge(1, "a", 2)).toEqual([-1, 0]);
    expect(await redis.hlen(RESERVATIONS_KEY)).toBe(2);
  });

  it.each([KEY, RESERVATIONS_KEY])("returns unavailable instead of capped if %s is lost", async lostKey => {
    await charge(CAP, "accepted");
    await redis.del(lostKey);
    expect((await charge(CAP, "accepted"))[0]).toBe(-1);
  });

  it("does not treat an old-version counter without reservations as a known cap", async () => {
    await redis.set(KEY, "1000");
    expect(await charge(1, "unknown-retry")).toEqual([-1, 1000]);
  });
});
