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

/**
 * Advance the IMAP cursor (syncCursorAt) after a sync run that
 * completed with no failed selected emails.
 *
 * The cursor is set to the time the sync completed, so the next
 * incremental fetch uses this as the SINCE date. Advances even on
 * zero-result checks to avoid re-scanning the same mailbox range.
 * On partial failure the caller should NOT call this helper so the
 * cursor stays at its previous position.
 *
 * Also updates lastImportedEmailAt and lastImportedEmailDate when
 * new emails were actually ingested during this sync run. The
 * lastImportedEmailAt field records *when* the newest email was
 * ingested (system clock), while lastImportedEmailDate records the
 * email's Date header value.
 *
 * No lock ownership required — cursor/import updates are informational
 * and not part of the concurrency-protected critical section.
 */
export async function recordCursorAdvance(
  db: DatabaseType,
  credentialId: string,
  cursorDate: Date,
  importedEmailAt?: Date | null,
  importedEmailDate?: Date | null,
): Promise<void> {
  const now = new Date()
  const updates: Record<string, unknown> = {
    syncCursorAt: cursorDate,
    updatedAt: now,
  }
  if (importedEmailAt) updates.lastImportedEmailAt = importedEmailAt
  if (importedEmailDate) updates.lastImportedEmailDate = importedEmailDate

  await db
    .update(imapCredentials)
    .set(updates)
    .where(eq(imapCredentials.id, credentialId))
}

/**
 * Update lastManualSyncAt after a manual sync completes.
 *
 * No lock ownership required — this is called at the end of a
 * user-initiated manual sync flow (not from auto cron).
 */
export async function recordManualSyncAt(
  db: DatabaseType,
  credentialId: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(imapCredentials)
    .set({
      lastManualSyncAt: now,
      updatedAt: now,
    })
    .where(eq(imapCredentials.id, credentialId))
}

/**
 * Record a successful manual sync: sets lastSyncSuccessAt and
 * lastManualSyncAt, clears failure/backoff state, and resets
 * consecutiveFailures.
 *
 * Unlike recordSuccess (which requires lock ownership for the
 * auto-cron lock model), this helper is for the user-initiated
 * manual sync path which does not use locks.
 */
export async function recordManualSuccess(
  db: DatabaseType,
  credentialId: string,
): Promise<void> {
  const now = new Date()
  await db
    .update(imapCredentials)
    .set({
      lastSyncSuccessAt: now,
      lastManualSyncAt: now,
      consecutiveFailures: 0,
      backoffUntil: null,
      lastSyncError: null,
      updatedAt: now,
    })
    .where(eq(imapCredentials.id, credentialId))
}

/**
 * SyncProjectionPayload — matches the main app's SyncProjectionBodySchema.
 */
export interface SyncProjectionPayload {
  userId: string
  status: 'completed' | 'failed'
  metadata?: {
    mode?: string
    credentialId?: string
    recipientEmail?: string
    emailsFound?: number
    emailsImported?: number
    emailsSkipped?: number
    emailsFailed?: number
    lastImportedEmailAt?: number
    lastImportedEmailDate?: number
    errorCode?: string
    errorMessage?: string
  }
  errorMessage?: string
}

/**
 * POST a sync-projection event to the main app.
 *
 * This is called after every sync run (auto or manual) so the main app
 * can track sync state via user_actions. Returns the parsed response
 * body. Logs a warning and returns {success: false} when the secret is
 * not configured or the call fails — never throws.
 */
export async function callSyncProjection(
  mainAppUrl: string,
  projectionSecret: string | undefined,
  body: SyncProjectionPayload,
): Promise<{ success: boolean; actionId?: string }> {
  if (!projectionSecret) {
    console.warn('[sync-projection] SYNC_PROJECTION_SECRET not configured, skipping')
    return { success: false }
  }

  try {
    const response = await fetch(`${mainAppUrl}/api/user-action/sync-projection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${projectionSecret}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`[sync-projection] HTTP ${response.status}:`, text)
      return { success: false }
    }

    return (await response.json()) as { success: boolean; actionId?: string }
  } catch (error) {
    console.error('[sync-projection] Network error:', error)
    return { success: false }
  }
}
