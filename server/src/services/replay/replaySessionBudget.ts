import { replayBudgetCharge, replayBudgetRedis } from "../../db/redis/redis.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import { ReplayBudgetUnavailableError } from "./replayBudgetError.js";

export { ReplayBudgetUnavailableError } from "./replayBudgetError.js";

const logger = createServiceLogger("session-replay-budget");

const DEFAULT_MAX_MB_PER_SESSION = 50;

// About the 99th percentile of replay sessions. The sessions above it are mostly
// pathological: recorder loops re-taking full snapshots, or many visitors merged
// into one never-ending session, which once wrote 1.2B rows (several TB) a day.
// 0 disables the cap.
function maxBytesFromEnv(): number {
  const raw = process.env.SESSION_REPLAY_MAX_MB_PER_SESSION;
  const mb = raw === undefined || raw === "" ? DEFAULT_MAX_MB_PER_SESSION : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) {
    return DEFAULT_MAX_MB_PER_SESSION * 1024 * 1024;
  }
  return Math.floor(mb * 1024 * 1024);
}

export const REPLAY_MAX_BYTES_PER_SESSION = maxBytesFromEnv();

// Must outlive the 30-minute sliding session it shadows; the key slides on every
// batch, so a live session can't outrun it.
const BUDGET_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_REPLAY_BATCH_RESERVATIONS_PER_SESSION = 4096;
export const MAX_FALLBACK_REPLAY_RESERVATIONS = 50_000;
// Same three TOTAL attempts as SessionReplayRecorder, not an initial + 3 retries.
export const MAX_REPLAY_BATCH_STORAGE_ATTEMPTS = 3;

export type ReplayBudgetDecision = { accepted: boolean; usedBytes: number };

// Per-worker budgets for when Redis is unavailable. Each worker counts on its
// own, so this fallback bounds that worker's ingest, not the cluster-wide total.
interface FallbackBudget {
  usedBytes: number;
  expiresAt: number;
  reservations: Map<string, { bytes: number; attempts: number }>;
}

type BudgetReservation = ReplayBudgetDecision & { reused?: boolean; unavailable?: boolean };

const fallbackBudgets = new Map<string, FallbackBudget>();
let fallbackReservationCount = 0;

function touchFallback(key: string, budget: FallbackBudget, now: number) {
  budget.expiresAt = now + BUDGET_TTL_MS;
  fallbackBudgets.delete(key);
  fallbackBudgets.set(key, budget);
}

function expireFallback(now: number) {
  // Touches keep insertion order aligned with sliding expiry. Never evict a
  // live reservation: its next retry must not be mistaken for a new batch.
  for (const [key, budget] of fallbackBudgets) {
    if (budget.expiresAt > now) break;
    fallbackReservationCount -= budget.reservations.size;
    fallbackBudgets.delete(key);
  }
}

function chargeFallback(
  key: string,
  fingerprint: string,
  bytes: number,
  capBytes: number,
  now: number
): BudgetReservation {
  const budget = fallbackBudgets.get(key) ?? {
    usedBytes: 0,
    expiresAt: 0,
    reservations: new Map<string, { bytes: number; attempts: number }>(),
  };
  const reserved = budget.reservations.get(fingerprint);
  if (reserved !== undefined) {
    touchFallback(key, budget, now);
    if (reserved.bytes !== bytes || reserved.attempts >= MAX_REPLAY_BATCH_STORAGE_ATTEMPTS) {
      throw new ReplayBudgetUnavailableError();
    }
    reserved.attempts++;
    return { accepted: true, usedBytes: budget.usedBytes, reused: true };
  }
  if (budget.usedBytes >= capBytes) {
    touchFallback(key, budget, now);
    return { accepted: false, usedBytes: budget.usedBytes };
  }
  if (
    budget.reservations.size >= MAX_REPLAY_BATCH_RESERVATIONS_PER_SESSION ||
    fallbackReservationCount >= MAX_FALLBACK_REPLAY_RESERVATIONS
  ) {
    if (fallbackBudgets.has(key)) touchFallback(key, budget, now);
    throw new ReplayBudgetUnavailableError();
  }

  budget.usedBytes += bytes;
  budget.reservations.set(fingerprint, { bytes, attempts: 1 });
  fallbackReservationCount++;
  touchFallback(key, budget, now);
  return { accepted: true, usedBytes: budget.usedBytes };
}

/**
 * Charge a replay batch against its session's byte budget. Returns whether the
 * batch may be stored. The cap counts unique captured payloads, not retries:
 * an accepted batch may have been written even if storage returned an error.
 * No refund is safe in that case, and no exactly-once storage is promised.
 * Healthy shared Redis allows at most three storage attempts per fingerprint:
 * up to two duplicate payload copies, or 3 * (cap + crossing-batch bytes) in
 * attempted payloads. This is not a physical-disk bound (metadata, compression
 * and R2 fallback also cost space). Redis outages remain per-worker.
 */
export async function chargeReplaySessionBudget(
  siteId: number,
  sessionId: string,
  bytes: number,
  fingerprint: string,
  capBytes: number = REPLAY_MAX_BYTES_PER_SESSION
): Promise<ReplayBudgetDecision> {
  if (capBytes <= 0) {
    return { accepted: true, usedBytes: 0 };
  }

  const key = `replay:budget:${siteId}:${sessionId}`;
  const now = Date.now();
  expireFallback(now);
  let decision: BudgetReservation;

  // A reservation made during this worker's Redis outage stays retryable on
  // that worker after recovery, even if Redis already reports a full budget.
  if (fallbackBudgets.get(key)?.reservations.has(fingerprint)) {
    decision = chargeFallback(key, fingerprint, bytes, capBytes, now);
  } else if (replayBudgetRedis.status !== "ready") {
    decision = chargeFallback(key, fingerprint, bytes, capBytes, now);
  } else {
    try {
      decision = await replayBudgetCharge(
        key,
        fingerprint,
        bytes,
        capBytes,
        BUDGET_TTL_MS,
        MAX_REPLAY_BATCH_RESERVATIONS_PER_SESSION,
        MAX_REPLAY_BATCH_STORAGE_ATTEMPTS
      );
    } catch (error) {
      logger.error(error as Error, "Replay budget lookup failed; using in-process fallback");
      decision = chargeFallback(key, fingerprint, bytes, capBytes, now);
    }
  }

  // Redis capacity/state loss is not a transport outage and must not open a
  // fresh fallback allowance or turn a possibly accepted retry into a cap.
  if (decision.unavailable) throw new ReplayBudgetUnavailableError();

  // Only the batch that crosses the cap is both accepted and at/over it, so this
  // logs once per capped session rather than once per refused batch.
  if (decision.accepted && !decision.reused && decision.usedBytes >= capBytes) {
    logger.warn({ siteId, sessionId, usedBytes: decision.usedBytes, capBytes }, "Session replay reached its size cap");
  }

  return { accepted: decision.accepted, usedBytes: decision.usedBytes };
}

/** Test hook: forget all in-process fallback budgets. */
export function resetReplayBudgetFallback(): void {
  fallbackBudgets.clear();
  fallbackReservationCount = 0;
}
