// @ts-check
import node from '@astrojs/node'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    define: {
      // Inject git commit SHA at build time for transparency
      'import.meta.env.PUBLIC_GIT_COMMIT': JSON.stringify(
        process.env.GIT_COMMIT || 'local'
      ),
      'import.meta.env.PUBLIC_DEPLOY_TIME': JSON.stringify(new Date().toISOString()),
    },
  },
})
