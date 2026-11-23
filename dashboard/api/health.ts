// GET /api/health -> which optional AI features this deployment has keys for.
import { env, json, llmConfigured, llmModel } from './_shared.js'

export function GET() {
  const llm = llmConfigured()
  return json({
    llm,
    model: llm ? llmModel() : null,
    tts: Boolean(env('ELEVENLABS_API_KEY') && env('ELEVENLABS_VOICE_ID')),
  })
}
