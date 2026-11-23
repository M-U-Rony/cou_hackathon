import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchSession, loginWithEmail, logoutSession, registerWithEmail, type AuthUser } from '../lib/auth'
import { DEFAULT_DISTRICT, marketLabel } from '../lib/markets'
import './style.css'

const POPULAR_DISTRICTS = [
  'Comilla Sadar',
  'Dhaka Sadar',
  'Chattogram Sadar',
  'Mymensing Sadar',
  'Rajshahi Sadar',
  'Khulna Sadar',
  'Sylhet Sadar',
  'Rangpur Sadar',
  'Barishal Sadar',
]

function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [district, setDistrict] = useState(DEFAULT_DISTRICT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSession().then(setUser)
  }, [])

  const fillDemo = () => {
    setMode('login')
    setEmail('demo@fairprice.bd')
    setPassword('FairPrice2026!')
    setError('')
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !password) {
      setError('ইমেইল এবং পাসওয়ার্ড দিন।')
      return
    }
    if (mode === 'register' && password.length < 8) {
      setError('পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।')
      return
    }
    setBusy(true)
    const res = mode === 'login'
      ? await loginWithEmail(email, password)
      : await registerWithEmail({ email, password, name, district })
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setUser(res.user)
    try { localStorage.setItem('fairprice.district', res.user.district) } catch { /* ignore */ }
    location.href = './index.html'
  }

  const onLogout = async () => {
    await logoutSession()
    setUser(null)
  }

  return (
    <>
      <header className="band">
        <a className="wordmark" href="./landing.html">ন্যায্য দাম</a>
        <a className="nav-link" href="./landing.html">পরিচিতি</a>
        <a className="nav-link" href="./index.html">ড্যাশবোর্ড</a>
        <a className="nav-link" href="./replay.html">অতীতের ঘটনা রিপ্লে</a>
      </header>

      <main className="auth-wrap">
        <section className="card" aria-labelledby="auth-title">
          <h1 id="auth-title">{mode === 'login' ? 'অ্যাকাউন্টে লগইন করুন' : 'নতুন অ্যাকাউন্ট তৈরি করুন'}</h1>
          <p className="sub">
            মূল বাজারদর সবার জন্য উন্মুক্ত। লগইন করলে আপনার পছন্দের জেলা ও পণ্যের ওয়াচলিস্ট সেভ থাকবে।
          </p>

          {user ? (
            <div className="ok-box">
              <div><strong>{user.name}</strong> ({user.email}) হিসেবে লগইন করা আছে।</div>
              <div>পছন্দের জেলা: <strong>{marketLabel(user.district)}</strong> · ওয়াচলিস্টে {user.watchlist.length}টি পণ্য।</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <a className="btn-primary" href="./index.html" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px' }}>
                  ড্যাশবোর্ডে যান →
                </a>
                <button className="btn-ghost" type="button" onClick={onLogout} style={{ padding: '0 14px' }}>
                  লগআউট
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="tabs" role="tablist" aria-label="লগইন বা নিবন্ধন">
                <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => { setMode('login'); setError('') }}>
                  লগইন
                </button>
                <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => { setMode('register'); setError('') }}>
                  নতুন অ্যাকাউন্ট
                </button>
              </div>

              <form onSubmit={onSubmit} style={{ display: 'grid', gap: 14 }} noValidate>
                {mode === 'register' && (
                  <div className="field">
                    <label htmlFor="name">আপনার নাম</label>
                    <input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)}
                      placeholder="যেমন: মেহেদী হাসান" autoComplete="name" />
                  </div>
                )}

                <div className="field">
                  <label htmlFor="email">ইমেইল</label>
                  <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com" autoComplete="email" required />
                </div>

                <div className="field">
                  <label htmlFor="password">পাসওয়ার্ড</label>
                  <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="কমপক্ষে ৮ অক্ষর" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
                  {mode === 'register' && <span className="hint">সার্ভারে scrypt + সল্ট দিয়ে এনক্রিপ্ট করে রাখা হয়।</span>}
                </div>

                {mode === 'register' && (
                  <div className="field">
                    <label htmlFor="district">পছন্দের জেলা</label>
                    <select id="district" value={district} onChange={(e) => setDistrict(e.target.value)}>
                      {POPULAR_DISTRICTS.map((d) => <option key={d} value={d}>{marketLabel(d)}</option>)}
                    </select>
                  </div>
                )}

                {error && <div className="alert" role="alert">{error}</div>}

                <button className="btn-primary" type="submit" disabled={busy}>
                  {busy ? 'অপেক্ষা করুন…' : mode === 'login' ? 'লগইন করুন' : 'অ্যাকাউন্ট তৈরি করুন'}
                </button>
              </form>

              <div className="demo-box">
                <span>ডেমো: <code>demo@fairprice.bd</code> / <code>FairPrice2026!</code></span>
                <button className="btn-ghost" type="button" onClick={fillDemo} style={{ height: 32, padding: '0 10px', fontSize: 13 }}>
                  ডেমো পূরণ করুন
                </button>
              </div>
            </>
          )}

          <p className="note">
            সিকিউরিটি: পাসওয়ার্ড <code>scrypt</code> হ্যাশিং ও সেশন <code>HMAC-SHA256 HttpOnly</code> কুকি দিয়ে সুরক্ষিত।
            <a href="./index.html" style={{ marginLeft: 6, fontWeight: 600 }}>লগইন ছাড়াই ড্যাশবোর্ড দেখুন →</a>
          </p>
        </section>
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><LoginPage /></StrictMode>)
