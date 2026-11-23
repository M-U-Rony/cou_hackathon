// "Check your district's price": Dhaka's latest model range shifted by WFP's district/Dhaka ratio.
import type { Day, DistrictMarket, Tone } from './data'

export type Ratio = { p10: number; p50: number; p90: number }
export type LatestBand = Pick<Day, 'mid' | 'lo80' | 'hi80'> & Partial<Pick<Day, 'lo95' | 'hi95'>>
export interface LocalRange { lo80: number; hi80: number; lo95?: number; hi95?: number; mid: number }

export const MAX_STALE_DAYS = 30

export function localRange(latest: LatestBand, ratio: Ratio): LocalRange {
  const out: LocalRange = { lo80: latest.lo80 * ratio.p10, hi80: latest.hi80 * ratio.p90, mid: latest.mid * ratio.p50 }
  if (latest.lo95 != null && latest.hi95 != null) {
    out.lo95 = latest.lo95 * ratio.p10
    out.hi95 = latest.hi95 * ratio.p90
  }
  return out
}

export function localStatus(price: number, r: LocalRange): Tone {
  if (price < r.lo80) return 'down'
  if (price <= r.hi80) return 'ok'
  if (r.hi95 != null && price > r.hi95) return 'alarm'
  return 'watch'
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000

/** False without a ratio, or when this commodity's latest TCB date lags the freshest one by more than 30 days. */
export function checkAvailable(commodityLatest: string, latestAll: string, entry: DistrictMarket | undefined): boolean {
  if (!entry?.ratio) return false
  return dayNum(latestAll) - dayNum(commodityLatest) <= MAX_STALE_DAYS
}

/** "৪৫.৫", "45.5", "৪৫" -> number; NaN for empty/invalid. */
export function parsePrice(raw: string): number {
  const s = raw.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[,\s]/g, '').replace('।', '.')
  return s === '' || !/^\d*\.?\d*$/.test(s) ? NaN : parseFloat(s)
}

/** Above this p90/p10 spread the monthly ratio is too noisy for a meaningful check. */
export const UNSTABLE_RATIO_SPREAD = 1.3
export const ratioUnstable = (r: Ratio): boolean => r.p90 / r.p10 > UNSTABLE_RATIO_SPREAD
