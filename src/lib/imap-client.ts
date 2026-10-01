/**
 * IMAP client using imapflow for stable TCP/TLS connections.
 * Replaces the cloudflare:sockets implementation which had TLS drop issues.
 */

import { convert } from 'html-to-text'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { APPROVED_SENDERS, isApprovedSender } from './approved-senders'
import { TICKET_KEYWORDS } from './email-filter'
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
  /** Explicit start date (overrides lookbackDays) */
  sinceDate?: string
  /** Explicit end date (defaults to now) */
  beforeDate?: string
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
 * Safely logout and destroy the client socket to prevent lingering timers or unhandled errors.
 */
async function safelyCloseClient(client: ImapFlow): Promise<void> {
  try {
    if (client.usable) {
      await client.logout()
    } else {
      client.close()
    }
  } catch {
    try {
      client.close()
    } catch {
      // Ignore
    }
  }
}

/**
 * Discover mailboxes to scan for tickets. Always includes INBOX.
 * Also includes Archive if present (critical for iCloud and swipe-to-archive users).
 */
async function getMailboxesToScan(client: ImapFlow): Promise<string[]> {
  const mailboxesToScan: string[] = ['INBOX']
  try {
    const list = await client.list()
    for (const mb of list) {
      const isArchive =
        mb.specialUse === '\\Archive' ||
        mb.name.toLowerCase() === 'archive' ||
        mb.path.toLowerCase() === 'archive' ||
        mb.path.toLowerCase() === 'archives'
      if (isArchive && !mailboxesToScan.includes(mb.path)) {
        mailboxesToScan.push(mb.path)
      }
    }
  } catch (err) {
    console.warn('[imap-client] Failed to list mailboxes, defaulting to INBOX:', err)
  }
  return mailboxesToScan
}

/**
 * Create an ImapFlow client with the given credentials
 */
function createClient(host: string, port: number, email: string, password: string): ImapFlow {
  const client = new ImapFlow({
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

  // Prevent unhandled 'error' events on the EventEmitter from terminating Node.js
  client.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[imapflow:handled-error] Background client error for ${email}:`, message)
  })

  return client
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
    return { success: true }
  } catch (error) {
    console.error('[imap-client] Connection failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    }
  } finally {
    await safelyCloseClient(client)
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
    console.log('[imap-client] Connected, selecting mailboxes...')

    const mailboxesToScan = await getMailboxesToScan(client)
    const emails: EmailPreview[] = []

    for (const mailboxPath of mailboxesToScan) {
      if (emails.length >= maxEmails) break
      let lock
      try {
        lock = await client.getMailboxLock(mailboxPath)
      } catch (lockError) {
        console.warn(`[imap-client] Could not lock mailbox "${mailboxPath}":`, lockError)
        continue
      }

      try {
        const mailbox = client.mailbox
        if (!mailbox || mailbox.exists === 0) continue

        console.log(
          `[imap-client] Found ${mailbox.exists} messages in ${mailboxPath}, fetching last 100...`,
        )

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
      } finally {
        lock.release()
      }
    }

    console.log(`[imap-client] Found ${emails.length} emails from approved senders`)
    return { success: true, emails }
  } catch (error) {
    console.error('[imap-client] Error fetching sample emails:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    }
  } finally {
    await safelyCloseClient(client)
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
  const seenMessageIds = new Set<string>()

  try {
    // Signal connection progress
    progress?.onConnecting?.()
    console.log('[imap-client] Connecting...')

    progress?.onAuthenticating?.()
    console.log('[imap-client] Authenticating...')

    await client.connect()

    progress?.onConnected?.()
    console.log('[imap-client] Connected')

    const mailboxesToScan = await getMailboxesToScan(client)
    console.log(`[imap-client] Mailboxes to scan: ${mailboxesToScan.join(', ')}`)

    // Calculate date range
    let sinceDate: Date
    if (options?.sinceDate) {
      sinceDate = new Date(options.sinceDate)
      console.log(`[imap-client] Using explicit sinceDate: ${sinceDate.toISOString()}`)
    } else if (options?.lookbackDays) {
      sinceDate = new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000)
      console.log(`[imap-client] Using lookback of ${options.lookbackDays} days`)
    } else if (credentials.lastSyncAt) {
      sinceDate = credentials.lastSyncAt
      console.log(`[imap-client] Using lastSyncAt: ${sinceDate.toISOString()}`)
    } else {
      sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Default: last 30 days
      console.log('[imap-client] Using default 30 day lookback')
    }

    const beforeDate = options?.beforeDate ? new Date(options.beforeDate) : undefined
    if (beforeDate) {
      console.log(`[imap-client] Using explicit beforeDate: ${beforeDate.toISOString()}`)
    }

    // Search for emails from each approved sender across all candidate mailboxes
    for (const sender of APPROVED_SENDERS) {
      console.log(`[imap-client] Searching for emails from ${sender}...`)
      progress?.onSenderStart(sender)

      const senderEmails: Email[] = []

      for (const mailboxPath of mailboxesToScan) {
        let lock
        try {
          lock = await client.getMailboxLock(mailboxPath)
        } catch (lockError) {
          console.warn(`[imap-client] Could not lock mailbox "${mailboxPath}":`, lockError)
          continue
        }

        try {
          const results = await client.search({
            from: sender,
            since: sinceDate,
            ...(beforeDate && { before: beforeDate }),
          })

          if (!results) continue

          let resultArray: number[]
          if (Array.isArray(results)) {
            resultArray = results
          } else if ((results as unknown) instanceof Set) {
            resultArray = Array.from(results as Set<number>)
          } else {
            continue
          }

          if (resultArray.length === 0) continue

          console.log(
            `[imap-client] Found ${resultArray.length} emails from ${sender} in ${mailboxPath}`,
          )

          const uidsToFetch = resultArray.slice(0, 10)

          for await (const msg of client.fetch(uidsToFetch, {
            envelope: true,
            source: true,
          })) {
            if (!msg.envelope) continue
            const from = msg.envelope.from?.[0]
            const fromAddress = from?.address || ''
            const fromName = from?.name || ''

            let body = ''
            if (msg.source) {
              const parsed = await simpleParser(msg.source)
              const text = parsed.text || ''
              const html = parsed.html || ''

              if (text.length < 100 && html.length > 0) {
                body = convert(html, {
                  wordwrap: 130,
                  selectors: [
                    { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
                    { selector: 'img', format: 'skip' },
                  ],
                })
              } else {
                body = text
              }
            }

            const rawDate = msg.envelope.date || new Date(0)
            const stableDate = new Date(Math.floor(rawDate.getTime() / 1000) * 1000)
            const messageId = msg.envelope.messageId || `${msg.uid}@${mailboxPath}`

            if (seenMessageIds.has(messageId)) continue
            seenMessageIds.add(messageId)

            const email: Email = {
              messageId,
              from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
              subject: msg.envelope.subject || '(no subject)',
              date: stableDate,
              body: body.trim(),
            }
            emails.push(email)
            senderEmails.push(email)
          }
        } catch (searchError) {
          console.error(
            `[imap-client] Error searching for ${sender} in ${mailboxPath}:`,
            searchError,
          )
        } finally {
          lock.release()
        }
      }

      progress?.onSenderComplete(sender, senderEmails)
    }

    console.log(`[imap-client] Total: ${emails.length} ticket emails`)
  } catch (error) {
    console.error('[imap-client] Error fetching ticket emails:', error)
    progress?.onConnectionError?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    await safelyCloseClient(client)
  }

  return emails
}

/**
 * Search emails by a user-provided query term (subject OR from) and filter by ticket keywords.
 * Used for manual "power search" mode where users can find ticket emails from any sender.
 */
export async function searchEmailsByQuery(
  credentials: ImapCredentials,
  encryptionKey: string,
  options: { lookbackDays?: number; sinceDate?: string; beforeDate?: string; searchTerm: string },
  progress?: FetchProgressCallback,
  plaintextPassword?: string,
): Promise<Email[]> {
  const { searchTerm } = options
  console.log(
    `[imap-client] Searching emails by query "${searchTerm}" from ${credentials.host}:${credentials.port}...`,
  )

  const password =
    plaintextPassword ||
    (await decryptPassword(credentials.encryptedPassword, credentials.iv, encryptionKey))

  const client = createClient(credentials.host, credentials.port, credentials.email, password)

  const emails: Email[] = []
  const seenMessageIds = new Set<string>()

  try {
    progress?.onConnecting?.()
    progress?.onAuthenticating?.()
    await client.connect()
    progress?.onConnected?.()

    const mailboxesToScan = await getMailboxesToScan(client)
    console.log(`[imap-client] Query search mailboxes: ${mailboxesToScan.join(', ')}`)

    // Calculate date range
    let sinceDate: Date
    if (options.sinceDate) {
      sinceDate = new Date(options.sinceDate)
    } else if (options.lookbackDays) {
      sinceDate = new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000)
    } else {
      sinceDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    }
    const beforeDate = options.beforeDate ? new Date(options.beforeDate) : undefined

    progress?.onSenderStart(searchTerm)

    for (const mailboxPath of mailboxesToScan) {
      let lock
      try {
        lock = await client.getMailboxLock(mailboxPath)
      } catch (lockError) {
        console.warn(`[imap-client] Could not lock mailbox "${mailboxPath}":`, lockError)
        continue
      }

      try {
        const results = await client.search({
          or: [{ subject: searchTerm }, { from: searchTerm }],
          since: sinceDate,
          ...(beforeDate && { before: beforeDate }),
        })

        if (!results) continue

        let resultArray: number[]
        if (Array.isArray(results)) {
          resultArray = results
        } else if ((results as unknown) instanceof Set) {
          resultArray = Array.from(results as Set<number>)
        } else {
          continue
        }

        if (resultArray.length === 0) continue

        console.log(
          `[imap-client] Found ${resultArray.length} emails matching "${searchTerm}" in ${mailboxPath}`,
        )

        // Limit to 50 results
        const uidsToFetch = resultArray.slice(0, 50)

        for await (const msg of client.fetch(uidsToFetch, {
          envelope: true,
          source: true,
        })) {
          if (!msg.envelope) continue
          const from = msg.envelope.from?.[0]
          const fromAddress = from?.address || ''
          const fromName = from?.name || ''

          let body = ''
          if (msg.source) {
            const parsed = await simpleParser(msg.source)
            const text = parsed.text || ''
            const html = parsed.html || ''

            if (text.length < 100 && html.length > 0) {
              body = convert(html, {
                wordwrap: 130,
                selectors: [
                  { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
                  { selector: 'img', format: 'skip' },
                ],
              })
            } else {
              body = text
            }
          }

          const rawDate = msg.envelope.date || new Date(0)
          const stableDate = new Date(Math.floor(rawDate.getTime() / 1000) * 1000)
          const messageId = msg.envelope.messageId || `${msg.uid}@${mailboxPath}`

          if (seenMessageIds.has(messageId)) continue
          seenMessageIds.add(messageId)

          emails.push({
            messageId,
            from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
            subject: msg.envelope.subject || '(no subject)',
            date: stableDate,
            body: body.trim(),
          })
        }
      } catch (searchError) {
        console.error(
          `[imap-client] Error searching for query "${searchTerm}" in ${mailboxPath}:`,
          searchError,
        )
      } finally {
        lock.release()
      }
    }

    // Client-side filter: keep only emails with a ticket keyword in the subject
    const filtered = emails.filter((e) => {
      const lowerSubject = e.subject.toLowerCase()
      return TICKET_KEYWORDS.some((kw) => lowerSubject.includes(kw))
    })

    // Replace emails array contents with filtered results
    emails.length = 0
    emails.push(...filtered)

    console.log(`[imap-client] After ticket keyword filter: ${filtered.length} emails remain`)

    progress?.onSenderComplete(searchTerm, filtered)
  } catch (error) {
    console.error('[imap-client] Error in searchEmailsByQuery:', error)
    progress?.onConnectionError?.(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    await safelyCloseClient(client)
  }

  return emails
}
