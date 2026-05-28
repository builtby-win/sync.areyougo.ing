import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { eq as drizzleEq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  computeJitterMs,
  computeBackoffMs,
  tryAcquireLock,
  releaseLock,
  recordAttempt,
  recordSuccess,
  recordFailure,
  LOCK_TTL_MS,
  MAX_BACKOFF_MS,
} from './sync-helpers'

// ----- In-memory test database -----
const testSchema = {
  imapCredentials: sqliteTable('imap_credentials', {
    id: text('id').primaryKey(),
    lockOwner: text('lock_owner'),
    lockExpiresAt: integer('lock_expires_at', { mode: 'timestamp' }),
    backoffUntil: integer('backoff_until', { mode: 'timestamp' }),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    lastSyncError: text('last_sync_error'),
    lastSyncAttemptAt: integer('last_sync_attempt_at', { mode: 'timestamp' }),
    lastSyncSuccessAt: integer('last_sync_success_at', { mode: 'timestamp' }),
    lastSyncFailureAt: integer('last_sync_failure_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  }),
}

function createTestDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE imap_credentials (
      id TEXT PRIMARY KEY,
      lock_owner TEXT,
      lock_expires_at INTEGER,
      backoff_until INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_sync_error TEXT,
      last_sync_attempt_at INTEGER,
      last_sync_success_at INTEGER,
      last_sync_failure_at INTEGER,
      updated_at INTEGER
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

    await recordFailure(db as any, 'cred-1', 'my-owner', 'IMAP auth failure')

    const cred = getCred(db, 'cred-1')
    assert.ok(cred.lastSyncFailureAt instanceof Date)
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

// Helper to work around drizzle's eq import shadowing
function eq(a: any, b: any) {
  return drizzleEq(a, b)
}
