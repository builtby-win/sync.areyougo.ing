/**
 * IMAP client using cloudflare:sockets for TCP/TLS connections.
 * This is a minimal implementation focused on fetching emails from approved senders.
 */

import { connect } from 'cloudflare:sockets'
import { APPROVED_SENDERS } from './approved-senders'
import { decryptPassword } from './encryption'

interface ImapCredentials {
  host: string
  port: number
  email: string
  encryptedPassword: string
  iv: string
  lastSyncAt: Date | null
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
  console.log('[imap-client] Testing connection to:', credentials.host)

  try {
    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
    })

    // Start TLS
    const secureSocket = socket.startTls()

    const reader = new ImapReader(secureSocket.readable.getReader())
    const writer = secureSocket.writable.getWriter()

    // Read greeting
    const greeting = await reader.readLine()
    console.log('[imap-client] Server greeting:', greeting.slice(0, 50))

    if (!greeting.startsWith('* OK')) {
      return { success: false, error: 'Unexpected server greeting' }
    }

    // Login
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

    // Logout
    await sendCommand(writer, reader, 'A002', 'LOGOUT')

    await writer.close()
    console.log('[imap-client] Connection test successful')

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
  encryptionKey: string
): Promise<Email[]> {
  console.log('[imap-client] Fetching emails from:', credentials.host)

  const password = await decryptPassword(credentials.encryptedPassword, credentials.iv, encryptionKey)

  try {
    const socket = connect({
      hostname: credentials.host,
      port: credentials.port,
    })

    const secureSocket = socket.startTls()

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

    // Build search criteria
    const sinceDate = credentials.lastSyncAt
      ? formatImapDate(credentials.lastSyncAt)
      : formatImapDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) // Default: last 30 days

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
