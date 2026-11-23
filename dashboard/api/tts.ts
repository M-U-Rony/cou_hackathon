// POST /api/tts  {commodity, date?, variant: "template" | "ai"}  -> audio/mpeg or audio/wav
// Speaks only text this app produced (the template paragraph or the checked
// AI summary for that day), via ElevenLabs (when configured) or OpenRouter
// (`openai/gpt-audio-mini` streaming PCM16 wrapped as WAV). Without keys: 501,
// and the browser falls back to its own speech engine.
import {
  env,
  extractSseAudioChunks,
  findDay,
  json,
  limited,
  pcm16ToWav,
  summaryFor,
  ttsConfigured,
} from './_shared.js'

const mp3Cache = new Map<string, Buffer>()
const wavCache = new Map<string, Buffer>()

export async function POST(req: Request) {
  if (!ttsConfigured()) return json({ error: 'server voice not configured' }, 501)
  if (limited(req, 10)) return json({ error: 'অনেক বেশি অনুরোধ' }, 429)
  let body: { commodity?: string; date?: string; variant?: string }
  try { body = (await req.json()) as typeof body } catch { return json({ error: 'bad json' }, 400) }
  if (!body.commodity || !/^[a-z_]{3,30}$/.test(body.commodity)) return json({ error: 'commodity missing' }, 400)

  let text: string | undefined
  if (body.variant === 'ai') text = (await summaryFor(body.commodity, body.date, req.url))?.text
  else text = (await findDay(body.commodity, body.date, req.url))?.day.text_bn?.replace(/\*\*/g, '')
  if (!text) return json({ error: 'এই দিনের তথ্য পাওয়া যায়নি' }, 404)

  const cacheKey = `${body.commodity}|${body.date ?? 'latest'}|${body.variant ?? 'template'}`
  const elevenKey = env('ELEVENLABS_API_KEY'), voice = env('ELEVENLABS_VOICE_ID')
  const openRouterKey = env('OPENROUTER_API_KEY')

  if (elevenKey && voice) {
    const cachedMp3 = mp3Cache.get(cacheKey)
    if (cachedMp3) {
      return new Response(new Uint8Array(cachedMp3), {
        headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
      })
    }
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        headers: { 'xi-api-key': elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: text.slice(0, 2000), model_id: env('ELEVENLABS_MODEL') || 'eleven_v3' }),
      })
      if (r.ok) {
        const mp3 = Buffer.from(await r.arrayBuffer())
        if (mp3.length > 0) {
          mp3Cache.set(cacheKey, mp3)
          return new Response(new Uint8Array(mp3), {
            headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
          })
        }
      }
      if (!openRouterKey) return json({ error: `voice error ${r.status}` }, 502)
    } catch {
      if (!openRouterKey) return json({ error: 'voice error' }, 502)
    }
  }

  if (!openRouterKey) return json({ error: 'server voice not configured' }, 501)

  const cached = wavCache.get(cacheKey)
  if (cached) {
    return new Response(new Uint8Array(cached), {
      headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
    })
  }

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(25_000),
    headers: {
      Authorization: `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://fairprice-bd.vercel.app',
      'X-Title': 'FairPrice BD',
    },
    body: JSON.stringify({
      model: env('OPENROUTER_TTS_MODEL') || 'openai/gpt-audio-mini',
      modalities: ['text', 'audio'],
      audio: { voice: env('OPENROUTER_TTS_VOICE') || 'alloy', format: 'pcm16' },
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'তুমি একজন বাংলা সংবাদ পাঠক। ব্যবহারকারীর দেওয়া বাংলা লেখাটি হুবহু, স্পষ্ট ও স্বাভাবিক বাংলাদেশি উচ্চারণে পড়ে শোনাও। কোনো বাড়তি কথা বা ভূমিকা যোগ করবে না।',
        },
        { role: 'user', content: text.slice(0, 1200) },
      ],
    }),
  })
  if (!r.ok) return json({ error: `openrouter tts error ${r.status}` }, 502)

  const sseText = await r.text()
  const pcm = extractSseAudioChunks(sseText)
  if (pcm.length === 0) return json({ error: 'empty audio stream' }, 502)

  const wav = pcm16ToWav(pcm, 24_000)
  wavCache.set(cacheKey, wav)
  return new Response(new Uint8Array(wav), {
    headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' },
  })
}
