import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react({
      fastRefresh: true,
      include: '**/*.{jsx,tsx}',
    })
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // All same-origin API paths route through the Lab Server (3002).
      // Lab Server forwards Gateway-owned paths (/web/*, /gateway/*,
      // /api/slack/*) to localhost:3001 internally — see proxyToGateway
      // in oven-timer-server.js. This keeps prod (Cloudflare tunnel) and
      // dev (vite) using identical same-origin URLs in the frontend.
      '/api':     'http://localhost:3002',
      '/web':     'http://localhost:3002',
      '/gateway': 'http://localhost:3002',
    },
    hmr: {
      overlay: true,
      // Prevent full page reloads - show overlay instead
      timeout: 60000,
    },
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/vite.config.js',
        '**/vite.config.ts',
        '**/.env',
        '**/.env.*',
        '**/package.json',
        '**/package-lock.json',
        '**/tsconfig.json',
      ],
      usePolling: false,
    }
  },
  build: {
    outDir: 'dist'
  },
  optimizeDeps: {
    holdUntilCrawlEnd: true
  },
  // Experimental: Don't invalidate on circular deps
  experimental: {
    hmrPartialAccept: true
  }
})
