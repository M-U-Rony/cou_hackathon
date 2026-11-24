// Zero-dependency production server for Docker / self-hosted deployments.
// Serves static Vite bundles from ./dist and routes /api/* to compiled ./dist-api/*.js.
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const DIST_DIR = resolve(ROOT, 'dist')
const API_DIR = resolve(ROOT, 'dist-api')
const PORT = Number(process.env.PORT || 3000)

const API_ROUTES = new Set(['health', 'auth', 'summary', 'tts'])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

async function handleApi(name, req, res, url) {
  const method = (req.method || 'GET').toUpperCase()
  try {
    const mod = await import(pathToFileURL(join(API_DIR, `${name}.js`)).href)
    const handler = mod[method]
    if (typeof handler !== 'function') {
      res.statusCode = 405
      return res.end('Method Not Allowed')
    }

    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item)
      } else if (v !== undefined) {
        headers.set(k, v)
      }
    }

    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
    const request = new Request(url.href, { method, headers, body })
    const out = await handler(request)

    res.statusCode = out.status
    const setCookies = typeof out.headers.getSetCookie === 'function' ? out.headers.getSetCookie() : []
    out.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'set-cookie') res.setHeader(k, v)
    })
    if (setCookies.length) res.setHeader('set-cookie', setCookies)

    const buf = Buffer.from(await out.arrayBuffer())
    return res.end(buf)
  } catch (err) {
    console.error('[server] api error:', err)
    res.statusCode = 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    return res.end(JSON.stringify({ error: 'Internal Server Error' }))
  }
}

function handleStatic(pathname, res) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.statusCode = 400
    return res.end('Bad Request')
  }

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const filePath = resolve(DIST_DIR, rel)
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
    res.statusCode = 403
    return res.end('Forbidden')
  }

  try {
    const st = statSync(filePath)
    if (!st.isFile()) {
      res.statusCode = 404
      return res.end('Not Found')
    }
    const ext = extname(filePath).toLowerCase()
    res.statusCode = 200
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream')
    if (rel.startsWith('assets/')) {
      res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    }
    return res.end(readFileSync(filePath))
  } catch {
    res.statusCode = 404
    return res.end('Not Found')
  }
}

const server = createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`
  const url = new URL(req.url || '/', `http://${host}`)
  const apiMatch = url.pathname.match(/^\/api\/([a-z0-9_-]+)$/)
  if (apiMatch && API_ROUTES.has(apiMatch[1])) {
    return handleApi(apiMatch[1], req, res, url)
  }
  return handleStatic(url.pathname, res)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FairPrice BD server listening on http://0.0.0.0:${PORT}`)
})
