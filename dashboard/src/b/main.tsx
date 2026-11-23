import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BandChart, RangeBar } from '../lib/charts'
import type { Commodity, Day, FPData, Tone } from '../lib/data'
import { addDays, bnDate, bnNum, bnPrice, loadData, tone } from '../lib/data'
import './style.css'

const ORDER = ['onion_local', 'egg_farm', 'potato', 'onion_import']

// plain words for shoppers
const VERDICT: Record<Tone, string> = {
  ok: 'ঠিক আছে',
  watch: 'একটু বেশি',
  alarm: 'অনেক বেশি',
  down: 'স্বাভাবিকের চেয়ে কম',
}

function weekAgo(c: Commodity): Day | undefined {
  const target = addDays(c.latest.date, -7)
  return [...c.series].reverse().find((d) => d.date <= target)
}

function Bold({ text }: { text: string }) {
  return <>{text.split('**').map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t))}</>
}

function Why({ d }: { d: Day }) {
  const steps = (d.waterfall ?? []).filter((s) => s.kind === 'step' && Math.abs(s.value) >= 0.5)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 4)
  const resid = d.waterfall?.find((s) => s.key === 'unexplained')
  return (
    <ul className="why">
      {steps.map((s) => (
        <li key={s.key}>
          <span className={`arrow ${s.value > 0 ? 'up' : 'dn'}`}>{s.value > 0 ? '↑' : '↓'}</span>
          <span>{s.label}</span>
          <span className="amt">{s.value > 0 ? '+' : '−'}{bnNum(Math.abs(s.value), 1)} ৳</span>
        </li>
      ))}
      {resid && Math.abs(resid.value) >= 0.5 && (
        <li className="resid">
          <span className="arrow">?</span>
          <span>যা ব্যাখ্যা করা যায়নি</span>
          <span className="amt">{resid.value > 0 ? '+' : '−'}{bnNum(Math.abs(resid.value), 1)} ৳</span>
        </li>
      )}
    </ul>
  )
}

function App() {
  const [data, setData] = useState<FPData | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>('onion_local')
  useEffect(() => { loadData().then(setData).catch((e) => setErr(String(e.message ?? e))) }, [])

  if (err) return <p className="loading">{err}</p>
  if (!data) return <p className="loading">দাম আনা হচ্ছে…</p>

  const latest = Object.values(data.commodities).map((x) => x.latest.date).sort().pop()!
  const keys = ORDER.filter((k) => data.commodities[k])

  return (
    <div className="board">
      <h1>আজকের বাজার</h1>
      <div className="date">ঢাকা, {bnDate(latest)}। সরকারি TCB দর</div>
      <p className="intro">দাম কি স্বাভাবিক? মৌসুম, উৎসব আর আগের দাম দেখে আমাদের হিসাবে যা হওয়ার কথা, তার সাথে মিলিয়ে দেখুন।</p>

      <div className="rows">
        {keys.map((k) => {
          const c = data.commodities[k]
          const d = c.latest
          const t = tone(d)
          const stale = d.date < latest
          const w = weekAgo(c)
          const isOpen = open === k
          return (
            <div key={k} className={`row${stale ? ' stale-row' : ''}`} style={{ ['--tone' as string]: `var(--c-${t})` }}>
              <button aria-expanded={isOpen} aria-controls={`d-${k}`} onClick={() => setOpen(isOpen ? null : k)}>
                <span className="name">{c.name_bn}</span>
                <span className="price">{bnPrice(d.price)}<small> ৳/{c.unit_bn}</small></span>
                <span className="exp">{stale ? `শেষ দর ${bnDate(d.date)}` : `হওয়ার কথা ${bnNum(d.lo80)}–${bnNum(d.hi80)} ৳`}</span>
                {!stale && <span className="verdict">{VERDICT[t]}</span>}
                {!stale && (
                  <span className="bar"><RangeBar d={d} width={150} />
                    {w ? `গত সপ্তাহে ${bnPrice(w.price)} ৳` : ''}</span>
                )}
                {!isOpen && !stale && <span className="more">কেন? দেখুন</span>}
              </button>
              {isOpen && (
                <div className="detail" id={`d-${k}`}>
                  <p><Bold text={d.text_bn ?? ''} /></p>
                  <div className="h3">গত ৩ মাস</div>
                  <BandChart days={c.series.filter((x) => x.date >= addDays(d.date, -92))} height={170} showBand95={false} />
                  <div className="h3">১৪ দিন আগে দাম ছিল {bnPrice(d.waterfall?.[0].value ?? 0)} ৳। তারপর যা যোগ-বিয়োগ হলো:</div>
                  <Why d={d} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="legend">
        <span><i style={{ background: 'var(--c-ok)' }} />ঠিক আছে: দাম প্রত্যাশিত সীমার ভেতরে</span>
        <span><i style={{ background: 'var(--c-watch)' }} />একটু বেশি: সীমার সামান্য উপরে</span>
        <span><i style={{ background: 'var(--c-alarm)' }} />অনেক বেশি: মৌসুম বা উৎসব দিয়ে ব্যাখ্যা হয় না</span>
        <span><i style={{ background: 'var(--c-down)' }} />স্বাভাবিকের চেয়ে কম: ক্রেতার জন্য চিন্তার কিছু নেই</span>
      </div>
      <p className="note">ন্যায্য দাম একটা পরিসংখ্যান মডেল। এটা দেখায় কোন দাম অস্বাভাবিক, কিন্তু কারসাজির প্রমাণ দেয় না। আমদানি করা পেঁয়াজের দর TCB ফেব্রুয়ারি ২০২৬ থেকে প্রকাশ করছে না।</p>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
