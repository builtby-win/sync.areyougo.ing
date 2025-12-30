import type { APIRoute } from 'astro'
import { verifySession } from '../../lib/verify-session'

export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env
  const mainAppUrl = env.MAIN_APP_URL || 'https://areyougo.ing'

  // Verify user is authenticated
  const user = await verifySession(request, mainAppUrl)
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Return the public encryption key
  // This key is used for client-side encryption
  const key = env.ENCRYPTION_KEY
  if (!key) {
    console.error('[encryption-key] ENCRYPTION_KEY not configured')
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ key }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
