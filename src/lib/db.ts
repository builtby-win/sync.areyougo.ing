import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'

// Database path from environment or default
const DB_PATH = process.env.DATABASE_PATH || './data/sync.db'

// Create database instance (lazy initialization)
let dbInstance: ReturnType<typeof drizzle> | null = null
let sqliteInstance: Database.Database | null = null

export function getDb() {
  if (!dbInstance) {
    // Ensure data directory exists
    const dir = dirname(DB_PATH)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    sqliteInstance = new Database(DB_PATH)
    // Enable WAL mode for better concurrent access
    sqliteInstance.pragma('journal_mode = WAL')
    dbInstance = drizzle(sqliteInstance, { schema })
  }
  return dbInstance
}

export function closeDb() {
  if (sqliteInstance) {
    sqliteInstance.close()
    sqliteInstance = null
    dbInstance = null
  }
}

export type DatabaseType = ReturnType<typeof getDb>
