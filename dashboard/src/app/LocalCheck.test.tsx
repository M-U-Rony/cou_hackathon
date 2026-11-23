import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Commodity, MarketData } from '../lib/data'
import { LocalCheck } from './LocalCheck'

const day = { date: '2026-11-15', price: 100, mid: 100, lo80: 80, hi80: 120, lo95: 70, hi95: 140,
  status: 'Normal', direction: '', unexplained_pct: 0, baseline_status: 'Normal' } as Commodity['latest']
const commodity = { name_bn: 'ডিম', unit_bn: 'হালি', latest: day, series: [] } as Commodity
const entry = (ratio: { p10: number; p50: number; p90: number } | null) =>
  ({ name: 'Comilla Sadar', admin1: 'Chittagong', vs_dhaka_pct: 0, overlap_months: 10, prices: {}, ratio })
const market = (ratio: { p10: number; p50: number; p90: number } | null = { p10: 1, p50: 1, p90: 1 }) =>
  ({ source: 's', unit_note: 'u', months: [], points: {}, comilla_vs_dhaka_pct: 0, overlap_months: 0,
    districts: { 'Comilla Sadar': entry(ratio) } }) as MarketData

const WIDE = { p10: 0.7, p50: 1, p90: 1.2 }
const setup = (m: MarketData = market(), district = 'Comilla Sadar', latestAll = '2026-11-15') =>
  render(<LocalCheck market={m} commodity={commodity} district={district} latestAll={latestAll} />)

describe('LocalCheck', () => {
  it('shows title, range text, unit and caveat', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'দাম যাচাই: কুমিল্লা সদর (আনুমানিক)' })).toBeInTheDocument()
    expect(screen.getByText(/১৫ নভেম্বর ২০২৬-এর ঢাকার সীমা আর WFP অনুপাত ধরে কুমিল্লা সদর এলাকায় প্রত্যাশিত দাম প্রায় ৮০–১২০ ৳/)).toBeVisible()
    expect(screen.getByText('৳/হালি')).toBeVisible()
    expect(screen.getByText(/কারসাজির প্রমাণ নয়/)).toBeVisible()
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', '১০০')
    expect(screen.getByLabelText('আজকের দাম, কুমিল্লা সদর (৳/হালি)')).toBeInTheDocument()
  })

  it('price inside the range is ok', async () => {
    setup()
    await userEvent.type(screen.getByRole('textbox'), '100')
    expect(screen.getByText('আপনার দাম ১০০ ৳: ঠিক আছে')).toBeVisible()
    expect(screen.getByTestId('local-pill')).toHaveTextContent('ঠিক আছে')
  })

  it('far above is alarm', async () => {
    setup()
    await userEvent.type(screen.getByRole('textbox'), '300')
    expect(screen.getByText('আপনার দাম ৩০০ ৳: অনেক বেশি')).toBeVisible()
  })

  it('below is down, slightly above is watch', async () => {
    setup()
    await userEvent.type(screen.getByRole('textbox'), '50')
    expect(screen.getByTestId('local-pill')).toHaveTextContent('স্বাভাবিকের চেয়ে কম')
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '130')
    expect(screen.getByTestId('local-pill')).toHaveTextContent('একটু বেশি')
  })

  it('accepts Bangla digits', async () => {
    setup()
    await userEvent.type(screen.getByRole('textbox'), '৩০০')
    expect(screen.getByText('আপনার দাম ৩০০ ৳: অনেক বেশি')).toBeVisible()
  })

  it('no verdict before typing', () => {
    setup()
    expect(screen.queryByTestId('local-pill')).toBeNull()
  })

  it('falls back with a muted note when the district has no data', () => {
    setup(market(), 'Bogra Sadar')
    expect(screen.getByRole('heading', { name: 'দাম যাচাই: কুমিল্লা সদর (আনুমানিক)' })).toBeInTheDocument()
    expect(screen.getByText(/বগুড়া সদর: এই পণ্যের WFP তথ্য নেই, কুমিল্লা সদর দেখানো হচ্ছে/)).toBeVisible()
  })

  it('renders nothing without a ratio or with stale data', () => {
    const a = setup(market(null)); expect(a.container).toBeEmptyDOMElement(); a.unmount()
    const b = setup(market(), 'Comilla Sadar', '2026-12-31'); expect(b.container).toBeEmptyDOMElement()
  })
})

describe('LocalCheck unstable ratio', () => {
  const warn = /সতর্কতা: এই এলাকায় এই পণ্যের দাম ঢাকার তুলনায় মাসে মাসে অনেক ওঠানামা করে \(WFP অনুপাত ০\.৭০–১\.২০\), তাই এখানে যাচাই নির্ভরযোগ্য নয়/
  it('shows the warning and range even before typing', () => {
    setup(market(WIDE))
    expect(screen.getByText(warn)).toBeVisible()
    expect(screen.getByText(/প্রায় ৫৬–১৪৪ ৳/)).toBeVisible()
  })
  it('shows a neutral line and no tone pill', async () => {
    setup(market(WIDE))
    await userEvent.type(screen.getByRole('textbox'), '300')
    expect(screen.getByText('আপনার দাম ৩০০ ৳ সীমার উপরে')).toBeVisible()
    expect(screen.queryByTestId('local-pill')).toBeNull()
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '100')
    expect(screen.getByText('আপনার দাম ১০০ ৳ সীমার ভেতরে')).toBeVisible()
    await userEvent.clear(screen.getByRole('textbox'))
    await userEvent.type(screen.getByRole('textbox'), '30')
    expect(screen.getByText('আপনার দাম ৩০ ৳ সীমার নিচে')).toBeVisible()
  })
  it('stable case has no warning', () => {
    setup()
    expect(screen.queryByText(/সতর্কতা/)).toBeNull()
  })
})

describe('LocalCheck reset', () => {
  const props = { market: market(), commodity, district: 'Comilla Sadar', latestAll: '2026-11-15' }
  it('clears the input and verdict when the commodity changes', async () => {
    const { rerender } = render(<LocalCheck {...props} />)
    await userEvent.type(screen.getByRole('textbox'), '58')
    expect(screen.getByTestId('local-pill')).toBeVisible()
    rerender(<LocalCheck {...props} commodity={{ ...commodity, name_bn: 'কাঁচা মরিচ', unit_bn: 'কেজি' }} />)
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.queryByTestId('local-pill')).toBeNull()
  })
  it('clears the input when the district changes', async () => {
    const m = market()
    m.districts!['Feni Sadar'] = entry({ p10: 1, p50: 1, p90: 1 })
    const { rerender } = render(<LocalCheck {...props} market={m} />)
    await userEvent.type(screen.getByRole('textbox'), '58')
    rerender(<LocalCheck {...props} market={m} district="Feni Sadar" />)
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.queryByTestId('local-pill')).toBeNull()
  })
})
