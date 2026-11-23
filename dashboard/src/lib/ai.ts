// Optional AI features. They work only where /api is deployed with keys
// (see dashboard/.env.example). Everywhere else the app keeps working:
// the template paragraph stays, and "শুনুন" uses the browser's own voice.

export interface Health { llm: boolean; tts: boolean; model: string | null }
const NONE: Health = { llm: false, tts: false, model: null }

let healthP: Promise<Health> | null = null
export function aiHealth(): Promise<Health> {
  healthP ??= (async () => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 4000)
      const r = await fetch('./api/health', { signal: ctl.signal })
      clearTimeout(t)
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return NONE
      return { ...NONE, ...(await r.json()) as Health }
    } catch { return NONE }
  })()
  return healthP
}

export interface AiSummary { text: string; ai: boolean; model?: string; note?: string; date: string }

export async function aiSummary(commodity: string, date?: string): Promise<AiSummary> {
  const r = await fetch('./api/summary', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commodity, date }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j as AiSummary
}

let current: HTMLAudioElement | null = null

export function stopSpeaking() {
  current?.pause()
  current = null
  try { speechSynthesis.cancel() } catch { /* no speech engine */ }
}

/** Speak a day's text. Server voice when configured, else the browser's Bangla voice.
 *  Resolves 'played' | 'no-voice' | 'error'. onEnd fires when speech finishes. */
export async function speak(opts: {
  text: string; commodity: string; date?: string; variant: 'template' | 'ai'; server: boolean; onEnd: () => void
}): Promise<'played' | 'no-voice' | 'error'> {
  stopSpeaking()
  if (opts.server) {
    try {
      const r = await fetch('./api/tts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commodity: opts.commodity, date: opts.date, variant: opts.variant }),
      })
      if (r.ok) {
        const url = URL.createObjectURL(await r.blob())
        current = new Audio(url)
        current.onended = () => { URL.revokeObjectURL(url); opts.onEnd() }
        await current.play()
        return 'played'
      }
    } catch { /* fall through to the browser voice */ }
  }
  try {
    const synth = window.speechSynthesis
    if (!synth) return 'no-voice'
    let voices = synth.getVoices()
    if (!voices.length) {
      await new Promise((ok) => { synth.onvoiceschanged = () => ok(null); setTimeout(ok, 800) })
      voices = synth.getVoices()
    }
    const voice = voices.find((v) => v.lang.toLowerCase().startsWith('bn'))
    if (!voice) return 'no-voice'
    const u = new SpeechSynthesisUtterance(opts.text.replace(/\*\*/g, ''))
    u.voice = voice
    u.lang = voice.lang
    u.rate = 0.95
    u.onend = opts.onEnd
    u.onerror = opts.onEnd
    synth.speak(u)
    return 'played'
  } catch { return 'error' }
}
