import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// IMAP credentials for syncing ticket emails
export const imapCredentials = sqliteTable(
  'imap_credentials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(), // References user.id from main app
    userEmail: text('user_email').notNull(), // User's main email (for /api/ingest matching)
    provider: text('provider').notNull(), // 'icloud', 'yahoo', 'outlook', 'gmail', 'other'
    imapEmail: text('imap_email').notNull(), // Email for IMAP login (may differ from userEmail)
    host: text('host').notNull(),
    port: integer('port').notNull().default(993),
    encryptedPassword: text('encrypted_password').notNull(),
    iv: text('iv').notNull(), // AES-GCM initialization vector (base64)
    syncMode: text('sync_mode').notNull().default('manual'), // 'manual' or 'auto_daily'
    // DEPRECATED: legacy field used as both IMAP cursor and "last checked" timestamp.
    // Replaced by syncCursorAt (cursor) and lastSyncSuccessAt (check timestamp).
    // Kept for backward compatibility during migration; will be removed in a future iteration.
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }),
    lastManualSyncAt: integer('last_manual_sync_at', { mode: 'timestamp' }), // For rate limiting manual syncs

    // ---- Explicit sync-state fields (added 2026-05-27) ----
    /** IMAP incremental-fetch cursor. Updated only after a successful mailbox check/search. */
    syncCursorAt: integer('sync_cursor_at', { mode: 'timestamp' }),
    /** Updated when any manual or auto sync attempt begins. */
    lastSyncAttemptAt: integer('last_sync_attempt_at', { mode: 'timestamp' }),
    /** Updated when a sync check completes successfully, including zero-result checks. */
    lastSyncSuccessAt: integer('last_sync_success_at', { mode: 'timestamp' }),
    /** Updated when a sync check fails. */
    lastSyncFailureAt: integer('last_sync_failure_at', { mode: 'timestamp' }),
    /** Human-readable error summary from the most recent failure. */
    lastSyncError: text('last_sync_error'),
    /** Timestamp of the newest email ingested into the main app. */
    lastImportedEmailAt: integer('last_imported_email_at', { mode: 'timestamp' }),
    /** Actual email Date header value for the newest imported email. */
    lastImportedEmailDate: integer('last_imported_email_date', { mode: 'timestamp' }),
    /** If set, skip auto sync until this time (bounded exponential backoff). */
    backoffUntil: integer('backoff_until', { mode: 'timestamp' }),
    /** Consecutive sync failures counter, reset on success. */
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    /** Identity of the process/host holding the per-credential sync lock. */
    lockOwner: text('lock_owner'),
    /** When the current lock lease expires. Null if no lock held. */
    lockExpiresAt: integer('lock_expires_at', { mode: 'timestamp' }),
    // ---- end explicit sync-state fields ----

    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // Prevent duplicate IMAP accounts per user
    uniqueUserImapEmail: uniqueIndex('unique_user_imap_email').on(table.userId, table.imapEmail),
  }),
)

// Sync history for audit logging
export const syncHistory = sqliteTable('sync_history', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  credentialId: text('credential_id'), // Links to specific IMAP account
  status: text('status').notNull(), // 'success', 'error', 'partial'
  emailsFound: integer('emails_found').default(0),
  emailsIngested: integer('emails_ingested').default(0),
  errorMessage: text('error_message'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
})

// Type exports
export type ImapCredentials = typeof imapCredentials.$inferSelect
export type NewImapCredentials = typeof imapCredentials.$inferInsert
export type SyncHistory = typeof syncHistory.$inferSelect
export type NewSyncHistory = typeof syncHistory.$inferInsert
