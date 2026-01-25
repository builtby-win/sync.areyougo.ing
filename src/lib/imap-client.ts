/**
 * IMAP client using imapflow for stable TCP/TLS connections.
 * Replaces the cloudflare:sockets implementation which had TLS drop issues.
 */

import { ImapFlow } from 'imapflow'
import { convert } from 'html-to-text'
import { simpleParser } from 'mailparser'
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

/**
 * Progress callbacks for tracking connection and fetch progress
 */
export interface FetchProgressCallback {
  // Connection state callbacks
  onConnecting?: () => void
  onAuthenticating?: () => void
  onConnected?: () => void
  onConnectionError?: (error: Error) => void
  // Sender progress callbacks
  onSenderStart: (sender: string) => void
  onSenderComplete: (sender: string, emails: Email[]) => void
  onError: (sender: string, error: Error) => void
}

export interface Email {
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
    // Enable logging to debug iCloud IMAP issues
    logger: {
      debug: (msg: unknown) => console.log('[imapflow:debug]', msg),
      info: (msg: unknown) => console.log('[imapflow:info]', msg),
      warn: (msg: unknown) => console.warn('[imapflow:warn]', msg),
      error: (msg: unknown) => console.error('[imapflow:error]', msg),
    },
  })
}

/**
 * Test IMAP connection with given credentials
 */
export async function testConnection(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string },
): Promise<{ success: boolean; error?: string }> {
  console.log(`[imap-client] Testing connection to ${credentials.host}:${credentials.port}...`)

  const client = createClient(
    credentials.host,
    credentials.port,
    credentials.email,
    credentials.password,
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
  maxEmails = 10,
): Promise<{ success: boolean; emails?: EmailPreview[]; error?: string }> {
  console.log(
    `[imap-client] Fetching sample emails from ${credentials.host}:${credentials.port}...`,
  )

  const client = createClient(
    credentials.host,
    credentials.port,
    credentials.email,
    credentials.password,
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
        if (!msg.envelope) continue
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
 * @param progress - Optional callbacks for progressive UI updates
 * @param plaintextPassword - Optional plaintext password (bypasses encryption, used for test connections)
 */
export async function fetchTicketEmails(
  credentials: ImapCredentials,
  encryptionKey: string,
  options?: FetchOptions,
  progress?: FetchProgressCallback,
  plaintextPassword?: string,
): Promise<Email[]> {
  console.log(
    `[imap-client] Fetching ticket emails from ${credentials.host}:${credentials.port}...`,
  )

  // Use plaintext password if provided, otherwise decrypt
  const password =
    plaintextPassword ||
    (await decryptPassword(credentials.encryptedPassword, credentials.iv, encryptionKey))

  const client = createClient(credentials.host, credentials.port, credentials.email, password)

  const emails: Email[] = []

  try {
    // Signal connection progress
    progress?.onConnecting?.()
    console.log('[imap-client] Connecting...')

    progress?.onAuthenticating?.()
    console.log('[imap-client] Authenticating...')

    await client.connect()

    progress?.onConnected?.()
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
        // IMAP FROM search matches if the string appears anywhere in the FROM field
        // So 'ticketmaster' will match @ticketmaster.com, @email.ticketmaster.com, etc.
        console.log(`[imap-client] Searching for emails from ${sender}...`)
        progress?.onSenderStart(sender)

        // Track emails found for this sender (for progress callback)
        const senderEmails: Email[] = []

        try {
          const results = await client.search({
            from: sender,
            since: sinceDate,
          })

          // Debug logging to understand what iCloud returns
          console.log(`[imap-client] Raw search results for ${sender}:`, {
            type: typeof results,
            isArray: Array.isArray(results),
            isSet: results instanceof Set,
            isFalsy: !results,
            constructorName: results?.constructor?.name,
            value: results,
          })

          // Handle all possible return values from imapflow search
          // - Array<number>: normal success case
          // - false: error or not in SELECTED state
          // - undefined: no mailbox selected
          if (!results) {
            console.log(`[imap-client] No results for ${sender} (returned ${results})`)
            progress?.onSenderComplete(sender, [])
            continue
          }

          // Convert to array - imapflow returns Array, but handle Set for safety
          let resultArray: number[]
          if (Array.isArray(results)) {
            resultArray = results
          } else if ((results as any) instanceof Set) {
            resultArray = Array.from(results as unknown as Set<number>)
          } else {
            console.warn(
              `[imap-client] Unexpected search result type for ${sender}:`,
              typeof results,
              results,
            )
            progress?.onSenderComplete(sender, [])
            continue
          }

          if (resultArray.length === 0) {
            progress?.onSenderComplete(sender, [])
            continue
          }

          console.log(`[imap-client] Found ${resultArray.length} emails from ${sender}`)

          // Limit to 10 per sender
          const uidsToFetch = resultArray.slice(0, 10)

          for await (const msg of client.fetch(uidsToFetch, {
            envelope: true,
            source: true, // Fetch full message source for body extraction
          })) {
            if (!msg.envelope) continue
            const from = msg.envelope.from?.[0]
            const fromAddress = from?.address || ''
            const fromName = from?.name || ''

            // Extract plaintext body using mailparser
            let body = ''
            if (msg.source) {
              const parsed = await simpleParser(msg.source)
              const text = parsed.text || ''
              const html = parsed.html || ''

              // Some providers (like Ticketmaster) send a "text/plain" part that is just a single word
              // or very short, while the real content is in the HTML part.
              // If text is suspiciously short (< 100 chars) and we have HTML, prefer the HTML-to-text conversion.
              if (text.length < 100 && html.length > 0) {
                body = convert(html, {
                  wordwrap: 130,
                  selectors: [
                    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
                    { selector: 'img', format: 'skip' }, // Skip images to reduce noise
                  ],
                })
              } else {
                body = text
              }
            }

            const email: Email = {
              messageId: msg.envelope.messageId || `${msg.uid}@unknown`,
              from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
              subject: msg.envelope.subject || '(no subject)',
              date: msg.envelope.date || new Date(),
              body: body.trim(),
            }
            emails.push(email)
            senderEmails.push(email)
          }

          // Notify progress callback with this sender's emails
          progress?.onSenderComplete(sender, senderEmails)
        } catch (searchError) {
          console.error(`[imap-client] Error searching for ${sender}:`, searchError)
          progress?.onError(
            sender,
            searchError instanceof Error ? searchError : new Error(String(searchError)),
          )
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
    progress?.onConnectionError?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  }

  return emails
}
