import { useEffect, useState } from 'react'
import { formatRelativeTime } from '../lib/date'
import { encryptPassword } from '../lib/encryption'

interface User {
  id: string
  email: string
  name: string | null
}

interface AccountCredential {
  id: string
  provider: string
  imapEmail: string
  host?: string
  port?: number
  lastSyncAt: number | null
  syncMode: string
  lastManualSyncAt: number | null
  lastSyncStatus?: string | null
  lastSyncError?: string | null
  lastSyncCompletedAt?: number | null
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

const PROVIDER_HELP_LINKS: Record<string, { url: string; label: string; instruction: string }> = {
  icloud: {
    url: 'https://appleid.apple.com/account/manage',
    label: 'appleid.apple.com',
    instruction:
      'Sign in to Apple ID → Sign-In and Security → App-Specific Passwords → Generate an app-specific password named "areyougo.ing".',
  },
  gmail: {
    url: 'https://myaccount.google.com/apppasswords',
    label: 'myaccount.google.com/apppasswords',
    instruction:
      'Requires 2-Step Verification enabled. Select app "Mail" → Generate → copy the 16-character code.',
  },
  yahoo: {
    url: 'https://login.yahoo.com/account/security',
    label: 'login.yahoo.com/account/security',
    instruction:
      'Go to Account Security → Generate app password → select "Other App" and enter "areyougo.ing".',
  },
  outlook: {
    url: 'https://account.microsoft.com/security',
    label: 'account.microsoft.com/security',
    instruction: 'Go to Advanced security options → App passwords → Create a new app password.',
  },
}

export default function AccountCard({ user, credential, onUpdate, onDelete, redirectUrl }: Props) {
  const [syncMode, setSyncMode] = useState<SyncMode>(credential.syncMode as SyncMode)
  const [isUpdatingSyncMode, setIsUpdatingSyncMode] = useState(false)
  const [localLastSyncAt, setLocalLastSyncAt] = useState<number | null>(credential.lastSyncAt)
  const [error, setError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  // Password update state
  const [isEditingPassword, setIsEditingPassword] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [isSavingPassword, setIsSavingPassword] = useState(false)
  const [passwordSuccess, setPasswordSuccess] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const isError = credential.lastSyncStatus === 'error'

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

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newPassword.trim()) return

    setIsSavingPassword(true)
    setPasswordError(null)

    try {
      const keyResponse = await fetch('/api/encryption-key')
      if (!keyResponse.ok) {
        throw new Error('Failed to retrieve encryption key')
      }
      const { key } = await keyResponse.json()

      const { encrypted, iv } = await encryptPassword(newPassword.trim(), key)

      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialId: credential.id,
          provider: credential.provider,
          email: credential.imapEmail,
          encryptedPassword: encrypted,
          iv,
          host: credential.host || (credential.provider === 'icloud' ? 'imap.mail.me.com' : ''),
          port: credential.port || 993,
          syncMode: credential.syncMode,
        }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update password')
      }

      setIsEditingPassword(false)
      setPasswordSuccess(true)
      setNewPassword('')
      onUpdate()
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Failed to update password')
    } finally {
      setIsSavingPassword(false)
    }
  }

  return (
    <div className="bg-card rounded-lg border border-border p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center ${
              isError && !passwordSuccess
                ? 'bg-destructive/20 text-destructive'
                : 'bg-success/20 text-success'
            }`}
          >
            {isError && !passwordSuccess ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            ) : (
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
            )}
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

      {/* Password update success banner */}
      {passwordSuccess && (
        <div className="p-3 bg-success/10 border border-success/30 rounded-lg flex items-center justify-between text-xs text-success font-medium">
          <span className="flex items-center gap-1.5">
            <svg
              className="w-4 h-4 flex-shrink-0"
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
            Password updated successfully!
          </span>
          <a href={runUrl} className="underline hover:text-success/80">
            Sync Now →
          </a>
        </div>
      )}

      {/* Sync Error Alert Banner */}
      {isError && !isEditingPassword && !passwordSuccess && (
        <div className="p-4 bg-destructive/10 border border-destructive/30 rounded-lg space-y-3">
          <div className="flex items-start gap-3">
            <svg
              className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div className="flex-1 text-sm">
              <p className="font-semibold text-destructive">Sync Failed</p>
              <p className="text-muted-foreground text-xs mt-1 leading-relaxed">
                {credential.lastSyncError || 'Unable to sync with your email account.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setIsEditingPassword(true)
                setPasswordError(null)
              }}
              className="px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:opacity-90 transition-opacity"
            >
              Update App Password
            </button>
            <a
              href={runUrl}
              className="px-3 py-1.5 bg-secondary text-secondary-foreground rounded-md text-xs font-medium hover:bg-secondary/80 transition-colors"
            >
              Retry Sync
            </a>
          </div>
        </div>
      )}

      {/* Inline Password Edit Form */}
      {isEditingPassword && (
        <div className="p-4 bg-muted/40 border border-border rounded-lg space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Update App Password</h3>
            <button
              type="button"
              onClick={() => {
                setIsEditingPassword(false)
                setPasswordError(null)
                setNewPassword('')
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>

          {PROVIDER_HELP_LINKS[credential.provider] && (
            <div className="text-xs text-muted-foreground bg-background/50 p-2.5 rounded border border-border/50">
              <p className="mb-1.5">{PROVIDER_HELP_LINKS[credential.provider].instruction}</p>
              <a
                href={PROVIDER_HELP_LINKS[credential.provider].url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-medium inline-flex items-center gap-1"
              >
                Open {PROVIDER_HELP_LINKS[credential.provider].label}
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            </div>
          )}

          {passwordError && (
            <div className="p-2.5 bg-destructive/10 border border-destructive/20 rounded text-xs text-destructive">
              {passwordError}
            </div>
          )}

          <form onSubmit={handlePasswordSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                New App Password
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new app password"
                className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                required
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isSavingPassword || !newPassword.trim()}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {isSavingPassword ? 'Saving...' : 'Save & Update'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditingPassword(false)
                  setPasswordError(null)
                  setNewPassword('')
                }}
                className="px-3 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/80"
              >
                Cancel
              </button>
            </div>
          </form>
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
          <div
            className={`w-9 h-5 rounded-full transition-colors relative ${
              syncMode === 'auto_daily' ? 'bg-primary' : 'bg-muted-foreground/30'
            }`}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                syncMode === 'auto_daily' ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
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
