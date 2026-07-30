import type { APIRoute } from 'astro'
import { and, eq } from 'drizzle-orm'
import { APPROVED_SENDERS } from '../../lib/approved-senders'
import { getDb } from '../../lib/db'
import { shouldProcessEmail } from '../../lib/email-filter'
import { fetchTicketEmails, searchEmailsByQuery } from '../../lib/imap-client'
import { runIngestion } from '../../lib/ingest'
import { redactPii } from '../../lib/redaction/redactor'
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
import { getSyncErrorMessage } from '../../lib/sync-errors'
import { verifySession } from '../../lib/verify-session'
import { checkAlreadyIngested, computeEmailHash } from '../../lib/dedup'

interface SyncRequest {
  credentialId: string
  lookbackDays: number
  dryRun: boolean
  waitForSelection?: boolean
  searchTerm?: string
  sinceDate?: string
  beforeDate?: string
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
const ENABLE_MANUAL_SYNC_RATE_LIMIT = false

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
  ingestApiKey: string | undefined,
  waitForSelection = false,
  searchTerm?: string,
  sinceDate?: string,
  beforeDate?: string,
) {
  const db = getDb()

  try {
    // Progress callbacks shared by both modes
    const progressCallbacks = {
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
      onConnectionError: (error: Error) => {
        console.error(`[sync:${sessionId}] Connection error:`, error)
        updateConnectionState(sessionId, 'error', getSyncErrorMessage(error))
      },
      onSenderStart: (sender: string) => {
        console.log(`[sync:${sessionId}] Searching ${sender}...`)
        updateCurrentSender(sessionId, sender)
      },
      onSenderComplete: (sender: string, emails: import('../../lib/imap-client').Email[]) => {
        // In search mode, keyword filtering is already done in searchEmailsByQuery
        const ticketEmails = searchTerm
          ? emails
          : emails.filter((e) => shouldProcessEmail(e.subject, e.from))

        console.log(
          `[sync:${sessionId}] Found ${emails.length} emails from ${sender} (${ticketEmails.length} tickets)`,
        )
        markSenderCompleted(sessionId, sender)

        for (const email of ticketEmails) {
          addEmailToSession(sessionId, {
            messageId: email.messageId,
            from: email.from,
            subject: email.subject,
            date: email.date.toISOString(),
            body: redactPii(email.body),
            ingestStatus: 'pending',
          })
        }
      },
      onError: (sender: string, error: Error) => {
        console.error(`[sync:${sessionId}] Error searching ${sender}:`, error)
        markSenderCompleted(sessionId, sender)
      },
    }

    const imapCreds = {
      host: cred.host,
      port: cred.port,
      email: cred.imapEmail,
      encryptedPassword: cred.encryptedPassword,
      iv: cred.iv,
      lastSyncAt: cred.lastSyncAt,
    }

    if (searchTerm) {
      // Power search mode: search by user query + ticket keyword filter
      await searchEmailsByQuery(
        imapCreds,
        encryptionKey,
        { lookbackDays, sinceDate, beforeDate, searchTerm },
        progressCallbacks,
      )
    } else {
      // Default mode: search approved senders
      await fetchTicketEmails(
        imapCreds,
        encryptionKey,
        { lookbackDays, sinceDate, beforeDate },
        progressCallbacks,
      )
    }

    // Clear current sender
    updateCurrentSender(sessionId, undefined)

    // Dedup: check which emails already exist in the main app
    const session = getSession(sessionId)
    if (session && session.emails.length > 0) {
      const emailsForCheck = session.emails
        .filter((e) => e.ingestStatus === 'pending')
        .map((e) => ({
          subject: e.subject,
          senderEmail: extractEmailAddress(e.from),
          recipientEmail: cred.imapEmail,
          emailDate: new Date(e.date),
        }))

      const existingHashes = await checkAlreadyIngested(
        mainAppUrl,
        ingestApiKey,
        cred.userId,
        emailsForCheck,
      )

      if (existingHashes.size > 0) {
        // Mark already-ingested emails as skipped
        for (const e of session.emails) {
          if (e.ingestStatus !== 'pending') continue
          const hash = computeEmailHash(
            e.subject,
            extractEmailAddress(e.from),
            cred.imapEmail,
            new Date(e.date),
          )
          if (existingHashes.has(hash)) {
            updateEmailStatus(sessionId, e.messageId, 'skipped', 'Already imported')
          }
        }
        console.log(`[sync:${sessionId}] Dedup: ${existingHashes.size} emails already imported`)
      }
    }

    if (waitForSelection) {
      updateSession(sessionId, { status: 'waiting_for_selection' })
      console.log(`[sync:${sessionId}] Waiting for user selection`)
      return
    }

    // Ingest immediately if not waiting
    await runIngestion({
      sessionId,
      cred: { id: cred.id, userId: cred.userId, imapEmail: cred.imapEmail },
      mainAppUrl,
      ingestApiKey,
    })
  } catch (error) {
    console.error(`[sync:${sessionId}] Error:`, error)
    const errorMessage = getSyncErrorMessage(error)
    updateSession(sessionId, {
      status: 'failed',
      error: errorMessage,
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
    return new Response(JSON.stringify({ success: false, error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
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
    const { credentialId, lookbackDays, dryRun, waitForSelection, searchTerm: rawSearchTerm, sinceDate, beforeDate } = body

    if (!credentialId) {
      return new Response(JSON.stringify({ success: false, error: 'credentialId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (typeof lookbackDays !== 'number' || lookbackDays < 1) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid lookbackDays' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Validate searchTerm if provided
    let searchTerm: string | undefined
    if (rawSearchTerm !== undefined) {
      if (typeof rawSearchTerm !== 'string' || rawSearchTerm.trim().length === 0) {
        return new Response(JSON.stringify({ success: false, error: 'searchTerm must be a non-empty string' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (rawSearchTerm.length > 200) {
        return new Response(JSON.stringify({ success: false, error: 'searchTerm must be 200 characters or less' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      searchTerm = rawSearchTerm.trim()
    }

    const db = getDb()

    // Get specific IMAP credential (must belong to user)
    const creds = await db
      .select()
      .from(imapCredentials)
      .where(and(eq(imapCredentials.id, credentialId), eq(imapCredentials.userId, user.id)))
      .limit(1)

    if (creds.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Credential not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const cred = creds[0]

    // Check rate limit (only for non-dry-run requests, and only in production)
    if (ENABLE_MANUAL_SYNC_RATE_LIMIT && !IS_DEV && !dryRun && cred.lastManualSyncAt) {
      const hoursSinceLastSync = (Date.now() - cred.lastManualSyncAt.getTime()) / (1000 * 60 * 60)
      if (hoursSinceLastSync < RATE_LIMIT_HOURS) {
        const retryAfter = new Date(
          cred.lastManualSyncAt.getTime() + RATE_LIMIT_HOURS * 60 * 60 * 1000,
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
          },
        )
      }
    }

    console.log(
      `[sync] Fetching emails with ${lookbackDays} day lookback, dryRun=${dryRun}, credentialId=${credentialId}`,
    )

    // If dry run, fetch and return preview synchronously
    if (dryRun) {
      const dryRunCredentials = {
        host: cred.host,
        port: cred.port,
        email: cred.imapEmail,
        encryptedPassword: cred.encryptedPassword,
        iv: cred.iv,
        lastSyncAt: cred.lastSyncAt,
      }
      const emails = searchTerm
        ? await searchEmailsByQuery(dryRunCredentials, encryptionKey, { lookbackDays, sinceDate, beforeDate, searchTerm })
        : await fetchTicketEmails(dryRunCredentials, encryptionKey, { lookbackDays, sinceDate, beforeDate })

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
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // For real sync: create session and process asynchronously
    cleanupSessions()
    const sendersTotal = searchTerm ? 1 : APPROVED_SENDERS.length
    const sessionId = createSession(user.id, cred.id, sendersTotal)

    // Start async processing (don't await)
    processSync(
      sessionId,
      cred,
      encryptionKey,
      lookbackDays,
      mainAppUrl,
      ingestApiKey,
      waitForSelection,
      searchTerm,
      sinceDate,
      beforeDate,
    ).catch((err) => {
      console.error(`[sync:${sessionId}] Async sync error:`, err)
        updateSession(sessionId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Sync failed',
          completedAt: new Date(),
        })
      },
    )

    // Return immediately with sessionId for polling
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        message: 'Sync started',
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (error) {
    console.error('[sync] Error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Sync failed',
      } satisfies SyncResponse),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
