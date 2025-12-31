/**
 * IMAP client using imapflow for stable TCP/TLS connections.
 * Replaces the cloudflare:sockets implementation which had TLS drop issues.
 */

import { ImapFlow } from 'imapflow'
import { APPROVED_SENDERS, isApprovedSender } from './approved-senders'
import { decryptPassword } from './encryption'

interface ImapCredentials {
  host: string
  port: number
  email: string
  encryptedPassword: string
  iv: string
  lastSyncAt: Date | null
}

interface FetchOptions {
  /** Override the since date (for manual sync with custom lookback) */
  lookbackDays?: number
}

interface Email {
  messageId: string
  from: string
  subject: string
  date: Date
  body: string
}

/**
 * Sample email preview (headers only, no body)
 */
export interface EmailPreview {
  from: string
  subject: string
  date: string
}

/**
 * Create an ImapFlow client with the given credentials
 */
function createClient(host: string, port: number, email: string, password: string): ImapFlow {
  return new ImapFlow({
    host,
    port,
    secure: port === 993, // Use TLS for port 993
    auth: {
      user: email,
      pass: password,
    },
    logger: false, // Disable verbose logging
  })
}

/**
 * Test IMAP connection with given credentials
 */
export async function testConnection(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string }
): Promise<{ success: boolean; error?: string }> {
  console.log(`[imap-client] Testing connection to ${credentials.host}:${credentials.port}...`)

  const client = createClient(
    credentials.host,
    credentials.port,
    credentials.email,
    credentials.password
  )

  try {
    await client.connect()
    console.log('[imap-client] Connection successful')
    await client.logout()
    return { success: true }
  } catch (error) {
    console.error('[imap-client] Connection failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    }
  }
}

/**
 * Fetch sample emails from approved senders (headers only) for preview.
 * Used during connection test to show users what will be synced.
 */
export async function fetchSampleEmails(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string },
  maxEmails = 10
): Promise<{ success: boolean; emails?: EmailPreview[]; error?: string }> {
  console.log(`[imap-client] Fetching sample emails from ${credentials.host}:${credentials.port}...`)

  const client = createClient(
    credentials.host,
    credentials.port,
    credentials.email,
    credentials.password
  )

  try {
    await client.connect()
    console.log('[imap-client] Connected, selecting INBOX...')

    const lock = await client.getMailboxLock('INBOX')
    const emails: EmailPreview[] = []

    try {
      // Get mailbox status
      const mailbox = client.mailbox
      if (!mailbox || mailbox.exists === 0) {
        console.log('[imap-client] Mailbox empty')
        return { success: true, emails: [] }
      }

      console.log(`[imap-client] Found ${mailbox.exists} messages, fetching last 100...`)

      // Fetch last 100 messages (or all if fewer)
      const startSeq = Math.max(1, mailbox.exists - 99)
      const range = `${startSeq}:*`

      for await (const msg of client.fetch(range, { envelope: true })) {
        const fromAddress = msg.envelope.from?.[0]?.address || ''

        if (isApprovedSender(fromAddress)) {
          const fromName = msg.envelope.from?.[0]?.name || ''
          emails.push({
            from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
            subject: msg.envelope.subject || '(no subject)',
            date: msg.envelope.date?.toISOString() || new Date().toISOString(),
          })

          if (emails.length >= maxEmails) break
        }
      }

      console.log(`[imap-client] Found ${emails.length} emails from approved senders`)
    } finally {
      lock.release()
    }

    await client.logout()
    return { success: true, emails }
  } catch (error) {
    console.error('[imap-client] Error fetching sample emails:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    }
  }
}

/**
 * Fetch emails from approved senders since last sync
 */
export async function fetchTicketEmails(
  credentials: ImapCredentials,
  encryptionKey: string,
  options?: FetchOptions
): Promise<Email[]> {
  console.log(`[imap-client] Fetching ticket emails from ${credentials.host}:${credentials.port}...`)

  // Decrypt password
  const password = await decryptPassword(
    credentials.encryptedPassword,
    credentials.iv,
    encryptionKey
  )

  const client = createClient(credentials.host, credentials.port, credentials.email, password)

  const emails: Email[] = []

  try {
    await client.connect()
    console.log('[imap-client] Connected')

    const lock = await client.getMailboxLock('INBOX')

    try {
      // Calculate since date
      let sinceDate: Date
      if (options?.lookbackDays) {
        sinceDate = new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000)
        console.log(`[imap-client] Using lookback of ${options.lookbackDays} days`)
      } else if (credentials.lastSyncAt) {
        sinceDate = credentials.lastSyncAt
        console.log(`[imap-client] Using lastSyncAt: ${sinceDate.toISOString()}`)
      } else {
        sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Default: last 30 days
        console.log('[imap-client] Using default 30 day lookback')
      }

      // Search for emails from each approved sender
      for (const sender of APPROVED_SENDERS) {
        try {
          const results = await client.search({
            from: sender,
            since: sinceDate,
          })

          if (results.length === 0) continue

          console.log(`[imap-client] Found ${results.length} emails from ${sender}`)

          // Limit to 10 per sender
          const uidsToFetch = results.slice(0, 10)

          for await (const msg of client.fetch(uidsToFetch, {
            envelope: true,
            source: true, // Fetch full message source for body extraction
          })) {
            const from = msg.envelope.from?.[0]
            const fromAddress = from?.address || ''
            const fromName = from?.name || ''

            // Extract text body from source
            let body = ''
            if (msg.source) {
              // Simple extraction - get everything after the headers
              const sourceStr = msg.source.toString()
              const headerEnd = sourceStr.indexOf('\r\n\r\n')
              if (headerEnd !== -1) {
                body = sourceStr.slice(headerEnd + 4, headerEnd + 10004) // Limit to ~10KB
              }
            }

            emails.push({
              messageId: msg.envelope.messageId || `${msg.uid}@unknown`,
              from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
              subject: msg.envelope.subject || '(no subject)',
              date: msg.envelope.date || new Date(),
              body: body.trim(),
            })
          }
        } catch (searchError) {
          console.error(`[imap-client] Error searching for ${sender}:`, searchError)
          // Continue with other senders
        }
      }

      console.log(`[imap-client] Total: ${emails.length} ticket emails`)
    } finally {
      lock.release()
    }

    await client.logout()
  } catch (error) {
    console.error('[imap-client] Error fetching ticket emails:', error)
    throw error
  }

  return emails
}
