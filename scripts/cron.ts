/**
 * Cron job handler for automated email syncing.
 * Runs daily at 6am UTC to fetch emails for users with auto-sync enabled.
 */

import cron from 'node-cron'
import { eq } from 'drizzle-orm'
import { getDb } from '../src/lib/db'
import { isLikelyTicketEmail } from '../src/lib/email-filter'
import { imapCredentials, syncHistory } from '../src/lib/schema'
import { fetchTicketEmails } from '../src/lib/imap-client'

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 6 * * *' // Daily at 6am UTC

async function runSync(): Promise<void> {
  console.log('[cron] Scheduled sync started at:', new Date().toISOString())

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
    const startedAt = new Date()
    const historyId = crypto.randomUUID()

    try {
      console.log(`[cron] Syncing account: ${cred.imapEmail} (user: ${cred.userId})`)

      // Fetch emails from approved senders
      const emails = await fetchTicketEmails(
        {
          host: cred.host,
          port: cred.port,
          email: cred.imapEmail,
          encryptedPassword: cred.encryptedPassword,
          iv: cred.iv,
          lastSyncAt: cred.lastSyncAt,
        },
        encryptionKey
      )

      console.log(`[cron] Found ${emails.length} ticket emails for user ${cred.userId}`)

      let ingestedCount = 0

      // POST each email to the main app's ingest endpoint
      for (const email of emails) {
        // Skip emails that don't look like ticket receipts
        if (!isLikelyTicketEmail(email.subject)) {
          console.log(`[cron] Skipping non-ticket email: "${email.subject}" (${email.messageId})`)
          continue
        }

        try {
          const response = await fetch(`${mainAppUrl}/api/ingest`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(ingestApiKey && { 'X-API-Key': ingestApiKey }),
            },
            body: JSON.stringify({
              userId: cred.userId,
              userEmail: cred.userEmail,
              email: {
                messageId: email.messageId,
                from: email.from,
                subject: email.subject,
                date: email.date.toISOString(),
                body: email.body,
              },
            }),
          })

          if (response.ok) {
            ingestedCount++
          } else {
            console.error(`[cron] Ingest failed for ${email.messageId}:`, await response.text())
          }
        } catch (error) {
          console.error(`[cron] Error ingesting email ${email.messageId}:`, error)
        }
      }

      // Update last sync time for this specific credential
      await db
        .update(imapCredentials)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(imapCredentials.id, cred.id))

      // Log success with credentialId
      await db.insert(syncHistory).values({
        id: historyId,
        userId: cred.userId,
        credentialId: cred.id,
        status: ingestedCount === emails.length ? 'success' : 'partial',
        emailsFound: emails.length,
        emailsIngested: ingestedCount,
        startedAt,
        completedAt: new Date(),
      })

      console.log(`[cron] Sync complete for ${cred.imapEmail}: ${ingestedCount}/${emails.length} ingested`)
    } catch (error) {
      console.error(`[cron] Sync failed for ${cred.imapEmail}:`, error)

      // Log error with credentialId
      await db.insert(syncHistory).values({
        id: historyId,
        userId: cred.userId,
        credentialId: cred.id,
        status: 'error',
        emailsFound: 0,
        emailsIngested: 0,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        startedAt,
        completedAt: new Date(),
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
