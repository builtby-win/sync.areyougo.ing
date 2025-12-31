import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// IMAP credentials for syncing ticket emails
export const imapCredentials = sqliteTable('imap_credentials', {
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
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp' }), // Last successful sync (manual or auto)
  lastManualSyncAt: integer('last_manual_sync_at', { mode: 'timestamp' }), // For rate limiting manual syncs
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})

// Sync history for audit logging
export const syncHistory = sqliteTable('sync_history', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
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
