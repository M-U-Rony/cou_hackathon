// Vercel Function + Vite dev API for optional FairPrice BD accounts.
//   GET    /api/auth                 -> current session user (or { user: null })
//   POST   /api/auth?action=login    -> authenticate with email + password
//   POST   /api/auth?action=register -> create account with email + password
//   POST   /api/auth?action=logout   -> clear session cookie
//   PATCH  /api/auth                 -> update saved district & commodity watchlist
import {
  SESSION_COOKIE,
  authenticateUser,
  buildClearCookie,
  buildSessionCookie,
  createSessionToken,
  parseCookie,
  registerUser,
  sanitizeWatchlist,
  updateStoredUser,
  verifySessionToken,
  type UserProfile,
} from './_auth.js'
import { json, limited } from './_shared.js'

function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')
  if (proto) return proto === 'https'
  return req.url.startsWith('https://')
}

function sessionResponse(user: UserProfile | null, cookie?: string, status = 200): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (cookie) headers['set-cookie'] = cookie
  return new Response(JSON.stringify({ user }), { status, headers })
}

export async function GET(req: Request) {
  const token = parseCookie(req.headers.get('cookie'), SESSION_COOKIE)
  if (!token) return sessionResponse(null)
  const payload = verifySessionToken(token)
  if (!payload) return sessionResponse(null, buildClearCookie(isSecureRequest(req)))
  return sessionResponse({
    email: payload.email,
    name: payload.name,
    district: payload.district,
    watchlist: payload.watchlist,
  })
}

export async function POST(req: Request) {
  const url = new URL(req.url)
  const action = url.searchParams.get('action') || 'login'
  const secure = isSecureRequest(req)

  if (action === 'logout') {
    return sessionResponse(null, buildClearCookie(secure))
  }

  if (limited(req, 20)) {
    return json({ error: 'অনেকবার চেষ্টা করা হয়েছে, এক মিনিট পর আবার চেষ্টা করুন।' }, 429)
  }

  let body: { email?: string; password?: string; name?: string; district?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: 'অবৈধ অনুরোধ।' }, 400)
  }

  const result = action === 'register'
    ? registerUser({
      email: body.email ?? '',
      password: body.password ?? '',
      name: body.name,
      district: body.district,
    })
    : authenticateUser({
      email: body.email ?? '',
      password: body.password ?? '',
    })

  if (!result.ok) {
    return json({ error: result.error }, result.status)
  }

  const token = createSessionToken(result.user)
  return sessionResponse(result.user, buildSessionCookie(token, secure), action === 'register' ? 201 : 200)
}

export async function PATCH(req: Request) {
  const token = parseCookie(req.headers.get('cookie'), SESSION_COOKIE)
  const payload = token ? verifySessionToken(token) : null
  if (!payload) {
    return json({ error: 'পছন্দ সংরক্ষণ করতে লগইন করুন।' }, 401)
  }

  let body: { district?: string; watchlist?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: 'অবৈধ অনুরোধ।' }, 400)
  }

  const updated: UserProfile = {
    email: payload.email,
    name: payload.name,
    district: typeof body.district === 'string' && body.district.trim() ? body.district.trim() : payload.district,
    watchlist: body.watchlist !== undefined ? sanitizeWatchlist(body.watchlist) : payload.watchlist,
  }
  updateStoredUser(updated.email, { district: updated.district, watchlist: updated.watchlist })

  const nextToken = createSessionToken(updated)
  return sessionResponse(updated, buildSessionCookie(nextToken, isSecureRequest(req)))
}
