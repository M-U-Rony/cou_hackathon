// Zero-dependency cryptographic auth helpers for FairPrice BD.
// Uses Node's built-in scrypt (with per-user random salt) for password hashing
// and HMAC-SHA256 signed HttpOnly session cookies for stateless persistence
// across Vercel serverless invocations.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { env } from './_shared.js'

export type UserProfile = {
  email: string
  name: string
  district: string
  watchlist: string[]
}

export type SessionPayload = UserProfile & {
  iat: number
  exp: number
}

export const SESSION_COOKIE = 'fp_session'
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60 // 7 days
export const VALID_COMMODITIES = new Set([
  'egg_farm',
  'green_chili',
  'potato',
  'onion_local',
  'onion_import',
])

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// In production, set AUTH_SECRET in Vercel project environment variables.
// A process-local fallback keeps local `vite dev` and unit tests working out of the box.
const DEV_FALLBACK_SECRET = 'fairprice-bd-local-dev-secret-change-in-prod'
const authSecret = () => env('AUTH_SECRET') || DEV_FALLBACK_SECRET

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function validateEmail(raw: string): string | null {
  const email = normalizeEmail(raw)
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null
  return email
}

export function validatePassword(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 128) return null
  return raw
}

export function sanitizeName(raw: string, fallbackEmail: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, 60)
  return cleaned || fallbackEmail.split('@')[0]
}

export function sanitizeWatchlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && VALID_COMMODITIES.has(item) && !out.includes(item)) {
      out.push(item)
    }
  }
  return out
}

/** Hash a password with scrypt + 16-byte random salt -> "saltHex:derivedHex". */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

/** Constant-time verification of a password against a stored "salt:hash" string. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 2) return false
  const [salt, expectedHex] = parts
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8')
}

function signData(data: string): string {
  return createHmac('sha256', authSecret()).update(data).digest('base64url')
}

/** Create an HMAC-SHA256 signed session token containing the user's profile & expiry. */
export function createSessionToken(profile: UserProfile, nowSec = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = {
    email: profile.email,
    name: profile.name,
    district: profile.district,
    watchlist: sanitizeWatchlist(profile.watchlist),
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SEC,
  }
  const encoded = b64urlEncode(JSON.stringify(payload))
  const sig = signData(encoded)
  return `${encoded}.${sig}`
}

/** Verify signature & expiry of a session token. Returns null if tampered or expired. */
export function verifySessionToken(token: string, nowSec = Math.floor(Date.now() / 1000)): SessionPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, sig] = parts
  if (!encoded || !sig) return null
  const expected = signData(encoded)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  try {
    const parsed = JSON.parse(b64urlDecode(encoded)) as SessionPayload
    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.exp !== 'number') return null
    if (parsed.exp <= nowSec) return null
    return {
      email: parsed.email,
      name: typeof parsed.name === 'string' ? parsed.name : parsed.email.split('@')[0],
      district: typeof parsed.district === 'string' && parsed.district ? parsed.district : 'Comilla Sadar',
      watchlist: sanitizeWatchlist(parsed.watchlist),
      iat: parsed.iat,
      exp: parsed.exp,
    }
  } catch {
    return null
  }
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

export function buildSessionCookie(token: string, isSecure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_SEC}`,
  ]
  if (isSecure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearCookie(isSecure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ]
  if (isSecure) parts.push('Secure')
  return parts.join('; ')
}

type StoredUser = UserProfile & { passwordHash: string }

const users = new Map<string, StoredUser>()

function ensureDemoUser() {
  const demoEmail = 'demo@fairprice.bd'
  if (!users.has(demoEmail)) {
    users.set(demoEmail, {
      email: demoEmail,
      name: 'ডেমো ক্রেতা (কুমিল্লা)',
      district: 'Comilla Sadar',
      watchlist: ['egg_farm', 'green_chili'],
      passwordHash: hashPassword('FairPrice2026!'),
    })
  }
}

export function registerUser(input: {
  email: string
  password: string
  name?: string
  district?: string
}): { ok: true; user: UserProfile } | { ok: false; status: number; error: string } {
  ensureDemoUser()
  const email = validateEmail(input.email)
  if (!email) return { ok: false, status: 400, error: 'সঠিক ইমেইল ঠিকানা দিন।' }
  const password = validatePassword(input.password)
  if (!password) return { ok: false, status: 400, error: 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।' }
  if (users.has(email)) return { ok: false, status: 409, error: 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট তৈরি করা হয়েছে।' }

  const user: StoredUser = {
    email,
    name: sanitizeName(input.name ?? '', email),
    district: (input.district ?? '').trim() || 'Comilla Sadar',
    watchlist: ['egg_farm'],
    passwordHash: hashPassword(password),
  }
  users.set(email, user)
  return { ok: true, user: { email: user.email, name: user.name, district: user.district, watchlist: user.watchlist } }
}

export function authenticateUser(input: {
  email: string
  password: string
}): { ok: true; user: UserProfile } | { ok: false; status: number; error: string } {
  ensureDemoUser()
  const email = validateEmail(input.email)
  if (!email || typeof input.password !== 'string' || !input.password) {
    return { ok: false, status: 400, error: 'ইমেইল এবং পাসওয়ার্ড দিন।' }
  }
  const found = users.get(email)
  if (!found || !verifyPassword(input.password, found.passwordHash)) {
    return { ok: false, status: 401, error: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।' }
  }
  return { ok: true, user: { email: found.email, name: found.name, district: found.district, watchlist: found.watchlist } }
}

export function updateStoredUser(email: string, patch: { district?: string; watchlist?: string[] }): void {
  const found = users.get(email)
  if (!found) return
  if (typeof patch.district === 'string' && patch.district.trim()) found.district = patch.district.trim()
  if (Array.isArray(patch.watchlist)) found.watchlist = sanitizeWatchlist(patch.watchlist)
}

/** Test helper to reset in-memory store between test cases. */
export function _resetUsersForTest() {
  users.clear()
}
