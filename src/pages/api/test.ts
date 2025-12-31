import type { APIRoute } from 'astro'
import { APPROVED_SENDERS } from '../../lib/approved-senders'
import { fetchTicketEmails } from '../../lib/imap-client'
import {
  addEmailToSession,
  cleanupSessions,
  createSession,
  markSenderCompleted,
  updateConnectionState,
  updateCurrentSender,
  updateSession,
} from '../../lib/sync-sessions'
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
  sessionId?: string
}

// Default lookback for test: 30 days
const TEST_LOOKBACK_DAYS = 30

// Async function to process test connection in background
async function processTest(
  sessionId: string,
  email: string,
  password: string,
  host: string,
  port: number
) {
  try {
    // Fetch emails from approved senders with progress callbacks (no ingest)
    await fetchTicketEmails(
      {
        host,
        port,
        email,
        encryptedPassword: '', // Not used - password passed directly
        iv: '', // Not used
        lastSyncAt: null,
      },
      '', // encryption key not needed
      { lookbackDays: TEST_LOOKBACK_DAYS },
      {
        onConnecting: () => {
          console.log(`[test:${sessionId}] Connecting...`)
          updateConnectionState(sessionId, 'connecting')
        },
        onAuthenticating: () => {
          console.log(`[test:${sessionId}] Authenticating...`)
          updateConnectionState(sessionId, 'authenticating')
        },
        onConnected: () => {
          console.log(`[test:${sessionId}] Connected!`)
          updateConnectionState(sessionId, 'connected')
        },
        onConnectionError: (error) => {
          console.error(`[test:${sessionId}] Connection error:`, error)
          updateConnectionState(sessionId, 'error', error.message)
        },
        onSenderStart: (sender) => {
          console.log(`[test:${sessionId}] Searching ${sender}...`)
          updateCurrentSender(sessionId, sender)
        },
        onSenderComplete: (sender, emails) => {
          console.log(`[test:${sessionId}] Found ${emails.length} emails from ${sender}`)
          markSenderCompleted(sessionId, sender)
          // Add emails to session (preview only, no ingest)
          for (const emailData of emails) {
            addEmailToSession(sessionId, {
              messageId: emailData.messageId,
              from: emailData.from,
              subject: emailData.subject,
              date: emailData.date.toISOString(),
              body: emailData.body,
              ingestStatus: 'pending', // Will stay pending (no ingest for test)
            })
          }
        },
        onError: (sender, error) => {
          console.error(`[test:${sessionId}] Error searching ${sender}:`, error)
          markSenderCompleted(sessionId, sender)
        },
      },
      password // Pass password directly instead of using encryption
    )

    // Clear current sender and mark complete (no ingesting for test)
    updateCurrentSender(sessionId, undefined)
    updateSession(sessionId, { status: 'completed', completedAt: new Date() })
    console.log(`[test:${sessionId}] Test complete`)
  } catch (error) {
    console.error(`[test:${sessionId}] Error:`, error)
    updateSession(sessionId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Connection test failed',
      completedAt: new Date(),
    })
    throw error
  }
}

export const POST: APIRoute = async ({ request }) => {
  console.log('[test] POST request received')

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

    // Create session and process asynchronously
    cleanupSessions()
    const sessionId = createSession(user.id, APPROVED_SENDERS.length)

    // Start async processing (don't await)
    processTest(sessionId, email, password, host, port).catch((err) => {
      console.error(`[test:${sessionId}] Async test error:`, err)
      updateSession(sessionId, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Connection test failed',
        completedAt: new Date(),
      })
    })

    // Return immediately with sessionId for polling
    return new Response(
      JSON.stringify({
        success: true,
        sessionId,
        message: 'Test started',
      } satisfies TestResponse),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
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
