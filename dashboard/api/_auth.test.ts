import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetUsersForTest,
  authenticateUser,
  buildSessionCookie,
  createSessionToken,
  hashPassword,
  parseCookie,
  registerUser,
  SESSION_COOKIE,
  verifyPassword,
  verifySessionToken,
} from './_auth.js'
import { GET, PATCH, POST } from './auth.js'

describe('auth crypto & token helpers', () => {
  it('hashes passwords with unique salts and verifies in constant time', () => {
    const h1 = hashPassword('StrongPass123')
    const h2 = hashPassword('StrongPass123')
    expect(h1).not.toBe(h2)
    expect(verifyPassword('StrongPass123', h1)).toBe(true)
    expect(verifyPassword('WrongPass123', h1)).toBe(false)
    expect(verifyPassword('StrongPass123', 'malformed')).toBe(false)
  })

  it('signs, verifies, and rejects tampered or expired session tokens', () => {
    const now = 1_700_000_000
    const token = createSessionToken({
      email: 'shopper@example.com',
      name: 'রনি',
      district: 'Comilla Sadar',
      watchlist: ['egg_farm', 'invalid_item'],
    }, now)

    const valid = verifySessionToken(token, now + 60)
    expect(valid?.email).toBe('shopper@example.com')
    expect(valid?.watchlist).toEqual(['egg_farm'])

    const [, sig] = token.split('.')
    const tampered = `${Buffer.from(JSON.stringify({ email: 'admin@example.com', exp: now + 9999 })).toString('base64url')}.${sig}`
    expect(verifySessionToken(tampered, now + 60)).toBeNull()

    expect(verifySessionToken(token, now + 8 * 24 * 60 * 60)).toBeNull()
  })

  it('builds and parses HttpOnly session cookies', () => {
    const cookie = buildSessionCookie('abc.def', true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(parseCookie(`other=1; ${SESSION_COOKIE}=abc.def`, SESSION_COOKIE)).toBe('abc.def')
  })
})

describe('auth HTTP endpoints', () => {
  beforeEach(() => _resetUsersForTest())

  it('supports demo login, registration, preference updates, and logout', async () => {
    const demo = authenticateUser({ email: 'demo@fairprice.bd', password: 'FairPrice2026!' })
    expect(demo.ok).toBe(true)

    const regRes = await POST(new Request('http://localhost/api/auth?action=register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'judge@cou.ac.bd',
        password: 'Password123!',
        name: 'বিচারক',
        district: 'Comilla Sadar',
      }),
    }))
    expect(regRes.status).toBe(201)
    const setCookie = regRes.headers.get('set-cookie')
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
    const cookiePair = setCookie!.split(';')[0]

    const dup = registerUser({ email: 'judge@cou.ac.bd', password: 'Password123!' })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.status).toBe(409)

    const meRes = await GET(new Request('http://localhost/api/auth', {
      headers: { cookie: cookiePair },
    }))
    const meBody = await meRes.json() as { user: { email: string; district: string } | null }
    expect(meBody.user?.email).toBe('judge@cou.ac.bd')

    const patchRes = await PATCH(new Request('http://localhost/api/auth', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookiePair },
      body: JSON.stringify({ district: 'Dhaka Sadar', watchlist: ['potato', 'egg_farm'] }),
    }))
    expect(patchRes.status).toBe(200)
    const patchBody = await patchRes.json() as { user: { district: string; watchlist: string[] } }
    expect(patchBody.user.district).toBe('Dhaka Sadar')
    expect(patchBody.user.watchlist).toEqual(['potato', 'egg_farm'])

    const logoutRes = await POST(new Request('http://localhost/api/auth?action=logout', { method: 'POST' }))
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('rejects weak passwords and invalid emails', async () => {
    const badRes = await POST(new Request('http://localhost/api/auth?action=register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: '123' }),
    }))
    expect(badRes.status).toBe(400)
  })
})
