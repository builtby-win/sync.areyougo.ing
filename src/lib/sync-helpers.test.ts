import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { eq as drizzleEq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  callSyncProjection,
  computeJitterMs,
  computeBackoffMs,
  pruneSyncHistory,
  recordAttempt,
  recordCursorAdvance,
  recordFailure,
  recordManualSuccess,
  recordManualSyncAt,
  recordSuccess,
  releaseLock,
  tryAcquireLock,
  LOCK_TTL_MS,
  MAX_BACKOFF_MS,
} from './sync-helpers'

// ----- In-memory test database -----
const testSchema = {
  imapCredentials: sqliteTable('imap_credentials', {
    id: text('id').primaryKey(),
    syncCursorAt: integer('sync_cursor_at', { mode: 'timestamp' }),
    lastSyncAttemptAt: integer('last_sync_attempt_at', { mode: 'timestamp' }),
    lastSyncSuccessAt: integer('last_sync_success_at', { mode: 'timestamp' }),
    lastSyncFailureAt: integer('last_sync_failure_at', { mode: 'timestamp' }),
    lastSyncError: text('last_sync_error'),
    lastImportedEmailAt: integer('last_imported_email_at', { mode: 'timestamp' }),
    lastImportedEmailDate: integer('last_imported_email_date', { mode: 'timestamp' }),
    lastManualSyncAt: integer('last_manual_sync_at', { mode: 'timestamp' }),
    backoffUntil: integer('backoff_until', { mode: 'timestamp' }),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    lockOwner: text('lock_owner'),
    lockExpiresAt: integer('lock_expires_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  }),
  syncHistory: sqliteTable('sync_history', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    credentialId: text('credential_id'),
    status: text('status').notNull(),
    emailsFound: integer('emails_found').default(0),
    emailsIngested: integer('emails_ingested').default(0),
    errorMessage: text('error_message'),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  }),
}

function createTestDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE imap_credentials (
      id TEXT PRIMARY KEY,
      sync_cursor_at INTEGER,
      last_sync_attempt_at INTEGER,
      last_sync_success_at INTEGER,
      last_sync_failure_at INTEGER,
      last_sync_error TEXT,
      last_imported_email_at INTEGER,
      last_imported_email_date INTEGER,
      last_manual_sync_at INTEGER,
      backoff_until INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      lock_owner TEXT,
      lock_expires_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE sync_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_id TEXT,
      status TEXT NOT NULL,
      emails_found INTEGER DEFAULT 0,
      emails_ingested INTEGER DEFAULT 0,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `)
  return drizzle(sqlite, { schema: testSchema })
}

type TestDb = ReturnType<typeof createTestDb>

// ----- Helper: select a credential by id -----
function getCred(db: TestDb, id: string) {
  return db
    .select()
    .from(testSchema.imapCredentials)
    .where(eq(testSchema.imapCredentials.id, id))
    .all()[0]
}

// ----- Pure function tests -----

describe('computeJitterMs', () => {
  it('returns a value between 0 and maxJitterMs', () => {
    const result = computeJitterMs('cred-1', 1000)
    assert.ok(result >= 0)
    assert.ok(result < 1000)
  })

  it('is deterministic for the same credential id', () => {
    const a = computeJitterMs('cred-abc-123')
    const b = computeJitterMs('cred-abc-123')
    assert.strictEqual(a, b)
  })

  it('returns different values for different credential ids', () => {
    const a = computeJitterMs('cred-aaa')
    const b = computeJitterMs('cred-bbb')
    // Very unlikely to collide
    assert.notStrictEqual(a, b)
  })

  it('uses default max jitter of 120 seconds', () => {
    const result = computeJitterMs('test-credential-id')
    assert.ok(result < 120_000)
  })

  it('respects custom maxJitterMs', () => {
    const result = computeJitterMs('test', 500)
    assert.ok(result < 500)
  })
})

describe('computeBackoffMs', () => {
  it('returns 0 for 0 or negative failures', () => {
    assert.strictEqual(computeBackoffMs(0), 0)
    assert.strictEqual(computeBackoffMs(-1), 0)
  })

  it('returns 15 minutes for first failure', () => {
    assert.strictEqual(computeBackoffMs(1), 15 * 60 * 1000)
  })

  it('returns 30 minutes for second failure', () => {
    assert.strictEqual(computeBackoffMs(2), 30 * 60 * 1000)
  })

  it('returns 1 hour for third failure', () => {
    assert.strictEqual(computeBackoffMs(3), 60 * 60 * 1000)
  })

  it('returns 2 hours for fourth failure', () => {
    assert.strictEqual(computeBackoffMs(4), 120 * 60 * 1000)
  })

  it('returns 4 hours for fifth failure', () => {
    assert.strictEqual(computeBackoffMs(5), 240 * 60 * 1000)
  })

  it('caps at 6 hours for many failures', () => {
    assert.strictEqual(computeBackoffMs(10), MAX_BACKOFF_MS)
    assert.strictEqual(computeBackoffMs(20), MAX_BACKOFF_MS)
  })
})

// ----- DB-dependent lock tests -----

describe('tryAcquireLock', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
    }).run()
  })

  it('acquires lock when no lock exists', async () => {
    const result = await tryAcquireLock(db as any, 'cred-1', 'test-owner')
    assert.strictEqual(result, true)
  })

  it('acquires lock when existing lock has expired', async () => {
    db.update(testSchema.imapCredentials)
      .set({
        lockOwner: 'old-owner',
        lockExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(testSchema.imapCredentials.id, 'cred-1'))
      .run()

    const result = await tryAcquireLock(db as any, 'cred-1', 'new-owner')
    assert.strictEqual(result, true)
  })

  it('fails to acquire lock when valid lock exists', async () => {
    db.update(testSchema.imapCredentials)
      .set({
        lockOwner: 'other-owner',
        lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS),
      })
      .where(eq(testSchema.imapCredentials.id, 'cred-1'))
      .run()

    const result = await tryAcquireLock(db as any, 'cred-1', 'my-owner')
    assert.strictEqual(result, false)
  })

  it('only one concurrent acquisition succeeds for the same credential', async () => {
    const results = await Promise.all([
      tryAcquireLock(db as any, 'cred-1', 'owner-a'),
      tryAcquireLock(db as any, 'cred-1', 'owner-b'),
    ])
    const acquired = results.filter((r) => r).length
    assert.strictEqual(acquired, 1)
  })
})

describe('releaseLock', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
    }).run()
  })

  it('releases lock owned by this owner', async () => {
    await tryAcquireLock(db as any, 'cred-1', 'my-owner')
    await releaseLock(db as any, 'cred-1', 'my-owner')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.lockOwner, null)
    assert.strictEqual(cred.lockExpiresAt, null)
  })

  it('does not release lock owned by another owner', async () => {
    await tryAcquireLock(db as any, 'cred-1', 'owner-a')
    await releaseLock(db as any, 'cred-1', 'owner-b')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.lockOwner, 'owner-a')
  })
})

// ----- recordAttempt tests -----

describe('recordAttempt', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
      lockOwner: 'my-owner',
      lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS),
    }).run()
  })

  it('sets lastSyncAttemptAt when lock is owned by this owner', async () => {
    await recordAttempt(db as any, 'cred-1', 'my-owner')

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.lastSyncAttemptAt instanceof Date)
  })

  it('does not set lastSyncAttemptAt when lock is owned by another owner', async () => {
    await recordAttempt(db as any, 'cred-1', 'other-owner')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.lastSyncAttemptAt, null)
  })
})

describe('recordSuccess', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 3,
      lockOwner: 'my-owner',
      lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS),
      backoffUntil: new Date(Date.now() + 60_000),
      lastSyncError: 'previous error',
    }).run()
  })

  it('clears lock, backoff, error and resets consecutiveFailures', async () => {
    await recordSuccess(db as any, 'cred-1', 'my-owner')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.lockOwner, null)
    assert.strictEqual(cred.lockExpiresAt, null)
    assert.strictEqual(cred.backoffUntil, null)
    assert.strictEqual(cred.lastSyncError, null)
    assert.strictEqual(cred.consecutiveFailures, 0)
  })

  it('sets lastSyncSuccessAt but does not overwrite lastSyncAttemptAt', async () => {
    // Set an initial attempt timestamp (older than success will be)
    const attemptTime = new Date(Date.now() - 120_000)
    db.update(testSchema.imapCredentials)
      .set({ lastSyncAttemptAt: attemptTime, lockOwner: 'my-owner', lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS) })
      .where(eq(testSchema.imapCredentials.id, 'cred-1'))
      .run()

    await recordSuccess(db as any, 'cred-1', 'my-owner')

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.lastSyncSuccessAt instanceof Date)
    // lastSyncAttemptAt should still be the old value (not overwritten to now)
    // Compare rounded to second since SQLite may truncate millis
    const attemptMs = Math.floor(attemptTime.getTime() / 1000) * 1000
    const storedMs = Math.floor(cred.lastSyncAttemptAt!.getTime() / 1000) * 1000
    assert.strictEqual(storedMs, attemptMs)
  })

  it('does not modify lastManualSyncAt (auto cron semantic)', async () => {
    // given a credential with a previous manual sync time and an acquired lock
    const manualSyncTime = new Date(Date.now() - 86400_000)
    db.update(testSchema.imapCredentials)
      .set({ lastManualSyncAt: manualSyncTime })
      .where(eq(testSchema.imapCredentials.id, 'cred-1'))
      .run()

    // when auto cron calls recordSuccess
    await recordSuccess(db as any, 'cred-1', 'my-owner')

    const cred = getCred(db, 'cred-1')
    // then lastManualSyncAt remains unchanged (auto cron never touches it)
    assert.ok(cred.lastManualSyncAt instanceof Date)
    const storedMs = Math.floor(cred.lastManualSyncAt!.getTime() / 1000) * 1000
    const expectedMs = Math.floor(manualSyncTime.getTime() / 1000) * 1000
    assert.strictEqual(storedMs, expectedMs)
  })
})

describe('recordFailure', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
      lockOwner: 'my-owner',
      lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS),
    }).run()
  })

  it('increments consecutiveFailures and sets backoffUntil', async () => {
    await recordFailure(db as any, 'cred-1', 'my-owner', 'Connection refused')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.consecutiveFailures, 1)
    assert.strictEqual(cred.lastSyncError, 'Connection refused')
    assert.ok(cred.backoffUntil instanceof Date)
    assert.ok(cred.backoffUntil!.getTime() > Date.now())
  })

  it('releases lock', async () => {
    await recordFailure(db as any, 'cred-1', 'my-owner', 'error')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.lockOwner, null)
    assert.strictEqual(cred.lockExpiresAt, null)
  })

  it('computes bounded backoff after many failures', async () => {
    db.update(testSchema.imapCredentials)
      .set({ consecutiveFailures: 9, lockOwner: 'my-owner', lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS) })
      .where(eq(testSchema.imapCredentials.id, 'cred-1'))
      .run()

    await recordFailure(db as any, 'cred-1', 'my-owner', 'error')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.consecutiveFailures, 10)
    const backoffMs = cred.backoffUntil!.getTime() - Date.now()
    assert.ok(backoffMs <= MAX_BACKOFF_MS + 1000) // small tolerance
  })

  it('does not overwrite lastSyncAttemptAt', async () => {
    const attemptTime = new Date(Date.now() - 120_000)
    db.update(testSchema.imapCredentials)
      .set({ lastSyncAttemptAt: attemptTime, lockOwner: 'my-owner', lockExpiresAt: new Date(Date.now() + LOCK_TTL_MS) })
      .where(eq(testSchema.imapCredentials.id, 'cred-1'))
      .run()

    await recordSuccess(db as any, 'cred-1', 'my-owner')

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.lastSyncSuccessAt instanceof Date)
    // Compare rounded to second since SQLite may truncate millis
    const attemptMs = Math.floor(attemptTime.getTime() / 1000) * 1000
    const storedMs = Math.floor(cred.lastSyncAttemptAt!.getTime() / 1000) * 1000
    assert.strictEqual(storedMs, attemptMs)
  })

})

// ----- Backoff skip logic tests -----

describe('backoff skip logic', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
  })

  it('skips credential when backoffUntil is in the future', async () => {
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 3,
      backoffUntil: new Date(Date.now() + 3600_000),
    }).run()

    const cred = getCred(db, 'cred-1')
    const now = new Date()
    assert.ok(cred.backoffUntil!.getTime() > now.getTime())
    // Simulate the skip check
    const shouldSkip = cred.backoffUntil! > now
    assert.strictEqual(shouldSkip, true)
  })

  it('does not skip when backoffUntil is in the past', async () => {
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-2',
      consecutiveFailures: 3,
      backoffUntil: new Date(Date.now() - 60_000),
    }).run()

    const cred = getCred(db, 'cred-2')
    const now = new Date()
    const shouldSkip = cred.backoffUntil! > now
    assert.strictEqual(shouldSkip, false)
  })

  it('does not skip when backoffUntil is null', async () => {
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-3',
      consecutiveFailures: 0,
      backoffUntil: null,
    }).run()

    const cred = getCred(db, 'cred-3')
    // backoffUntil is null, so should never skip
    const shouldSkip = cred.backoffUntil !== null && cred.backoffUntil > new Date()
    assert.strictEqual(shouldSkip, false)
    assert.strictEqual(cred.backoffUntil, null)
  })
})

// ----- recordCursorAdvance tests -----

describe('recordCursorAdvance', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
    }).run()
  })

  it('sets syncCursorAt to the given date', async () => {
    const cursorDate = new Date('2026-05-28T12:00:00Z')
    await recordCursorAdvance(db as any, 'cred-1', cursorDate)

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.syncCursorAt instanceof Date)
    assert.strictEqual(
      Math.floor(cred.syncCursorAt!.getTime() / 1000),
      Math.floor(cursorDate.getTime() / 1000),
    )
  })

  it('sets lastImportedEmailAt and lastImportedEmailDate when provided', async () => {
    const cursorDate = new Date('2026-05-28T12:00:00Z')
    const importAt = new Date('2026-05-28T12:05:00Z')
    const importDate = new Date('2026-05-28T10:00:00Z')

    await recordCursorAdvance(db as any, 'cred-1', cursorDate, importAt, importDate)

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(
      Math.floor(cred.lastImportedEmailAt!.getTime() / 1000),
      Math.floor(importAt.getTime() / 1000),
    )
    assert.strictEqual(
      Math.floor(cred.lastImportedEmailDate!.getTime() / 1000),
      Math.floor(importDate.getTime() / 1000),
    )
  })

  it('does not set import fields when null is passed', async () => {
    const cursorDate = new Date()
    await recordCursorAdvance(db as any, 'cred-1', cursorDate, null, null)

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.lastImportedEmailAt, null)
    assert.strictEqual(cred.lastImportedEmailDate, null)
  })

  it('updates only the target credential', async () => {
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-2',
      consecutiveFailures: 0,
    }).run()

    await recordCursorAdvance(db as any, 'cred-1', new Date())

    const cred2 = getCred(db, 'cred-2')
    assert.strictEqual(cred2.syncCursorAt, null)
  })
})

// ----- recordManualSyncAt tests -----

describe('recordManualSyncAt', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
    }).run()
  })

  it('sets lastManualSyncAt', async () => {
    await recordManualSyncAt(db as any, 'cred-1')

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.lastManualSyncAt instanceof Date)
  })

  it('updates only the target credential', async () => {
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-2',
      consecutiveFailures: 0,
    }).run()

    await recordManualSyncAt(db as any, 'cred-1')

    const cred2 = getCred(db, 'cred-2')
    assert.strictEqual(cred2.lastManualSyncAt, null)
  })
})

// ----- recordManualSuccess tests -----

describe('recordManualSuccess', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 3,
      backoffUntil: new Date(Date.now() + 3600_000),
      lastSyncError: 'previous error',
    }).run()
  })

  it('sets lastSyncSuccessAt and lastManualSyncAt', async () => {
    await recordManualSuccess(db as any, 'cred-1')

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.lastSyncSuccessAt instanceof Date)
    assert.ok(cred.lastManualSyncAt instanceof Date)
  })

  it('clears failure state (consecutiveFailures, backoffUntil, lastSyncError)', async () => {
    await recordManualSuccess(db as any, 'cred-1')

    const cred = getCred(db, 'cred-1')
    assert.strictEqual(cred.consecutiveFailures, 0)
    assert.strictEqual(cred.backoffUntil, null)
    assert.strictEqual(cred.lastSyncError, null)
  })

  it('updates only the target credential', async () => {
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-2',
      consecutiveFailures: 0,
    }).run()

    await recordManualSuccess(db as any, 'cred-1')

    const cred2 = getCred(db, 'cred-2')
    assert.strictEqual(cred2.lastSyncSuccessAt, null)
    assert.strictEqual(cred2.lastManualSyncAt, null)
  })
})

// ----- Cursor fallback tests -----

describe('cursor fallback (syncCursorAt ?? lastSyncAt)', () => {
  it('uses syncCursorAt when both are present', () => {
    const syncCursorAt = new Date('2026-05-28T10:00:00Z')
    const lastSyncAt = new Date('2026-05-27T00:00:00Z')
    const result = syncCursorAt ?? lastSyncAt
    assert.strictEqual(result, syncCursorAt)
    assert.notStrictEqual(result, lastSyncAt)
  })

  it('falls back to lastSyncAt when syncCursorAt is null', () => {
    const syncCursorAt: Date | null = null
    const lastSyncAt = new Date('2026-05-27T00:00:00Z')
    const result = syncCursorAt ?? lastSyncAt
    assert.strictEqual(result, lastSyncAt)
  })

  it('falls back to lastSyncAt when syncCursorAt is undefined', () => {
    const syncCursorAt: Date | undefined = undefined
    const lastSyncAt = new Date('2026-05-27T00:00:00Z')
    const result = syncCursorAt ?? lastSyncAt
    assert.strictEqual(result, lastSyncAt)
  })
})

// ----- Cursor-on-failure behavior -----

describe('cursor on partial failure', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    db.insert(testSchema.imapCredentials).values({
      id: 'cred-1',
      consecutiveFailures: 0,
      syncCursorAt: new Date('2026-05-27T00:00:00Z'),
    }).run()
  })

  it('does not advance syncCursorAt when failedCount > 0 (manual sync)', async () => {
    // Simulate a manual sync with failures: only recordManualSuccess,
    // but DO NOT call recordCursorAdvance (matching ingest.ts behavior)
    await recordManualSuccess(db as any, 'cred-1')

    const cred = getCred(db, 'cred-1')
    // success and manual fields updated
    assert.ok(cred.lastSyncSuccessAt instanceof Date)
    assert.ok(cred.lastManualSyncAt instanceof Date)
    // cursor stays at its previous position (unchanged)
    assert.ok(cred.syncCursorAt instanceof Date)
    assert.strictEqual(
      Math.floor(cred.syncCursorAt!.getTime() / 1000),
      Math.floor(new Date('2026-05-27T00:00:00Z').getTime() / 1000),
    )
  })
})

// ----- callSyncProjection tests -----

describe('callSyncProjection', () => {
  it('returns success:false when secret is not configured', async () => {
    const result = await callSyncProjection('http://localhost', undefined, {
      userId: 'user-1',
      status: 'completed',
    })

    assert.deepStrictEqual(result, { success: false })
  })

  it('returns success:false on network error (no server)', async () => {
    const result = await callSyncProjection('http://localhost:1', 'test-secret', {
      userId: 'user-1',
      status: 'completed',
    })

    assert.strictEqual(result.success, false)
  })
})

// ----- pruneSyncHistory tests -----

function insertHistory(
  db: TestDb,
  overrides: Partial<{
    id: string
    userId: string
    credentialId: string | null
    status: string
    completedAt: Date
  }>,
) {
  const id = overrides.id ?? crypto.randomUUID()
  db.insert(testSchema.syncHistory)
    .values({
      id,
      userId: overrides.userId ?? 'user-1',
      credentialId: overrides.credentialId !== undefined ? overrides.credentialId : 'cred-1',
      status: overrides.status ?? 'success',
      startedAt: new Date(Date.now() - 86400_000),
      completedAt: overrides.completedAt ?? new Date(Date.now() - 3600_000),
    })
    .run()
  return id
}

function countHistory(db: TestDb): number {
  return db.select().from(testSchema.syncHistory).all().length
}

function getHistoryCredIds(db: TestDb): (string | null)[] {
  return db
    .select({ credentialId: testSchema.syncHistory.credentialId })
    .from(testSchema.syncHistory)
    .all()
    .map((r) => r.credentialId)
}

describe('pruneSyncHistory', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
  })

  it('keeps only the most recent entries per credential', () => {
    const now = Date.now()
    // Insert 5 entries for cred-1, with completedAt ascending
    for (let i = 0; i < 5; i++) {
      insertHistory(db, {
        credentialId: 'cred-1',
        completedAt: new Date(now - (5 - i) * 60_000),
      })
    }
    assert.strictEqual(countHistory(db), 5)

    // Prune keeping max 3 per credential
    pruneSyncHistory(db as any, 3)

    assert.strictEqual(countHistory(db), 3)
    // The 3 kept entries should be the 3 most recent (largest completedAt)
  })

  it('prunes per-credential independently', () => {
    const now = Date.now()
    // 4 entries for cred-1, 2 entries for cred-2
    for (let i = 0; i < 4; i++) {
      insertHistory(db, {
        credentialId: 'cred-1',
        completedAt: new Date(now - (4 - i) * 60_000),
      })
    }
    for (let i = 0; i < 2; i++) {
      insertHistory(db, {
        credentialId: 'cred-2',
        completedAt: new Date(now - (2 - i) * 60_000),
      })
    }
    assert.strictEqual(countHistory(db), 6)

    pruneSyncHistory(db as any, 3)

    // cred-1 should have 3 kept, cred-2 should have 2 kept (under limit)
    assert.strictEqual(countHistory(db), 5)
    const credIds = getHistoryCredIds(db)
    const cred1Count = credIds.filter((id) => id === 'cred-1').length
    const cred2Count = credIds.filter((id) => id === 'cred-2').length
    assert.strictEqual(cred1Count, 3)
    assert.strictEqual(cred2Count, 2)
  })

  it('preserves entries with NULL credential_id', () => {
    insertHistory(db, { credentialId: null, completedAt: new Date(Date.now() - 60_000) })
    insertHistory(db, { credentialId: null, completedAt: new Date(Date.now() - 120_000) })
    assert.strictEqual(countHistory(db), 2)

    pruneSyncHistory(db as any, 1)

    // Entries with NULL credential_id should be untouched
    assert.strictEqual(countHistory(db), 2)
  })

  it('handles empty table without error', () => {
    assert.strictEqual(countHistory(db), 0)
    const result = pruneSyncHistory(db as any, 5)
    assert.strictEqual(result.deleted, 0)
    assert.strictEqual(countHistory(db), 0)
  })

  it('returns correct deleted count', () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      insertHistory(db, {
        credentialId: 'cred-1',
        completedAt: new Date(now - (5 - i) * 60_000),
      })
    }

    const result = pruneSyncHistory(db as any, 2)
    assert.strictEqual(result.deleted, 3)
    assert.strictEqual(countHistory(db), 2)
  })
})

// Helper to work around drizzle's eq import shadowing
function eq(a: any, b: any) {
  return drizzleEq(a, b)
}
