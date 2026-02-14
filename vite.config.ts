import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Proxy API and doc requests to unified server in dev mode
      '/api': 'http://localhost:5176',
      '/docs': 'http://localhost:5176',
      '/health': 'http://localhost:5176',
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
})
