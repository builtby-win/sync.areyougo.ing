import type { APIRoute } from 'astro'
import { eq } from 'drizzle-orm'
import { getDb } from '../../lib/db'
import { imapCredentials } from '../../lib/schema'
import { verifySession } from '../../lib/verify-session'

type SyncMode = 'manual' | 'auto_daily'

interface SettingsRequest {
  syncMode: SyncMode
}

interface SettingsResponse {
  success: boolean
  error?: string
  settings?: {
    syncMode: SyncMode
    lastSyncAt: string | null
    lastManualSyncAt: string | null
    provider: string
    imapEmail: string
  }
}

// GET - Fetch current settings
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
      .limit(1)

    if (creds.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No IMAP credentials configured' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const cred = creds[0]

    return new Response(
      JSON.stringify({
        success: true,
        settings: {
          syncMode: cred.syncMode as SyncMode,
          lastSyncAt: cred.lastSyncAt?.toISOString() || null,
          lastManualSyncAt: cred.lastManualSyncAt?.toISOString() || null,
          provider: cred.provider,
          imapEmail: cred.imapEmail,
        },
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

// PATCH - Update settings
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
    const { syncMode } = body

    // Validate syncMode
    if (!['manual', 'auto_daily'].includes(syncMode)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid syncMode. Must be "manual" or "auto_daily".' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const db = getDb()

    // Check if user has credentials
    const existing = await db
      .select({ id: imapCredentials.id })
      .from(imapCredentials)
      .where(eq(imapCredentials.userId, user.id))
      .limit(1)

    if (existing.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No IMAP credentials configured' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Update syncMode
    await db
      .update(imapCredentials)
      .set({
        syncMode,
        updatedAt: new Date(),
      })
      .where(eq(imapCredentials.userId, user.id))

    console.log(`[settings] Updated syncMode to ${syncMode} for user ${user.id}`)

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
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
