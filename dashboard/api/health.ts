// GET /api/health -> which optional AI features this deployment has keys for.
import { env, json, llmModel } from './_shared.js'

export function GET() {
  return json({
    llm: Boolean(env('ANTHROPIC_API_KEY')),
    model: env('ANTHROPIC_API_KEY') ? llmModel() : null,
    tts: Boolean(env('ELEVENLABS_API_KEY') && env('ELEVENLABS_VOICE_ID')),
  })
}
