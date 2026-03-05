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
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3002'
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
