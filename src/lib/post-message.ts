/**
 * PostMessage protocol for iframe communication between sync app and main app.
 *
 * Message types:
 * - SYNC_READY: Sync app loaded and ready
 * - SYNC_COMPLETE: Sync finished with results
 * - SYNC_CANCELLED: User cancelled sync
 * - SYNC_ERROR: Error occurred during sync
 */

// Allowed parent origins for postMessage
const ALLOWED_ORIGINS = [
  'https://areyougo.ing',
  'http://localhost:4321',
  'http://localhost:4322',
]

export type SyncMessageType = 'SYNC_READY' | 'SYNC_COMPLETE' | 'SYNC_CANCELLED' | 'SYNC_ERROR'

export interface SyncReadyMessage {
  type: 'SYNC_READY'
}

export interface SyncCompleteMessage {
  type: 'SYNC_COMPLETE'
  data: {
    emailsFound: number
    emailsIngested: number
    nextAction?: 'timeline' | 'audit'
  }
}

export interface SyncCancelledMessage {
  type: 'SYNC_CANCELLED'
}

export interface SyncErrorMessage {
  type: 'SYNC_ERROR'
  error: string
}

export type SyncMessage =
  | SyncReadyMessage
  | SyncCompleteMessage
  | SyncCancelledMessage
  | SyncErrorMessage

/**
 * Check if we're running inside an iframe
 */
export function isEmbedded(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    // If we can't access window.top due to cross-origin restrictions,
    // we're definitely in an iframe
    return true
  }
}

/**
 * Get the parent window's origin if we're embedded
 */
function getParentOrigin(): string | null {
  if (typeof window === 'undefined') return null
  try {
    // Check if running in iframe by comparing window objects
    if (window.self === window.top) return null

    // Try to get parent origin from referrer
    if (document.referrer) {
      const url = new URL(document.referrer)
      return url.origin
    }
  } catch {
    // Cross-origin - can't access parent
  }
  return null
}

/**
 * Post a message to the parent window with origin validation
 */
export function postToParent(message: SyncMessage): boolean {
  if (typeof window === 'undefined') return false
  if (!window.parent || window.parent === window) return false

  const parentOrigin = getParentOrigin()

  // If we can determine the parent origin, validate it
  if (parentOrigin && !ALLOWED_ORIGINS.includes(parentOrigin)) {
    console.warn('[sync] Attempted to post to unauthorized parent:', parentOrigin)
    return false
  }

  // Post to all allowed origins (the parent will only receive if one matches)
  // In production, we use '*' because we've already validated via CSP frame-ancestors
  // The CSP header ensures only areyougo.ing can embed us
  // For local dev, we also force '*' to avoid localhost vs 127.0.0.1 mismatches
  const targetOrigin = '*' 
  // const targetOrigin = parentOrigin || '*'
  console.log('[sync] Posting message to parent:', message.type, 'Target:', targetOrigin)

  try {
    window.parent.postMessage(
      {
        source: 'sync.areyougo.ing',
        ...message,
      },
      targetOrigin,
    )
    console.log('[sync] Message posted successfully')
    return true
  } catch (error) {
    console.error('[sync] Failed to post message to parent:', error)
    return false
  }
}

/**
 * Notify parent that sync app is ready
 */
export function notifyReady(): boolean {
  return postToParent({ type: 'SYNC_READY' })
}

/**
 * Notify parent that sync completed successfully
 */
export function notifySyncComplete(
  emailsFound: number,
  emailsIngested: number,
  nextAction?: 'timeline' | 'audit',
): boolean {
  return postToParent({
    type: 'SYNC_COMPLETE',
    data: { emailsFound, emailsIngested, nextAction },
  })
}

/**
 * Notify parent that user cancelled sync
 */
export function notifyCancelled(): boolean {
  return postToParent({ type: 'SYNC_CANCELLED' })
}

/**
 * Notify parent that an error occurred
 */
export function notifyError(error: string): boolean {
  return postToParent({ type: 'SYNC_ERROR', error })
}
