/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

type D1Database = import('@cloudflare/workers-types').D1Database

interface Env {
  DB: D1Database
  ENCRYPTION_KEY: string
  MAIN_APP_URL: string
  INGEST_API_KEY?: string
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>

declare namespace App {
  interface Locals extends Runtime {}
}
