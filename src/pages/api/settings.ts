import type { APIRoute } from 'astro'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../lib/db'
import { imapCredentials } from '../../lib/schema'
import { verifySession } from '../../lib/verify-session'

type SyncMode = 'manual' | 'auto_daily'

interface SettingsRequest {
  credentialId: string
  syncMode: SyncMode
}

interface AccountInfo {
  id: string
  syncMode: SyncMode
  lastSyncAt: string | null
  lastManualSyncAt: string | null
  provider: string
  imapEmail: string
}

interface SettingsResponse {
  success: boolean
  error?: string
  accounts?: AccountInfo[]
}

// GET - Fetch all accounts for user
export const GET: APIRoute = async ({ request }) => {
  console.log('[settings] GET request received')

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'

  try {
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const db = getDb()

    const creds = await db
      .select()
      .from(imapCredentials)
      .where(eq(imapCredentials.userId, user.id))
      .orderBy(imapCredentials.createdAt)

    return new Response(
      JSON.stringify({
        success: true,
        accounts: creds.map((cred) => ({
          id: cred.id,
          syncMode: cred.syncMode as SyncMode,
          lastSyncAt: cred.lastSyncAt?.toISOString() || null,
          lastManualSyncAt: cred.lastManualSyncAt?.toISOString() || null,
          provider: cred.provider,
          imapEmail: cred.imapEmail,
        })),
      } satisfies SettingsResponse),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('[settings] GET error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch settings',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

// PATCH - Update settings for a specific account
export const PATCH: APIRoute = async ({ request }) => {
  console.log('[settings] PATCH request received')

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'

  try {
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const body = (await request.json()) as SettingsRequest
    const { credentialId, syncMode } = body

    if (!credentialId) {
      return new Response(
        JSON.stringify({ success: false, error: 'credentialId is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Validate syncMode
    if (!['manual', 'auto_daily'].includes(syncMode)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid syncMode. Must be "manual" or "auto_daily".' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const db = getDb()

    // Update syncMode for specific credential (must belong to user)
    const result = await db
      .update(imapCredentials)
      .set({
        syncMode,
        updatedAt: new Date(),
      })
      .where(and(eq(imapCredentials.id, credentialId), eq(imapCredentials.userId, user.id)))
      .returning({ id: imapCredentials.id })

    if (result.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Credential not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[settings] Updated syncMode to ${syncMode} for credential ${credentialId}`)

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[settings] PATCH error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update settings',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
