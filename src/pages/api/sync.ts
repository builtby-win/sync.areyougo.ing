import type { APIRoute } from 'astro'
import { and, eq } from 'drizzle-orm'
import { APPROVED_SENDERS } from '../../lib/approved-senders'
import { getDb } from '../../lib/db'
import { fetchTicketEmails } from '../../lib/imap-client'
import { imapCredentials, syncHistory } from '../../lib/schema'
import {
  addEmailToSession,
  cleanupSessions,
  createSession,
  getSession,
  markSenderCompleted,
  updateConnectionState,
  updateCurrentSender,
  updateEmailStatus,
  updateSession,
} from '../../lib/sync-sessions'
import { verifySession } from '../../lib/verify-session'

interface SyncRequest {
  credentialId: string
  lookbackDays: number
  dryRun: boolean
}

interface EmailForIngest {
  messageId: string
  from: string
  subject: string
  date: string
  body: string
}

interface SyncResponse {
  success: boolean
  error?: string
  emails?: EmailForIngest[]
  emailsFound?: number
  emailsIngested?: number
  rateLimitedUntil?: string
  sessionId?: string
}

const RATE_LIMIT_HOURS = 24
const IS_DEV = process.env.NODE_ENV !== 'production'

// Extract email address from "Name <email@domain.com>" format
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from.trim()
}

// Async function to process sync in background
async function processSync(
  sessionId: string,
  cred: {
    id: string
    userId: string
    userEmail: string
    host: string
    port: number
    imapEmail: string
    encryptedPassword: string
    iv: string
    lastSyncAt: Date | null
  },
  encryptionKey: string,
  lookbackDays: number,
  mainAppUrl: string,
  ingestApiKey: string | undefined
) {
  const db = getDb()

  try {
    // Fetch emails from approved senders with progress callbacks
    await fetchTicketEmails(
      {
        host: cred.host,
        port: cred.port,
        email: cred.imapEmail,
        encryptedPassword: cred.encryptedPassword,
        iv: cred.iv,
        lastSyncAt: cred.lastSyncAt,
      },
      encryptionKey,
      { lookbackDays },
      {
        onConnecting: () => {
          console.log(`[sync:${sessionId}] Connecting...`)
          updateConnectionState(sessionId, 'connecting')
        },
        onAuthenticating: () => {
          console.log(`[sync:${sessionId}] Authenticating...`)
          updateConnectionState(sessionId, 'authenticating')
        },
        onConnected: () => {
          console.log(`[sync:${sessionId}] Connected!`)
          updateConnectionState(sessionId, 'connected')
        },
        onConnectionError: (error) => {
          console.error(`[sync:${sessionId}] Connection error:`, error)
          updateConnectionState(sessionId, 'error', error.message)
        },
        onSenderStart: (sender) => {
          console.log(`[sync:${sessionId}] Searching ${sender}...`)
          updateCurrentSender(sessionId, sender)
        },
        onSenderComplete: (sender, emails) => {
          console.log(`[sync:${sessionId}] Found ${emails.length} emails from ${sender}`)
          markSenderCompleted(sessionId, sender)
          // Add emails to session immediately for progressive display
          for (const email of emails) {
            addEmailToSession(sessionId, {
              messageId: email.messageId,
              from: email.from,
              subject: email.subject,
              date: email.date.toISOString(),
              body: email.body,
              ingestStatus: 'pending',
            })
          }
        },
        onError: (sender, error) => {
          console.error(`[sync:${sessionId}] Error searching ${sender}:`, error)
          markSenderCompleted(sessionId, sender)
        },
      }
    )

    // Clear current sender and move to ingesting
    updateCurrentSender(sessionId, undefined)
    updateSession(sessionId, { status: 'ingesting' })

    // Ingest each email
    const session = getSession(sessionId)
    console.log(`[sync:${sessionId}] Total: ${session?.totalFound || 0} ticket emails found`)

    if (!session) {
      throw new Error('Session not found')
    }

    for (let i = 0; i < session.emails.length; i++) {
      const email = session.emails[i]
      console.log(`[sync:${sessionId}] Ingesting email ${i + 1}/${session.emails.length}: "${email.subject}" (${email.messageId})`)
      updateEmailStatus(sessionId, email.messageId, 'sending')

      try {
        const payload = {
          recipientEmail: cred.imapEmail,
          senderEmail: extractEmailAddress(email.from),
          subject: email.subject,
          body: email.body,
          emailDate: email.date,
          userId: cred.userId,
        }
        console.log(`[sync:${sessionId}] POST ${mainAppUrl}/api/ingest - recipient: ${payload.recipientEmail}, sender: ${payload.senderEmail}`)

        const response = await fetch(`${mainAppUrl}/api/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(ingestApiKey && { 'X-API-Key': ingestApiKey }),
          },
          body: JSON.stringify(payload),
        })

        if (response.ok) {
          const result = await response.json()
          console.log(`[sync:${sessionId}] Ingest success for ${email.messageId}:`, result)
          updateEmailStatus(sessionId, email.messageId, 'success')
        } else {
          const errorText = await response.text()
          console.error(`[sync:${sessionId}] Ingest failed for ${email.messageId} (${response.status}):`, errorText)
          updateEmailStatus(sessionId, email.messageId, 'failed', errorText)
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Network error'
        console.error(`[sync:${sessionId}] Error ingesting email ${email.messageId}:`, error)
        updateEmailStatus(sessionId, email.messageId, 'failed', errorMsg)
      }
    }

    // Update timestamps for this specific credential
    await db
      .update(imapCredentials)
      .set({
        lastSyncAt: new Date(),
        lastManualSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(imapCredentials.id, cred.id))

    // Log to history with credentialId
    const finalSession = getSession(sessionId)!
    await db.insert(syncHistory).values({
      id: crypto.randomUUID(),
      userId: cred.userId,
      credentialId: cred.id,
      status: finalSession.totalIngested === finalSession.totalFound ? 'success' : 'partial',
      emailsFound: finalSession.totalFound,
      emailsIngested: finalSession.totalIngested,
      startedAt: finalSession.startedAt,
      completedAt: new Date(),
    })

    updateSession(sessionId, { status: 'completed', completedAt: new Date() })
    console.log(
      `[sync:${sessionId}] Complete: ${finalSession.totalIngested}/${finalSession.totalFound} ingested`
    )
  } catch (error) {
    console.error(`[sync:${sessionId}] Error:`, error)
    updateSession(sessionId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Sync failed',
      completedAt: new Date(),
    })
    throw error
  }
}

export const POST: APIRoute = async ({ request }) => {
  console.log('[sync] POST request received')

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'
  const encryptionKey = process.env.ENCRYPTION_KEY
  const ingestApiKey = process.env.INGEST_API_KEY

  if (!encryptionKey) {
    console.error('[sync] ENCRYPTION_KEY not configured')
    return new Response(
      JSON.stringify({ success: false, error: 'Server configuration error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    // Verify user is authenticated
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      console.log('[sync] Unauthorized - no valid session')
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[sync] User verified:', user.id)

    // Parse request body
    const body = (await request.json()) as SyncRequest
    const { credentialId, lookbackDays, dryRun } = body

    if (!credentialId) {
      return new Response(
        JSON.stringify({ success: false, error: 'credentialId is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (typeof lookbackDays !== 'number' || lookbackDays < 1) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid lookbackDays' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const db = getDb()

    // Get specific IMAP credential (must belong to user)
    const creds = await db
      .select()
      .from(imapCredentials)
      .where(and(eq(imapCredentials.id, credentialId), eq(imapCredentials.userId, user.id)))
      .limit(1)

    if (creds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Credential not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const cred = creds[0]

    // Check rate limit (only for non-dry-run requests, and only in production)
    if (!IS_DEV && !dryRun && cred.lastManualSyncAt) {
      const hoursSinceLastSync = (Date.now() - cred.lastManualSyncAt.getTime()) / (1000 * 60 * 60)
      if (hoursSinceLastSync < RATE_LIMIT_HOURS) {
        const retryAfter = new Date(
          cred.lastManualSyncAt.getTime() + RATE_LIMIT_HOURS * 60 * 60 * 1000
        )
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Rate limited. Manual sync available once per 24 hours.',
            rateLimitedUntil: retryAfter.toISOString(),
          } satisfies SyncResponse),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': Math.ceil((RATE_LIMIT_HOURS - hoursSinceLastSync) * 3600).toString(),
            },
          }
        )
      }
    }

    console.log(`[sync] Fetching emails with ${lookbackDays} day lookback, dryRun=${dryRun}, credentialId=${credentialId}`)

    // If dry run, fetch and return preview synchronously
    if (dryRun) {
      const emails = await fetchTicketEmails(
        {
          host: cred.host,
          port: cred.port,
          email: cred.imapEmail,
          encryptedPassword: cred.encryptedPassword,
          iv: cred.iv,
          lastSyncAt: cred.lastSyncAt,
        },
        encryptionKey,
        { lookbackDays }
      )

      const emailsForIngest: EmailForIngest[] = emails.map((email) => ({
        messageId: email.messageId,
        from: email.from,
        subject: email.subject,
        date: email.date.toISOString(),
        body: email.body,
      }))

      return new Response(
        JSON.stringify({
          success: true,
          emails: emailsForIngest,
          emailsFound: emails.length,
        } satisfies SyncResponse),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // For real sync: create session and process asynchronously
    cleanupSessions()
    const sessionId = createSession(user.id, APPROVED_SENDERS.length)

    // Start async processing (don't await)
    processSync(sessionId, cred, encryptionKey, lookbackDays, mainAppUrl, ingestApiKey).catch(
      (err) => {
        console.error(`[sync:${sessionId}] Async sync error:`, err)
        updateSession(sessionId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Sync failed',
          completedAt: new Date(),
        })
      }
    )

    // Return immediately with sessionId for polling
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        message: 'Sync started',
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('[sync] Error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Sync failed',
      } satisfies SyncResponse),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
