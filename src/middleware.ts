import type { MiddlewareHandler } from 'astro'

/**
 * Middleware to set security headers for iframe embedding.
 *
 * In production, only allows embedding from areyougo.ing.
 * In development, allows localhost origins.
 *
 * Detection uses MAIN_APP_URL env var set in docker-compose.yml.
 * If it contains 'localhost' or is unset, we're in dev mode.
 */
export const onRequest: MiddlewareHandler = async (_context, next) => {
  const response = await next()

  // Check MAIN_APP_URL to determine environment
  // In production, MAIN_APP_URL is https://areyougo.ing
  // In development, it defaults to localhost or isn't set
  const mainAppUrl = process.env.MAIN_APP_URL || ''
  const isDev =
    !mainAppUrl ||
    mainAppUrl.includes('localhost') ||
    mainAppUrl.includes('127.0.0.1') ||
    process.env.NODE_ENV === 'development'

  const frameAncestors = isDev
    ? "'self' http://localhost:4321 http://localhost:4322 http://localhost:5432"
    : "'self' https://areyougo.ing"

  // Set Content-Security-Policy header to control where this app can be embedded
  response.headers.set('Content-Security-Policy', `frame-ancestors ${frameAncestors}`)

  // Also set X-Frame-Options for older browsers (ALLOW-FROM is deprecated but some still use it)
  // For modern browsers, CSP frame-ancestors takes precedence
  if (!isDev) {
    response.headers.set('X-Frame-Options', 'SAMEORIGIN')
  }

  return response
}
