// POST /api/summary  {commodity: "onion_local", date?: "2026-11-15"}
// -> {text, ai, model?, note?, date}
// ai=false means the template text came back (no key, LLM error, or the
// LLM's text held a number that is not in the facts).
import { json, limited, summaryFor } from './_shared.js'

export async function POST(req: Request) {
  if (limited(req)) return json({ error: 'অনেক বেশি অনুরোধ, এক মিনিট পরে চেষ্টা করুন' }, 429)
  let body: { commodity?: string; date?: string }
  try { body = (await req.json()) as typeof body } catch { return json({ error: 'bad json' }, 400) }
  if (!body.commodity || !/^[a-z_]{3,30}$/.test(body.commodity)) return json({ error: 'commodity missing' }, 400)
  if (body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return json({ error: 'bad date' }, 400)
  const s = await summaryFor(body.commodity, body.date)
  if (!s) return json({ error: 'এই দিনের তথ্য পাওয়া যায়নি' }, 404)
  return json(s)
}
