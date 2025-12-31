/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace NodeJS {
  interface ProcessEnv {
    DATABASE_PATH?: string
    ENCRYPTION_KEY: string
    MAIN_APP_URL?: string
    INGEST_API_KEY?: string
  }
}
