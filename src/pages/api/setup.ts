import type { APIRoute } from 'astro'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '../../lib/db'
import { imapCredentials } from '../../lib/schema'
import { verifySession } from '../../lib/verify-session'

const MAX_ACCOUNTS = 5

interface SetupRequest {
  provider: string
  email: string
  encryptedPassword: string
  iv: string
  host: string
  port: number
  syncMode?: 'manual' | 'auto_daily'
  credentialId?: string // For updating an existing account
}

export const POST: APIRoute = async ({ request }) => {
  console.log('[setup] POST request received')
  const startTime = Date.now()

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'

  try {
    // Verify user is authenticated
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      console.log('[setup] Unauthorized - no valid session')
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[setup] User verified:', user.id)

    // Parse request body
    const body = (await request.json()) as SetupRequest
    const { provider, email, encryptedPassword, iv, host, port, syncMode, credentialId } = body

    if (!provider || !email || !encryptedPassword || !iv || !host || !port) {
      console.log('[setup] Missing required fields')
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[setup] Saving credentials for:', { provider, email, host, port, syncMode, credentialId })

    const db = getDb()

    // If updating an existing credential
    if (credentialId) {
      console.log('[setup] Updating existing credentials:', credentialId)
      const result = await db
        .update(imapCredentials)
        .set({
          provider,
          imapEmail: email,
          host,
          port,
          encryptedPassword,
          iv,
          syncMode: syncMode || 'manual',
          updatedAt: new Date(),
        })
        .where(and(eq(imapCredentials.id, credentialId), eq(imapCredentials.userId, user.id)))
        .returning({ id: imapCredentials.id })

      if (result.length === 0) {
        return new Response(JSON.stringify({ error: 'Credential not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      console.log('[setup] Success (update):', { elapsed: Date.now() - startTime })
      return new Response(JSON.stringify({ success: true, credentialId: result[0].id }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Adding a new account - check limits
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(imapCredentials)
      .where(eq(imapCredentials.userId, user.id))

    const currentCount = countResult[0]?.count ?? 0

    if (currentCount >= MAX_ACCOUNTS) {
      console.log('[setup] Account limit reached:', currentCount)
      return new Response(
        JSON.stringify({ error: `Maximum of ${MAX_ACCOUNTS} email accounts allowed` }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // Check for duplicate IMAP email
    const existing = await db
      .select({ id: imapCredentials.id })
      .from(imapCredentials)
      .where(and(eq(imapCredentials.userId, user.id), eq(imapCredentials.imapEmail, email)))
      .limit(1)

    if (existing.length > 0) {
      console.log('[setup] Duplicate IMAP email:', email)
      return new Response(JSON.stringify({ error: 'This email account is already connected' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Insert new credentials
    console.log('[setup] Creating new credentials')
    const newId = crypto.randomUUID()
    await db.insert(imapCredentials).values({
      id: newId,
      userId: user.id,
      userEmail: user.email,
      provider,
      imapEmail: email,
      host,
      port,
      encryptedPassword,
      iv,
      syncMode: syncMode || 'manual',
    })

    console.log('[setup] Success (create):', { elapsed: Date.now() - startTime })

    return new Response(JSON.stringify({ success: true, credentialId: newId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[setup] Error:', error)
    console.error('[setup] Stack:', error instanceof Error ? error.stack : 'none')
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
