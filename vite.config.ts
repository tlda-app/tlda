import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  resolve: {
    alias: {
      'fleet-dashboard': path.resolve(__dirname, '../fleet/dashboard'),
    },
  },
  server: {
    host: true,
    port: 5173,
    fs: {
      allow: ['..'],
    },
    proxy: {
      // Fleet WebSocket endpoint
      '/ws/fleet': {
        target: 'ws://localhost:5199',
        ws: true,
      },
      // tlda-specific API routes → tlda server
      '/api/projects': 'http://localhost:5176',
      '/api/auth': 'http://localhost:5176',
      '/api/recognize': 'http://localhost:5176',
      // Remaining /api/* → fleet server (state, chat, activity, etc.)
      '/api': 'http://localhost:5199',
      '/docs': 'http://localhost:5176',
      '/health': 'http://localhost:5176',
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
})
