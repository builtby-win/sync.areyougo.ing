/**
 * Cron job handler for automated email syncing.
 * Runs every 15 minutes by default to fetch emails for users with auto-sync enabled.
 *
 * Per-credential safety:
 *   - Skip if credential is in backoff (backoffUntil > now)
 *   - Acquire lock atomically before work (single conditional UPDATE)
 *   - Release lock on success or failure
 *   - Deterministic jitter before IMAP connection to spread load
 */

import { eq } from 'drizzle-orm'
import cron from 'node-cron'
import { checkAlreadyIngested, computeEmailHash } from '../src/lib/dedup'
import { getDb } from '../src/lib/db'
import { shouldProcessEmail } from '../src/lib/email-filter'
import { buildIngestPayload } from '../src/lib/ingest'
import { fetchTicketEmails } from '../src/lib/imap-client'
import { imapCredentials, syncHistory } from '../src/lib/schema'
import {
  callSyncProjection,
  computeJitterMs,
  recordAttempt,
  recordCursorAdvance,
  recordFailure,
  recordSuccess,
  tryAcquireLock,
} from '../src/lib/sync-helpers'

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/15 * * * *' // Every 15 minutes

export function getCronSchedule(): string {
  return CRON_SCHEDULE
}

// Unique identity for this process instance (used for lock ownership)
const LOCK_OWNER = `cron-${crypto.randomUUID().slice(0, 8)}`

function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from.trim()
}

async function runSync(): Promise<void> {
  console.log('[cron] Scheduled sync started at:', new Date().toISOString())
  console.log(`[cron] Lock owner identity: ${LOCK_OWNER}`)

  const encryptionKey = process.env.ENCRYPTION_KEY
  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'
  const ingestApiKey = process.env.INGEST_API_KEY

  if (!encryptionKey) {
    console.error('[cron] ENCRYPTION_KEY not configured, skipping sync')
    return
  }

  const db = getDb()

  // Get only users with auto-sync enabled
  const credentials = await db
    .select()
    .from(imapCredentials)
    .where(eq(imapCredentials.syncMode, 'auto_daily'))

  console.log(`[cron] Found ${credentials.length} accounts to sync`)

  for (const cred of credentials) {
    // --- Step 1: Check backoff ---
    if (cred.backoffUntil && cred.backoffUntil > new Date()) {
      console.log(
        `[cron] Skipping ${cred.imapEmail} — in backoff until ${cred.backoffUntil.toISOString()}`,
      )
      continue
    }

    // --- Step 2: Acquire per-credential lock ---
    const acquired = await tryAcquireLock(db, cred.id, LOCK_OWNER)
    if (!acquired) {
      console.log(`[cron] Skipping ${cred.imapEmail} — lock held by another instance`)
      continue
    }

    await recordAttempt(db, cred.id, LOCK_OWNER)

    const startedAt = new Date()
    const historyId = crypto.randomUUID()
    const projectionSecret = process.env.SYNC_PROJECTION_SECRET

    // Per-credential tracking for sync-projection
    let importedCount = 0
    let skippedCount = 0
    let failedCount = 0
    let newestImportedEmail: { importedAt: Date; emailDate: Date } | null = null

    try {
      // --- Step 3: Deterministic jitter before IMAP connection ---
      const jitterMs = computeJitterMs(cred.id)
      if (jitterMs > 0) {
        console.log(`[cron] Jittering ${cred.imapEmail} for ${jitterMs}ms`)
        await new Promise((resolve) => setTimeout(resolve, jitterMs))
      }

      console.log(`[cron] Syncing account: ${cred.imapEmail} (user: ${cred.userId})`)

      // Fetch emails from approved senders
      const emails = await fetchTicketEmails(
        {
          host: cred.host,
          port: cred.port,
          email: cred.imapEmail,
          encryptedPassword: cred.encryptedPassword,
          iv: cred.iv,
          lastSyncAt: cred.syncCursorAt ?? cred.lastSyncAt,
        },
        encryptionKey,
      )

      console.log(`[cron] Found ${emails.length} ticket emails for user ${cred.userId}`)

      const emailsForIngest = [...emails]
        .filter((e) => shouldProcessEmail(e.subject, e.from))
        .sort((a, b) => a.date.getTime() - b.date.getTime())

      const fullEmailsFound = emails.length

      // Dedup: which emails already exist in the main app
      const existingHashes = await checkAlreadyIngested(
        mainAppUrl,
        ingestApiKey,
        cred.userId,
        emailsForIngest.map((e) => ({
          subject: e.subject,
          senderEmail: extractEmailAddress(e.from),
          recipientEmail: cred.imapEmail,
          emailDate: e.date,
        })),
      )

      if (existingHashes.size > 0) {
        console.log(
          `[cron] Dedup: ${existingHashes.size} emails already imported for ${cred.imapEmail}`,
        )
      }

      // POST each email to the main app's ingest endpoint
      for (const email of emailsForIngest) {
        // Skip already-imported emails
        const hash = computeEmailHash(
          email.subject,
          extractEmailAddress(email.from),
          cred.imapEmail,
          email.date,
        )
        if (existingHashes.has(hash)) {
          skippedCount++
          console.log(`[cron] Skipping already-imported: "${email.subject}" (${email.messageId})`)
          continue
        }

        try {
          const payload = buildIngestPayload({
            userId: cred.userId,
            recipientEmail: cred.imapEmail,
            email,
          })

          const response = await fetch(`${mainAppUrl}/api/ingest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ingestApiKey && { 'X-API-Key': ingestApiKey }),
            },
            body: JSON.stringify(payload),
          })

          if (response.ok) {
            importedCount++
            // Track newest email for import-timestamp updates
            if (!newestImportedEmail || email.date > newestImportedEmail.emailDate) {
              newestImportedEmail = { importedAt: new Date(), emailDate: email.date }
            }
          } else {
            failedCount++
            console.error(`[cron] Ingest failed for ${email.messageId}:`, await response.text())
          }
        } catch (error) {
          failedCount++
          console.error(`[cron] Error ingesting email ${email.messageId}:`, error)
        }
      }

      // Record success: clear lock/backoff/error, update lastSyncSuccessAt
      const completedAt = new Date()
      await recordSuccess(db, cred.id, LOCK_OWNER)

      // Don't advance cursor when any emails failed — the next sync will
      // re-fetch the same date range so nothing is missed.
      if (failedCount === 0) {
        await recordCursorAdvance(
          db,
          cred.id,
          completedAt,
          newestImportedEmail?.importedAt ?? null,
          newestImportedEmail?.emailDate ?? null,
        )
      }

      // Log sync-projection for auto sync (mode: auto)
      await callSyncProjection(mainAppUrl, projectionSecret, {
        userId: cred.userId,
        status: 'completed',
        metadata: {
          mode: 'auto',
          credentialId: cred.id,
          recipientEmail: cred.imapEmail,
          emailsFound: fullEmailsFound,
          emailsImported: importedCount,
          emailsSkipped: skippedCount,
          emailsFailed: failedCount,
          lastImportedEmailAt: newestImportedEmail?.importedAt?.getTime(),
          lastImportedEmailDate: newestImportedEmail?.emailDate?.getTime(),
        },
      })

      const syncStatus =
        failedCount === 0
          ? 'success'
          : importedCount > 0
            ? 'partial'
            : 'error'

      await db.insert(syncHistory).values({
        id: historyId,
        userId: cred.userId,
        credentialId: cred.id,
        status: syncStatus,
        emailsFound: fullEmailsFound,
        emailsIngested: importedCount,
        startedAt,
        completedAt,
      })

      console.log(
        `[cron] Sync complete for ${cred.imapEmail}: ${importedCount} imported, ${skippedCount} skipped, ${failedCount} failed (${fullEmailsFound} found)`,
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[cron] Sync failed for ${cred.imapEmail}:`, error)

      // Record failure: set backoff, failure state, release lock
      const completedAt = new Date()
      await recordFailure(db, cred.id, LOCK_OWNER, errorMessage)

      // Log sync-projection for failed auto sync
      await callSyncProjection(mainAppUrl, projectionSecret, {
        userId: cred.userId,
        status: 'failed',
        metadata: {
          mode: 'auto',
          credentialId: cred.id,
          recipientEmail: cred.imapEmail,
          emailsFound: 0,
          emailsImported: 0,
          emailsSkipped: 0,
          emailsFailed: 0,
          errorCode: 'SYNC_FAILED',
          errorMessage,
        },
        errorMessage,
      })

      // Log error with credentialId
      await db.insert(syncHistory).values({
        id: historyId,
        userId: cred.userId,
        credentialId: cred.id,
        status: 'error',
        emailsFound: 0,
        emailsIngested: 0,
        errorMessage,
        startedAt,
        completedAt,
      })
    }
  }

  console.log('[cron] Scheduled sync completed')
}

export function startCronJobs(): void {
  console.log(`[cron] Starting cron jobs with schedule: ${CRON_SCHEDULE}`)

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      await runSync()
    } catch (error) {
      console.error('[cron] Unhandled error in sync job:', error)
    }
  })

  console.log('[cron] Cron jobs scheduled successfully')
}

// Allow running directly for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('[cron] Running sync manually...')
  runSync()
    .then(() => {
      console.log('[cron] Manual sync completed')
      process.exit(0)
    })
    .catch((error) => {
      console.error('[cron] Manual sync failed:', error)
      process.exit(1)
    })
}
