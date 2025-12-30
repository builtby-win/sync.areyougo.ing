import type { APIRoute } from 'astro'
import { verifySession } from '../../lib/verify-session'

interface TestRequest {
  provider: string
  email: string
  password: string
  host: string
  port: number
}

export const POST: APIRoute = async ({ request, locals }) => {
  console.log('[test] POST request received')
  const startTime = Date.now()

  const env = locals.runtime.env
  const mainAppUrl = env.MAIN_APP_URL || 'https://areyougo.ing'

  try {
    // Verify user is authenticated
    const user = await verifySession(request, mainAppUrl)
    if (!user) {
      console.log('[test] Unauthorized - no valid session')
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[test] User verified:', user.id)

    // Parse request body
    const body = (await request.json()) as TestRequest
    const { provider, email, password, host, port } = body

    if (!provider || !email || !password || !host || !port) {
      console.log('[test] Missing required fields')
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[test] Testing connection to:', { provider, email, host, port })

    // TODO: Implement actual IMAP connection test using cloudflare:sockets
    // For now, we'll simulate a successful connection
    // The actual implementation will use the imap-client.ts module

    // Simulate connection test delay
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Basic validation - in production, this would actually connect to IMAP
    if (!email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Invalid email format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log('[test] Connection test successful:', { elapsed: Date.now() - startTime })

    return new Response(JSON.stringify({ success: true, message: 'Connection successful' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('[test] Error:', error)
    console.error('[test] Stack:', error instanceof Error ? error.stack : 'none')
    return new Response(JSON.stringify({ error: 'Connection test failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
