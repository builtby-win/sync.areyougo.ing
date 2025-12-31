/**
 * Cloudflare Worker entry point for cron job handling.
 * This runs daily at 6am UTC to fetch emails for users with auto-sync enabled
 * and POST to areyougo.ing/api/ingest.
 */

import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { imapCredentials, syncHistory } from './lib/schema'
import { fetchTicketEmails } from './lib/imap-client'

interface Env {
  DB: D1Database
  ENCRYPTION_KEY: string
  MAIN_APP_URL: string
  INGEST_API_KEY?: string
}

export default {
  /**
   * Scheduled handler - runs on cron trigger (daily at 6am UTC)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('[cron] Scheduled sync started at:', new Date(event.scheduledTime).toISOString())

    const db = drizzle(env.DB)

    // Get only users with auto-sync enabled
    const credentials = await db
      .select()
      .from(imapCredentials)
      .where(eq(imapCredentials.syncMode, 'auto_daily'))

    console.log(`[cron] Found ${credentials.length} users to sync`)

    for (const cred of credentials) {
      const startedAt = new Date()
      const historyId = crypto.randomUUID()

      try {
        console.log(`[cron] Syncing user: ${cred.userId}`)

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
          env.ENCRYPTION_KEY
        )

        console.log(`[cron] Found ${emails.length} ticket emails for user ${cred.userId}`)

        let ingestedCount = 0

        // POST each email to the main app's ingest endpoint
        for (const email of emails) {
          try {
            const response = await fetch(`${env.MAIN_APP_URL}/api/ingest`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(env.INGEST_API_KEY && { 'X-API-Key': env.INGEST_API_KEY }),
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

        // Update last sync time
        await db
          .update(imapCredentials)
          .set({ lastSyncAt: new Date(), updatedAt: new Date() })
          .where(eq(imapCredentials.userId, cred.userId))

        // Log success
        await db.insert(syncHistory).values({
          id: historyId,
          userId: cred.userId,
          status: 'success',
          emailsFound: emails.length,
          emailsIngested: ingestedCount,
          startedAt,
          completedAt: new Date(),
        })

        console.log(`[cron] Sync complete for ${cred.userId}: ${ingestedCount}/${emails.length} ingested`)
      } catch (error) {
        console.error(`[cron] Sync failed for ${cred.userId}:`, error)

        // Log error
        await db.insert(syncHistory).values({
          id: historyId,
          userId: cred.userId,
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
  },
}
