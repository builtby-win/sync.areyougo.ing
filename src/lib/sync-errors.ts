export function isAuthenticationError(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'string') {
    const lower = error.toLowerCase()
    return (
      lower.includes('authenticationfailed') ||
      lower.includes('authentication failed') ||
      lower.includes('invalid credentials') ||
      lower.includes('login failed') ||
      lower.includes('credentials rejected')
    )
  }
  if (typeof error !== 'object') return false

  const candidate = error as {
    authenticationFailed?: boolean
    serverResponseCode?: string
    response?: string
    message?: string
  }

  const msg = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : ''
  const resp = typeof candidate.response === 'string' ? candidate.response.toLowerCase() : ''

  return (
    candidate.authenticationFailed === true ||
    candidate.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    resp.includes('authenticationfailed') ||
    resp.includes('authentication failed') ||
    msg.includes('authenticationfailed') ||
    msg.includes('authentication failed') ||
    msg.includes('invalid credentials') ||
    msg.includes('login failed') ||
    msg.includes('credentials rejected')
  )
}

export function isTimeoutError(error: unknown): boolean {
  if (!error) return false
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (error as { message?: string })?.message || ''
  const lower = msg.toLowerCase()
  return (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('connect_timeout') ||
    lower.includes('failed to establish connection') ||
    lower.includes('required time') ||
    lower.includes('socket timeout') ||
    lower.includes('connection timeout')
  )
}

export function isNetworkError(error: unknown): boolean {
  if (!error) return false
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (error as { message?: string })?.message || ''
  const lower = msg.toLowerCase()
  return (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('ehostunreach') ||
    lower.includes('network error')
  )
}

export function getSyncErrorMessage(error: unknown, provider?: string): string {
  if (isAuthenticationError(error)) {
    const prov = provider?.toLowerCase()
    if (prov === 'icloud') {
      return 'iCloud rejected your credentials. Apple requires an App-Specific Password (not your main Apple ID password). Generate a new App-Specific Password at appleid.apple.com to resume syncing.'
    }
    if (prov === 'gmail') {
      return 'Gmail rejected your credentials. Google requires an App Password (with 2-Step Verification enabled). Generate a new App Password in your Google Account security settings.'
    }
    if (prov === 'yahoo') {
      return 'Yahoo rejected your credentials. Generate an App Password in your Yahoo Account security settings to resume syncing.'
    }
    if (prov === 'outlook') {
      return 'Outlook rejected your credentials. Generate an App Password in your Microsoft Account security settings to resume syncing.'
    }
    return 'Your email credentials were rejected. Reconnect your email account with a new app password, then try again.'
  }

  if (isTimeoutError(error)) {
    const prov = provider?.toLowerCase()
    if (prov === 'icloud') {
      return 'Connection to iCloud Mail timed out. Apple may be temporarily throttling connection attempts after repeated logins. Please wait a couple minutes and try again.'
    }
    return 'Connection to the mail server timed out. The server may be temporarily busy or throttling requests. Please wait a couple minutes and try again.'
  }

  if (isNetworkError(error)) {
    return 'Could not reach the mail server. Please verify the mail server host and port settings.'
  }

  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Sync failed'
}
