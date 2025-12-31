import type { APIRoute } from 'astro'
import { getSession } from '../../lib/sync-sessions'
import { verifySession } from '../../lib/verify-session'

export const GET: APIRoute = async ({ request, url }) => {
  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'

  // Verify user is authenticated
  const user = await verifySession(request, mainAppUrl)
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
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

  // Security: verify session belongs to requesting user
  if (session.userId !== user.id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(
    JSON.stringify({
      status: session.status,
      emails: session.emails,
      totalFound: session.totalFound,
      totalIngested: session.totalIngested,
      error: session.error,
      // Progressive fetch tracking
      currentSender: session.currentSender,
      sendersCompleted: session.sendersCompleted,
      sendersTotal: session.sendersTotal,
      // Connection state tracking
      connectionState: session.connectionState,
      connectionError: session.connectionError,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  )
}
