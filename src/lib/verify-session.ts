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
    const response = await fetch(`${mainAppUrl}/api/auth/get-session`, {
      headers: {
        cookie,
        // Pass through origin for CORS
        origin: new URL(request.url).origin,
      },
      credentials: 'include',
    })

    if (!response.ok) {
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
    console.error('[verify-session] Error verifying session:', error)
    return null
  }
}
