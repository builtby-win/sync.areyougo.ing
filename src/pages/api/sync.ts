import type { APIRoute } from 'astro'
import { eq } from 'drizzle-orm'
import { verifySession } from '../../lib/verify-session'
import { getDb } from '../../lib/db'
import { imapCredentials, syncHistory } from '../../lib/schema'
import { fetchTicketEmails } from '../../lib/imap-client'

interface SyncRequest {
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
}

const RATE_LIMIT_HOURS = 24

export const POST: APIRoute = async ({ request, locals }) => {
  console.log('[sync] POST request received')
  const startTime = Date.now()

  const env = locals.runtime.env
  const mainAppUrl = env.MAIN_APP_URL || 'https://areyougo.ing'

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
    const { lookbackDays, dryRun } = body

    if (typeof lookbackDays !== 'number' || lookbackDays < 1) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid lookbackDays' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const db = getDb(env)

    // Get user's IMAP credentials
    const creds = await db
      .select()
      .from(imapCredentials)
      .where(eq(imapCredentials.userId, user.id))
      .limit(1)

    if (creds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No IMAP credentials configured' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const cred = creds[0]

    // Check rate limit (only for non-dry-run requests)
    if (!dryRun && cred.lastManualSyncAt) {
      const hoursSinceLastSync = (Date.now() - cred.lastManualSyncAt.getTime()) / (1000 * 60 * 60)
      if (hoursSinceLastSync < RATE_LIMIT_HOURS) {
        const retryAfter = new Date(cred.lastManualSyncAt.getTime() + RATE_LIMIT_HOURS * 60 * 60 * 1000)
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

    console.log(`[sync] Fetching emails with ${lookbackDays} day lookback, dryRun=${dryRun}`)

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
      env.ENCRYPTION_KEY,
      { lookbackDays }
    )

    console.log(`[sync] Found ${emails.length} ticket emails`)

    // Convert to ingest format
    const emailsForIngest: EmailForIngest[] = emails.map((email) => ({
      messageId: email.messageId,
      from: email.from,
      subject: email.subject,
      date: email.date.toISOString(),
      body: email.body,
    }))

    // If dry run, just return the preview
    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          emails: emailsForIngest,
          emailsFound: emails.length,
        } satisfies SyncResponse),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Actually send emails to main app
    let ingestedCount = 0
    const historyId = crypto.randomUUID()
    const startedAt = new Date()

    for (const email of emailsForIngest) {
      try {
        const response = await fetch(`${mainAppUrl}/api/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env.INGEST_API_KEY && { 'X-API-Key': env.INGEST_API_KEY }),
          },
          body: JSON.stringify({
            userId: cred.userId,
            userEmail: cred.userEmail,
            email,
          }),
        })

        if (response.ok) {
          ingestedCount++
        } else {
          console.error(`[sync] Ingest failed for ${email.messageId}:`, await response.text())
        }
      } catch (error) {
        console.error(`[sync] Error ingesting email ${email.messageId}:`, error)
      }
    }

    // Update timestamps
    await db
      .update(imapCredentials)
      .set({
        lastSyncAt: new Date(),
        lastManualSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(imapCredentials.userId, user.id))

    // Log to history
    await db.insert(syncHistory).values({
      id: historyId,
      userId: cred.userId,
      status: ingestedCount === emails.length ? 'success' : 'partial',
      emailsFound: emails.length,
      emailsIngested: ingestedCount,
      startedAt,
      completedAt: new Date(),
    })

    console.log(`[sync] Complete: ${ingestedCount}/${emails.length} ingested, elapsed: ${Date.now() - startTime}ms`)

    return new Response(
      JSON.stringify({
        success: true,
        emailsFound: emails.length,
        emailsIngested: ingestedCount,
      } satisfies SyncResponse),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
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
