import { describe, expect, it } from 'vitest'
import type { FairCompare } from './data'
import {
  EVENT_TITLE_BN, TONE_BN, TONE_HELP, addDays, bn, bnDate, bnMonthYear, bnNum, bnPrice,
  daysBetween, fairAt, fairEventLead, plain, tone,
} from './data'

describe('bn / bnNum / bnPrice', () => {
  it('converts every digit and leaves other characters alone', () => {
    expect(bn('0123456789')).toBe('০১২৩৪৫৬৭৮৯')
    expect(bn('৳ 4.5%')).toBe('৳ ৪.৫%')
    expect(bn(2026)).toBe('২০২৬')
  })

  it('formats with thousands separators and fixed decimals', () => {
    expect(bnNum(1234567)).toBe('১,২৩৪,৫৬৭')
    expect(bnNum(47.5, 1)).toBe('৪৭.৫')
    expect(bnNum(45, 2)).toBe('৪৫.০০')
    expect(bnNum(47.6)).toBe('৪৮')
  })

  it('handles negatives and zero', () => {
    expect(bnNum(-12.5, 1)).toBe('-১২.৫')
    expect(bnNum(0)).toBe('০')
  })

  it('bnPrice shows one decimal only when needed', () => {
    expect(bnPrice(45)).toBe('৪৫')
    expect(bnPrice(47.5)).toBe('৪৭.৫')
    expect(bnPrice(1200)).toBe('১,২০০')
  })
})

describe('dates', () => {
  it('bnDate long form', () => {
    expect(bnDate('2026-03-05')).toBe('৫ মার্চ ২০২৬')
    expect(bnDate('2024-12-31')).toBe('৩১ ডিসেম্বর ২০২৪')
  })

  it('bnDate short form omits the year', () => {
    expect(bnDate('2026-01-09', true)).toBe('৯ জানু')
  })

  it('bnDate has a name for every month', () => {
    const names = Array.from({ length: 12 }, (_, i) => bnDate(`2025-${String(i + 1).padStart(2, '0')}-01`).split(' ')[1])
    expect(new Set(names).size).toBe(12)
  })

  it('bnMonthYear uses the short month and two-digit year', () => {
    expect(bnMonthYear('2025-10-01')).toBe('অক্টো ২৫')
    expect(bnMonthYear('2024-03')).toBe('মার্চ ২৪')
  })

  it('addDays crosses month and year boundaries and goes backwards', () => {
    expect(addDays('2026-01-30', 5)).toBe('2026-02-04')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('daysBetween is signed', () => {
    expect(daysBetween('2026-01-01', '2026-01-15')).toBe(14)
    expect(daysBetween('2026-01-15', '2026-01-01')).toBe(-14)
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0)
  })
})

describe('tone', () => {
  it('Normal is ok regardless of direction', () => {
    expect(tone({ status: 'Normal', direction: '' })).toBe('ok')
    expect(tone({ status: 'Normal', direction: 'up' })).toBe('ok')
  })

  it('a falling price is never an alarm', () => {
    expect(tone({ status: 'Watch', direction: 'down' })).toBe('down')
    expect(tone({ status: 'Unusual', direction: 'down' })).toBe('down')
  })

  it('rising: Watch -> watch, Unusual -> alarm', () => {
    expect(tone({ status: 'Watch', direction: 'up' })).toBe('watch')
    expect(tone({ status: 'Unusual', direction: 'up' })).toBe('alarm')
  })

  it('steady rise (Watch, no direction) counts as watch', () => {
    expect(tone({ status: 'Watch', direction: '' })).toBe('watch')
  })

  it('every tone has a word and a help line', () => {
    for (const t of ['ok', 'watch', 'alarm', 'down'] as const) {
      expect(TONE_BN[t]).toBeTruthy()
      expect(TONE_HELP[t]).toBeTruthy()
    }
  })
})

describe('plain', () => {
  it('strips bold markers', () => {
    expect(plain('অবস্থা: **অনেক বেশি**।')).toBe('অবস্থা: অনেক বেশি।')
  })
  it('tolerates undefined', () => {
    expect(plain()).toBe('')
    expect(plain(undefined)).toBe('')
  })
})

const fc: FairCompare = {
  summary: [
    { target_fa: 5, method: 'model', threshold: 1.0, actual_fa: 4.5, events: 3, detected: 3, median_lead: 10, mean_lead_detected: 12 },
    { target_fa: 5, method: 'baseline', threshold: 1.4, actual_fa: 4.9, events: 3, detected: 2, median_lead: 6, mean_lead_detected: 8 },
    { target_fa: 10, method: 'model', threshold: 0.8, actual_fa: 9.0, events: 3, detected: 3, median_lead: 14, mean_lead_detected: 15 },
  ],
  events: [
    { target_fa: 5, event_id: 'a', model: 12, baseline: 3 },
    { target_fa: 5, event_id: 'b', model: 7, baseline: null },
  ],
}

describe('fairAt', () => {
  it('returns both methods for a target', () => {
    const r = fairAt(fc, 5)
    expect(r.model?.threshold).toBe(1.0)
    expect(r.baseline?.threshold).toBe(1.4)
  })
  it('missing method for a target is undefined', () => {
    expect(fairAt(fc, 10).baseline).toBeUndefined()
    expect(fairAt(fc, 10).model?.median_lead).toBe(14)
  })
  it('unknown target, null or undefined data give empty result', () => {
    expect(fairAt(fc, 99)).toEqual({ model: undefined, baseline: undefined })
    expect(fairAt(null, 5)).toEqual({ model: undefined, baseline: undefined })
    expect(fairAt(undefined, 5)).toEqual({ model: undefined, baseline: undefined })
  })
})

describe('fairEventLead', () => {
  it('returns both leads when the event has a row', () => {
    expect(fairEventLead(fc, 'a', 5)).toEqual({ model: 12, baseline: 3 })
  })
  it('keeps null for a method that missed the event', () => {
    expect(fairEventLead(fc, 'b', 5)).toEqual({ model: 7, baseline: null })
  })
  it('no row for the event at a target that has rows => both missed', () => {
    expect(fairEventLead(fc, 'zzz', 5)).toEqual({ model: null, baseline: null })
  })
  it('target with no rows at all => undefined (unknown, not missed)', () => {
    expect(fairEventLead(fc, 'a', 10)).toBeUndefined()
  })
  it('no fair_compare data => undefined', () => {
    expect(fairEventLead(null, 'a', 5)).toBeUndefined()
    expect(fairEventLead(undefined, 'a', 5)).toBeUndefined()
  })
  it('tolerates a missing events array', () => {
    expect(fairEventLead({ summary: [] } as unknown as FairCompare, 'a', 5)).toBeUndefined()
  })
})

describe('EVENT_TITLE_BN', () => {
  it('has a title for each known event id', () => {
    expect(Object.keys(EVENT_TITLE_BN)).toContain('onion_india_ban_2023')
    expect(Object.values(EVENT_TITLE_BN).every(Boolean)).toBe(true)
  })
})
