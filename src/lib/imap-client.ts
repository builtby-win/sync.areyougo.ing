/**
 * IMAP client using cloudflare:sockets for TCP/TLS connections.
 * This is a minimal implementation focused on fetching emails from approved senders.
 */

import { connect } from 'cloudflare:sockets'
import { APPROVED_SENDERS, isApprovedSender } from './approved-senders'
import { decryptPassword } from './encryption'

/**
 * Helper for timestamped logging to debug connection issues
 */
const logWithTime = (startTime: number, msg: string) => {
  const elapsed = Date.now() - startTime
  console.log(`[imap-client] [+${elapsed}ms] ${msg}`)
}

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

  // Add timeout - 5 minutes for production debugging
  const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'Connection timed out after 5 minutes.' }), 300000)
  )

  const testPromise = testConnectionImpl(credentials)

  return Promise.race([testPromise, timeoutPromise])
}

async function testConnectionImpl(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string }
): Promise<{ success: boolean; error?: string }> {
  const startTime = Date.now()

  try {
    // Port 993 uses implicit TLS (connect with TLS immediately)
    // Port 143 would use STARTTLS (upgrade plaintext to TLS)
    const useImplicitTls = credentials.port === 993
    logWithTime(startTime, `Using ${useImplicitTls ? 'implicit TLS (port 993)' : 'STARTTLS (port 143)'}`)

    logWithTime(startTime, 'Calling cloudflare:sockets connect()...')
    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
      secureTransport: useImplicitTls ? 'on' : 'starttls',
    })
    logWithTime(startTime, 'Socket object created')

    // For STARTTLS, upgrade after connecting; for implicit TLS, already secure
    logWithTime(startTime, useImplicitTls ? 'Using socket directly (implicit TLS)' : 'Calling startTls()...')
    const secureSocket = useImplicitTls ? socket : socket.startTls()
    logWithTime(startTime, 'Secure socket ready')

    logWithTime(startTime, 'Getting readable stream...')
    const readableReader = secureSocket.readable.getReader()
    logWithTime(startTime, 'Got readable stream reader')

    logWithTime(startTime, 'Getting writable stream...')
    const writer = secureSocket.writable.getWriter()
    logWithTime(startTime, 'Got writable stream writer')

    const reader = new ImapReader(readableReader)

    // Read greeting
    logWithTime(startTime, 'Waiting for server greeting...')
    const greeting = await reader.readLine()
    logWithTime(startTime, `Server greeting received: ${greeting.substring(0, 50)}...`)

    if (!greeting.startsWith('* OK')) {
      logWithTime(startTime, `ERROR: Unexpected greeting: ${greeting}`)
      return { success: false, error: 'Unexpected server greeting' }
    }

    // Login
    logWithTime(startTime, 'Sending LOGIN command...')
    const loginResponse = await sendCommand(
      writer,
      reader,
      'A001',
      `LOGIN "${credentials.email}" "${credentials.password}"`
    )
    logWithTime(startTime, 'LOGIN response received')

    const loginResult = loginResponse[loginResponse.length - 1]
    if (!loginResult.includes('OK')) {
      logWithTime(startTime, `Login failed: ${loginResult}`)
      return { success: false, error: 'Invalid credentials' }
    }
    logWithTime(startTime, 'Login successful')

    // Logout
    logWithTime(startTime, 'Sending LOGOUT...')
    await sendCommand(writer, reader, 'A002', 'LOGOUT')

    await writer.close()
    logWithTime(startTime, 'Connection test complete - SUCCESS')

    return { success: true }
  } catch (error) {
    logWithTime(startTime, `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`)
    console.error('[imap-client] Full error:', error)
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
  const startTime = Date.now()
  logWithTime(startTime, `Fetching emails from: ${credentials.host}:${credentials.port}`)

  logWithTime(startTime, 'Decrypting password...')
  const password = await decryptPassword(credentials.encryptedPassword, credentials.iv, encryptionKey)
  logWithTime(startTime, 'Password decrypted')

  try {
    // Port 993 uses implicit TLS (connect with TLS immediately)
    // Port 143 would use STARTTLS (upgrade plaintext to TLS)
    const useImplicitTls = credentials.port === 993
    logWithTime(startTime, `Using ${useImplicitTls ? 'implicit TLS (port 993)' : 'STARTTLS (port 143)'}`)

    logWithTime(startTime, 'Calling cloudflare:sockets connect()...')
    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
      secureTransport: useImplicitTls ? 'on' : 'starttls',
    })
    logWithTime(startTime, 'Socket object created')

    logWithTime(startTime, useImplicitTls ? 'Using socket directly (implicit TLS)' : 'Calling startTls()...')
    const secureSocket = useImplicitTls ? socket : socket.startTls()
    logWithTime(startTime, 'Secure socket ready')

    logWithTime(startTime, 'Getting streams...')
    const reader = new ImapReader(secureSocket.readable.getReader())
    const writer = secureSocket.writable.getWriter()
    logWithTime(startTime, 'Streams ready')

    // Read greeting
    logWithTime(startTime, 'Waiting for server greeting...')
    const greeting = await reader.readLine()
    logWithTime(startTime, `Server greeting received: ${greeting.substring(0, 50)}...`)

    // Login
    logWithTime(startTime, 'Sending LOGIN command...')
    const loginResponse = await sendCommand(
      writer,
      reader,
      'A001',
      `LOGIN "${credentials.email}" "${password}"`
    )
    logWithTime(startTime, 'LOGIN response received')

    if (!loginResponse[loginResponse.length - 1].includes('OK')) {
      logWithTime(startTime, 'Login failed')
      throw new Error('Login failed')
    }
    logWithTime(startTime, 'Login successful')

    // Select INBOX
    logWithTime(startTime, 'Selecting INBOX...')
    const selectResponse = await sendCommand(writer, reader, 'A002', 'SELECT INBOX')
    logWithTime(startTime, `Selected INBOX: ${selectResponse.length} lines`)

    // Build search criteria - use lookbackDays if specified, otherwise lastSyncAt
    let sinceDate: string
    if (options?.lookbackDays) {
      sinceDate = formatImapDate(new Date(Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000))
      logWithTime(startTime, `Using lookback of ${options.lookbackDays} days (since ${sinceDate})`)
    } else if (credentials.lastSyncAt) {
      sinceDate = formatImapDate(credentials.lastSyncAt)
      logWithTime(startTime, `Using lastSyncAt: ${sinceDate}`)
    } else {
      sinceDate = formatImapDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) // Default: last 30 days
      logWithTime(startTime, `Using default 30 day lookback: ${sinceDate}`)
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

      if (messageIds.length > 0) {
        logWithTime(startTime, `Found ${messageIds.length} emails from ${sender}`)
      }

      // Fetch each email
      for (const msgId of messageIds.slice(0, 10)) {
        // Limit to 10 per sender
        try {
          const email = await fetchEmail(writer, reader, msgId)
          if (email) {
            emails.push(email)
          }
        } catch (error) {
          logWithTime(startTime, `Error fetching message ${msgId}: ${error}`)
        }
      }
    }

    // Logout
    logWithTime(startTime, 'Logging out...')
    await sendCommand(writer, reader, 'A999', 'LOGOUT')
    await writer.close()

    logWithTime(startTime, `Complete - fetched ${emails.length} total emails`)
    return emails
  } catch (error) {
    logWithTime(startTime, `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`)
    console.error('[imap-client] Full error:', error)
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

  // Add timeout - 5 minutes for production debugging
  const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'Connection timed out after 5 minutes.' }), 300000)
  )

  const fetchPromise = fetchSampleEmailsImpl(credentials, maxEmails)

  return Promise.race([fetchPromise, timeoutPromise])
}

async function fetchSampleEmailsImpl(
  credentials: Omit<ImapCredentials, 'lastSyncAt'> & { password: string },
  maxEmails: number
): Promise<{ success: boolean; emails?: EmailPreview[]; error?: string }> {
  const startTime = Date.now()

  try {
    // Port 993 uses implicit TLS (connect with TLS immediately)
    // Port 143 would use STARTTLS (upgrade plaintext to TLS)
    const useImplicitTls = credentials.port === 993
    logWithTime(startTime, `Using ${useImplicitTls ? 'implicit TLS (port 993)' : 'STARTTLS (port 143)'}`)

    logWithTime(startTime, 'Calling cloudflare:sockets connect()...')
    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
      secureTransport: useImplicitTls ? 'on' : 'starttls',
    })
    logWithTime(startTime, 'Socket object created')

    logWithTime(startTime, useImplicitTls ? 'Using socket directly (implicit TLS)' : 'Calling startTls()...')
    const secureSocket = useImplicitTls ? socket : socket.startTls()
    logWithTime(startTime, 'Secure socket ready')

    logWithTime(startTime, 'Getting readable stream...')
    const readableReader = secureSocket.readable.getReader()
    logWithTime(startTime, 'Got readable stream reader')

    logWithTime(startTime, 'Getting writable stream...')
    const writer = secureSocket.writable.getWriter()
    logWithTime(startTime, 'Got writable stream writer')

    const reader = new ImapReader(readableReader)

    // Read greeting
    logWithTime(startTime, 'Waiting for server greeting...')
    const greeting = await reader.readLine()
    logWithTime(startTime, `Server greeting received: ${greeting.substring(0, 50)}...`)

    if (!greeting.startsWith('* OK')) {
      logWithTime(startTime, `ERROR: Unexpected greeting: ${greeting}`)
      return { success: false, error: 'Unexpected server greeting' }
    }

    // Login
    logWithTime(startTime, 'Sending LOGIN command...')
    const loginResponse = await sendCommand(
      writer,
      reader,
      'A001',
      `LOGIN "${credentials.email}" "${credentials.password}"`
    )
    logWithTime(startTime, 'LOGIN response received')

    if (!loginResponse[loginResponse.length - 1].includes('OK')) {
      logWithTime(startTime, 'Login failed - invalid credentials')
      return { success: false, error: 'Invalid credentials' }
    }
    logWithTime(startTime, 'Login successful')

    // Select INBOX and get message count
    logWithTime(startTime, 'Selecting INBOX...')
    const selectResponse = await sendCommand(writer, reader, 'A002', 'SELECT INBOX')
    logWithTime(startTime, 'INBOX selected')

    // Parse message count from "* 1234 EXISTS" line
    const existsLine = selectResponse.find((line) => line.includes(' EXISTS'))
    const messageCount = existsLine ? parseInt(existsLine.replace('* ', '').replace(' EXISTS', ''), 10) : 0

    logWithTime(startTime, `Found ${messageCount} total messages in INBOX`)

    if (messageCount === 0) {
      logWithTime(startTime, 'No messages, logging out...')
      await sendCommand(writer, reader, 'A999', 'LOGOUT')
      await writer.close()
      logWithTime(startTime, 'Complete - no emails found')
      return { success: true, emails: [] }
    }

    // Fetch headers for last 100 messages (or all if fewer)
    const fetchCount = Math.min(100, messageCount)
    const startMsg = Math.max(1, messageCount - fetchCount + 1)
    const endMsg = messageCount

    logWithTime(startTime, `Fetching headers for messages ${startMsg}:${endMsg}...`)

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

    logWithTime(startTime, `Parsed ${allEmails.length} email headers`)

    // Filter for approved senders
    logWithTime(startTime, 'Filtering for ticket vendors...')
    const ticketEmails = allEmails.filter((email) => isApprovedSender(email.from))

    logWithTime(startTime, `Found ${ticketEmails.length} ticket emails from approved senders`)

    // Logout
    logWithTime(startTime, 'Logging out...')
    await sendCommand(writer, reader, 'A999', 'LOGOUT')
    await writer.close()

    logWithTime(startTime, 'Complete - SUCCESS')
    // Return up to maxEmails
    return { success: true, emails: ticketEmails.slice(0, maxEmails) }
  } catch (error) {
    logWithTime(startTime, `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`)
    console.error('[imap-client] Full error:', error)
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
