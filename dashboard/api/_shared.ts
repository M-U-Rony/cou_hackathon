// Shared by the serverless functions in /api (files starting with _ are not routes).
//
// Keys live in environment variables only (Vercel project settings, or
// dashboard/.env.local for local dev). The browser never sees them.
//   ANTHROPIC_API_KEY   enables the AI Bangla summary
//   LLM_MODEL           optional, default claude-haiku-5-5
//   ELEVENLABS_API_KEY  + ELEVENLABS_VOICE_ID enable server voice
//   ELEVENLABS_MODEL    optional, default eleven_v3 (supports Bengali)
//
// The functions never take free text from the browser: they take a product
// id and a date, look the facts up in the app's own data file, and only then
// call the LLM. So a deployed key cannot be used as an open proxy.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Step = { key: string; label: string; value: number; kind: string }
type Day = {
  date: string; price: number; mid: number; lo80: number; hi80: number; status: string
  direction: string; unexplained_pct: number; reason?: string; text_bn?: string; waterfall?: Step[]
}
type Data = {
  commodities: Record<string, { name_bn: string; unit_bn: string; latest: Day }>
  events: { commodity: string; days: Day[] }[]
}
// vercel.json ships public/fairprice_data.json with the functions (includeFiles)
let D: Data | null = null
const dataFile = (): Data =>
  (D ??= JSON.parse(readFileSync(join(process.cwd(), 'public', 'fairprice_data.json'), 'utf8')) as Data)

export const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined)
export const llmModel = () => env('LLM_MODEL') || 'claude-haiku-5-5'

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

export function findDay(commodity: string, date?: string): { day: Day; name: string; unit: string } | null {
  const c = dataFile().commodities[commodity]
  if (!c) return null
  if (!date || date === c.latest.date) return { day: c.latest, name: c.name_bn, unit: c.unit_bn }
  for (const e of dataFile().events) {
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

/** Call the Anthropic Messages API. Returns null when no key is set. */
export async function llmSummary(facts: string): Promise<string | null> {
  const key = env('ANTHROPIC_API_KEY')
  if (!key) return null
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: llmModel(), max_tokens: 400, system: SYSTEM,
      messages: [{ role: 'user', content: `তথ্য:\n${facts}\n\nএই তথ্য দিয়ে সারাংশ লেখো।` }],
    }),
  })
  if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json() as { content?: { type: string; text?: string }[] }
  return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null
}

/** Per-instance cache so the same day is not summarised (or spoken) twice. */
const cache = new Map<string, { text: string; ai: boolean; model?: string; note?: string }>()

export async function summaryFor(commodity: string, date?: string) {
  const f = findDay(commodity, date)
  if (!f) return null
  const id = `${commodity}|${f.day.date}`
  const hit = cache.get(id)
  if (hit) return { ...hit, date: f.day.date }
  const template = (f.day.text_bn ?? '').replace(/\*\*/g, '')
  const facts = factSheet(f)
  let out: { text: string; ai: boolean; model?: string; note?: string }
  try {
    const text = await llmSummary(facts)
    if (!text) out = { text: template, ai: false, note: 'no_key' }
    else {
      const allowed = allowedNumbers(f, facts)
      const bad = numbersIn(text).filter((n) => !allowed.has(n) && !allowed.has(Math.round(n)))
      out = bad.length
        ? { text: template, ai: false, note: `number_check_failed: ${bad.slice(0, 3).join(', ')}` }
        : { text, ai: true, model: llmModel() }
    }
  } catch (e) {
    out = { text: template, ai: false, note: String((e as Error).message).slice(0, 160) }
  }
  cache.set(id, out)
  return { ...out, date: f.day.date }
}
