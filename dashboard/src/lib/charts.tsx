// Chart components drawn in plain SVG. Colors come from CSS custom
// properties, so each prototype themes them:
//   --c-band95 --c-band80 --c-line --c-grid --c-axis
//   --c-ok --c-watch --c-alarm --c-down --c-mark
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Day, WaterfallStep } from './data'
import { TONE_BN, bn, bnDate, bnMonthYear, bnNum, bnPrice, tone } from './data'

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)  // 0 until measured, so nothing overflows on first paint
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function niceTicks(lo: number, hi: number, n = 4) {
  const span = hi - lo || 1
  const raw = span / n
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) ?? mag * 10
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
}

/** split into runs where consecutive observations are <= maxGap days apart */
function segments(days: Day[], maxGap = 21) {
  const segs: Day[][] = []
  let cur: Day[] = []
  for (const d of days) {
    const prev = cur[cur.length - 1]
    if (prev && (Date.parse(d.date) - Date.parse(prev.date)) / 864e5 > maxGap) {
      segs.push(cur)
      cur = []
    }
    cur.push(d)
  }
  if (cur.length) segs.push(cur)
  return segs
}

export interface Marker { date: string; label: string; color?: string }

export function BandChart({
  days, height = 280, cursorDate, bandAheadDays = 0, markers = [], showDots = true,
  showBand95 = true, unit = 'টাকা', compact = false, ariaLabel, overlay,
}: {
  days: Day[]
  height?: number
  /** replay: draw price only up to this date */
  cursorDate?: string
  /** replay: the range is known this many days ahead of the price */
  bandAheadDays?: number
  markers?: Marker[]
  showDots?: boolean
  showBand95?: boolean
  unit?: string
  compact?: boolean
  ariaLabel?: string
  /** another survey's monthly points (e.g. a district), drawn as hollow diamonds; never changes the band */
  overlay?: { label: string; points: { date: string; price: number }[] }
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const pad = compact ? { l: 4, r: 4, t: 6, b: 6 } : { l: 44, r: 12, t: 22, b: 26 }

  const { x, y, yticks, y0, y1, xticks } = useMemo(() => {
    const t0 = Date.parse(days[0].date)
    const t1 = Date.parse(days[days.length - 1].date)
    const lo0 = Math.min(...days.map((d) => Math.min(d.price, showBand95 ? d.lo95 : d.lo80)))
    const hi0 = Math.max(...days.map((d) => Math.max(d.price, showBand95 ? d.hi95 : d.hi80)))
    // overlay points widen the axis only while the whole range stays within 1.5x the band's span
    const margin = (hi0 - lo0) * 0.25
    const inRange = (overlay?.points ?? []).map((p) => p.price).filter((v) => v >= lo0 - margin && v <= hi0 + margin)
    const lo = Math.min(lo0, ...inRange), hi = Math.max(hi0, ...inRange)
    const yt = niceTicks(Math.max(0, lo * 0.95), hi * 1.03)
    const y0 = Math.min(yt[0], lo), y1 = Math.max(yt[yt.length - 1], hi)
    const x = (iso: string) => pad.l + ((Date.parse(iso) - t0) / (t1 - t0 || 1)) * (width - pad.l - pad.r)
    const y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b)
    // month ticks, thinned to fit
    const months: string[] = []
    const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1)
    while (d.getTime() <= t1) { months.push(d.toISOString().slice(0, 10)); d.setUTCMonth(d.getUTCMonth() + 1) }
    const every = Math.max(1, Math.ceil(months.length / Math.max(2, Math.floor(width / 70))))
    return { x, y, yticks: yt, y0, y1, xticks: months.filter((_, i) => i % every === 0) }
  }, [days, overlay, width, height, showBand95, pad.l, pad.r, pad.t, pad.b])

  const cutBand = cursorDate ? addIso(cursorDate, bandAheadDays) : undefined
  const bandDays = cutBand ? days.filter((d) => d.date <= cutBand) : days
  const lineDays = cursorDate ? days.filter((d) => d.date <= cursorDate) : days

  const area = (seg: Day[], lo: keyof Day, hi: keyof Day) =>
    seg.length < 2 ? '' :
      'M' + seg.map((d) => `${x(d.date)},${y(d[hi] as number)}`).join('L') +
      'L' + [...seg].reverse().map((d) => `${x(d.date)},${y(d[lo] as number)}`).join('L') + 'Z'
  const line = (seg: Day[]) => seg.length < 2 ? '' : 'M' + seg.map((d) => `${x(d.date)},${y(d.price)}`).join('L')

  const last = lineDays[lineDays.length - 1]
  const hovered = !compact && hoverIdx != null && hoverIdx < lineDays.length ? lineDays[hoverIdx] : null
  const hoveredOverlay = hovered && overlay
    ? overlay.points.find((p) => p.date.slice(0, 7) === hovered.date.slice(0, 7))
    : undefined

  const pickByClientX = (clientX: number, rect: DOMRect) => {
    if (!lineDays.length || width <= 0) return
    const px = clientX - rect.left
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < lineDays.length; i++) {
      const dist = Math.abs(x(lineDays[i].date) - px)
      if (dist < bestDist) { bestDist = dist; best = i }
    }
    setHoverIdx(best)
  }

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      {!compact && (
        <div className="chart-readout" aria-live="polite">
          {hovered ? (
            <>
              <span className="cr-date">{bnDate(hovered.date)}</span>
              <span className="cr-item">ঢাকা: <b>{bnPrice(hovered.price)} ৳</b></span>
              <span className="cr-item">স্বাভাবিক সীমা: <b>{bnNum(hovered.lo80)}–{bnNum(hovered.hi80)} ৳</b></span>
              <span className="cr-badge" style={{ ['--tone' as string]: `var(--c-${tone(hovered)})` }}>
                {TONE_BN[tone(hovered)]}
              </span>
              {hoveredOverlay && (
                <span className="cr-item cr-wfp">{overlay?.label} (মাসিক গড়): <b>{bnNum(hoveredOverlay.price)} ৳</b></span>
              )}
            </>
          ) : (
            <span className="cr-hint">যেকোনো দিনের দাম ও স্বাভাবিক সীমা দেখতে চার্টে মাউস রাখুন বা ট্যাপ করুন</span>
          )}
        </div>
      )}
      <div ref={ref} style={{ width: '100%', minWidth: 0, height }}>
        {width > 0 && <svg width={width} height={height} role="img" aria-label={ariaLabel ?? 'দাম ও প্রত্যাশিত সীমা'}
          style={{ display: 'block', overflow: 'visible', touchAction: compact ? undefined : 'pan-y' }}
          onPointerMove={compact ? undefined : (e) => pickByClientX(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={compact ? undefined : (e) => pickByClientX(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={compact ? undefined : () => setHoverIdx(null)}>
          {!compact && yticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--c-grid)" strokeWidth={1} />
              <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--c-axis)"
                style={{ fontVariantNumeric: 'tabular-nums' }}>{bnNum(v)}</text>
            </g>
          ))}
          {!compact && xticks.map((m) => (
            <text key={m} x={x(m)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--c-axis)">{bnMonthYear(m)}</text>
          ))}
          {!compact && <text x={pad.l - 8} y={10} textAnchor="end" fontSize={10} fill="var(--c-axis)">{unit}</text>}

          {segments(bandDays).map((seg, i) => (
            <g key={i}>
              {showBand95 && <path d={area(seg, 'lo95', 'hi95')} fill="var(--c-band95)" />}
              <path d={area(seg, 'lo80', 'hi80')} fill="var(--c-band80)" />
            </g>
          ))}

          {markers.map((m) => (
            <g key={m.date + m.label}>
              <line x1={x(m.date)} x2={x(m.date)} y1={pad.t} y2={height - pad.b}
                stroke={m.color ?? 'var(--c-mark)'} strokeDasharray="4 3" strokeWidth={1.2} />
              {!compact && <text x={x(m.date) + 4} y={pad.t + 10} fontSize={11} fill={m.color ?? 'var(--c-mark)'}>{m.label}</text>}
            </g>
          ))}

          {segments(lineDays).map((seg, i) => (
            <path key={i} d={line(seg)} fill="none" stroke="var(--c-line)" strokeWidth={compact ? 1.4 : 1.8}
              strokeLinejoin="round" strokeLinecap="round" />
          ))}

          {showDots && lineDays.filter((d) => d.status !== 'Normal').map((d) => (
            <circle key={d.date} cx={x(d.date)} cy={y(d.price)} r={compact ? 1.8 : 3}
              fill={`var(--c-${tone(d)})`} />
          ))}
          {overlay?.points.map((p) => {
            const cx = x(p.date)
            // outliers are pinned to the plot edge; the title still states the true price
            const cy = Math.min(height - pad.b, Math.max(pad.t, y(Math.min(y1, Math.max(y0, p.price)))))
            const r = 4.5
            return (
              <g key={p.date} className="wfp-dot" data-cy={cy}>
                <title>{`${overlay.label}, ${bnMonthYear(p.date)} (WFP মাসিক গড়): ${bnNum(p.price)} ৳`}</title>
                <polygon points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
                  fill="var(--panel, #fff)" stroke="var(--c-wf-up)" strokeWidth={1.8} />
              </g>
            )
          })}
          {last && (
            <circle cx={x(last.date)} cy={y(last.price)} r={compact ? 2.6 : 4.5}
              fill={`var(--c-${tone(last)})`} stroke="var(--c-line)" strokeWidth={compact ? 1 : 1.5} />
          )}
          {hovered && (
            <g pointerEvents="none">
              <line x1={x(hovered.date)} x2={x(hovered.date)} y1={pad.t} y2={height - pad.b}
                stroke="var(--c-axis)" strokeDasharray="3 3" strokeWidth={1.2} />
              <circle cx={x(hovered.date)} cy={y(hovered.price)} r={6}
                fill={`var(--c-${tone(hovered)})`} stroke="var(--c-line)" strokeWidth={2} />
            </g>
          )}
        </svg>}
      </div>
    </div>
  )
}

export function OverlayLegendItem({ label }: { label: string }) {
  return <span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ marginRight: 5, verticalAlign: 'middle' }}>
    <polygon points="6,1 11,6 6,11 1,6" fill="none" stroke="var(--c-wf-up)" strokeWidth="1.8" /></svg>{label} (WFP মাসিক গড়)</span>
}

export function OverlayNote({ hasMarkets, fellBack, requested, label }: {
  hasMarkets: boolean; fellBack: boolean; requested: string; label: string
}) {
  if (!hasMarkets) return <p className="muted-note">এই পণ্যের জেলাভিত্তিক WFP তথ্য নেই।</p>
  return (
    <>
      {fellBack && <p className="muted-note" role="status">{requested}-এর এই পণ্যের WFP তথ্য নেই, {label} দেখানো হচ্ছে</p>}
      <p className="muted-note">জেলার বিন্দুগুলো WFP-র মাসিক গড়, আলাদা জরিপ; ঢাকার প্রত্যাশিত সীমা দিয়ে জেলার দাম বিচার করা হয় না।</p>
    </>
  )
}

function addIso(iso: string, n: number) {
  return new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10)
}

/** Horizontal waterfall in Taka. Rows read top to bottom like a receipt. */
export function Waterfall({ steps, english = false, rowH = 30 }: {
  steps: WaterfallStep[]; english?: boolean; rowH?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const labelW = Math.min(170, width * 0.42)
  const valW = 56
  const plotW = width - labelW - valW - 8

  let cur = 0
  const rows = steps.map((s) => {
    let from: number, to: number
    if (s.kind === 'start' || s.kind === 'total') { from = 0; to = s.value; cur = s.value }
    else { from = cur; to = cur + s.value; cur = to }
    return { s, from, to }
  })
  const max = Math.max(...rows.map((r) => Math.max(r.from, r.to))) * 1.04
  const sx = (v: number) => labelW + (v / max) * plotW
  const color = (s: WaterfallStep) =>
    s.kind === 'start' || s.kind === 'total' ? (s.key === 'actual' ? 'var(--c-line)' : 'var(--c-wf-total)')
      : s.kind === 'residual' ? 'var(--c-wf-resid)'
        : s.value >= 0 ? 'var(--c-wf-up)' : 'var(--c-wf-down)'

  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0 }}>
      {width > 0 && <svg width={width} height={rows.length * rowH + 4} role="img" aria-label="প্রত্যাশিত দাম কীভাবে তৈরি হলো">
        {rows.map(({ s, from, to }, i) => {
          const yy = i * rowH + 2
          const isTotal = s.kind === 'start' || s.kind === 'total'
          const tiny = Math.abs(sx(to) - sx(from)) < 2
          return (
            <g key={s.key}>
              <text x={0} y={yy + rowH / 2} dy="0.35em" fontSize={12.5}
                fontWeight={isTotal ? 600 : 400} fill="var(--c-text, currentColor)">
                {english ? s.label_en : s.label}
              </text>
              <rect x={Math.min(sx(from), sx(to))} y={yy + 6} height={rowH - 12} rx={2}
                width={Math.max(tiny ? 2 : 0, Math.abs(sx(to) - sx(from)))} fill={color(s)} />
              {i > 0 && !isTotal && (
                <line x1={sx(from)} x2={sx(from)} y1={yy - 6} y2={yy + 6} stroke="var(--c-grid)" />
              )}
              <text x={width - 2} y={yy + rowH / 2} dy="0.35em" fontSize={12.5} textAnchor="end"
                fill="var(--c-text, currentColor)" style={{ fontVariantNumeric: 'tabular-nums' }}
                fontWeight={isTotal ? 600 : 400}>
                {isTotal ? bnNum(s.value, s.value % 1 ? 1 : 0) : (s.value >= 0 ? '+' : '−') + bnNum(Math.abs(s.value), 1)}
              </text>
            </g>
          )
        })}
      </svg>}
    </div>
  )
}

/** Small position bar: where today's price sits in the expected range. */
export function RangeBar({ d, width = 160 }: { d: Day; width?: number }) {
  const lo = Math.min(d.lo95, d.price), hi = Math.max(d.hi95, d.price)
  const s = (v: number) => 6 + ((v - lo) / (hi - lo || 1)) * (width - 12)
  return (
    <svg width={width} height={22} aria-hidden="true" style={{ display: 'block' }}>
      <rect x={s(d.lo95)} y={9} width={s(d.hi95) - s(d.lo95)} height={4} rx={2} fill="var(--c-band95)" />
      <rect x={s(d.lo80)} y={7} width={s(d.hi80) - s(d.lo80)} height={8} rx={3} fill="var(--c-band80)" />
      <circle cx={s(d.price)} cy={11} r={5.5} fill={`var(--c-${tone(d)})`} stroke="var(--c-line)" strokeWidth={1.2} />
    </svg>
  )
}

export interface LineSeries { key: string; label: string; color: string; values: (number | null)[]; dashed?: boolean }

/** Monthly lines (+ optional band) on one scale. Gaps stay gaps. */
export function MultiLine({ x, series, band, height = 220, unit = 'টাকা', digits = 0 }: {
  x: string[]; series: LineSeries[]; band?: { lo: (number | null)[]; hi: (number | null)[]; label: string }
  height?: number; unit?: string; digits?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const pad = { l: 48, r: 12, t: 14, b: 26 }
  const vals = [...series.flatMap((s) => s.values), ...(band ? [...band.lo, ...band.hi] : [])]
    .filter((v): v is number => v != null)
  const lo = Math.min(...vals), hi = Math.max(...vals)
  const yt = niceTicks(lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.05)
  const y0 = Math.min(yt[0], lo), y1 = Math.max(yt[yt.length - 1], hi)
  const sx = (i: number) => pad.l + (i / Math.max(1, x.length - 1)) * (width - pad.l - pad.r)
  const sy = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b)
  const path = (v: (number | null)[]) => {
    let d = '', pen = false
    v.forEach((p, i) => { if (p == null) { pen = false; return } d += `${pen ? 'L' : 'M'}${sx(i)},${sy(p)}`; pen = true })
    return d
  }
  const area = band ? (() => {
    const idx = x.map((_, i) => i).filter((i) => band.lo[i] != null && band.hi[i] != null)
    if (idx.length < 2) return ''
    return 'M' + idx.map((i) => `${sx(i)},${sy(band.hi[i]!)}`).join('L') + 'L' +
      [...idx].reverse().map((i) => `${sx(i)},${sy(band.lo[i]!)}`).join('L') + 'Z'
  })() : ''
  const every = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(width / 80))))
  return (
    <div ref={ref} style={{ width: '100%', minWidth: 0, height }}>
      {width > 0 && <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(', ')}>
        {yt.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={sy(v)} y2={sy(v)} stroke="var(--c-grid)" />
            <text x={pad.l - 8} y={sy(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--c-axis)">{bnNum(v, digits)}</text>
          </g>
        ))}
        <text x={pad.l - 8} y={pad.t - 4} textAnchor="end" fontSize={10} fill="var(--c-axis)">{unit}</text>
        {x.map((m, i) => i % every === 0 && (
          <text key={m} x={sx(i)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--c-axis)">{bnMonthYear(m + '-01')}</text>
        ))}
        {area && <path d={area} fill="var(--c-band80)" />}
        {series.map((s) => (
          <g key={s.key}>
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5 4' : undefined} />
            {s.values.map((v, i) => v != null && <circle key={i} cx={sx(i)} cy={sy(v)} r={2.4} fill={s.color} />)}
          </g>
        ))}
      </svg>}
    </div>
  )
}

export { bn }
