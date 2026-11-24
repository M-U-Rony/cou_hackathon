// Types and helpers for reports/dashboard/fairprice_data.json
// (written by modeling/export_dashboard.py).

export type Status = 'Normal' | 'Watch' | 'Unusual'
export type SurgeStage = 'none' | 'emerging' | 'confirmed'
export type DataTrust = 'high' | 'caution' | 'degraded'

export interface WaterfallStep {
  key: string
  label: string
  label_en: string
  value: number
  kind: 'start' | 'step' | 'total' | 'residual'
}

export interface Day {
  date: string
  price: number
  mid: number
  lo80: number
  hi80: number
  lo95: number
  hi95: number
  status: Status
  direction: '' | 'up' | 'down'
  unexplained_pct: number
  reason?: string
  baseline_status: Status
  surge_stage?: SurgeStage
  surge_score?: number
  surge_reason?: string
  data_trust?: DataTrust
  obs_gap_days?: number
  band_inflation?: number
  unit_status?: string
  trust_note_bn?: string
  text_bn?: string
  waterfall?: WaterfallStep[]
}

export interface Commodity {
  name_bn: string
  unit_bn: string
  latest: Day
  series: Day[]
}

export interface EventEval {
  first_flag: string | null
  first_unusual: string | null
  lead_days_to_peak: number | null
  detected: boolean
  first_emerging?: string | null
  emerging_lead_days_to_peak?: number | null
  days_before_confirmed?: number | null
}

export interface FPEvent {
  event_id: string
  commodity: string
  description: string
  start: string
  peak: string
  end: string
  model: EventEval | null
  baseline: EventEval | null
  days: Day[]
}

export interface Metric {
  commodity: string
  method: 'model' | 'baseline'
  n_days: number
  coverage80: number
  coverage95: number
  median_width80_pct: number
  unusual_per100_normal_days: number
}

export interface MarketMonth { month: string; national: number | null; dhaka: number | null; comilla: number | null; n_markets: number | null }
export interface DistrictMarket {
  name: string; admin1: string; vs_dhaka_pct: number | null; overlap_months: number; prices: Record<string, number>
  ratio?: { p10: number; p50: number; p90: number } | null
}
export interface MarketData {
  source: string; unit_note: string; months: MarketMonth[]
  points: Record<string, number>; comilla_vs_dhaka_pct: number | null; overlap_months: number
  districts?: Record<string, DistrictMarket>
}
export interface SpreadMonth { month: string; ratio: number | null; p10: number | null; p90: number | null; flagged_days: number; retail: number | null; wholesale: number | null }
export interface SpreadData {
  source: string; until: string; typical_ratio: number; flagged_days: number; days: number
  latest: { date: string; ratio: number; p10: number; p90: number; retail: number; wholesale: number; flag: boolean }
  months: SpreadMonth[]
}

export interface FairRow {
  target_fa: number
  method: 'model' | 'baseline'
  threshold: number
  actual_fa: number
  events: number
  detected: number
  median_lead: number | null
  mean_lead_detected: number | null
}
export interface FairEventRow {
  target_fa: number
  event_id: string
  model: number | null
  baseline: number | null
}
export interface FairCompare {
  summary: FairRow[]
  events: FairEventRow[]
}

export function fairAt(fc: FairCompare | null | undefined, target: number): { model?: FairRow; baseline?: FairRow } {
  const rows = fc?.summary.filter((r) => r.target_fa === target) ?? []
  return { model: rows.find((r) => r.method === 'model'), baseline: rows.find((r) => r.method === 'baseline') }
}

/** Lead days at equal false-alarm rate; undefined = no row for that event/target, null = not detected. */
export function fairEventLead(fc: FairCompare | null | undefined, eventId: string, target: number):
  { model: number | null; baseline: number | null } | undefined {
  if (!fc || !fc.events?.some((e) => e.target_fa === target)) return undefined
  const r = fc.events.find((e) => e.event_id === eventId && e.target_fa === target)
  // pivot file has no row when both methods missed
  return { model: r?.model ?? null, baseline: r?.baseline ?? null }
}

export interface ResilienceSummary {
  early_surge: {
    events_total: number
    events_flagged_before_confirm: number
    median_extra_lead_days: number
    max_extra_lead_days: number
    mean_normal_emerging_per_100d: number
  }
  reporting_guard: {
    gap_widened_days: number
    caution_days: number
    degraded_days: number
    post_gap_capped_days: number
    quarantined_implicit_unit_rows: number
    converted_explicit_unit_rows: number
  }
}

export interface FPData {
  fair_compare?: FairCompare | null
  markets?: Record<string, MarketData>
  spread?: Record<string, SpreadData>
  resilience?: ResilienceSummary
  generated: string
  horizon_days: number
  note_bn: string
  metrics: Metric[]
  commodities: Record<string, Commodity>
  events: FPEvent[]
}

export async function loadData(): Promise<FPData> {
  const r = await fetch('./fairprice_data.json')
  if (!r.ok) throw new Error(`fairprice_data.json লোড হয়নি (${r.status})`)
  return r.json()
}

const BN = '০১২৩৪৫৬৭৮৯'
export const bn = (s: string | number) => String(s).replace(/[0-9]/g, (d) => BN[+d])

export function bnNum(x: number, digits = 0): string {
  const s = x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return bn(s)
}

/** 47.5 -> ৪৭.৫, 45 -> ৪৫ */
export const bnPrice = (x: number) => bnNum(x, x % 1 ? 1 : 0)

const MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট',
  'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর']
const MONTHS_SHORT = ['জানু', 'ফেব্রু', 'মার্চ', 'এপ্রি', 'মে', 'জুন', 'জুলা', 'আগ',
  'সেপ্টে', 'অক্টো', 'নভে', 'ডিসে']

export function bnDate(iso: string, short = false): string {
  const [y, m, d] = iso.split('-').map(Number)
  return short ? `${bn(d)} ${MONTHS_SHORT[m - 1]}` : `${bn(d)} ${MONTHS[m - 1]} ${bn(y)}`
}
export const bnMonthYear = (iso: string) => {
  const [y, m] = iso.split('-').map(Number)
  return `${MONTHS_SHORT[m - 1]} ${bn(String(y).slice(2))}`
}

/** What the status means for a shopper. Falling prices are not an alarm. */
export type Tone = 'ok' | 'watch' | 'alarm' | 'down'
export function tone(d: Pick<Day, 'status' | 'direction'>): Tone {
  if (d.status === 'Normal') return 'ok'
  if (d.direction === 'down') return 'down'
  return d.status === 'Unusual' ? 'alarm' : 'watch'
}

// One vocabulary everywhere (app, replay, Bangla paragraphs from Python).
export const TONE_BN: Record<Tone, string> = {
  ok: 'ঠিক আছে',
  watch: 'একটু বেশি',
  alarm: 'অনেক বেশি',
  down: 'স্বাভাবিকের চেয়ে কম',
}

/** One line on what the verdict means. */
export const TONE_HELP: Record<Tone, string> = {
  ok: 'দাম প্রত্যাশিত সীমার ভেতরে',
  watch: 'দাম প্রত্যাশিত সীমার সামান্য উপরে',
  alarm: 'দাম অনেক বেশি; মৌসুম, উৎসব বা আগের দাম দিয়ে ব্যাখ্যা হয় না',
  down: 'দাম প্রত্যাশার চেয়ে কম; ক্রেতার জন্য চিন্তার কিছু নেই',
}

export const SURGE_BN: Record<SurgeStage, string> = {
  none: 'স্থিতিশীল',
  emerging: 'আগাম ঊর্ধ্বমুখী চাপ',
  confirmed: 'নিশ্চিত অসঙ্গতি',
}

export const TRUST_BN: Record<DataTrust, string> = {
  high: 'নির্ভরযোগ্য তথ্য',
  caution: 'সতর্ক পর্যবেক্ষণ',
  degraded: 'তথ্য অসঙ্গতি (অ্যালার্ম স্থগিত)',
}

export const isEmerging = (d: Pick<Day, 'surge_stage' | 'status'>) =>
  d.surge_stage === 'emerging' && d.status === 'Normal'

export const EVENT_TITLE_BN: Record<string, string> = {
  onion_india_ban_2023: 'ভারতের পেঁয়াজ রপ্তানি নিষেধ, ডিসেম্বর ২০২৩',
  egg_oct_2024: 'ডিমের দাম বৃদ্ধি, অক্টোবর ২০২৪',
  potato_late_2024: 'আলুর দাম বৃদ্ধি, শেষ ২০২৪',
  onion_nov_2025: 'পেঁয়াজ ৪২ থেকে ১১৫ টাকা, নভেম্বর ২০২৫',
  egg_spring_2026: 'ডিমের দাম বৃদ্ধি, এপ্রিল–মে ২০২৬',
  egg_autumn_2026: 'ডিমের রেকর্ড দাম, অক্টোবর ২০২৬',
  chili_jul_2026: 'কাঁচা মরিচ ৩৬০ টাকা, জুলাই ২০২৬',
}

export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86400000)

export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10)

/** Remove the **bold** markers the Python template adds. */
export const plain = (s = '') => s.replace(/\*\*/g, '')
