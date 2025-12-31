import type { APIRoute } from 'astro'
import { eq } from 'drizzle-orm'
import { getDb } from '../../lib/db'
import { imapCredentials } from '../../lib/schema'
import { verifySession } from '../../lib/verify-session'

interface SetupRequest {
  provider: string
  email: string
  encryptedPassword: string
  iv: string
  host: string
  port: number
  syncMode?: 'manual' | 'auto_daily'
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
    const { provider, email, encryptedPassword, iv, host, port, syncMode } = body

    if (!provider || !email || !encryptedPassword || !iv || !host || !port) {
      console.log('[setup] Missing required fields')
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[setup] Saving credentials for:', { provider, email, host, port, syncMode })

    const db = getDb()

    // Check if user already has credentials
    const existing = await db
      .select({ id: imapCredentials.id })
      .from(imapCredentials)
      .where(eq(imapCredentials.userId, user.id))
      .limit(1)

    if (existing.length > 0) {
      // Update existing credentials
      console.log('[setup] Updating existing credentials')
      await db
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
        .where(eq(imapCredentials.userId, user.id))
    } else {
      // Insert new credentials
      console.log('[setup] Creating new credentials')
      await db.insert(imapCredentials).values({
        id: crypto.randomUUID(),
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
    }

    console.log('[setup] Success:', { elapsed: Date.now() - startTime })

    return new Response(JSON.stringify({ success: true }), {
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
