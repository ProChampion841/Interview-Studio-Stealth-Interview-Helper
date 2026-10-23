import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const developmentCspPlugin: Plugin = {
  name: 'development-csp',
  transformIndexHtml(html, context) {
    if (!context.server) return html
    return html.replace(
      "connect-src 'self'",
      "connect-src 'self' ws://127.0.0.1:* ws://localhost:*"
    )
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@ozymandiasthegreat/vad'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          'offline-caption-worker': resolve(__dirname, 'electron/main/offline-caption-worker.ts'),
          'offline-translation-worker': resolve(__dirname, 'electron/main/offline-translation-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    server: {
      host: '127.0.0.1'
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    plugins: [developmentCspPlugin, react()]
  }
})
