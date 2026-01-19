import { useState, useEffect } from 'react'
import { encryptPassword } from '../lib/encryption'

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
}

interface EmailPreview {
  from: string
  subject: string
  date: string
}

type ConnectionState = 'connecting' | 'authenticating' | 'connected' | 'error'

interface SyncEmail {
  messageId: string
  from: string
  subject: string
  date: string
  ingestStatus: 'pending' | 'sending' | 'success' | 'failed'
}

interface SyncStatusResponse {
  status: 'fetching' | 'ingesting' | 'completed' | 'failed'
  emails: SyncEmail[]
  totalFound: number
  error?: string
  currentSender?: string
  sendersCompleted?: string[]
  sendersTotal?: number
  connectionState?: ConnectionState
  connectionError?: string
}

interface Props {
  user: User
  existingCredentials: ExistingCredentials | null
  onComplete?: () => void
  onCancel?: () => void
}

type Provider = 'icloud' | 'gmail' | 'yahoo' | 'outlook' | 'other'
type SyncMode = 'manual' | 'auto_daily'

interface ProviderConfig {
  name: string
  host: string
  port: number
  instructions: React.ReactNode[]
  helpUrl: string
}

const Link = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-blue-500 hover:text-blue-600 underline font-medium"
  >
    {children}
  </a>
)

const PROVIDERS: Record<Provider, ProviderConfig> = {
  icloud: {
    name: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    instructions: [
      <span key="i1">
        Go to <Link href="https://appleid.apple.com">appleid.apple.com</Link> and sign in
      </span>,
      <span key="i2">Go to "Sign-In and Security" → "App-Specific Passwords"</span>,
      <span key="i3">Click "Generate an app-specific password"</span>,
      <span key="i4">Name it "areyougo.ing" and click Create</span>,
      <span key="i5">Copy the password shown (you won't see it again)</span>,
    ],
    helpUrl: 'https://support.apple.com/en-us/102654',
  },
  gmail: {
    name: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    instructions: [
      <span key="g1">
        Go to{' '}
        <Link href="https://myaccount.google.com/apppasswords">
          myaccount.google.com/apppasswords
        </Link>
      </span>,
      <span key="g2">Sign in if prompted</span>,
      <span key="g3">Select "Mail" as the app and your device</span>,
      <span key="g4">Click "Generate"</span>,
      <span key="g5">Copy the 16-character password shown</span>,
    ],
    helpUrl: 'https://support.google.com/accounts/answer/185833',
  },
  yahoo: {
    name: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    instructions: [
      <span key="y1">
        Go to{' '}
        <Link href="https://login.yahoo.com/account/security">
          login.yahoo.com/account/security
        </Link>
      </span>,
      <span key="y2">Scroll to "Generate app password"</span>,
      <span key="y3">Select "Other App" and enter "areyougo.ing"</span>,
      <span key="y4">Click "Generate"</span>,
      <span key="y5">Copy the password shown</span>,
    ],
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
  },
  outlook: {
    name: 'Outlook / Hotmail',
    host: 'outlook.office365.com',
    port: 993,
    instructions: [
      <span key="o1">
        Go to{' '}
        <Link href="https://account.microsoft.com/security">account.microsoft.com/security</Link>
      </span>,
      <span key="o2">Click "Advanced security options"</span>,
      <span key="o3">Under "App passwords", click "Create a new app password"</span>,
      <span key="o4">Copy the password shown</span>,
    ],
    helpUrl:
      'https://support.microsoft.com/en-us/account-billing/using-app-passwords-with-apps-that-don-t-support-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944',
  },
  other: {
    name: 'Other Provider',
    host: '',
    port: 993,
    instructions: [
      <span key="oth1">Find your email provider's IMAP settings</span>,
      <span key="oth2">Generate an app-specific password if available</span>,
      <span key="oth3">Enter the IMAP server hostname and port below</span>,
    ],
    helpUrl: '',
  },
}

type Step =
  | 'provider'
  | 'instructions'
  | 'credentials'
  | 'testing'
  | 'preferences'
  | 'success'
  | 'manage'

export default function SetupWizard({ user, existingCredentials, onComplete, onCancel }: Props) {
  const [step, setStep] = useState<Step>(existingCredentials ? 'manage' : 'provider')
  const [provider, setProvider] = useState<Provider | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(993)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [sampleEmails, setSampleEmails] = useState<EmailPreview[]>([])
  const [syncMode, setSyncMode] = useState<SyncMode>('manual')

  // Real polling state for test connection
  const [testSessionId, setTestSessionId] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState | undefined>()
  const [currentSender, setCurrentSender] = useState<string | undefined>()
  const [sendersCompleted, setSendersCompleted] = useState<number>(0)
  const [sendersTotal, setSendersTotal] = useState<number>(0)
  const [testStatus, setTestStatus] = useState<SyncStatusResponse['status'] | null>(null)

  // Polling effect for test session status
  useEffect(() => {
    if (!testSessionId) return

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/sync-status?sessionId=${testSessionId}`)
        if (response.ok) {
          const data: SyncStatusResponse = await response.json()
          setConnectionState(data.connectionState)
          setCurrentSender(data.currentSender)
          setSendersCompleted(data.sendersCompleted?.length || 0)
          setSendersTotal(data.sendersTotal || 0)
          setTestStatus(data.status)

          if (data.status === 'completed' || data.status === 'failed') {
            clearInterval(pollInterval)
            setIsLoading(false)

            if (data.status === 'completed') {
              // Convert to EmailPreview format for display
              const previews: EmailPreview[] = data.emails.map((e) => ({
                from: e.from,
                subject: e.subject,
                date: e.date,
              }))
              setSampleEmails(previews)
              setStep('testing')
            } else if (data.error) {
              setError(data.connectionError || data.error || 'Connection failed')
            }
          }
        }
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, 1000)

    return () => clearInterval(pollInterval)
  }, [testSessionId])

  // Format sender name for display
  const formatSenderName = (sender: string) => {
    return sender.charAt(0).toUpperCase() + sender.slice(1)
  }

  // Get progress message based on real state
  const getProgressMessage = () => {
    if (connectionState === 'connecting') return 'Connecting to your email...'
    if (connectionState === 'authenticating') return 'Authenticating...'
    if (connectionState === 'connected' && currentSender) {
      return `Searching ${formatSenderName(currentSender)}... (${sendersCompleted}/${sendersTotal})`
    }
    if (connectionState === 'connected') return 'Connected! Starting search...'
    return 'Connecting to your email...'
  }

  const handleProviderSelect = (p: Provider) => {
    setProvider(p)
    setHost(PROVIDERS[p].host)
    setPort(PROVIDERS[p].port)
    setStep('instructions')
  }

  const handleTestConnection = async () => {
    if (!provider || !email || !password) return

    setIsLoading(true)
    setError(null)
    setTestSessionId(null)
    setConnectionState(undefined)
    setCurrentSender(undefined)
    setSendersCompleted(0)
    setSendersTotal(0)
    setTestStatus(null)
    setSampleEmails([])

    try {
      const response = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          email,
          password, // Sent over HTTPS, encrypted at rest
          host: host || PROVIDERS[provider].host,
          port: port || PROVIDERS[provider].port,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Connection test failed')
        setIsLoading(false)
        return
      }

      // Start polling with sessionId
      if (data.sessionId) {
        setTestSessionId(data.sessionId)
        // isLoading stays true, polling effect handles the rest
      } else {
        // Fallback for old API response format
        setSampleEmails(data.sampleEmails || [])
        setStep('testing')
        setIsLoading(false)
      }
    } catch {
      setError('Failed to test connection. Please try again.')
      setIsLoading(false)
    }
  }

  const handleSave = async () => {
    if (!provider || !email || !password) return

    setIsLoading(true)
    setError(null)

    try {
      // Get encryption key from server
      const keyResponse = await fetch('/api/encryption-key')
      if (!keyResponse.ok) {
        throw new Error('Failed to get encryption key')
      }
      const { key } = await keyResponse.json()

      // Encrypt password client-side
      const { encrypted, iv } = await encryptPassword(password, key)

      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          email,
          encryptedPassword: encrypted,
          iv,
          host: host || PROVIDERS[provider].host,
          port: port || PROVIDERS[provider].port,
          syncMode,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || 'Failed to save credentials')
        return
      }

      // If callback provided, use it; otherwise reload
      if (onComplete) {
        onComplete()
      } else {
        setStep('success')
      }
    } catch {
      setError('Failed to save credentials. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/delete', {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        setError(data.error || 'Failed to delete credentials')
        return
      }

      // Reload page to reset state
      window.location.reload()
    } catch {
      setError('Failed to delete credentials. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  // Manage existing credentials
  if (step === 'manage' && existingCredentials) {
    return (
      <div className="bg-card rounded-lg border border-border p-6">
        <div className="flex items-center gap-3 mb-4">
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
            <h2 className="font-semibold">Email Sync Active</h2>
            <p className="text-sm text-muted-foreground">
              Syncing {existingCredentials.imapEmail} via{' '}
              {PROVIDERS[existingCredentials.provider as Provider]?.name ||
                existingCredentials.provider}
            </p>
          </div>
        </div>

        {existingCredentials.lastSyncAt && (
          <p className="text-sm text-muted-foreground mb-4">
            Last synced: {new Date(existingCredentials.lastSyncAt * 1000).toLocaleString()}
          </p>
        )}

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive mb-4">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => {
              setStep('provider')
              setProvider(null)
              setEmail('')
              setPassword('')
            }}
            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
          >
            Update Settings
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isLoading}
            className="px-4 py-2 bg-destructive text-destructive-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isLoading ? 'Deleting...' : deleteConfirm ? 'Confirm Delete' : 'Delete My Data'}
          </button>
        </div>

        {deleteConfirm && !isLoading && (
          <p className="text-sm text-muted-foreground mt-2">
            Click again to confirm. This will permanently delete your IMAP credentials.
          </p>
        )}
      </div>
    )
  }

  // Provider selection
  if (step === 'provider') {
    return (
      <div className="bg-card rounded-lg border border-border p-6">
        <h2 className="font-semibold mb-4">Select Your Email Provider</h2>
        <div className="grid gap-3">
          {(Object.entries(PROVIDERS) as [Provider, ProviderConfig][]).map(([key, config]) => (
            <button
              key={key}
              type="button"
              onClick={() => handleProviderSelect(key)}
              className="w-full p-4 text-left bg-secondary/50 hover:bg-secondary rounded-md transition-colors border border-transparent hover:border-border"
            >
              <span className="font-medium">{config.name}</span>
            </button>
          ))}
        </div>
        {onCancel && (
          <div className="mt-4">
            <button
              type="button"
              onClick={onCancel}
              className="w-full px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    )
  }

  // Instructions
  if (step === 'instructions' && provider) {
    const config = PROVIDERS[provider]
    return (
      <div className="bg-card rounded-lg border border-border p-6">
        <h2 className="font-semibold mb-4">Create an App Password for {config.name}</h2>
        <div className="mb-6">
          <p className="text-sm text-muted-foreground mb-4">
            App passwords let you connect without using your main password. Follow these steps:
          </p>
          <ol className="list-decimal list-inside space-y-2 text-sm">
            {config.instructions.map((instruction, i) => (
              <li key={i}>{instruction}</li>
            ))}
          </ol>
          {config.helpUrl && (
            <a
              href={config.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-4 text-sm text-primary hover:underline"
            >
              View official help guide →
            </a>
          )}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep('provider')}
            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => setStep('credentials')}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
          >
            I Have My App Password
          </button>
        </div>
      </div>
    )
  }

  // Credentials form
  if (step === 'credentials' && provider) {
    const config = PROVIDERS[provider]
    return (
      <div className="bg-card rounded-lg border border-border p-6">
        <h2 className="font-semibold mb-4">Enter Your Credentials</h2>

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive mb-4">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleTestConnection()
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium mb-1">
              Email Address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">
              App Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="App-specific password"
              required
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">
              This is the app password you generated, not your main password
            </p>
          </div>

          {provider === 'other' && (
            <>
              <div>
                <label htmlFor="host" className="block text-sm font-medium mb-1">
                  IMAP Server
                </label>
                <input
                  id="host"
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="imap.example.com"
                  required
                  className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label htmlFor="port" className="block text-sm font-medium mb-1">
                  Port
                </label>
                <input
                  id="port"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  placeholder="993"
                  required
                  className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </>
          )}

          {provider !== 'other' && (
            <p className="text-xs text-muted-foreground">
              Connecting to {config.host}:{config.port}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setStep('instructions')}
              className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {isLoading ? 'Testing...' : 'Test Connection'}
            </button>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <svg
                className="animate-spin h-4 w-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>{getProgressMessage()}</span>
            </div>
          )}
        </form>
      </div>
    )
  }

  // Testing successful, show sample emails
  if (step === 'testing') {
    return (
      <div className="bg-card rounded-lg border border-border p-6">
        <div className="flex items-center gap-3 mb-4">
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
            <h2 className="font-semibold">Connection Successful!</h2>
            <p className="text-sm text-muted-foreground">We can connect to your email</p>
          </div>
        </div>

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive mb-4">
            {error}
          </div>
        )}

        {/* Sample emails preview */}
        {sampleEmails.length > 0 ? (
          <div className="mb-6">
            <h3 className="text-sm font-medium mb-2">
              Found {sampleEmails.length} ticket email{sampleEmails.length !== 1 ? 's' : ''} from
              the last 30 days:
            </h3>
            <div className="bg-secondary/50 rounded-md border border-border divide-y divide-border max-h-64 overflow-y-auto">
              {sampleEmails.map((email, i) => (
                <div key={i} className="p-3 text-sm">
                  <div className="font-medium truncate">{email.subject}</div>
                  <div className="text-muted-foreground text-xs mt-1 flex justify-between">
                    <span className="truncate">{email.from}</span>
                    <span className="ml-2 flex-shrink-0">
                      {new Date(email.date).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              These are the kinds of emails we'll sync to your areyougo.ing timeline.
            </p>
          </div>
        ) : (
          <div className="mb-6 p-4 bg-secondary/50 rounded-md">
            <p className="text-sm text-muted-foreground">
              No ticket emails found in the last 30 days. Don't worry — we'll still watch for new
              ones!
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep('credentials')}
            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => setStep('preferences')}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  // Sync preferences
  if (step === 'preferences') {
    return (
      <div className="bg-card rounded-lg border border-border p-6">
        <h2 className="font-semibold mb-4">Choose Your Sync Preferences</h2>

        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive mb-4">
            {error}
          </div>
        )}

        <div className="space-y-3 mb-6">
          <label
            className={`flex items-start gap-3 p-4 rounded-md border cursor-pointer transition-colors ${
              syncMode === 'manual'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground'
            }`}
          >
            <input
              type="radio"
              name="syncMode"
              value="manual"
              checked={syncMode === 'manual'}
              onChange={() => setSyncMode('manual')}
              className="mt-1"
            />
            <div>
              <div className="font-medium">Manual Sync Only</div>
              <p className="text-sm text-muted-foreground mt-1">
                You control when to sync. Use the "Sync Now" button anytime to pull your latest
                ticket emails. Great if you want to verify exactly what's being synced.
              </p>
            </div>
          </label>

          <label
            className={`flex items-start gap-3 p-4 rounded-md border cursor-pointer transition-colors ${
              syncMode === 'auto_daily'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground'
            }`}
          >
            <input
              type="radio"
              name="syncMode"
              value="auto_daily"
              checked={syncMode === 'auto_daily'}
              onChange={() => setSyncMode('auto_daily')}
              className="mt-1"
            />
            <div>
              <div className="font-medium">Auto-Sync Daily</div>
              <p className="text-sm text-muted-foreground mt-1">
                We'll automatically check for new ticket emails once per day (at 6am UTC). You can
                still use manual sync anytime. You can change this later.
              </p>
            </div>
          </label>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep('testing')}
            className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md font-medium hover:opacity-90 transition-opacity"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isLoading}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isLoading ? 'Saving...' : 'Save & Continue'}
          </button>
        </div>
      </div>
    )
  }

  // Success - reload page to show SyncSettings with sync button
  if (step === 'success') {
    // Auto-reload to show SyncSettings component which has the sync functionality
    window.location.reload()
    return (
      <div className="bg-card rounded-lg border border-border p-6 text-center">
        <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-4">
          <svg className="animate-spin w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
        <h2 className="font-semibold text-xl mb-2">Setup Complete!</h2>
        <p className="text-muted-foreground">Loading sync settings...</p>
      </div>
    )
  }

  return null
}
