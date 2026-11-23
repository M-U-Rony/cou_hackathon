import { describe, expect, it } from 'vitest'
import type { MarketData } from './data'
import { MARKET_BN, allDistricts, districtOverlay, marketLabel, resolveDistrict } from './markets'

const district = (name: string) => ({ name, admin1: 'x', vs_dhaka_pct: 0, overlap_months: 6, prices: {} })
const market = (...names: string[]): MarketData => ({
  source: 's', unit_note: 'u', months: [], points: {}, comilla_vs_dhaka_pct: null, overlap_months: 0,
  districts: Object.fromEntries(names.map((n) => [n, district(n)])),
})

describe('marketLabel', () => {
  it('translates known WFP market names', () => {
    expect(marketLabel('Comilla Sadar')).toBe('কুমিল্লা সদর')
    expect(marketLabel('Cox`s Bazar Sadar')).toBe('কক্সবাজার সদর')
  })
  it('falls back to the raw name for unknown markets', () => {
    expect(marketLabel('Mystery Town')).toBe('Mystery Town')
  })
  it('MARKET_BN has no empty labels', () => {
    expect(Object.values(MARKET_BN).every((v) => v.length > 0)).toBe(true)
  })
})

describe('allDistricts', () => {
  it('is empty without data', () => {
    expect(allDistricts(undefined)).toEqual([])
    expect(allDistricts({})).toEqual([])
    expect(allDistricts({ potato: { ...market(), districts: undefined } })).toEqual([])
  })

  it('takes the union across commodities without duplicates', () => {
    const keys = allDistricts({
      potato: market('Comilla Sadar', 'Feni Sadar'),
      egg_farm: market('Comilla Sadar', 'Bogra Sadar'),
    })
    expect(keys).toHaveLength(3)
    expect(new Set(keys)).toEqual(new Set(['Comilla Sadar', 'Feni Sadar', 'Bogra Sadar']))
  })

  it('is sorted by the Bangla label, not the English key', () => {
    const keys = allDistricts({ potato: market('Feni Sadar', 'Comilla Sadar', 'Bogra Sadar', 'Barisal Sadar') })
    const labels = keys.map(marketLabel)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'bn')))
    // English order would be Barisal, Bogra, Comilla, Feni; Bangla order differs
    expect(keys).not.toEqual(['Barisal Sadar', 'Bogra Sadar', 'Comilla Sadar', 'Feni Sadar'])
  })

  it('keeps keys that have no Bangla translation', () => {
    expect(allDistricts({ potato: market('Mystery Town') })).toEqual(['Mystery Town'])
  })
})

describe('resolveDistrict', () => {
  const keys = ['Bogra Sadar', 'Comilla Sadar', 'Feni Sadar']
  it('uses the selection when the commodity has it', () => {
    expect(resolveDistrict('Feni Sadar', keys)).toBe('Feni Sadar')
  })
  it('falls back to Comilla Sadar when the selection is missing', () => {
    expect(resolveDistrict('Sylhet Sadar', keys)).toBe('Comilla Sadar')
  })
  it('falls back to the first key when Comilla is missing too', () => {
    expect(resolveDistrict('Sylhet Sadar', ['Bogra Sadar', 'Feni Sadar'])).toBe('Bogra Sadar')
  })
  it('returns an empty string when there are no districts', () => {
    expect(resolveDistrict('Comilla Sadar', [])).toBe('')
  })
})

describe('districtOverlay', () => {
  const withPrices = (name: string, prices: Record<string, number>): MarketData => {
    const m = market(name)
    m.districts![name].prices = prices
    return m
  }
  it('is null without market data', () => {
    expect(districtOverlay(undefined, 'Feni Sadar', '2025-01-01', '2025-12-31')).toBeNull()
    expect(districtOverlay({ ...market(), districts: undefined }, 'Feni Sadar', '2025-01-01', '2025-12-31')).toBeNull()
  })
  it('places monthly prices on the 15th, sorted, inside the inclusive window', () => {
    const m = withPrices('Feni Sadar', { '2025-03': 30, '2025-01': 10, '2025-02': 20, '2025-04': 40 })
    const o = districtOverlay(m, 'Feni Sadar', '2025-01-15', '2025-03-15')!
    expect(o.points).toEqual([
      { date: '2025-01-15', price: 10 }, { date: '2025-02-15', price: 20 }, { date: '2025-03-15', price: 30 },
    ])
    expect(o.key).toBe('Feni Sadar')
    expect(o.label).toBe('ফেনী সদর')
    expect(o.fellBack).toBe(false)
  })
  it('excludes months whose 15th is outside the window', () => {
    const m = withPrices('Feni Sadar', { '2025-01': 10, '2025-02': 20 })
    const o = districtOverlay(m, 'Feni Sadar', '2025-01-16', '2025-02-14')!
    expect(o.points).toEqual([])
  })
  it('falls back to Comilla Sadar when the selection has no data', () => {
    const m = withPrices('Comilla Sadar', { '2025-01': 10 })
    const o = districtOverlay(m, 'Bogra Sadar', '2025-01-01', '2025-02-01')!
    expect(o.key).toBe('Comilla Sadar')
    expect(o.fellBack).toBe(true)
    expect(o.points).toHaveLength(1)
  })
})
