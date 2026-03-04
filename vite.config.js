import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3002'
    },
    hmr: {
      overlay: true,  // Show error overlay instead of blank screen
    },
    watch: {
      // Ignore config files to prevent constant restarts
      ignored: ['**/node_modules/**', '**/.git/**']
    }
  },
  build: {
    outDir: 'dist'
  },
  // Optimize for large files
  optimizeDeps: {
    holdUntilCrawlEnd: true
  }
})
