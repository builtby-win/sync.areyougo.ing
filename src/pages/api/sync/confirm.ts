import type { APIRoute } from 'astro'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../lib/db'
import { runIngestion } from '../../../lib/ingest'
import { imapCredentials } from '../../../lib/schema'
import { getSession, updateEmailStatus, updateSession } from '../../../lib/sync-sessions'
import { verifySession } from '../../../lib/verify-session'
import { tryAcquireLock } from '../../../lib/sync-helpers'

interface ConfirmRequest {
  sessionId: string
  selectedMessageIds: string[]
}

export const POST: APIRoute = async ({ request }) => {
  console.log('[sync/confirm] POST request received')

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'
  const encryptionKey = process.env.ENCRYPTION_KEY
  const ingestApiKey = process.env.INGEST_API_KEY

  if (!encryptionKey) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const body = (await request.json()) as ConfirmRequest
    const { sessionId, selectedMessageIds } = body

    if (!sessionId || !selectedMessageIds) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const session = getSession(sessionId)
    if (!session) {
      return new Response(JSON.stringify({ error: 'Session not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (session.userId !== user.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized session access' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (session.status !== 'waiting_for_selection') {
      return new Response(
        JSON.stringify({ error: `Invalid session status: ${session.status}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // Retrieve credentials from DB
    const db = getDb()
    const creds = await db
      .select()
      .from(imapCredentials)
      .where(and(eq(imapCredentials.id, session.credentialId), eq(imapCredentials.userId, user.id)))
      .limit(1)

    if (creds.length === 0) {
      return new Response(JSON.stringify({ error: 'Credential not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const cred = creds[0]

    // Mark unselected emails as skipped
    const selectedSet = new Set(selectedMessageIds)
    let skippedCount = 0
    
    session.emails.forEach((email) => {
        if (!selectedSet.has(email.messageId)) {
            email.ingestStatus = 'skipped'
            skippedCount++
        }
    })

    console.log(`[sync:${sessionId}] Confirmed selection. ${selectedMessageIds.length} selected, ${skippedCount} skipped.`)

    // Acquire lock before ingestion to prevent concurrent cron sync
    // from running on the same credential during ingestion.
    const confirmLockOwner = `manual-${crypto.randomUUID().slice(0, 8)}`
    const acquired = await tryAcquireLock(db, cred.id, confirmLockOwner)
    if (!acquired) {
      return new Response(JSON.stringify({
        error: 'Another sync is currently running for this credential. Please try again.',
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Resume ingestion asynchronously
    runIngestion({
      sessionId,
      cred: { id: cred.id, userId: cred.userId, imapEmail: cred.imapEmail },
      mainAppUrl,
      ingestApiKey,
      lockOwner: confirmLockOwner,
    }).catch((err: unknown) => {
        console.error(`[sync:${sessionId}] Async ingestion error:`, err)
    })

    return new Response(JSON.stringify({ success: true, message: 'Ingestion started' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('[sync/confirm] Error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}