export interface SyncEmail {
  messageId: string
  from: string
  subject: string
  date: string
  body: string
  ingestStatus: 'pending' | 'sending' | 'success' | 'failed'
  ingestError?: string
}

export interface SyncSession {
  id: string
  userId: string
  status: 'fetching' | 'ingesting' | 'completed' | 'failed'
  emails: SyncEmail[]
  totalFound: number
  totalIngested: number
  startedAt: Date
  completedAt?: Date
  error?: string
}

// In-memory store (simple Map, cleared on restart)
const sessions = new Map<string, SyncSession>()

export function createSession(userId: string): string {
  const sessionId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  sessions.set(sessionId, {
    id: sessionId,
    userId,
    status: 'fetching',
    emails: [],
    totalFound: 0,
    totalIngested: 0,
    startedAt: new Date(),
  })
  return sessionId
}

export function getSession(sessionId: string): SyncSession | undefined {
  return sessions.get(sessionId)
}

export function updateSession(sessionId: string, updates: Partial<SyncSession>): void {
  const session = sessions.get(sessionId)
  if (session) {
    Object.assign(session, updates)
  }
}

export function addEmailToSession(sessionId: string, email: SyncEmail): void {
  const session = sessions.get(sessionId)
  if (session) {
    session.emails.push(email)
    session.totalFound = session.emails.length
  }
}

export function updateEmailStatus(
  sessionId: string,
  messageId: string,
  status: SyncEmail['ingestStatus'],
  error?: string
): void {
  const session = sessions.get(sessionId)
  if (session) {
    const email = session.emails.find((e) => e.messageId === messageId)
    if (email) {
      email.ingestStatus = status
      email.ingestError = error
      if (status === 'success') {
        session.totalIngested++
      }
    }
  }
}

// Cleanup old sessions (> 1 hour)
export function cleanupSessions(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  for (const [id, session] of sessions) {
    if (session.startedAt.getTime() < oneHourAgo) {
      sessions.delete(id)
    }
  }
}
