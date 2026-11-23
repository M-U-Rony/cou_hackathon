import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BandChart, Waterfall } from '../lib/charts'
import type { FPData } from '../lib/data'
import {
  EVENT_TITLE_BN, TONE_BN, addDays, bnDate, bnNum, bnPrice, loadData, tone,
} from '../lib/data'
import './style.css'

const ORDER = ['onion_local', 'egg_farm', 'potato', 'onion_import']
const RANGES = { '3m': ['৩ মাস', 92], '1y': ['১ বছর', 366], all: ['সব', 99999] } as const
type RangeKey = keyof typeof RANGES

export function Bold({ text }: { text: string }) {
  return <>{text.split('**').map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t))}</>
}

function App() {
  const [data, setData] = useState<FPData | null>(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(() => (location.hash.slice(1) in { onion_local: 1, egg_farm: 1, potato: 1, onion_import: 1 } ? location.hash.slice(1) : 'onion_local'))
  const [range, setRange] = useState<RangeKey>('1y')

  useEffect(() => { loadData().then(setData).catch((e) => setErr(String(e.message ?? e))) }, [])
  useEffect(() => {
    const on = () => { const h = location.hash.slice(1); if (ORDER.includes(h)) setSel(h) }
    addEventListener('hashchange', on); return () => removeEventListener('hashchange', on)
  }, [])

  const c = data?.commodities[sel]
  const series = useMemo(() => {
    if (!c) return []
    const from = addDays(c.latest.date, -RANGES[range][1])
    return c.series.filter((d) => d.date >= from)
  }, [c, range])

  if (err) return <p className="loading">{err}</p>
  if (!data || !c) return <p className="loading">তথ্য লোড হচ্ছে…</p>

  const latestAll = Object.values(data.commodities).map((x) => x.latest.date).sort().pop()!
  const d = c.latest
  const t = tone(d)
  const stale = d.date < latestAll
  const evs = data.events.filter((e) => e.commodity === sel)
  const markers = evs.filter((e) => series.length && e.peak >= series[0].date)
    .map((e) => ({ date: e.peak, label: 'ঘটনার পিক' }))
  const m = data.metrics.filter((x) => x.commodity === sel)
  const mm = m.find((x) => x.method === 'model')!, mb = m.find((x) => x.method === 'baseline')!

  const pick = (k: string) => { setSel(k); history.replaceState(null, '', '#' + k) }

  return (
    <>
      <header className="top">
        <div className="brand">ন্যায্য দাম <span>বাজারদর মনিটর</span></div>
        <div className="meta">উৎস: TCB দৈনিক খুচরা দর, ঢাকা। সর্বশেষ তথ্য <b>{bnDate(latestAll)}</b></div>
      </header>
      <div className="layout">
        <nav className="rail" aria-label="পণ্য">
          {ORDER.filter((k) => data.commodities[k]).map((k) => {
            const x = data.commodities[k], tt = tone(x.latest)
            return (
              <button key={k} className="item" aria-pressed={k === sel} onClick={() => pick(k)}
                style={{ ['--tone' as string]: `var(--c-${tt})` }}>
                <div className="row"><span className="name">{x.name_bn}</span>
                  <span><span className="price">{bnPrice(x.latest.price)}</span> <span className="unit">৳/{x.unit_bn}</span></span></div>
                <div className="row">
                  {x.latest.date < latestAll
                    ? <span className="stale">শেষ তথ্য {bnDate(x.latest.date)}</span>
                    : <span className="st">{TONE_BN[tt]}</span>}
                </div>
                <BandChart days={x.series.slice(-120)} height={38} compact showBand95={false} />
              </button>
            )
          })}
        </nav>

        <main className="main" style={{ ['--tone' as string]: `var(--c-${t})` }}>
          <div className="head">
            <h1>{c.name_bn}</h1>
            <div className="figure"><span className="k">আজকের দাম ({bnDate(d.date)})</span>
              <span className="v">{bnPrice(d.price)} ৳/{c.unit_bn}</span></div>
            <div className="figure"><span className="k">প্রত্যাশিত সীমা (৮০%)</span>
              <span className="v">{bnNum(d.lo80)}–{bnNum(d.hi80)} ৳</span></div>
            <div className="figure"><span className="k">অবস্থা</span><span className="pill">{TONE_BN[t]}</span></div>
          </div>
          {stale && <p className="foot">ফেব্রুয়ারি ২০২৬-এর পর TCB আমদানি করা পেঁয়াজের দাম প্রকাশ করছে না, তাই এটা শেষ পাওয়া দিনের অবস্থা।</p>}
          <p className="para"><Bold text={d.text_bn ?? ''} /></p>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>দাম বনাম প্রত্যাশিত সীমা</h2>
                <p className="sub">প্রতিটা দিনের সীমা ১৪ দিন আগের তথ্য দিয়ে বানানো, আর সেই মাসের আগের ডেটায় ট্রেন করা মডেল দিয়ে</p>
              </div>
              <div className="seg" role="group" aria-label="সময়কাল">
                {(Object.keys(RANGES) as RangeKey[]).map((k) => (
                  <button key={k} aria-pressed={range === k} onClick={() => setRange(k)}>{RANGES[k][0]}</button>
                ))}
              </div>
            </div>
            <BandChart days={series} height={300} markers={markers} />
            <div className="legend">
              <span><i style={{ background: 'var(--c-band80)' }} />৮০% সীমা</span>
              <span><i style={{ background: 'var(--c-band95)' }} />৯৫% সীমা</span>
              <span><i className="dot" style={{ background: 'var(--c-watch)' }} />নজরে রাখুন</span>
              <span><i className="dot" style={{ background: 'var(--c-alarm)' }} />অস্বাভাবিক</span>
              <span><i className="dot" style={{ background: 'var(--c-down)' }} />প্রত্যাশার চেয়ে কম</span>
            </div>
          </section>

          <div className="two">
            <section className="panel">
              <h2>আজকের দাম কীভাবে ব্যাখ্যা হয়</h2>
              <p className="sub">১৪ দিন আগের দাম থেকে শুরু, প্রতিটা উপাদানের অবদান টাকায়। শেষ লাল অংশটা মডেল ব্যাখ্যা করতে পারেনি।</p>
              {d.waterfall && <Waterfall steps={d.waterfall} />}
            </section>
            <section className="panel">
              <h2>মডেল কতটা নির্ভরযোগ্য</h2>
              <p className="sub">২০২৩ থেকে {bnNum(mm.n_days)} দিনের walk-forward পরীক্ষা, সাধারণ ৮৪ দিনের গড়ের পদ্ধতির সাথে তুলনা</p>
              <div className="cmp">
                <Cmp label="৮০% সীমার ভেতরে দাম ছিল" note="লক্ষ্য ৮০%" a={mm.coverage80 * 100} b={mb.coverage80 * 100} max={100} unit="%" />
                <Cmp label="৯৫% সীমার ভেতরে দাম ছিল" note="লক্ষ্য ৯৫%" a={mm.coverage95 * 100} b={mb.coverage95 * 100} max={100} unit="%" />
                <Cmp label="ভুল সতর্কসংকেত, প্রতি ১০০ স্বাভাবিক দিনে" note="কম হলে ভালো" a={mm.unusual_per100_normal_days} b={mb.unusual_per100_normal_days} max={35} unit="" />
              </div>
            </section>
          </div>

          {evs.length > 0 && (
            <section className="panel">
              <h2>অতীতের ঘটনায় কত আগে ধরা পড়ত</h2>
              <p className="sub">ঘটনা শুরুর ৩০ দিন আগে থেকে পিক পর্যন্ত, দাম প্রথম কবে উপরের দিকে সীমা ছাড়াল</p>
              <div className="tablewrap"><table>
                <thead><tr><th>ঘটনা</th><th>পিক</th><th>মডেলের প্রথম সংকেত</th><th>পিকের কত দিন আগে</th><th>সাধারণ পদ্ধতি</th></tr></thead>
                <tbody>{evs.map((e) => (
                  <tr key={e.event_id}>
                    <td>{EVENT_TITLE_BN[e.event_id] ?? e.description}</td>
                    <td>{bnDate(e.peak)}</td>
                    <td>{e.model?.first_flag ? bnDate(e.model.first_flag) : <span className="miss">ধরা পড়েনি</span>}</td>
                    <td className="lead">{e.model?.lead_days_to_peak != null ? `${bnNum(e.model.lead_days_to_peak)} দিন` : '—'}</td>
                    <td>{e.baseline?.lead_days_to_peak != null ? `${bnNum(e.baseline.lead_days_to_peak)} দিন` : '—'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </section>
          )}
          <p className="foot">{data.note_bn} সাধারণ পদ্ধতি কখনো আগে সংকেত দেয়, কিন্তু প্রায় চার গুণ বেশি ভুল সংকেতের বিনিময়ে।</p>
        </main>
      </div>
    </>
  )
}

function Cmp({ label, note, a, b, max, unit }: { label: string; note: string; a: number; b: number; max: number; unit: string }) {
  const row = (name: string, v: number, color: string) => (
    <div className="bar"><span>{name}</span>
      <div className="track"><div className="fill" style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }} /></div>
      <span className="n">{bnNum(v, unit ? 0 : 1)}{unit}</span></div>
  )
  return (
    <div>
      <div className="lbl">{label}<span>{note}</span></div>
      <div className="bars">{row('মডেল', a, 'var(--c-wf-total)')}{row('সাধারণ', b, 'var(--c-axis)')}</div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
