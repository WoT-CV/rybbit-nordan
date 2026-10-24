/**
 * Per-session replay byte budget, checked and charged in one atomic round trip.
 *
 * Previously accepted batches may retry without another charge, even at the
 * cap: a failed/uncertain storage response never refunds their reservation.
 * New batches are accepted while the session is below its cap. Fingerprints
 * are bounded; running out of reservation memory is retryable, not a size cap.
 * Both keys share a sliding TTL, refused calls included.
 *
 * KEYS[1] byte counter for one (site, session)
 * KEYS[2] hash of accepted fingerprints to "reservedBytes:acceptedAttempts"
 *
 * ARGV[1] server-computed batch fingerprint
 * ARGV[2] bytes in this batch
 * ARGV[3] cap in bytes
 * ARGV[4] TTL in milliseconds
 * ARGV[5] maximum accepted fingerprints per session
 * ARGV[6] maximum accepted storage attempts per fingerprint (initial included)
 *
 * Returns { outcome, usedBytes }: 1=new reservation, 2=retry, 0=capped,
 * -1=unavailable. A missing half of existing state must never cap an accepted
 * retry whose fingerprint may have been lost (eviction or an older server).
 */
export const REPLAY_BUDGET_LUA = `
local fingerprint = ARGV[1]
local bytes = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local maxReservations = tonumber(ARGV[5])
local maxAttempts = tonumber(ARGV[6])

local rawUsed = redis.call('GET', KEYS[1])
local hasReservations = redis.call('EXISTS', KEYS[2]) == 1
local used = tonumber(rawUsed or '0')
local function touch()
  redis.call('PEXPIRE', KEYS[1], ttlMs)
  redis.call('PEXPIRE', KEYS[2], ttlMs)
end

if (rawUsed and not hasReservations) or (not rawUsed and hasReservations) then
  touch()
  return { -1, used }
end

local reserved = redis.call('HGET', KEYS[2], fingerprint)
if reserved then
  touch()
  local reservedBytes, attempts = string.match(reserved, '^(%d+):(%d+)$')
  attempts = tonumber(attempts)
  if tonumber(reservedBytes) ~= bytes or not attempts or attempts >= maxAttempts then
    return { -1, used }
  end
  redis.call('HSET', KEYS[2], fingerprint, tostring(bytes) .. ':' .. tostring(attempts + 1))
  return { 2, used }
end

if used >= cap then
  touch()
  return { 0, used }
end

if redis.call('HLEN', KEYS[2]) >= maxReservations then
  touch()
  return { -1, used }
end

used = redis.call('INCRBY', KEYS[1], bytes)
redis.call('HSET', KEYS[2], fingerprint, tostring(bytes) .. ':1')
touch()
return { 1, used }
`;
