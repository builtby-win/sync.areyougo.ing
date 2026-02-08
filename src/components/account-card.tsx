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
  const [lookbackDays, setLookbackDays] = useState(30)

  // Update local sync time when prop changes
  useEffect(() => {
    setLocalLastSyncAt(credential.lastSyncAt)
  }, [credential.lastSyncAt])

  // Construct run URL
  const runParams = new URLSearchParams()
  if (redirectUrl) runParams.set('redirectUrl', redirectUrl)
  if (lookbackDays !== 30) runParams.set('lookbackDays', String(lookbackDays))
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

      {/* Sync mode toggle */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Sync Mode</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleSyncModeChange('manual')}
            disabled={isUpdatingSyncMode}
            className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              syncMode === 'manual'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            } disabled:opacity-50`}
          >
            Manual Only
          </button>
          <button
            type="button"
            onClick={() => handleSyncModeChange('auto_daily')}
            disabled={isUpdatingSyncMode}
            className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              syncMode === 'auto_daily'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            } disabled:opacity-50`}
          >
            Auto-Sync Daily
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {syncMode === 'auto_daily'
            ? 'We check for new ticket emails once per day at 6am UTC.'
            : 'Use the sync button below to manually pull ticket emails.'}
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Sync range selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Sync Range</h3>
        <div className="flex gap-2">
          {([
            { label: '1mo', days: 30 },
            { label: '6mo', days: 180 },
            { label: '1yr', days: 365 },
            { label: '2yr', days: 730 },
            { label: '5yr', days: 1825 },
          ] as const).map((opt) => (
            <button
              key={opt.days}
              type="button"
              onClick={() => setLookbackDays(opt.days)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                lookbackDays === opt.days
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          How far back to search for ticket emails.
        </p>
      </div>

      {/* Manual sync action */}
      <div className="pt-2 border-t border-border">
        <a
          href={runUrl}
          className="block w-full px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity text-center"
        >
          Sync Now
        </a>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          You can select which emails to import.
        </p>
      </div>
    </div>
  )
}