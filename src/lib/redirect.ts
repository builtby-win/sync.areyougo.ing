export function buildReturnUrl(redirectUrl: string | null, fallbackUrl: string): string {
  const targetUrl = redirectUrl ?? fallbackUrl
  try {
    const parsed = new URL(targetUrl)
    parsed.searchParams.set('showSyncing', 'true')
    return parsed.toString()
  } catch {
    const parsed = new URL(fallbackUrl)
    parsed.searchParams.set('showSyncing', 'true')
    return parsed.toString()
  }
}

export function getRedirectPath(redirectUrl: string | null, fallbackPath: string): string {
  if (!redirectUrl) return fallbackPath
  try {
    const parsed = new URL(redirectUrl)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallbackPath
  }
}
