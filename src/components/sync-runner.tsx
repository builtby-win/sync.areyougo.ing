import { useEffect, useState } from 'react'
import { isEmbedded, notifySyncComplete } from '../lib/post-message'
import { buildReturnUrl } from '../lib/redirect'

interface User {
  id: string
  email: string
  name: string | null
}

interface Props {
  user: User
  credentialId: string
  defaultLookbackDays?: number
  redirectUrl?: string | null
  mainAppUrl: string
}

interface SyncEmail {
  messageId: string
  from: string
  subject: string
  date: string
  ingestStatus: 'pending' | 'sending' | 'success' | 'failed' | 'skipped'
  ingestError?: string
}

interface SyncStatus {
  status: 'fetching' | 'waiting_for_selection' | 'ingesting' | 'completed' | 'failed'
  emails: SyncEmail[]
  totalFound: number
  currentSender?: string
  sendersCompleted?: string[]
  sendersTotal?: number
  error?: string
}

export default function SyncRunner({ user, credentialId, defaultLookbackDays = 30, redirectUrl, mainAppUrl }: Props) {
  const [stage, setStep] = useState<'init' | 'fetching' | 'selecting' | 'ingesting' | 'completed' | 'error'>('init')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [emails, setEmails] = useState<SyncEmail[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [statusData, setStatusData] = useState<SyncStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lookbackDays, setLookbackDays] = useState(defaultLookbackDays)
  
  const returnUrl = buildReturnUrl(redirectUrl ?? null, mainAppUrl)
  const isEmbeddedMode = isEmbedded()

  // Start Sync
  const startSync = async () => {
    setStep('fetching')
    setError(null)
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialId,
          lookbackDays,
          dryRun: false,
          waitForSelection: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start sync')
      setSessionId(data.sessionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setStep('error')
    }
  }

  // Poll Status
  useEffect(() => {
    if (!sessionId) return

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/sync-status?sessionId=${sessionId}`)
        if (res.ok) {
          const data: SyncStatus = await res.json()
          setStatusData(data)
          setEmails(data.emails)

          if (data.status === 'waiting_for_selection') {
            setStep('selecting')
            // Default select all pending emails if not already set
            if (selectedIds.size === 0 && data.emails.length > 0) {
                const pendingIds = data.emails.filter(e => e.ingestStatus === 'pending').map(e => e.messageId)
                setSelectedIds(new Set(pendingIds))
            }
          } else if (data.status === 'ingesting') {
            setStep('ingesting')
          } else if (data.status === 'completed') {
            setStep('completed')
            clearInterval(interval)
          } else if (data.status === 'failed') {
            setError(data.error || 'Sync failed')
            setStep('error')
            clearInterval(interval)
          }
        }
      } catch (e) {
        console.error('Polling error', e)
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [sessionId, selectedIds.size])

  // Initial auto-start
  useEffect(() => {
    if (stage === 'init') {
      startSync()
    }
  }, [stage])

  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const toggleAll = () => {
    const pendingIds = emails.filter(e => e.ingestStatus === 'pending').map(e => e.messageId)
    if (selectedIds.size === pendingIds.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(pendingIds))
    }
  }

  const confirmSelection = async () => {
    setStep('ingesting') // Optimistic update
    try {
      const res = await fetch('/api/sync/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          selectedMessageIds: Array.from(selectedIds),
        }),
      })
      if (!res.ok) throw new Error('Failed to confirm')
    } catch (e) {
      setError('Failed to start import')
      setStep('error')
    }
  }

  const handleComplete = (action: 'timeline' | 'audit') => {
    // 1. Try postMessage to close modal
    notifySyncComplete(statusData?.totalFound || 0, statusData?.emails.filter(e => e.ingestStatus === 'success').length || 0, action)
    
    // 2. Fallback: Force redirect parent window after short delay
    // This ensures navigation happens even if postMessage is blocked/ignored
    setTimeout(() => {
        const targetPath = action === 'audit' ? '/settings/email-audit' : '/'
        const targetUrl = `${mainAppUrl}${targetPath}`
        try {
            window.top!.location.href = targetUrl
        } catch (e) {
            console.error('Failed to redirect top window:', e)
        }
    }, 100)
  }

  const formatSenderName = (sender: string) => {
    return sender.charAt(0).toUpperCase() + sender.slice(1)
  }

  // Render Helpers
  if (stage === 'init' || stage === 'fetching') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-4">
        <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
          <svg className="animate-spin w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Searching for Tickets...</h2>
          <p className="text-muted-foreground">
            {statusData?.currentSender 
              ? `Scanning ${formatSenderName(statusData.currentSender)}` 
              : 'Connecting to your email...'}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Found {statusData?.totalFound || 0} tickets so far
          </p>
        </div>
      </div>
    )
  }

  if (stage === 'selecting') {
    const pendingEmails = emails.filter(e => e.ingestStatus === 'pending')
    const skippedEmails = emails.filter(e => e.ingestStatus === 'skipped')

    return (
      <div className="max-w-2xl mx-auto py-8 px-4">
        <h1 className="text-2xl font-bold mb-2">Review Tickets</h1>
        <p className="text-muted-foreground mb-6">Select the emails you want to import to areyougo.ing</p>

        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border flex justify-between items-center bg-muted/30">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selectedIds.size === pendingEmails.length && pendingEmails.length > 0}
                onChange={toggleAll}
                className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
              />
              <span className="text-sm font-medium">Select All</span>
            </label>
            <span className="text-sm text-muted-foreground">{selectedIds.size} selected</span>
          </div>

          <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
            {pendingEmails.length === 0 && skippedEmails.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                    No ticket emails found in the last {lookbackDays} days.
                </div>
            ) : (
              <>
                {pendingEmails.map(email => (
                <label key={email.messageId} className="flex items-start gap-3 p-4 hover:bg-muted/50 cursor-pointer transition-colors">
                    <input
                    type="checkbox"
                    checked={selectedIds.has(email.messageId)}
                    onChange={() => toggleSelection(email.messageId)}
                    className="mt-1 w-4 h-4 rounded border-input text-primary focus:ring-primary"
                    />
                    <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{email.subject}</div>
                    <div className="text-sm text-muted-foreground flex justify-between mt-1">
                        <span>{email.from}</span>
                        <span>{new Date(email.date).toLocaleDateString()}</span>
                    </div>
                    </div>
                </label>
                ))}
                {skippedEmails.length > 0 && (
                  <>
                    <div className="p-3 bg-muted/50 text-xs font-medium text-muted-foreground">
                      Already imported ({skippedEmails.length})
                    </div>
                    {skippedEmails.map(email => (
                      <div key={email.messageId} className="flex items-start gap-3 p-4 opacity-50">
                        <div className="mt-1 w-4 h-4 flex items-center justify-center">
                          <svg className="w-4 h-4 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{email.subject}</div>
                          <div className="text-sm text-muted-foreground flex justify-between mt-1">
                            <span>{email.from}</span>
                            <span>{new Date(email.date).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <a href="/" className="px-4 py-2 border border-border rounded-md font-medium hover:bg-secondary transition-colors text-center">
            Cancel
          </a>
          <button
            onClick={confirmSelection}
            disabled={selectedIds.size === 0}
            className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            Sync {selectedIds.size} Tickets
          </button>
        </div>
      </div>
    )
  }

  if (stage === 'ingesting' || stage === 'completed') {
    const successCount = emails.filter(e => e.ingestStatus === 'success').length
    const failCount = emails.filter(e => e.ingestStatus === 'failed').length
    const completed = successCount + failCount
    const total = selectedIds.size
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0
    const isDone = stage === 'completed'

    return (
      <div className="max-w-xl mx-auto py-12 px-4 text-center">
        <h2 className="text-2xl font-bold mb-6">
          {isDone ? 'Sync Complete' : 'Syncing Tickets...'}
        </h2>
        
        <div className="w-full bg-secondary rounded-full h-4 mb-4 overflow-hidden">
          <div 
            className="bg-primary h-full transition-all duration-500 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div className="mb-8">
            <p className="text-muted-foreground">
            {isDone 
                ? `Successfully synced ${successCount} tickets${failCount > 0 ? `, ${failCount} failed` : ''}.`
                : `${completed} of ${total} processed`}
            </p>
            {isDone && successCount > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                    Your tickets are being processed and will appear in your timeline shortly.
                </p>
            )}
        </div>

        <div className="bg-card border border-border rounded-lg p-4 text-left max-h-60 overflow-y-auto mb-8">
            {emails.filter(e => selectedIds.has(e.messageId)).map(email => (
                <div key={email.messageId} className="flex items-center justify-between py-2 text-sm border-b border-border/50 last:border-0">
                    <span className="truncate flex-1 pr-4">{email.subject}</span>
                    <div className="flex-shrink-0">
                        {email.ingestStatus === 'pending' && <span className="text-muted-foreground">Pending</span>}
                        {email.ingestStatus === 'sending' && <span className="text-primary animate-pulse font-medium">Syncing...</span>}
                        {email.ingestStatus === 'success' && <span className="text-success font-medium flex items-center gap-1">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            Received
                        </span>}
                        {email.ingestStatus === 'failed' && <span className="text-destructive font-medium">Failed</span>}
                    </div>
                </div>
            ))}
        </div>

        {isDone && (
            <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-4 duration-500">
                {isEmbeddedMode ? (
                    <>
                    {failCount === 0 ? (
                        <button
                            onClick={() => handleComplete('timeline')}
                            className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
                        >
                            Go to Timeline
                        </button>
                    ) : (
                        <button
                            onClick={() => handleComplete('audit')}
                            className="w-full px-4 py-2 bg-destructive text-destructive-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
                        >
                            View Sync Issues
                        </button>
                    )}
                    </>
                ) : (
                    <a 
                        href={returnUrl}
                        className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
                    >
                        Return to Dashboard
                    </a>
                )}
                <a href="/" className="text-sm text-muted-foreground hover:underline mt-2">Sync another account</a>
            </div>
        )}
      </div>
    )
  }

  if (stage === 'error') {
    return (
      <div className="max-w-md mx-auto py-12 px-4 text-center">
        <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center mx-auto mb-6">
          <span className="text-3xl">⚠️</span>
        </div>
        <h2 className="text-2xl font-bold mb-2 text-destructive">Sync Failed</h2>
        <p className="text-muted-foreground mb-8">{error}</p>
        <a href="/" className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90">
          Go Back
        </a>
      </div>
    )
  }

  return null
}
