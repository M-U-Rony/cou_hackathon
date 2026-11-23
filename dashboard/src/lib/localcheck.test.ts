import { describe, expect, it } from 'vitest'
import { UNSTABLE_RATIO_SPREAD, checkAvailable, localRange, localStatus, ratioUnstable } from './localcheck'

const latest = { mid: 100, lo80: 80, hi80: 120, lo95: 70, hi95: 140 }
const ratio = { p10: 0.9, p50: 0.95, p90: 1.1 }

describe('localRange', () => {
  it('scales the 80% and 95% bands by p10/p90 and mid by p50', () => {
    const r = localRange(latest, ratio)
    expect(r.lo80).toBeCloseTo(72); expect(r.hi80).toBeCloseTo(132)
    expect(r.lo95).toBeCloseTo(63); expect(r.hi95).toBeCloseTo(154)
    expect(r.mid).toBeCloseTo(95)
  })
  it('works with 80% only', () => {
    const r = localRange({ mid: 100, lo80: 80, hi80: 120 }, ratio)
    expect(r.hi95).toBeUndefined()
    expect(r.hi80).toBeCloseTo(132)
  })
})

describe('localStatus', () => {
  const r = localRange(latest, ratio)
  it('classifies', () => {
    expect(localStatus(60, r)).toBe('down')
    expect(localStatus(100, r)).toBe('ok')
    expect(localStatus(72, r)).toBe('ok')
    expect(localStatus(132, r)).toBe('ok')
    expect(localStatus(140, r)).toBe('watch')
    expect(localStatus(154, r)).toBe('watch')
    expect(localStatus(200, r)).toBe('alarm')
  })
  it('without 95% band anything above 80% is watch', () => {
    expect(localStatus(500, localRange({ mid: 100, lo80: 80, hi80: 120 }, ratio))).toBe('watch')
  })
})

describe('checkAvailable', () => {
  const entry = { name: 'x', admin1: 'y', vs_dhaka_pct: 0, overlap_months: 10, prices: {}, ratio }
  it('true for fresh data with a ratio', () => {
    expect(checkAvailable('2026-11-15', '2026-11-15', entry)).toBe(true)
    expect(checkAvailable('2026-10-16', '2026-11-15', entry)).toBe(true)
  })
  it('false when ratio missing or entry absent', () => {
    expect(checkAvailable('2026-11-15', '2026-11-15', { ...entry, ratio: null })).toBe(false)
    expect(checkAvailable('2026-11-15', '2026-11-15', { ...entry, ratio: undefined })).toBe(false)
    expect(checkAvailable('2026-11-15', '2026-11-15', undefined)).toBe(false)
  })
  it('false when commodity data is stale (>30 days behind)', () => {
    expect(checkAvailable('2026-02-10', '2026-11-15', entry)).toBe(false)
    expect(checkAvailable('2026-10-15', '2026-11-15', entry)).toBe(false)
  })
})

describe('ratioUnstable', () => {
  it('egg-like ratio is stable, chili-like is unstable', () => {
    expect(ratioUnstable({ p10: 0.934, p50: 0.9777, p90: 1.0187 })).toBe(false)
    expect(ratioUnstable({ p10: 0.6826, p50: 0.8419, p90: 1.0993 })).toBe(true)
  })
  it('threshold is exclusive', () => {
    expect(UNSTABLE_RATIO_SPREAD).toBe(1.3)
    expect(ratioUnstable({ p10: 1, p50: 1.1, p90: 1.3 })).toBe(false)
    expect(ratioUnstable({ p10: 1, p50: 1.1, p90: 1.31 })).toBe(true)
  })
})
