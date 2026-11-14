import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        // The dev proxy keeps the upstream request open when the browser aborts; close it so the backend sees the
        // disconnect and cancels IRSA downloads nobody is waiting for any more (e.g. after switching targets).
        configure: proxy => {
          proxy.on('proxyReq', (proxyReq, _req, res) => {
            res.on('close', () => { if (!res.writableFinished) proxyReq.destroy() })
          })
        },
      },
    },
  },
})
