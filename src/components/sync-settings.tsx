import { useState, useEffect } from 'react'

interface User {
  id: string
  email: string
  name: string | null
}

interface ExistingCredentials {
  provider: string
  imapEmail: string
  lastSyncAt: number | null
  syncMode: string
  lastManualSyncAt: number | null
}

interface Props {
  user: User
  credentials: ExistingCredentials
  onUpdateSettings: () => void
}

type SyncMode = 'manual' | 'auto_daily'

interface LookbackOption {
  label: string
  days: number
  warning?: string
}

const LOOKBACK_OPTIONS: LookbackOption[] = [
  { label: '1 month', days: 30 },
  { label: '6 months', days: 180 },
  { label: '1 year', days: 365, warning: 'May take a minute' },
  { label: '2 years', days: 730, warning: 'May take a few minutes' },
  { label: '5 years', days: 1825, warning: 'May take several minutes' },
]

const PROVIDER_NAMES: Record<string, string> = {
  icloud: 'iCloud Mail',
  gmail: 'Gmail',
  yahoo: 'Yahoo Mail',
  outlook: 'Outlook / Hotmail',
  other: 'Custom IMAP',
}

export default function SyncSettings({ user, credentials, onUpdateSettings }: Props) {
  const [syncMode, setSyncMode] = useState<SyncMode>(credentials.syncMode as SyncMode)
  const [isUpdatingSyncMode, setIsUpdatingSyncMode] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ found: number; ingested: number } | null>(null)
  const [lookbackDays, setLookbackDays] = useState(30)
  const [showLookbackSelector, setShowLookbackSelector] = useState(false)
  const [rateLimitedUntil, setRateLimitedUntil] = useState<Date | null>(null)

  // Calculate if rate limited
  useEffect(() => {
    if (credentials.lastManualSyncAt) {
      const nextAvailable = new Date(credentials.lastManualSyncAt * 1000 + 24 * 60 * 60 * 1000)
      if (nextAvailable > new Date()) {
        setRateLimitedUntil(nextAvailable)
      } else {
        setRateLimitedUntil(null)
      }
    }
  }, [credentials.lastManualSyncAt])

  const handleSyncModeChange = async (newMode: SyncMode) => {
    if (newMode === syncMode) return

    setIsUpdatingSyncMode(true)
    setSyncError(null)

    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncMode: newMode }),
      })

      if (!response.ok) {
        const data = await response.json()
        setSyncError(data.error || 'Failed to update sync mode')
        return
      }

      setSyncMode(newMode)
      onUpdateSettings()
    } catch {
      setSyncError('Failed to update sync mode')
    } finally {
      setIsUpdatingSyncMode(false)
    }
  }

  const handleManualSync = async (dryRun = false) => {
    setIsSyncing(true)
    setSyncError(null)
    setSyncResult(null)

    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays, dryRun }),
      })

      const data = await response.json()

      if (response.status === 429) {
        setRateLimitedUntil(new Date(data.rateLimitedUntil))
        setSyncError('Rate limited. You can sync manually once per 24 hours.')
        return
      }

      if (!response.ok) {
        setSyncError(data.error || 'Sync failed')
        return
      }

      if (dryRun) {
        setSyncResult({ found: data.emailsFound || 0, ingested: 0 })
      } else {
        setSyncResult({ found: data.emailsFound || 0, ingested: data.emailsIngested || 0 })
        onUpdateSettings() // Refresh to get new lastSyncAt
      }
    } catch {
      setSyncError('Sync failed. Please try again.')
    } finally {
      setIsSyncing(false)
      setShowLookbackSelector(false)
    }
  }

  const formatRelativeTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`
  }

  const isRateLimited = rateLimitedUntil && rateLimitedUntil > new Date()

  return (
    <div className="bg-card rounded-lg border border-border p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
          <svg className="w-5 h-5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div>
          <h2 className="font-semibold">Email Sync Active</h2>
          <p className="text-sm text-muted-foreground">
            {credentials.imapEmail} via {PROVIDER_NAMES[credentials.provider] || credentials.provider}
          </p>
        </div>
      </div>

      {/* Last sync info */}
      {credentials.lastSyncAt && (
        <div className="text-sm text-muted-foreground">
          Last synced: {formatRelativeTime(credentials.lastSyncAt)}
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
      {syncError && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {syncError}
        </div>
      )}

      {/* Success display */}
      {syncResult && (
        <div className="p-3 bg-success/10 border border-success/20 rounded-md text-sm text-success">
          {syncResult.ingested > 0
            ? `Synced ${syncResult.ingested} of ${syncResult.found} ticket emails.`
            : `Found ${syncResult.found} ticket emails${syncResult.found > 0 ? ' (preview only)' : ''}.`}
        </div>
      )}

      {/* Manual sync section */}
      <div className="space-y-3 pt-2 border-t border-border">
        <h3 className="text-sm font-medium">Manual Sync</h3>

        {showLookbackSelector ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              How far back should we look for ticket emails?
            </p>
            <div className="grid grid-cols-2 gap-2">
              {LOOKBACK_OPTIONS.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  onClick={() => setLookbackDays(option.days)}
                  className={`px-3 py-2 rounded-md text-sm transition-colors ${
                    lookbackDays === option.days
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                  }`}
                >
                  {option.label}
                  {option.warning && lookbackDays === option.days && (
                    <span className="block text-xs opacity-80">{option.warning}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowLookbackSelector(false)}
                className="flex-1 px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleManualSync(false)}
                disabled={isSyncing}
                className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isSyncing ? 'Syncing...' : 'Sync Now'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            {isRateLimited ? (
              <div className="text-sm text-muted-foreground">
                <p>Manual sync available again: {rateLimitedUntil!.toLocaleString()}</p>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowLookbackSelector(true)}
                disabled={isSyncing}
                className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {isSyncing ? 'Syncing...' : 'Sync Now'}
              </button>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Manual sync is available once per 24 hours.
            </p>
          </div>
        )}
      </div>

      {/* Dashboard link */}
      <div className="pt-2 border-t border-border">
        <a
          href="https://areyougo.ing/dashboard"
          className="text-sm text-primary hover:underline"
        >
          View your timeline on areyougo.ing →
        </a>
      </div>
    </div>
  )
}
