// GET /api/health -> which optional AI features this deployment has keys for.
import { json, llmConfigured, llmModel, ttsConfigured } from './_shared.js'

export function GET() {
  const llm = llmConfigured()
  return json({
    llm,
    model: llm ? llmModel() : null,
    tts: ttsConfigured(),
  })
}
