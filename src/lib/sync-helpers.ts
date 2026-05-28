/**
 * Helper functions for per-credential sync locking, backoff, and jitter.
 *
 * Lock model: optimistic lease via `lockOwner` and `lockExpiresAt` columns.
 * Lock acquire is a single conditional UPDATE — atomic without transactions.
 * Backoff: bounded exponential (15m, 30m, 1h, 2h, 4h, max 6h).
 * Jitter: deterministic hash of credential id, 0–120s.
 */

import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { DatabaseType } from './db'
import { imapCredentials } from './schema'

export const LOCK_TTL_MS = 20 * 60 * 1000 // 20 minutes
export const DEFAULT_MAX_JITTER_MS = 120_000 // 120 seconds (2 minutes)
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Deterministic jitter computed from a credential id string.
 * Returns a value between 0 and maxJitterMs.
 * The hash is a simple djb2-style string hash that is stable
 * across restarts and instances for the same credential id.
 */
export function computeJitterMs(credentialId: string, maxJitterMs = DEFAULT_MAX_JITTER_MS): number {
  let hash = 0
  for (let i = 0; i < credentialId.length; i++) {
    hash = ((hash << 5) - hash) + credentialId.charCodeAt(i)
  }
  return Math.abs(hash) % maxJitterMs
}

/**
 * Compute bounded exponential backoff delay for a given number of consecutive failures.
 *
 * Sequence: 15m, 30m, 1h, 2h, 4h, ... capped at MAX_BACKOFF_MS (6h).
 */
export function computeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0
  const base = 15 * 60 * 1000 // 15 minutes
  const backoff = base * Math.pow(2, consecutiveFailures - 1)
  return Math.min(backoff, MAX_BACKOFF_MS)
}

/**
 * Atomically acquire a per-credential lock.
 *
 * The update only succeeds when the credential has no lock or the existing
 * lock has expired. Returns true if the lock was acquired, false if
 * another owner holds a valid (non-expired) lock.
 */
export async function tryAcquireLock(
  db: DatabaseType,
  credentialId: string,
  lockOwner: string,
  lockTtlMs = LOCK_TTL_MS,
): Promise<boolean> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + lockTtlMs)

  const result: { changes: number } = await db
    .update(imapCredentials)
    .set({
      lockOwner,
      lockExpiresAt: expiresAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(imapCredentials.id, credentialId),
        or(
          isNull(imapCredentials.lockExpiresAt),
          lt(imapCredentials.lockExpiresAt, now),
        ),
      ),
    )

  return Number(result.changes) > 0
}

/**
 * Release the lock only if it is owned by the given lockOwner identity.
 * Uses a conditional update to avoid stealing another owner's lock.
 */
export async function releaseLock(
  db: DatabaseType,
  credentialId: string,
  lockOwner: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(imapCredentials)
    .set({
      lockOwner: null,
      lockExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(imapCredentials.id, credentialId),
        eq(imapCredentials.lockOwner, lockOwner),
      ),
    )
}

/**
 * Record a sync attempt start, setting lastSyncAttemptAt.
 *
 * This is called immediately after lock acquisition (before jitter/IMAP work)
 * so the attempt timestamp reflects the real start time regardless of
 * how long the subsequent work takes.
 *
 * Only succeeds if the lock is still owned by the caller (safe against
 * lock steal across instances).
 */
export async function recordAttempt(
  db: DatabaseType,
  credentialId: string,
  lockOwner: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(imapCredentials)
    .set({
      lastSyncAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(imapCredentials.id, credentialId),
        eq(imapCredentials.lockOwner, lockOwner),
      ),
    )
}

/**
 * Record a successful sync outcome.
 *
 * Clears lock, backoff, and error fields; resets consecutiveFailures;
 * sets lastSyncSuccessAt. lastSyncAttemptAt is already set by recordAttempt
 * at the start of the sync attempt.
 */
export async function recordSuccess(
  db: DatabaseType,
  credentialId: string,
  lockOwner: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(imapCredentials)
    .set({
      lockOwner: null,
      lockExpiresAt: null,
      backoffUntil: null,
      lastSyncError: null,
      consecutiveFailures: 0,
      lastSyncSuccessAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(imapCredentials.id, credentialId),
        eq(imapCredentials.lockOwner, lockOwner),
      ),
    )
}

/**
 * Record a sync failure.
 *
 * Increments consecutiveFailures, computes bounded backoffUntil,
 * sets lastSyncFailureAt and lastSyncError, and releases the lock.
 * lastSyncAttemptAt is already set by recordAttempt at the start.
 */
export async function recordFailure(
  db: DatabaseType,
  credentialId: string,
  lockOwner: string,
  errorMessage: string,
): Promise<void> {
  const now = new Date()

  // Read current consecutiveFailures to compute next backoff
  const current = await db
    .select({ consecutiveFailures: imapCredentials.consecutiveFailures })
    .from(imapCredentials)
    .where(eq(imapCredentials.id, credentialId))
    .limit(1)

  const currentFailures = current[0]?.consecutiveFailures ?? 0
  const nextFailures = currentFailures + 1
  const backoffMs = computeBackoffMs(nextFailures)
  const backoffUntil = new Date(now.getTime() + backoffMs)

  await db
    .update(imapCredentials)
    .set({
      lastSyncFailureAt: now,
      lastSyncError: errorMessage,
      backoffUntil,
      consecutiveFailures: nextFailures,
      lockOwner: null,
      lockExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(imapCredentials.id, credentialId),
        eq(imapCredentials.lockOwner, lockOwner),
      ),
    )
}
