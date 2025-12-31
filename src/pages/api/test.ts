import type { APIRoute } from 'astro'
import { fetchSampleEmails, type EmailPreview } from '../../lib/imap-client'
import { verifySession } from '../../lib/verify-session'

interface TestRequest {
  provider: string
  email: string
  password: string
  host: string
  port: number
}

interface TestResponse {
  success: boolean
  message?: string
  error?: string
  sampleEmails?: EmailPreview[]
}

export const POST: APIRoute = async ({ request }) => {
  console.log('[test] POST request received')
  const startTime = Date.now()

  const mainAppUrl = process.env.MAIN_APP_URL || 'https://areyougo.ing'

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

    // Test connection and fetch sample emails from approved senders
    const result = await fetchSampleEmails({
      host,
      port,
      email,
      password,
    })

    console.log('[test] Connection test result:', {
      success: result.success,
      emailCount: result.emails?.length ?? 0,
      elapsed: Date.now() - startTime,
    })

    if (!result.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: result.error || 'Connection failed',
        } satisfies TestResponse),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Connection successful',
        sampleEmails: result.emails || [],
      } satisfies TestResponse),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('[test] Error:', error)
    console.error('[test] Stack:', error instanceof Error ? error.stack : 'none')
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed',
      } satisfies TestResponse),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
