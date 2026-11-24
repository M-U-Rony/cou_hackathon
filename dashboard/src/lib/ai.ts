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

export function ttsUrl(commodity: string, date: string | undefined, variant: 'template' | 'ai'): string {
  const p = new URLSearchParams({ commodity, variant })
  if (date) p.set('date', date)
  return `./api/tts?${p}`
}

const prefetched = new Set<string>()
/** Warm the Edge CDN and browser HTTP cache before the user clicks "শুনুন". */
export function prefetchAudio(opts: {
  commodity: string; date?: string; variant: 'template' | 'ai'; server: boolean
}): void {
  if (!opts.server) return
  const url = ttsUrl(opts.commodity, opts.date, opts.variant)
  if (prefetched.has(url)) return
  prefetched.add(url)
  fetch(url, { priority: 'low' } as RequestInit).catch(() => { prefetched.delete(url) })
}

let current: HTMLAudioElement | null = null
let cancelActive: (() => void) | null = null

export function stopSpeaking() {
  cancelActive?.()
  cancelActive = null
  if (current) {
    current.onplaying = null
    current.onended = null
    current.onerror = null
    current.pause()
    current.src = ''
    current = null
  }
  try { speechSynthesis.cancel() } catch { /* no speech engine */ }
}

/** Speak a day's text. Streams server audio progressively when configured,
 *  falling back to the browser's Bangla voice. */
export async function speak(opts: {
  text: string; commodity: string; date?: string; variant: 'template' | 'ai'; server: boolean
  onPlay?: () => void; onEnd: () => void
}): Promise<'played' | 'no-voice' | 'error'> {
  stopSpeaking()
  let aborted = false
  if (opts.server) {
    const ok = await new Promise<boolean>((resolve) => {
      const audio = new Audio(ttsUrl(opts.commodity, opts.date, opts.variant))
      audio.preload = 'auto'
      current = audio
      let settled = false
      let started = false
      const finish = (val: boolean) => {
        if (!settled) { settled = true; resolve(val) }
      }
      cancelActive = () => { aborted = true; finish(false) }

      audio.onplaying = () => {
        started = true
        opts.onPlay?.()
        finish(true)
      }
      audio.onended = () => {
        if (current === audio) { current = null; cancelActive = null }
        finish(true)
        opts.onEnd()
      }
      audio.onerror = () => {
        if (current === audio) { current = null; cancelActive = null }
        if (started) opts.onEnd()
        finish(false)
      }
      audio.play().then(() => {
        if (!started && !aborted && !audio.paused) {
          started = true
          opts.onPlay?.()
          finish(true)
        }
      }).catch(() => {
        if (current === audio) { current = null; cancelActive = null }
        finish(false)
      })
    })
    if (aborted) return 'played'
    if (ok) return 'played'
  }
  if (aborted) return 'played'
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
    u.onstart = () => opts.onPlay?.()
    u.onend = opts.onEnd
    u.onerror = opts.onEnd
    synth.speak(u)
    return 'played'
  } catch { return 'error' }
}
