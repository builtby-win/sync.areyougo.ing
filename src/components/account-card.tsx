import { useEffect, useState } from 'react'
import { formatRelativeTime } from '../lib/date'

interface User {
  id: string
  email: string
  name: string | null
}

interface AccountCredential {
  id: string
  provider: string
  imapEmail: string
  lastSyncAt: number | null
  syncMode: string
  lastManualSyncAt: number | null
}

interface Props {
  user: User
  credential: AccountCredential
  onUpdate: () => void
  onDelete: () => void
  redirectUrl?: string | null
}

type SyncMode = 'manual' | 'auto_daily'

const PROVIDER_NAMES: Record<string, string> = {
  icloud: 'iCloud Mail',
  gmail: 'Gmail',
  yahoo: 'Yahoo Mail',
  outlook: 'Outlook / Hotmail',
  other: 'Custom IMAP',
}

export default function AccountCard({ user, credential, onUpdate, onDelete, redirectUrl }: Props) {
  const [syncMode, setSyncMode] = useState<SyncMode>(credential.syncMode as SyncMode)
  const [isUpdatingSyncMode, setIsUpdatingSyncMode] = useState(false)
  const [localLastSyncAt, setLocalLastSyncAt] = useState<number | null>(credential.lastSyncAt)
  const [error, setError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Update local sync time when prop changes
  useEffect(() => {
    setLocalLastSyncAt(credential.lastSyncAt)
  }, [credential.lastSyncAt])

  // Construct run URL
  const runParams = new URLSearchParams()
  if (redirectUrl) runParams.set('redirectUrl', redirectUrl)
  const runUrl = `/run/${credential.id}${runParams.toString() ? `?${runParams.toString()}` : ''}`

  const handleSyncModeChange = async (newMode: SyncMode) => {
    if (newMode === syncMode) return

    setIsUpdatingSyncMode(true)
    setError(null)

    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: credential.id, syncMode: newMode }),
      })

      if (!response.ok) {
        const data = await response.json()
        setError(data.error || 'Failed to update sync mode')
        return
      }

      setSyncMode(newMode)
      onUpdate()
    } catch {
      setError('Failed to update sync mode')
    } finally {
      setIsUpdatingSyncMode(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    setError(null)

    try {
      const response = await fetch('/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: credential.id }),
      })

      if (!response.ok) {
        const data = await response.json()
        setError(data.error || 'Failed to delete account')
        setIsDeleting(false)
        return
      }

      onDelete()
    } catch {
      setError('Failed to delete account')
      setIsDeleting(false)
    }
  }

  return (
    <div className="bg-card rounded-lg border border-border p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
            <svg
              className="w-5 h-5 text-success"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <div>
            <h2 className="font-semibold">{credential.imapEmail}</h2>
            <p className="text-sm text-muted-foreground">
              {PROVIDER_NAMES[credential.provider] || credential.provider}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="text-muted-foreground hover:text-destructive transition-colors p-2"
          title="Remove account"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md space-y-3">
          <p className="text-sm">Are you sure you want to remove this account?</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="flex-1 px-3 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="flex-1 px-3 py-2 bg-destructive text-destructive-foreground rounded-md text-sm font-medium disabled:opacity-50"
            >
              {isDeleting ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </div>
      )}

      {/* Last sync info */}
      {localLastSyncAt && (
        <div className="text-sm text-muted-foreground">
          Last synced: {formatRelativeTime(localLastSyncAt)}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Auto-sync toggle */}
      <button
        type="button"
        onClick={() => handleSyncModeChange(syncMode === 'auto_daily' ? 'manual' : 'auto_daily')}
        disabled={isUpdatingSyncMode}
        className={`w-full text-left p-4 rounded-lg border-2 transition-colors ${
          syncMode === 'auto_daily'
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-muted-foreground'
        } disabled:opacity-50`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">Auto-Sync Daily</span>
            {syncMode !== 'auto_daily' && (
              <span className="text-xs bg-primary/15 text-primary px-2 py-0.5 rounded-full font-medium">
                Recommended
              </span>
            )}
          </div>
          <div className={`w-9 h-5 rounded-full transition-colors relative ${
            syncMode === 'auto_daily' ? 'bg-primary' : 'bg-muted-foreground/30'
          }`}>
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              syncMode === 'auto_daily' ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {syncMode === 'auto_daily'
            ? 'Checks for new ticket emails once per day at 6am UTC.'
            : 'Enable to automatically check for new tickets daily.'}
        </p>
      </button>

      {/* Manual sync action */}
      <a
        href={runUrl}
        className="block w-full px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/80 transition-colors text-center"
      >
        Sync Now
      </a>
    </div>
  )
}