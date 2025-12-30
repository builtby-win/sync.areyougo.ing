import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
// @ts-check
import { defineConfig } from 'astro/config'

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
      configPath: './wrangler.jsonc',
    },
    session: false,
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    define: {
      // Inject git commit SHA at build time for transparency
      'import.meta.env.PUBLIC_GIT_COMMIT': JSON.stringify(
        process.env.CF_PAGES_COMMIT_SHA || process.env.GIT_COMMIT || 'local'
      ),
      'import.meta.env.PUBLIC_DEPLOY_TIME': JSON.stringify(new Date().toISOString()),
    },
    resolve: {
      alias: import.meta.env.PROD
        ? {
            'react-dom/server': 'react-dom/server.edge',
          }
        : {},
    },
    server: {
      allowedHosts: ['.trycloudflare.com'],
    },
  },
})
