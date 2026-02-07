import { eq } from 'drizzle-orm'
import { getDb } from './db'
import { imapCredentials, syncHistory } from './schema'
import {
  getSession,
  updateEmailStatus,
  updateSession,
  type SyncSession,
} from './sync-sessions'

interface IngestOptions {
  sessionId: string
  cred: {
    id: string
    userId: string
    imapEmail: string
  }
  mainAppUrl: string
  ingestApiKey?: string
}

// Extract email address from "Name <email@domain.com>" format
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from.trim()
}

/**
 * Runs the ingestion process for a session.
 * Iterates through pending emails and sends them to the main app.
 */
export async function runIngestion({
  sessionId,
  cred,
  mainAppUrl,
  ingestApiKey,
}: IngestOptions) {
  const db = getDb()
  const session = getSession(sessionId)

  if (!session) {
    throw new Error('Session not found')
  }

  updateSession(sessionId, { status: 'ingesting' })

  // Sort by date (oldest first)
  const emailsToIngest = session.emails
    .filter((e) => e.ingestStatus === 'pending')
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  console.log(`[sync:${sessionId}] Ingesting ${emailsToIngest.length} pending emails`)

  for (let i = 0; i < emailsToIngest.length; i++) {
    const email = emailsToIngest[i]

    console.log(
      `[sync:${sessionId}] Ingesting email ${i + 1}/${emailsToIngest.length}: "${email.subject}" (${email.messageId})`,
    )
    updateEmailStatus(sessionId, email.messageId, 'sending')

    try {
      const payload = {
        recipientEmail: cred.imapEmail,
        senderEmail: extractEmailAddress(email.from),
        subject: email.subject,
        body: email.body,
        emailDate: email.date,
        userId: cred.userId,
      }
      
      const response = await fetch(`${mainAppUrl}/api/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ingestApiKey && { 'X-API-Key': ingestApiKey }),
        },
        body: JSON.stringify(payload),
      })

      if (response.ok) {
        const result = await response.json()
        console.log(`[sync:${sessionId}] Ingest success for ${email.messageId}:`, result)
        updateEmailStatus(sessionId, email.messageId, 'success')
      } else {
        const errorText = await response.text()
        console.error(
          `[sync:${sessionId}] Ingest failed for ${email.messageId} (${response.status}):`,
          errorText,
        )
        updateEmailStatus(sessionId, email.messageId, 'failed', errorText)
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Network error'
      console.error(`[sync:${sessionId}] Error ingesting email ${email.messageId}:`, error)
      updateEmailStatus(sessionId, email.messageId, 'failed', errorMsg)
    }
  }

  // Update timestamps for this specific credential
  await db
    .update(imapCredentials)
    .set({
      lastSyncAt: new Date(),
      lastManualSyncAt: new Date(), // This might need logic if it's auto sync? But runIngestion implies actual ingest.
      updatedAt: new Date(),
    })
    .where(eq(imapCredentials.id, cred.id))

  // Log to history with credentialId
  const finalSession = getSession(sessionId)!
  await db.insert(syncHistory).values({
    id: crypto.randomUUID(),
    userId: cred.userId,
    credentialId: cred.id,
    status: finalSession.totalIngested > 0 ? 'success' : 'partial', // Simplified status logic
    emailsFound: finalSession.totalFound,
    emailsIngested: finalSession.totalIngested,
    startedAt: finalSession.startedAt,
    completedAt: new Date(),
  })

  updateSession(sessionId, { status: 'completed', completedAt: new Date() })
  console.log(
    `[sync:${sessionId}] Complete: ${finalSession.totalIngested}/${finalSession.totalFound} ingested`,
  )
}
