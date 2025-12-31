/**
 * Production entry point that starts cron jobs and the Astro server.
 */

import { startCronJobs } from './cron'

// Start cron jobs
startCronJobs()

// Import and start the Astro server
console.log('[server] Starting Astro server...')
import('../dist/server/entry.mjs')
  .then(() => {
    console.log('[server] Astro server started successfully')
  })
  .catch((error: unknown) => {
    console.error('[server] Failed to start Astro server:', error)
    process.exit(1)
  })
