/**
 * Production entry point that starts cron jobs and the Astro server.
 */

import { spawn } from 'node:child_process'
import { startCronJobs } from './cron'

// Ensure HOST and PORT are set for Astro
process.env.HOST = process.env.HOST || '0.0.0.0'
process.env.PORT = process.env.PORT || '4321'

// Start cron jobs
startCronJobs()

// Start the Astro server as a child process
console.log('[server] Starting Astro server...')
console.log(`[server] Server will listen on ${process.env.HOST}:${process.env.PORT}`)

const server = spawn('node', ['dist/server/entry.mjs'], {
  stdio: 'inherit',
  env: process.env,
})

server.on('error', (error) => {
  console.error('[server] Failed to start Astro server:', error)
  process.exit(1)
})

server.on('exit', (code) => {
  console.error('[server] Astro server exited with code:', code)
  process.exit(code || 1)
})

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  console.log('[server] Received SIGTERM, shutting down...')
  server.kill('SIGTERM')
})

process.on('SIGINT', () => {
  console.log('[server] Received SIGINT, shutting down...')
  server.kill('SIGINT')
})
