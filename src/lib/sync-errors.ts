const AUTHENTICATION_ERROR =
  'Your email credentials were rejected. Reconnect your email account with a new app password, then try again.'

export function getSyncErrorMessage(error: unknown): string {
  if (isAuthenticationError(error)) return AUTHENTICATION_ERROR
  return error instanceof Error ? error.message : 'Sync failed'
}

function isAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const candidate = error as {
    authenticationFailed?: boolean
    serverResponseCode?: string
    response?: string
  }

  return (
    candidate.authenticationFailed === true ||
    candidate.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    candidate.response?.includes('AUTHENTICATIONFAILED') === true
  )
}
