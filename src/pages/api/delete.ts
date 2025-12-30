import type { APIRoute } from 'astro'
import { verifySession } from '../../lib/verify-session'
import { getDb } from '../../lib/db'
import { imapCredentials, syncHistory } from '../../lib/schema'
import { eq } from 'drizzle-orm'

export const DELETE: APIRoute = async ({ request, locals }) => {
  console.log('[delete] DELETE request received')
  const startTime = Date.now()

  const env = locals.runtime.env
  const mainAppUrl = env.MAIN_APP_URL || 'https://areyougo.ing'

  try {
    // Verify user is authenticated
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      console.log('[delete] Unauthorized - no valid session')
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[delete] User verified:', user.id)

    const db = getDb(env)

    // Delete IMAP credentials
    const result = await db
      .delete(imapCredentials)
      .where(eq(imapCredentials.userId, user.id))
      .returning({ id: imapCredentials.id })

    if (result.length === 0) {
      console.log('[delete] No credentials found for user')
      return new Response(JSON.stringify({ error: 'No credentials found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Also delete sync history for this user
    await db.delete(syncHistory).where(eq(syncHistory.userId, user.id))

    console.log('[delete] Successfully deleted credentials and history:', { elapsed: Date.now() - startTime })

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[delete] Error:', error)
    console.error('[delete] Stack:', error instanceof Error ? error.stack : 'none')
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
