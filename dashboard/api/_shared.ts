// Shared by the serverless functions in /api (files starting with _ are not routes).
//
// Keys live in environment variables only (Vercel project settings, or
// dashboard/.env.local for local dev). The browser never sees them.
//   OPENROUTER_API_KEY  recommended primary key (multi-model fallback)
//   ANTHROPIC_API_KEY   fallback direct Anthropic Claude API key
//   LLM_MODEL           optional, default google/gemini-2.5-flash (OpenRouter) or claude-haiku-4-5
//   ELEVENLABS_API_KEY  + ELEVENLABS_VOICE_ID enable server voice
//   ELEVENLABS_MODEL    optional, default eleven_v3 (supports Bengali)
//
// The functions never take free text from the browser: they take a product
// id and a date, look the facts up in the app's own data file, and only then
// call the LLM. So a deployed key cannot be used as an open proxy.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Step = { key: string; label: string; value: number; kind: string }
type Day = {
  date: string; price: number; mid: number; lo80: number; hi80: number; status: string
  direction: string; unexplained_pct: number; reason?: string; text_bn?: string; waterfall?: Step[]
  surge_stage?: string; surge_score?: number; data_trust?: string; trust_note_bn?: string
}
type Data = {
  commodities: Record<string, { name_bn: string; unit_bn: string; latest: Day }>
  events: { commodity: string; days: Day[] }[]
}

let D: Data | null = null
async function loadDataFile(reqUrl?: string): Promise<Data> {
  if (D) return D
  const candidates = [
    join(process.cwd(), 'public', 'fairprice_data.json'),
    join(process.cwd(), 'dashboard', 'public', 'fairprice_data.json'),
    join(process.cwd(), 'dist', 'fairprice_data.json'),
    fileURLToPath(new URL('../public/fairprice_data.json', import.meta.url)),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      D = JSON.parse(readFileSync(p, 'utf8')) as Data
      return D
    }
  }
  let origin = 'https://fairprice-bd.vercel.app'
  if (reqUrl) {
    try { origin = new URL(reqUrl).origin } catch { /* fallback to production origin */ }
  }
  const r = await fetch(`${origin}/fairprice_data.json`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Failed to fetch fairprice_data.json: HTTP ${r.status}`)
  D = (await r.json()) as Data
  return D
}

export const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined)
export const llmConfigured = () => Boolean(env('OPENROUTER_API_KEY') || env('ANTHROPIC_API_KEY'))
export const ttsConfigured = () =>
  Boolean((env('ELEVENLABS_API_KEY') && env('ELEVENLABS_VOICE_ID')) || env('OPENROUTER_API_KEY'))
export const llmModel = () =>
  env('LLM_MODEL') || (env('OPENROUTER_API_KEY') ? 'google/gemini-2.5-flash' : 'claude-haiku-4-5')

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Small per-instance limiter: enough to stop a loop from burning credits. */
const hits = new Map<string, number[]>()
export function limited(req: Request, perMinute = 20) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local'
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > perMinute
}

export async function findDay(
  commodity: string,
  date?: string,
  reqUrl?: string,
): Promise<{ day: Day; name: string; unit: string } | null> {
  const data = await loadDataFile(reqUrl)
  const c = data.commodities[commodity]
  if (!c) return null
  if (!date || date === c.latest.date) return { day: c.latest, name: c.name_bn, unit: c.unit_bn }
  for (const e of data.events) {
    if (e.commodity !== commodity) continue
    const d = e.days.find((x) => x.date === date)
    if (d?.text_bn) return { day: d, name: c.name_bn, unit: c.unit_bn }
  }
  return null
}

const BN = '০১২৩৪৫৬৭৮৯'
const toAscii = (s: string) => s.replace(/[০-৯]/g, (ch) => String(BN.indexOf(ch)))
/** every number in a text, digits normalised, commas dropped */
export const numbersIn = (s: string) =>
  (toAscii(s).replace(/(\d),(\d)/g, '$1$2').match(/\d+(\.\d+)?/g) ?? []).map(Number)

const VERDICT: Record<string, string> = { ok: 'ঠিক আছে', watch: 'একটু বেশি', alarm: 'অনেক বেশি', down: 'স্বাভাবিকের চেয়ে কম' }
const verdictKey = (d: Day) =>
  d.status === 'Normal' ? 'ok' : d.direction === 'down' ? 'down' : d.status === 'Unusual' ? 'alarm' : 'watch'

/** The facts the LLM may use, as plain lines. */
export function factSheet(f: { day: Day; name: string; unit: string }) {
  const d = f.day
  const steps = (d.waterfall ?? []).filter((s) => s.kind === 'step' && Math.abs(s.value) >= 0.5)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 3)
  const lines = [
    `পণ্য: ${f.name} (ঢাকা, TCB খুচরা দর)`,
    `তারিখ: ${d.date}`,
    `আসল দাম: ${d.price} টাকা/${f.unit}`,
    `প্রত্যাশিত সীমা (৮০%): ${Math.round(d.lo80)}–${Math.round(d.hi80)} টাকা, মাঝামাঝি ${Math.round(d.mid)} টাকা`,
    `রায়: ${VERDICT[verdictKey(d)]}`,
    `প্রত্যাশার চেয়ে পার্থক্য: ${Math.round(d.unexplained_pct)}%`,
    ...steps.map((s) => `উপাদান: ${s.label}, ${s.value > 0 ? '+' : '−'}${Math.abs(s.value).toFixed(1)} টাকা`),
    d.reason === 'steady_rise' ? 'বিশেষ: দাম কয়েক দিন ধরে সীমার উপরের দিকে আছে' : '',
    d.surge_stage === 'emerging' && d.status === 'Normal'
      ? `আগাম ঊর্ধ্বমুখী চাপ: চাপ সূচক ${Math.round((d.surge_score ?? 0.6) * 100)}% (নিশ্চিত অসঙ্গতির আগেই প্রাথমিক সতর্কতা)`
      : '',
    d.trust_note_bn ? `তথ্য সতর্কতা: ${d.trust_note_bn}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

/** Numbers the summary may contain: everything in the facts, the template, plus the date parts. */
export function allowedNumbers(f: { day: Day }, facts: string) {
  const set = new Set<number>([...numbersIn(facts), ...numbersIn(f.day.text_bn ?? '')])
  for (const n of [...set]) { set.add(Math.round(n)); set.add(Math.round(n * 10) / 10) }
  return set
}

const SYSTEM = `তুমি একটা বাজারদর অ্যাপের জন্য সাধারণ ক্রেতার উপযোগী ছোট বাংলা সারাংশ লেখো।
নিয়ম:
- শুধু দেওয়া তথ্য ব্যবহার করবে। নতুন কোনো সংখ্যা, তারিখ, কারণ বা খবর যোগ করবে না।
- সংখ্যা বাংলা অঙ্কে লিখবে, দেওয়া মানের মতোই (রাউন্ড করলে পূর্ণসংখ্যায়)।
- কাউকে দোষ দেবে না, কারসাজি বা সিন্ডিকেটের কথা বলবে না। এটা পরিসংখ্যান মডেলের হিসাব।
- কেনা বা না কেনার পরামর্শ দেবে না।
- ২–৩টা ছোট বাক্য, সহজ চলিত ভাষা, কোনো শিরোনাম, তালিকা বা ইমোজি নয়।`

const OPENROUTER_FALLBACKS = [
  'google/gemini-2.5-flash',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-4o-mini',
]

/** Call OpenRouter (primary, multi-model fallback) or Anthropic Messages API. Returns null when no key is set. */
export async function llmSummary(facts: string): Promise<{ text: string; model: string } | null> {
  const prompt = `তথ্য:\n${facts}\n\nএই তথ্য দিয়ে সারাংশ লেখো।`
  const openRouterKey = env('OPENROUTER_API_KEY')
  if (openRouterKey) {
    const primary = llmModel()
    const models = [...new Set([primary, ...OPENROUTER_FALLBACKS])]
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://fairprice-bd.vercel.app',
        'X-Title': 'FairPrice BD',
      },
      body: JSON.stringify({
        model: primary,
        models,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    })
    if (!r.ok) throw new Error(`OpenRouter error ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json() as { model?: string; choices?: { message?: { content?: string } }[] }
    const text = j.choices?.[0]?.message?.content?.trim() || ''
    return text ? { text, model: j.model || primary } : null
  }

  const key = env('ANTHROPIC_API_KEY')
  if (!key) return null
  const model = llmModel()
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(12_000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 400, system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json() as { content?: { type: string; text?: string }[] }
  const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
  return text ? { text, model } : null
}

/** Per-instance cache so the same day is not summarised (or spoken) twice. */
const cache = new Map<string, { text: string; ai: boolean; model?: string; note?: string }>()

export async function summaryFor(commodity: string, date?: string, reqUrl?: string) {
  const f = await findDay(commodity, date, reqUrl)
  if (!f) return null
  const id = `${commodity}|${f.day.date}`
  const hit = cache.get(id)
  if (hit) return { ...hit, date: f.day.date }
  const template = (f.day.text_bn ?? '').replace(/\*\*/g, '')
  const facts = factSheet(f)
  let out: { text: string; ai: boolean; model?: string; note?: string }
  try {
    const res = await llmSummary(facts)
    if (!res) out = { text: template, ai: false, note: 'no_key' }
    else {
      const allowed = allowedNumbers(f, facts)
      const bad = numbersIn(res.text).filter((n) => !allowed.has(n) && !allowed.has(Math.round(n)))
      out = bad.length
        ? { text: template, ai: false, note: `number_check_failed: ${bad.slice(0, 3).join(', ')}` }
        : { text: res.text, ai: true, model: res.model }
    }
  } catch (e) {
    out = { text: template, ai: false, note: String((e as Error).message).slice(0, 160) }
  }
  if (out.ai) cache.set(id, out)
  return { ...out, date: f.day.date }
}

/** Wrap raw 16-bit mono PCM bytes into a playable RIFF/WAVE container. */
export function pcm16ToWav(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Extract and decode base64 PCM audio chunks from OpenRouter SSE stream text. */
export function extractSseAudioChunks(sseText: string): Buffer {
  const chunks: Buffer[] = []
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { audio?: { data?: string } }; message?: { audio?: { data?: string } } }[]
      }
      const b64 = parsed.choices?.[0]?.delta?.audio?.data ?? parsed.choices?.[0]?.message?.audio?.data
      if (typeof b64 === 'string' && b64) chunks.push(Buffer.from(b64, 'base64'))
    } catch {
      /* ignore non-JSON SSE lines */
    }
  }
  return Buffer.concat(chunks)
}

const BN_WORDS = [
  'শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
  'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
  'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আঠাশ', 'উনত্রিশ',
  'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'উনচল্লিশ',
  'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'উনপঞ্চাশ',
  'পঞ্চাশ', 'একান্ন', 'বাহান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'উনষাট',
  'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'উনসত্তর',
  'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিয়াত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'উনআশি',
  'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'আটাশি', 'উননব্বই',
  'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
] as const

/** Convert an integer to standard spoken Bengali words (0..99, hundreds, thousands, lakhs). */
export function bnNumberToWords(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (n < 0) return `মাইনাস ${bnNumberToWords(-n)}`
  let x = Math.trunc(n)
  if (x < 100) return BN_WORDS[x]
  const parts: string[] = []
  if (x >= 100_000) {
    parts.push(`${bnNumberToWords(Math.floor(x / 100_000))} লাখ`)
    x %= 100_000
  }
  if (x >= 1_000) {
    parts.push(`${bnNumberToWords(Math.floor(x / 1_000))} হাজার`)
    x %= 1_000
  }
  if (x >= 100) {
    parts.push(`${BN_WORDS[Math.floor(x / 100)]} শত`)
    x %= 100
  }
  if (x > 0) parts.push(BN_WORDS[x])
  return parts.join(' ')
}

function numStrToBn(raw: string): string {
  const [intPart, decPart] = raw.split('.')
  const intWords = bnNumberToWords(Number(intPart || '0'))
  if (!decPart) return intWords
  const decWords = decPart.split('').map((d) => BN_WORDS[Number(d)] ?? d).join(' ')
  return `${intWords} দশমিক ${decWords}`
}

function ordinalToBn(d: number, suf: string): string {
  if (d === 1 && suf === 'লা') return 'পহেলা'
  if (d === 2 && suf === 'রা') return 'দোসরা'
  if (d === 3 && suf === 'রা') return 'তেসরা'
  if (d === 4 && suf === 'ঠা') return 'চৌঠা'
  const w = bnNumberToWords(d)
  if (suf === 'শে' && w.endsWith('শ')) return `${w}ে`
  return `${w}${suf}`
}

/** Spell out all Bengali/ASCII numbers, ranges, decimals, units, and acronyms for natural TTS. */
export function bnTextForSpeech(text: string): string {
  let out = text
    .replace(/\*\*/g, '')
    .replace(/\bTCB\b/g, 'টিসিবি')
    .replace(/\bWFP\b/g, 'ডব্লিউএফপি')
    .replace(/\s*(?:৳|টাকা)\s*\/\s*(হালি|কেজি|লিটার|ডজন|পিস)/g, ' টাকা প্রতি $1')
    .replace(/\s*৳/g, ' টাকা')
  out = toAscii(out).replace(/(\d),(\d)/g, '$1$2')
  out = out
    .replace(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/g, (_, a: string, b: string) => `${numStrToBn(a)} থেকে ${numStrToBn(b)}`)
    .replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n: string) => `${numStrToBn(n)} শতাংশ`)
    .replace(/((?:^|[\s(]))([+−-])(\d+(?:\.\d+)?)/g, (_, pre: string, sign: string, n: string) => `${pre}${sign === '+' ? 'প্লাস' : 'মাইনাস'} ${numStrToBn(n)}`)
    .replace(/(\d+)(শে|ই|লা|রা|ঠা)/g, (_, d: string, suf: string) => ordinalToBn(Number(d), suf))
    .replace(/\d+(?:\.\d+)?/g, (m) => numStrToBn(m))
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return out
}
