import { useState } from 'react'
import AccountCard from './account-card'
import SetupWizard from './setup-wizard'
import { buildReturnUrl } from '../lib/redirect'

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
  accounts: AccountCredential[]
  redirectUrl?: string | null
}

const MAX_ACCOUNTS = 5

export default function AccountsList({ user, accounts, redirectUrl }: Props) {
  const handleUpdate = () => {
    window.location.reload()
  }
  const [showAddForm, setShowAddForm] = useState(false)
  const returnUrl = buildReturnUrl(redirectUrl ?? null, 'https://areyougo.ing')
  const returnLabel = redirectUrl ? 'Back to your wrapped →' : 'Back to Dashboard →'

  const canAddMore = accounts.length < MAX_ACCOUNTS

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Connected Accounts</h2>
          <p className="text-sm text-muted-foreground">
            {accounts.length} of {MAX_ACCOUNTS} accounts connected
          </p>
        </div>
        {canAddMore && !showAddForm && (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md font-medium hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add Account
          </button>
        )}
      </div>

      {/* Add account form */}
      {showAddForm && (
        <div className="bg-card rounded-lg border border-border">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="font-medium">Add Email Account</h3>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <SetupWizard
            user={user}
            existingCredentials={null}
            onComplete={handleUpdate}
            onCancel={() => setShowAddForm(false)}
          />
        </div>
      )}

      {/* Account cards */}
      <div className="space-y-4">
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            user={user}
            credential={account}
            onUpdate={handleUpdate}
            onDelete={handleUpdate}
            redirectUrl={redirectUrl}
          />
        ))}
      </div>

      {/* Limit message */}
      {!canAddMore && (
        <p className="text-sm text-muted-foreground text-center py-2">
          Maximum of {MAX_ACCOUNTS} accounts reached. Remove an account to add a new one.
        </p>
      )}

      {/* Dashboard link */}
      <div className="pt-4 border-t border-border text-center">
        <a
          href={returnUrl}
          className="text-sm text-primary hover:underline"
        >
          {returnLabel}
        </a>
      </div>
    </div>
  )
}
