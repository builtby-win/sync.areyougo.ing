import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export interface Env {
  DB: D1Database
  ENCRYPTION_KEY: string
  MAIN_APP_URL: string
  INGEST_API_KEY?: string
}

export function getDb(env: Env) {
  return drizzle(env.DB, { schema })
}

export type Database = ReturnType<typeof getDb>
