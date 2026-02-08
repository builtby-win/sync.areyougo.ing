import { createEmailHash } from './email-hash'

interface EmailForDedup {
  subject: string
  senderEmail: string
  recipientEmail: string
  emailDate: Date
}

/**
 * Checks which emails already exist in the main app by computing hashes
 * and batch-checking against the /api/ingest/check endpoint.
 *
 * Returns a Set of hashes that already exist (for filtering).
 */
export async function checkAlreadyIngested(
  mainAppUrl: string,
  ingestApiKey: string | undefined,
  userId: string,
  emails: EmailForDedup[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set()

  const hashes = emails.map((e) =>
    createEmailHash(e.subject, e.senderEmail, e.recipientEmail, Math.floor(e.emailDate.getTime() / 1000)),
  )

  try {
    const response = await fetch(`${mainAppUrl}/api/ingest-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ingestApiKey && { 'X-API-Key': ingestApiKey }),
      },
      body: JSON.stringify({ userId, hashes }),
    })

    if (!response.ok) {
      console.warn(`[dedup] Check endpoint returned ${response.status}, skipping dedup`)
      return new Set()
    }

    const data = (await response.json()) as { existingHashes: string[] }
    return new Set(data.existingHashes)
  } catch (error) {
    console.warn('[dedup] Failed to reach check endpoint, skipping dedup:', error)
    return new Set()
  }
}

/**
 * Given an email, compute its hash for comparison against the existing set.
 */
export function computeEmailHash(
  subject: string,
  senderEmail: string,
  recipientEmail: string,
  emailDate: Date,
): string {
  return createEmailHash(subject, senderEmail, recipientEmail, Math.floor(emailDate.getTime() / 1000))
}
