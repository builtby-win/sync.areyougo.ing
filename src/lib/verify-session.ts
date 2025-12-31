/**
 * Delegated session verification.
 * We don't run our own auth - we trust the session cookie from areyougo.ing
 * and verify it by calling the main app's API.
 */

export interface User {
  id: string
  email: string
  name: string | null
  image: string | null
}

export interface Session {
  user: User
  session: {
    id: string
    expiresAt: string
  }
}

/**
 * Verify the session by forwarding the cookie to the main app.
 * Returns the user if authenticated, null otherwise.
 */
export async function verifySession(
  request: Request,
  mainAppUrl: string
): Promise<User | null> {
  const cookie = request.headers.get('cookie')
  if (!cookie) {
    console.log('[verify-session] No cookie present')
    return null
  }

  try {
    console.log('[verify-session] Forwarding cookies to main app...')
    console.log('[verify-session] Cookie header:', cookie.substring(0, 100) + '...')
    console.log('[verify-session] Calling:', `${mainAppUrl}/api/verify-session`)

    const response = await fetch(`${mainAppUrl}/api/verify-session`, {
      method: 'POST', // better-auth requires POST for session endpoints
      headers: {
        cookie,
        'content-type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({}), // Empty body for POST request
    })

    console.log('[verify-session] Main app response status:', response.status)
    if (!response.ok) {
      const responseText = await response.text()
      console.log('[verify-session] Error response body:', responseText.substring(0, 200))
    }

    if (!response.ok) {
      if (response.status === 403) {
        console.error('\n❌ Main app returned 403 Forbidden')
        console.error('💡 This usually means:')
        console.error('   1. Session cookie is invalid or expired')
        console.error('   2. better-auth rejected the request')
        console.error('   3. Check if the request method is correct\n')
      }
      console.log('[verify-session] Main app returned:', response.status)
      return null
    }

    const data = (await response.json()) as Session | null
    if (!data?.user) {
      console.log('[verify-session] No user in session response')
      return null
    }

    console.log('[verify-session] Verified user:', data.user.id)
    return data.user
  } catch (error) {
    // Check if it's a connection refused error (Docker can't reach host)
    if (error instanceof Error && 'cause' in error) {
      const cause = error.cause as any
      if (cause?.code === 'ECONNREFUSED') {
        console.error('\n❌ Cannot connect to main app at', mainAppUrl)
        console.error('💡 If running in Docker, make sure the main areyougo.ing app is running with:')
        console.error('   cd ../areyougo.ing && pnpm dev:host')
        console.error('   (The --host flag allows Docker to connect to your local server)\n')
        throw new Error('Cannot connect to main app. Is areyougo.ing running with pnpm dev:host?')
      }
    }
    console.error('[verify-session] Error verifying session:', error)
    return null
  }
}
