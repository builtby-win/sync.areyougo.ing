import type { APIRoute } from 'astro'

export const GET: APIRoute = () => {
  const commit = import.meta.env.PUBLIC_GIT_COMMIT || 'local'
  const commitShort = commit.slice(0, 7)
  const deployedAt = import.meta.env.PUBLIC_DEPLOY_TIME || 'unknown'

  return new Response(
    JSON.stringify({
      commit,
      commitShort,
      deployedAt,
      repo: 'https://github.com/builtby-win/sync.areyougo.ing',
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
}
