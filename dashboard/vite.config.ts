/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// Three prototypes share one data file (public/fairprice_data.json, copied
// from reports/dashboard by `npm run data`). base './' so each built page can
// be hosted from any folder.
// Local dev: serve /api/*.ts (the Vercel functions) from the Vite server, with
// keys from .env.local. On Vercel the same files run as serverless functions.
function devApi(): Plugin {
  return {
    name: 'fairprice-dev-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv('development', process.cwd(), ''))
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const m = req.url?.match(/^\/api\/([a-z]+)/)
        if (!m) return next()
        try {
          const mod = await server.ssrLoadModule(`/api/${m[1]}.ts`)
          const handler = mod[req.method ?? 'GET']
          if (!handler) { res.statusCode = 405; return res.end() }
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const request = new Request(`http://localhost${req.url}`, {
            method: req.method, headers: req.headers as Record<string, string>,
            body: chunks.length ? Buffer.concat(chunks) : undefined,
          })
          const out: Response = await handler(request)
          res.statusCode = out.status
          out.headers.forEach((v, k) => res.setHeader(k, v))
          res.end(Buffer.from(await out.arrayBuffer()))
        } catch (e) {
          res.statusCode = 500
          res.end(String(e))
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), devApi()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'api/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        landing: resolve(import.meta.dirname, 'landing.html'),
        login: resolve(import.meta.dirname, 'login.html'),
        prototypes: resolve(import.meta.dirname, 'prototypes.html'),
        monitor: resolve(import.meta.dirname, 'monitor.html'),
        today: resolve(import.meta.dirname, 'today.html'),
        replay: resolve(import.meta.dirname, 'replay.html'),
      },
    },
  },
})
