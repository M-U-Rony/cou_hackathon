// POST /api/tts  {commodity, date?, variant: "template" | "ai"}  -> audio/mpeg
// Speaks only text this app produced (the template paragraph or the checked
// AI summary for that day), via ElevenLabs. Without keys: 501, and the
// browser falls back to its own speech engine.
import { env, findDay, json, limited, summaryFor } from './_shared.js'

export async function POST(req: Request) {
  const key = env('ELEVENLABS_API_KEY'), voice = env('ELEVENLABS_VOICE_ID')
  if (!key || !voice) return json({ error: 'server voice not configured' }, 501)
  if (limited(req, 10)) return json({ error: 'অনেক বেশি অনুরোধ' }, 429)
  let body: { commodity?: string; date?: string; variant?: string }
  try { body = (await req.json()) as typeof body } catch { return json({ error: 'bad json' }, 400) }
  if (!body.commodity || !/^[a-z_]{3,30}$/.test(body.commodity)) return json({ error: 'commodity missing' }, 400)

  let text: string | undefined
  if (body.variant === 'ai') text = (await summaryFor(body.commodity, body.date))?.text
  else text = findDay(body.commodity, body.date)?.day.text_bn?.replace(/\*\*/g, '')
  if (!text) return json({ error: 'এই দিনের তথ্য পাওয়া যায়নি' }, 404)

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: text.slice(0, 2000), model_id: env('ELEVENLABS_MODEL') || 'eleven_v3' }),
  })
  if (!r.ok) return json({ error: `voice error ${r.status}` }, 502)
  return new Response(r.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } })
}
