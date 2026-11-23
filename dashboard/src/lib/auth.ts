// Client helper for optional FairPrice BD accounts (/api/auth).
export type AuthUser = {
  email: string
  name: string
  district: string
  watchlist: string[]
}

export type AuthResult = { ok: true; user: AuthUser } | { ok: false; error: string }

export async function fetchSession(): Promise<AuthUser | null> {
  try {
    const r = await fetch('/api/auth', { credentials: 'same-origin' })
    if (!r.ok) return null
    const j = (await r.json()) as { user?: AuthUser | null }
    return j.user ?? null
  } catch {
    return null
  }
}

export async function loginWithEmail(email: string, password: string): Promise<AuthResult> {
  try {
    const r = await fetch('/api/auth?action=login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const j = (await r.json().catch(() => ({}))) as { user?: AuthUser; error?: string }
    if (!r.ok || !j.user) return { ok: false, error: j.error || 'লগইন করা যায়নি।' }
    return { ok: true, user: j.user }
  } catch {
    return { ok: false, error: 'সার্ভারের সাথে সংযোগ পাওয়া যায়নি।' }
  }
}

export async function registerWithEmail(input: {
  email: string
  password: string
  name: string
  district: string
}): Promise<AuthResult> {
  try {
    const r = await fetch('/api/auth?action=register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const j = (await r.json().catch(() => ({}))) as { user?: AuthUser; error?: string }
    if (!r.ok || !j.user) return { ok: false, error: j.error || 'অ্যাকাউন্ট তৈরি করা যায়নি।' }
    return { ok: true, user: j.user }
  } catch {
    return { ok: false, error: 'সার্ভারের সাথে সংযোগ পাওয়া যায়নি।' }
  }
}

export async function logoutSession(): Promise<void> {
  try {
    await fetch('/api/auth?action=logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    /* ignore network error on logout */
  }
}

export async function saveUserPreferences(patch: {
  district?: string
  watchlist?: string[]
}): Promise<AuthUser | null> {
  try {
    const r = await fetch('/api/auth', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { user?: AuthUser | null }
    return j.user ?? null
  } catch {
    return null
  }
}
