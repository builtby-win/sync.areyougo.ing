import { eq } from 'drizzle-orm'
import { getDb } from './db'
import { redactPii } from './redaction/redactor'
import { imapCredentials, syncHistory } from './schema'
import {
  callSyncProjection,
  recordCursorAdvance,
  recordFailure,
  recordManualSyncAt,
  recordSuccess,
} from './sync-helpers'
import { type SyncSession, getSession, updateEmailStatus, updateSession } from './sync-sessions'

interface IngestOptions {
  sessionId: string
  cred: {
    id: string
    userId: string
    imapEmail: string
  }
  mainAppUrl: string
  ingestApiKey?: string
  lockOwner: string
}

interface IngestEmailInput {
  messageId: string
  from: string
  subject: string
  body: string
  date: string | Date
}

interface BuildIngestPayloadInput {
  userId: string
  recipientEmail: string
  email: IngestEmailInput
}

// Extract email address from "Name <email@domain.com>" format
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return match ? match[1] : from.trim()
}

export function buildIngestPayload({ userId, recipientEmail, email }: BuildIngestPayloadInput) {
  return {
    userId,
    recipientEmail,
    senderEmail: extractEmailAddress(email.from),
    subject: email.subject,
    body: redactPii(email.body),
    emailDate: email.date instanceof Date ? email.date.toISOString() : email.date,
  }
}

/**
 * Runs the ingestion process for a session.
 * Iterates through pending emails and sends them to the main app.
 */
export async function runIngestion({ sessionId, cred, mainAppUrl, ingestApiKey, lockOwner }: IngestOptions) {
  const db = getDb()
  const session = getSession(sessionId)

  if (!session) {
    throw new Error('Session not found')
  }

  try {
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
        const payload = buildIngestPayload({
          userId: cred.userId,
          recipientEmail: cred.imapEmail,
          email,
        })

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

    // Determine stats from session
    const finalSession = getSession(sessionId)!
    const importedCount = finalSession.totalIngested
    const skippedCount = finalSession.emails.filter((e) => e.ingestStatus === 'skipped').length
    const failedCount = finalSession.emails.filter((e) => e.ingestStatus === 'failed').length
    const foundCount = finalSession.totalFound

    // Find the newest imported email for import-timestamp tracking
    const importedEmails = finalSession.emails.filter((e) => e.ingestStatus === 'success')
    let newestImportedEmail: { importedAt: Date; emailDate: Date } | null = null
    if (importedEmails.length > 0) {
      const sorted = [...importedEmails].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      )
      newestImportedEmail = {
        importedAt: new Date(),
        emailDate: new Date(sorted[0].date),
      }
    }

    // Release lock and record success on completion.
    // recordSuccess clears lock, backoff, error, resets consecutiveFailures,
    // and sets lastSyncSuccessAt.
    await recordSuccess(db, cred.id, lockOwner)
    // Set lastManualSyncAt separately (recordSuccess doesn't touch it)
    await recordManualSyncAt(db, cred.id)

    // Don't advance cursor when any emails failed — the next sync will
    // re-fetch the same date range so nothing is missed.
    // This covers both explicit syncCursorAt and legacy lastSyncAt.
    if (failedCount === 0) {
      await recordCursorAdvance(
        db,
        cred.id,
        new Date(),
        newestImportedEmail?.importedAt ?? null,
        newestImportedEmail?.emailDate ?? null,
      )

      // Keep legacy lastSyncAt in sync for backward compatibility
      // (used as fallback when syncCursorAt is null)
      await db
        .update(imapCredentials)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(imapCredentials.id, cred.id))
    }

    // Log sync-projection for manual sync mode
    const projectionSecret = process.env.SYNC_PROJECTION_SECRET
    await callSyncProjection(mainAppUrl, projectionSecret, {
      userId: cred.userId,
      status: 'completed',
      metadata: {
        mode: 'manual',
        credentialId: cred.id,
        recipientEmail: cred.imapEmail,
        emailsFound: foundCount,
        emailsImported: importedCount,
        emailsSkipped: skippedCount,
        emailsFailed: failedCount,
        lastImportedEmailAt: newestImportedEmail?.importedAt?.getTime(),
        lastImportedEmailDate: newestImportedEmail?.emailDate?.getTime(),
      },
    })

    // Log to history with credentialId
    const syncStatus =
      failedCount > 0 && importedCount > 0
        ? 'partial'
        : foundCount > 0 && importedCount === 0 && failedCount > 0
          ? 'error'
          : 'success'
    await db.insert(syncHistory).values({
      id: crypto.randomUUID(),
      userId: cred.userId,
      credentialId: cred.id,
      status: syncStatus,
      emailsFound: foundCount,
      emailsIngested: importedCount,
      startedAt: finalSession.startedAt,
      completedAt: new Date(),
    })

    updateSession(sessionId, { status: 'completed', completedAt: new Date() })
    console.log(
      `[sync:${sessionId}] Complete: ${importedCount}/${foundCount} ingested (${skippedCount} skipped, ${failedCount} failed)`,
    )
  } catch (error) {
    console.error(`[sync:${sessionId}] Ingestion error:`, error)
    const errMsg = error instanceof Error ? error.message : 'Ingestion failed'

    // Durable failure state: recordFailure sets failure state, releases
    // lock, and computes backoff so credential can be retried next cycle.
    await recordFailure(db, cred.id, lockOwner, errMsg).catch(() => {})
    await db
      .insert(syncHistory)
      .values({
        id: crypto.randomUUID(),
        userId: cred.userId,
        credentialId: cred.id,
        status: 'error',
        errorMessage: errMsg,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .catch(() => {})
    const projectionSecret = process.env.SYNC_PROJECTION_SECRET
    await callSyncProjection(mainAppUrl, projectionSecret, {
      userId: cred.userId,
      status: 'failed',
      errorMessage: errMsg,
      metadata: {
        mode: 'manual',
        credentialId: cred.id,
        recipientEmail: cred.imapEmail,
        errorMessage: errMsg,
      },
    }).catch(() => {})

    updateSession(sessionId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date(),
    })
  }
}
