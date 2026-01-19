/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

// biome-ignore lint/style/noNamespace: This is the convention for Astro
declare namespace NodeJS {
  interface ProcessEnv {
    DATABASE_PATH?: string
    ENCRYPTION_KEY: string
    MAIN_APP_URL?: string
    INGEST_API_KEY?: string
  }
}
