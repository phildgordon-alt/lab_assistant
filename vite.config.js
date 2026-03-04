import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react({
      // Disable Fast Refresh boundary checks - keeps content visible during updates
      fastRefresh: true,
      // Don't require consistent exports for refresh
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
      // Don't reload on error - keep showing current content
      protocol: 'ws',
    },
    watch: {
      ignored: ['**/node_modules/**', '**/.git/**']
    }
  },
  build: {
    outDir: 'dist'
  },
  optimizeDeps: {
    holdUntilCrawlEnd: true
  }
})
