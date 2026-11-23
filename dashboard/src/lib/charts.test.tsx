import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { BandChart, OverlayLegendItem, OverlayNote } from './charts'
import type { Day } from './data'

beforeAll(() => {
  globalThis.ResizeObserver = class {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) { this.cb = cb }
    observe() { this.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const day = (date: string, price: number): Day => ({
  date, price, mid: price, lo80: price - 5, hi80: price + 5, lo95: price - 10, hi95: price + 10, status: 'Normal',
} as Day)
const days = [day('2025-01-01', 100), day('2025-01-20', 102), day('2025-02-10', 101), day('2025-03-01', 100)]
const overlay = {
  label: 'কুমিল্লা সদর',
  points: [{ date: '2025-01-15', price: 104 }, { date: '2025-02-15', price: 500 }],
}

describe('BandChart district overlay', () => {
  it('draws one mark per overlay point with a month + price title', () => {
    const { container } = render(<BandChart days={days} overlay={overlay} />)
    const marks = container.querySelectorAll('.wfp-dot')
    expect(marks).toHaveLength(2)
    expect(marks[0].querySelector('title')?.textContent).toContain('কুমিল্লা সদর')
    expect(marks[0].querySelector('title')?.textContent).toContain('১০৪')
  })
  it('does not let an outlier stretch the y-axis (clamped inside the plot)', () => {
    const { container } = render(<BandChart days={days} height={280} overlay={overlay} />)
    const outlier = container.querySelectorAll('.wfp-dot')[1]
    const cy = Number(outlier.getAttribute('data-cy'))
    expect(cy).toBeGreaterThanOrEqual(0)
    expect(cy).toBeLessThanOrEqual(280)
    // axis max stays near the band, not near 500
    const ticks = Array.from(container.querySelectorAll('text')).map((t) => t.textContent)
    expect(ticks.some((t) => t === '৫০০')).toBe(false)
  })
  it('renders nothing extra without overlay', () => {
    const { container } = render(<BandChart days={days} />)
    expect(container.querySelectorAll('.wfp-dot')).toHaveLength(0)
  })
})

describe('overlay legend and note', () => {
  it('shows the legend label and honest note', () => {
    render(<><OverlayLegendItem label="কুমিল্লা সদর" /><OverlayNote hasMarkets fellBack={false} requested="কুমিল্লা সদর" label="কুমিল্লা সদর" /></>)
    expect(screen.getByText('কুমিল্লা সদর (WFP মাসিক গড়)')).toBeInTheDocument()
    expect(screen.getByText(/জেলার বিন্দুগুলো WFP-র মাসিক গড়/)).toBeInTheDocument()
  })
  it('mentions the fallback', () => {
    render(<OverlayNote hasMarkets fellBack requested="বগুড়া সদর" label="কুমিল্লা সদর" />)
    expect(screen.getByText(/বগুড়া সদর-এর এই পণ্যের WFP তথ্য নেই, কুমিল্লা সদর দেখানো হচ্ছে/)).toBeInTheDocument()
  })
  it('says there is no district data for commodities without markets', () => {
    render(<OverlayNote hasMarkets={false} fellBack={false} requested="" label="" />)
    expect(screen.getByText('এই পণ্যের জেলাভিত্তিক WFP তথ্য নেই।')).toBeInTheDocument()
  })
})
