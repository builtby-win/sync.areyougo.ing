/**
 * Database migration script.
 * Run this to apply schema changes to the SQLite database.
 */

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DB_PATH = process.env.DATABASE_PATH || './data/sync.db'
const MIGRATIONS_PATH = './drizzle/migrations'

async function runMigrations(): Promise<void> {
  console.log('[migrate] Starting database migrations...')
  console.log('[migrate] Database path:', DB_PATH)
  console.log('[migrate] Migrations path:', MIGRATIONS_PATH)

  // Ensure data directory exists
  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) {
    console.log('[migrate] Creating data directory:', dir)
    mkdirSync(dir, { recursive: true })
  }

  // Open database
  const sqlite = new Database(DB_PATH)
  sqlite.pragma('journal_mode = WAL')

  const db = drizzle(sqlite)

  // Run migrations
  console.log('[migrate] Running migrations...')
  migrate(db, { migrationsFolder: MIGRATIONS_PATH })

  console.log('[migrate] Migrations completed successfully')

  // Close database
  sqlite.close()
}

runMigrations()
  .then(() => {
    console.log('[migrate] Done')
    process.exit(0)
  })
  .catch((error) => {
    console.error('[migrate] Migration failed:', error)
    process.exit(1)
  })
