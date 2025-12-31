import type { APIRoute } from 'astro'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../lib/db'
import { imapCredentials, syncHistory } from '../../lib/schema'
import { verifySession } from '../../lib/verify-session'

interface DeleteRequest {
  credentialId: string
}

export const DELETE: APIRoute = async ({ request }) => {
  console.log('[delete] DELETE request received')
  const startTime = Date.now()

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'

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

    // Parse request body
    const body = (await request.json()) as DeleteRequest
    const { credentialId } = body

    if (!credentialId) {
      return new Response(JSON.stringify({ error: 'credentialId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const db = getDb()

    // Delete specific IMAP credential (must belong to user)
    const result = await db
      .delete(imapCredentials)
      .where(and(eq(imapCredentials.id, credentialId), eq(imapCredentials.userId, user.id)))
      .returning({ id: imapCredentials.id })

    if (result.length === 0) {
      console.log('[delete] Credential not found:', credentialId)
      return new Response(JSON.stringify({ error: 'Credential not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Delete sync history for this specific credential
    await db.delete(syncHistory).where(eq(syncHistory.credentialId, credentialId))

    console.log('[delete] Successfully deleted credential and history:', {
      credentialId,
      elapsed: Date.now() - startTime,
    })

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
