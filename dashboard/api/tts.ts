// GET /api/tts?commodity=egg_farm&date=2026-11-23&variant=template|ai
// POST /api/tts  {commodity, date?, variant: "template" | "ai"}
// -> audio/mpeg (progressive ElevenLabs stream) or audio/wav (OpenRouter fallback)
// GET responses carry Vercel Edge CDN cache headers so repeat plays start <0.2s.
import {
  bnTextForSpeech,
  env,
  extractSseAudioChunks,
  findDay,
  json,
  limited,
  pcm16ToWav,
  summaryFor,
  ttsConfigured,
} from './_shared.js'

const DEFAULT_FREE_VOICE = 'EXAVITQu4vr4xnSDxMaL'
const EDGE_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600'

const blockedVoices = new Set<string>()
const wavCache = new Map<string, Buffer>()

async function handleTts(
  req: Request,
  params: { commodity?: string; date?: string; variant?: string },
  cacheable: boolean,
): Promise<Response> {
  if (!ttsConfigured()) return json({ error: 'server voice not configured' }, 501)
  if (limited(req, 30)) return json({ error: 'অনেক বেশি অনুরোধ' }, 429)
  if (!params.commodity || !/^[a-z_]{3,30}$/.test(params.commodity)) return json({ error: 'commodity missing' }, 400)
  if (params.date && !/^\d{4}-\d{2}-\d{2}$/.test(params.date)) return json({ error: 'bad date' }, 400)

  const variant = params.variant === 'ai' ? 'ai' : 'template'
  let text: string | undefined
  if (variant === 'ai') text = (await summaryFor(params.commodity, params.date, req.url))?.text
  else text = (await findDay(params.commodity, params.date, req.url))?.day.text_bn?.replace(/\*\*/g, '')
  if (!text) return json({ error: 'এই দিনের তথ্য পাওয়া যায়নি' }, 404)
  const spokenText = bnTextForSpeech(text)

  const cacheControl = cacheable ? EDGE_CACHE_CONTROL : 'no-store'
  const cacheKey = `${params.commodity}|${params.date ?? 'latest'}|${variant}`
  const elevenKey = env('ELEVENLABS_API_KEY')?.trim()
  const voice = env('ELEVENLABS_VOICE_ID')?.trim()
  const openRouterKey = env('OPENROUTER_API_KEY')?.trim()
  let elevenErr = ''

  if (elevenKey && voice) {
    const candidates = (voice === DEFAULT_FREE_VOICE ? [voice] : [voice, DEFAULT_FREE_VOICE])
      .filter((v) => !blockedVoices.has(v))
    const voicesToTry = candidates.length ? candidates : [DEFAULT_FREE_VOICE]

    try {
      for (const v of voicesToTry) {
        const r = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v)}/stream?output_format=mp3_44100_64`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(20_000),
            headers: { 'xi-api-key': elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
            body: JSON.stringify({
              text: spokenText.slice(0, 2000),
              model_id: env('ELEVENLABS_MODEL') || 'eleven_v3',
              language_code: 'bn',
            }),
          },
        )
        if (r.ok && r.body) {
          return new Response(r.body, {
            headers: {
              'content-type': 'audio/mpeg',
              'cache-control': cacheControl,
              'x-tts-provider': v === voice ? 'elevenlabs-stream' : 'elevenlabs-premade-stream',
            },
          })
        }
        const errText = (await r.text()).slice(0, 300)
        console.error('[tts] elevenlabs failed', { voice: v, status: r.status, body: errText })
        if (r.status === 402 || r.status === 404) blockedVoices.add(v)
        elevenErr = String(r.status)
        if (r.status === 401) break
      }
      if (!openRouterKey) return json({ error: `voice error ${elevenErr || '502'}` }, 502)
    } catch (e) {
      console.error('[tts] elevenlabs exception', String(e).slice(0, 200))
      elevenErr = 'exception'
      if (!openRouterKey) return json({ error: 'voice error' }, 502)
    }
  }

  if (!openRouterKey) return json({ error: 'server voice not configured' }, 501)

  const wavHeaders: Record<string, string> = {
    'content-type': 'audio/wav',
    'cache-control': cacheControl,
    'x-tts-provider': 'openrouter',
  }
  if (elevenErr) wavHeaders['x-tts-fallback-reason'] = `elevenlabs_${elevenErr}`

  const cached = wavCache.get(cacheKey)
  if (cached) {
    return new Response(new Uint8Array(cached), { headers: wavHeaders })
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
        { role: 'user', content: spokenText.slice(0, 1200) },
      ],
    }),
  })
  if (!r.ok) return json({ error: `openrouter tts error ${r.status}` }, 502)

  const sseText = await r.text()
  const pcm = extractSseAudioChunks(sseText)
  if (pcm.length === 0) return json({ error: 'empty audio stream' }, 502)

  const wav = pcm16ToWav(pcm, 24_000)
  wavCache.set(cacheKey, wav)
  return new Response(new Uint8Array(wav), { headers: wavHeaders })
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams
  return handleTts(
    req,
    {
      commodity: sp.get('commodity') ?? undefined,
      date: sp.get('date') ?? undefined,
      variant: sp.get('variant') ?? undefined,
    },
    true,
  )
}

export async function POST(req: Request) {
  let body: { commodity?: string; date?: string; variant?: string }
  try { body = (await req.json()) as typeof body } catch { return json({ error: 'bad json' }, 400) }
  return handleTts(req, body, false)
}
