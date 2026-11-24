import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allowedNumbers,
  bnNumberToWords,
  bnTextForSpeech,
  extractSseAudioChunks,
  llmConfigured,
  llmModel,
  llmSummary,
  numbersIn,
  pcm16ToWav,
  ttsConfigured,
} from './_shared.js'

const origEnv = { ...process.env }
const origFetch = globalThis.fetch

afterEach(() => {
  for (const k of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'LLM_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
  globalThis.fetch = origFetch
  vi.restoreAllMocks()
})

describe('LLM config & provider selection', () => {
  it('reports unconfigured when neither OpenRouter nor Anthropic key is set', () => {
    delete process.env.OPENROUTER_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.LLM_MODEL
    expect(llmConfigured()).toBe(false)
    expect(llmModel()).toBe('claude-haiku-4-5')
  })

  it('prefers OpenRouter with gemini-2.5-flash default and supports Anthropic fallback', () => {
    delete process.env.LLM_MODEL
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    delete process.env.OPENROUTER_API_KEY
    expect(llmConfigured()).toBe(true)
    expect(llmModel()).toBe('claude-haiku-4-5')

    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    expect(llmConfigured()).toBe(true)
    expect(llmModel()).toBe('google/gemini-2.5-flash')

    process.env.LLM_MODEL = 'anthropic/claude-haiku-4.5'
    expect(llmModel()).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('llmSummary OpenRouter multi-model fallback', () => {
  it('sends OpenRouter headers, deduplicated models array, temperature 0.2, and parses response', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-demo'
    process.env.LLM_MODEL = 'anthropic/claude-haiku-4.5'

    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      choices: [{ message: { content: '  আজ ডিমের দাম ৪৩.৫ টাকা, যা স্বাভাবিক সীমার ভেতরেই আছে।  ' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const res = await llmSummary('আসল দাম: 43.5 টাকা')
    expect(res).toEqual({
      text: 'আজ ডিমের দাম ৪৩.৫ টাকা, যা স্বাভাবিক সীমার ভেতরেই আছে।',
      model: 'anthropic/claude-haiku-4.5',
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-or-demo')
    expect(headers['HTTP-Referer']).toBe('https://fairprice-bd.vercel.app')
    expect(headers['X-Title']).toBe('FairPrice BD')

    const body = JSON.parse(init.body as string) as {
      model: string; models: string[]; temperature: number; max_tokens: number
    }
    expect(body.model).toBe('anthropic/claude-haiku-4.5')
    expect(body.models).toEqual([
      'anthropic/claude-haiku-4.5',
      'google/gemini-2.5-flash',
      'openai/gpt-4o-mini',
    ])
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(400)
  })
})

describe('Number-Guard verification', () => {
  it('allows numbers from fact sheet & template and catches fabricated Bengali/ASCII numbers', () => {
    const day = {
      date: '2026-11-23',
      price: 43.5,
      mid: 44,
      lo80: 42,
      hi80: 47,
      status: 'Normal',
      direction: 'ok',
      unexplained_pct: 1,
      text_bn: 'আজকের দাম **৪৩.৫ টাকা**, যা স্বাভাবিক সীমা **৪২–৪৭ টাকার** ভেতরে।',
    }
    const facts = 'আসল দাম: 43.5 টাকা\nপ্রত্যাশিত সীমা (৮০%): 42–47 টাকা'
    const allowed = allowedNumbers({ day }, facts)

    expect(numbersIn('আজ দাম ৪৩.৫ টাকা, সীমা ৪২ থেকে ৪৭ টাকা।').every((n) => allowed.has(n))).toBe(true)
    const bad = numbersIn('গত সপ্তাহে দাম ৯৯ টাকা বা 120 টাকা ছিল।').filter((n) => !allowed.has(n))
    expect(bad).toEqual([99, 120])
  })
})

describe('TTS configuration & WAV/SSE helpers', () => {
  it('enables ttsConfigured via OpenRouter key or ElevenLabs credentials', () => {
    delete process.env.OPENROUTER_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_VOICE_ID
    expect(ttsConfigured()).toBe(false)

    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    expect(ttsConfigured()).toBe(true)

    delete process.env.OPENROUTER_API_KEY
    process.env.ELEVENLABS_API_KEY = 'el-key'
    expect(ttsConfigured()).toBe(false)
    process.env.ELEVENLABS_VOICE_ID = 'el-voice'
    expect(ttsConfigured()).toBe(true)
  })

  it('wraps PCM16 bytes in a valid 44-byte RIFF/WAVE header', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6])
    const wav = pcm16ToWav(pcm, 24_000)
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt32LE(24)).toBe(24_000)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    expect(wav.subarray(44).equals(pcm)).toBe(true)
  })

  it('extracts and concatenates base64 audio chunks from SSE frames', () => {
    const c1 = Buffer.from('hello').toString('base64')
    const c2 = Buffer.from('world').toString('base64')
    const sse = [
      ': OPENROUTER PROCESSING',
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: c1, transcript: 'a' } } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ignore' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: c2 } } }] })}`,
      'data: [DONE]',
    ].join('\n')
    const out = extractSseAudioChunks(sse)
    expect(out.toString('utf8')).toBe('helloworld')
  })
})

describe('Bengali number-to-words speech normalization', () => {
  it('converts integers across 0..2026 into standard Bengali words', () => {
    expect(bnNumberToWords(0)).toBe('শূন্য')
    expect(bnNumberToWords(14)).toBe('চৌদ্দ')
    expect(bnNumberToWords(23)).toBe('তেইশ')
    expect(bnNumberToWords(43)).toBe('তেতাল্লিশ')
    expect(bnNumberToWords(58)).toBe('আটান্ন')
    expect(bnNumberToWords(100)).toBe('এক শত')
    expect(bnNumberToWords(147)).toBe('এক শত সাতচল্লিশ')
    expect(bnNumberToWords(2026)).toBe('দুই হাজার ছাব্বিশ')
  })

  it('spells out numbers, decimals, ranges, percentages, currency, and ordinals in real templates', () => {
    const raw = '২৩ নভেম্বর ২০২৬: ঢাকায় ফার্মের ডিমের TCB দাম ৪৩.৫ টাকা/হালি। ১৪ দিন আগের তথ্য দিয়ে প্রত্যাশিত দাম ছিল ৪২–৪৭ টাকা। অবস্থা: **ঠিক আছে**। প্রায় ৩% কমেছে।'
    const spoken = bnTextForSpeech(raw)
    expect(spoken).toContain('তেইশ নভেম্বর দুই হাজার ছাব্বিশ')
    expect(spoken).toContain('টিসিবি')
    expect(spoken).toContain('তেতাল্লিশ দশমিক পাঁচ টাকা প্রতি হালি')
    expect(spoken).toContain('চৌদ্দ দিন')
    expect(spoken).toContain('বিয়াল্লিশ থেকে সাতচল্লিশ টাকা')
    expect(spoken).toContain('তিন শতাংশ')
    expect(spoken).not.toContain('**')
    expect(spoken).not.toMatch(/[0-9০-৯]/)

    const aiText = 'আজ ২৩শে নভেম্বর, ২০২৬ (গত মাসের ১৫ই তারিখ থেকে) দামের তারতম্য (-১.৫ টাকা) এবং (+০.৯ টাকা)।'
    const aiSpoken = bnTextForSpeech(aiText)
    expect(aiSpoken).toContain('তেইশে নভেম্বর, দুই হাজার ছাব্বিশ')
    expect(aiSpoken).toContain('পনেরোই তারিখ')
    expect(aiSpoken).toContain('(মাইনাস এক দশমিক পাঁচ টাকা)')
    expect(aiSpoken).toContain('(প্লাস শূন্য দশমিক নয় টাকা)')
    expect(aiSpoken).not.toMatch(/[0-9০-৯]/)
  })
})
