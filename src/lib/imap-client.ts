/**
 * IMAP client using cloudflare:sockets for TCP/TLS connections.
 * This is a minimal implementation focused on fetching emails from approved senders.
 */

import { connect } from 'cloudflare:sockets'
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
 * Simple line-based IMAP response reader
 */
class ImapReader {
  private buffer = ''
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private decoder = new TextDecoder()

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader
  }

  async readLine(): Promise<string> {
    while (!this.buffer.includes('\r\n')) {
      const { value, done } = await this.reader.read()
      if (done) throw new Error('Connection closed')
      this.buffer += this.decoder.decode(value)
    }
    const lineEnd = this.buffer.indexOf('\r\n')
    const line = this.buffer.slice(0, lineEnd)
    this.buffer = this.buffer.slice(lineEnd + 2)
    return line
  }

  async readUntilTag(tag: string): Promise<string[]> {
    const lines: string[] = []
    let line = await this.readLine()
    while (!line.startsWith(tag)) {
      lines.push(line)
      line = await this.readLine()
    }
    lines.push(line) // Include the tagged response
    return lines
  }
}

/**
 * Send an IMAP command and wait for response
 */
async function sendCommand(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ImapReader,
  tag: string,
  command: string
): Promise<string[]> {
  const encoder = new TextEncoder()
  await writer.write(encoder.encode(`${tag} ${command}\r\n`))
  return await reader.readUntilTag(tag)
}

/**
 * Test IMAP connection with given credentials
 */
export async function testConnection(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string }
): Promise<{ success: boolean; error?: string }> {
  console.log(`[imap-client] Connecting to ${credentials.host}:${credentials.port}...`)

  // Add timeout for local dev where cloudflare:sockets may not work
  const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'Connection timed out. TCP sockets may not work in local development - try deploying to Cloudflare.' }), 15000)
  )

  const testPromise = testConnectionImpl(credentials)

  return Promise.race([testPromise, timeoutPromise])
}

async function testConnectionImpl(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    // Port 993 uses implicit TLS (connect with TLS immediately)
    // Port 143 would use STARTTLS (upgrade plaintext to TLS)
    const useImplicitTls = credentials.port === 993

    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
      secureTransport: useImplicitTls ? 'on' : 'starttls',
    })

    // For STARTTLS, upgrade after connecting; for implicit TLS, already secure
    const secureSocket = useImplicitTls ? socket : socket.startTls()
    console.log('[imap-client] TLS connection established')

    const reader = new ImapReader(secureSocket.readable.getReader())
    const writer = secureSocket.writable.getWriter()

    // Read greeting
    const greeting = await reader.readLine()
    console.log('[imap-client] Server greeting received')

    if (!greeting.startsWith('* OK')) {
      return { success: false, error: 'Unexpected server greeting' }
    }

    // Login
    console.log('[imap-client] Logging in...')
    const loginResponse = await sendCommand(
      writer,
      reader,
      'A001',
      `LOGIN "${credentials.email}" "${credentials.password}"`
    )

    const loginResult = loginResponse[loginResponse.length - 1]
    if (!loginResult.includes('OK')) {
      console.log('[imap-client] Login failed:', loginResult)
      return { success: false, error: 'Invalid credentials' }
    }
    console.log('[imap-client] Login successful')

    // Logout
    await sendCommand(writer, reader, 'A002', 'LOGOUT')

    await writer.close()
    console.log('[imap-client] Connection test complete')

    return { success: true }
  } catch (error) {
    console.error('[imap-client] Connection error:', error)
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
  console.log('[imap-client] Fetching emails from:', credentials.host)

  const password = await decryptPassword(credentials.encryptedPassword, credentials.iv, encryptionKey)

  try {
    // Port 993 uses implicit TLS (connect with TLS immediately)
    // Port 143 would use STARTTLS (upgrade plaintext to TLS)
    const useImplicitTls = credentials.port === 993

    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
      secureTransport: useImplicitTls ? 'on' : 'starttls',
    })

    const secureSocket = useImplicitTls ? socket : socket.startTls()

    const reader = new ImapReader(secureSocket.readable.getReader())
    const writer = secureSocket.writable.getWriter()

    // Read greeting
    await reader.readLine()

    // Login
    const loginResponse = await sendCommand(
      writer,
      reader,
      'A001',
      `LOGIN "${credentials.email}" "${password}"`
    )

    if (!loginResponse[loginResponse.length - 1].includes('OK')) {
      throw new Error('Login failed')
    }

    // Select INBOX
    const selectResponse = await sendCommand(writer, reader, 'A002', 'SELECT INBOX')
    console.log('[imap-client] Selected INBOX:', selectResponse.length, 'lines')

    // Build search criteria - use lookbackDays if specified, otherwise lastSyncAt
    let sinceDate: string
    if (options?.lookbackDays) {
      sinceDate = formatImapDate(new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000))
      console.log(`[imap-client] Using lookback of ${options.lookbackDays} days`)
    } else if (credentials.lastSyncAt) {
      sinceDate = formatImapDate(credentials.lastSyncAt)
    } else {
      sinceDate = formatImapDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) // Default: last 30 days
    }

    // Search for emails from approved senders
    const emails: Email[] = []

    for (const sender of APPROVED_SENDERS) {
      const searchResponse = await sendCommand(
        writer,
        reader,
        'A003',
        `SEARCH FROM "${sender}" SINCE ${sinceDate}`
      )

      // Parse search results (format: * SEARCH 1 2 3 4)
      const searchLine = searchResponse.find((line) => line.startsWith('* SEARCH'))
      if (!searchLine) continue

      const messageIds = searchLine
        .replace('* SEARCH', '')
        .trim()
        .split(' ')
        .filter((id) => id)

      console.log(`[imap-client] Found ${messageIds.length} emails from ${sender}`)

      // Fetch each email
      for (const msgId of messageIds.slice(0, 10)) {
        // Limit to 10 per sender
        try {
          const email = await fetchEmail(writer, reader, msgId)
          if (email) {
            emails.push(email)
          }
        } catch (error) {
          console.error(`[imap-client] Error fetching message ${msgId}:`, error)
        }
      }
    }

    // Logout
    await sendCommand(writer, reader, 'A999', 'LOGOUT')
    await writer.close()

    console.log(`[imap-client] Fetched ${emails.length} total emails`)
    return emails
  } catch (error) {
    console.error('[imap-client] Fetch error:', error)
    throw error
  }
}

/**
 * Fetch a single email by message ID
 */
async function fetchEmail(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ImapReader,
  messageId: string
): Promise<Email | null> {
  const tag = `F${messageId}`

  // Fetch headers and body preview
  const response = await sendCommand(
    writer,
    reader,
    tag,
    `FETCH ${messageId} (BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] BODY[TEXT]<0.10000>)`
  )

  // Parse response
  const headers: Record<string, string> = {}
  let body = ''
  let inHeaders = false
  let inBody = false

  for (const line of response) {
    if (line.includes('BODY[HEADER')) {
      inHeaders = true
      continue
    }
    if (line.includes('BODY[TEXT]')) {
      inHeaders = false
      inBody = true
      continue
    }

    if (inHeaders && line.includes(':')) {
      const colonIndex = line.indexOf(':')
      const key = line.slice(0, colonIndex).toLowerCase().trim()
      const value = line.slice(colonIndex + 1).trim()
      headers[key] = value
    }

    if (inBody && !line.startsWith(tag) && !line.startsWith(')')) {
      body += line + '\n'
    }
  }

  if (!headers.from || !headers.subject) {
    return null
  }

  return {
    messageId: headers['message-id'] || `${messageId}@unknown`,
    from: headers.from,
    subject: headers.subject,
    date: headers.date ? new Date(headers.date) : new Date(),
    body: body.trim(),
  }
}

/**
 * Format date for IMAP SINCE search
 */
function formatImapDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${date.getDate()}-${months[date.getMonth()]}-${date.getFullYear()}`
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
 * Fetch sample emails from approved senders (headers only) for preview.
 * Used during connection test to show users what will be synced.
 *
 * New approach: Fetch last 100 emails and filter locally (faster than 24 SEARCH commands)
 */
export async function fetchSampleEmails(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string },
  maxEmails = 10
): Promise<{ success: boolean; emails?: EmailPreview[]; error?: string }> {
  console.log(`[imap-client] Connecting to ${credentials.host}:${credentials.port}...`)

  // Add timeout for local dev where cloudflare:sockets may not work
  const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'Connection timed out. TCP sockets may not work in local development - try deploying to Cloudflare.' }), 15000)
  )

  const fetchPromise = fetchSampleEmailsImpl(credentials, maxEmails)

  return Promise.race([fetchPromise, timeoutPromise])
}

async function fetchSampleEmailsImpl(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string },
  maxEmails: number
): Promise<{ success: boolean; emails?: EmailPreview[]; error?: string }> {
  try {
    // Port 993 uses implicit TLS (connect with TLS immediately)
    // Port 143 would use STARTTLS (upgrade plaintext to TLS)
    const useImplicitTls = credentials.port === 993

    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
      secureTransport: useImplicitTls ? 'on' : 'starttls',
    })

    const secureSocket = useImplicitTls ? socket : socket.startTls()

    const reader = new ImapReader(secureSocket.readable.getReader())
    const writer = secureSocket.writable.getWriter()

    // Read greeting
    const greeting = await reader.readLine()
    console.log('[imap-client] Server greeting received')
    if (!greeting.startsWith('* OK')) {
      return { success: false, error: 'Unexpected server greeting' }
    }

    // Login
    console.log('[imap-client] Logging in...')
    const loginResponse = await sendCommand(
      writer,
      reader,
      'A001',
      `LOGIN "${credentials.email}" "${credentials.password}"`
    )

    if (!loginResponse[loginResponse.length - 1].includes('OK')) {
      return { success: false, error: 'Invalid credentials' }
    }
    console.log('[imap-client] Login successful')

    // Select INBOX and get message count
    console.log('[imap-client] Selecting INBOX...')
    const selectResponse = await sendCommand(writer, reader, 'A002', 'SELECT INBOX')

    // Parse message count from "* 1234 EXISTS" line
    const existsLine = selectResponse.find((line) => line.includes(' EXISTS'))
    const messageCount = existsLine ? parseInt(existsLine.replace('* ', '').replace(' EXISTS', ''), 10) : 0

    console.log(`[imap-client] Found ${messageCount} total messages in INBOX`)

    if (messageCount === 0) {
      await sendCommand(writer, reader, 'A999', 'LOGOUT')
      await writer.close()
      return { success: true, emails: [] }
    }

    // Fetch headers for last 100 messages (or all if fewer)
    const fetchCount = Math.min(100, messageCount)
    const startMsg = Math.max(1, messageCount - fetchCount + 1)
    const endMsg = messageCount

    console.log(`[imap-client] Fetching headers for messages ${startMsg}:${endMsg}...`)

    const fetchResponse = await sendCommand(
      writer,
      reader,
      'A003',
      `FETCH ${startMsg}:${endMsg} (BODY[HEADER.FIELDS (FROM SUBJECT DATE)])`
    )

    // Parse all email headers from response
    const allEmails: EmailPreview[] = []
    let currentHeaders: Record<string, string> = {}
    let inHeaders = false

    for (const line of fetchResponse) {
      if (line.includes('FETCH') && line.includes('BODY[HEADER')) {
        // Start of new message
        if (Object.keys(currentHeaders).length > 0 && currentHeaders.from && currentHeaders.subject) {
          allEmails.push({
            from: currentHeaders.from,
            subject: currentHeaders.subject,
            date: currentHeaders.date || new Date().toISOString(),
          })
        }
        currentHeaders = {}
        inHeaders = true
        continue
      }

      if (line === ')' || line.startsWith('A003')) {
        // End of current message or end of response
        if (Object.keys(currentHeaders).length > 0 && currentHeaders.from && currentHeaders.subject) {
          allEmails.push({
            from: currentHeaders.from,
            subject: currentHeaders.subject,
            date: currentHeaders.date || new Date().toISOString(),
          })
        }
        currentHeaders = {}
        inHeaders = false
        continue
      }

      if (inHeaders && line.includes(':')) {
        const colonIndex = line.indexOf(':')
        const key = line.slice(0, colonIndex).toLowerCase().trim()
        const value = line.slice(colonIndex + 1).trim()
        currentHeaders[key] = value
      }
    }

    console.log(`[imap-client] Parsed ${allEmails.length} email headers`)

    // Filter for approved senders
    console.log('[imap-client] Filtering for ticket vendors...')
    const ticketEmails = allEmails.filter((email) => isApprovedSender(email.from))

    console.log(`[imap-client] Found ${ticketEmails.length} ticket emails from approved senders`)

    // Logout
    await sendCommand(writer, reader, 'A999', 'LOGOUT')
    await writer.close()

    // Return up to maxEmails
    return { success: true, emails: ticketEmails.slice(0, maxEmails) }
  } catch (error) {
    console.error('[imap-client] Sample fetch error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    }
  }
}

/**
 * Fetch just headers for an email (for preview)
 */
async function fetchEmailHeaders(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  reader: ImapReader,
  messageId: string
): Promise<EmailPreview | null> {
  const tag = `H${messageId}`

  const response = await sendCommand(
    writer,
    reader,
    tag,
    `FETCH ${messageId} (BODY[HEADER.FIELDS (FROM SUBJECT DATE)])`
  )

  const headers: Record<string, string> = {}
  let inHeaders = false

  for (const line of response) {
    if (line.includes('BODY[HEADER')) {
      inHeaders = true
      continue
    }
    if (line.startsWith(tag) || line === ')') {
      inHeaders = false
    }

    if (inHeaders && line.includes(':')) {
      const colonIndex = line.indexOf(':')
      const key = line.slice(0, colonIndex).toLowerCase().trim()
      const value = line.slice(colonIndex + 1).trim()
      headers[key] = value
    }
  }

  if (!headers.from || !headers.subject) {
    return null
  }

  return {
    from: headers.from,
    subject: headers.subject,
    date: headers.date || new Date().toISOString(),
  }
}
