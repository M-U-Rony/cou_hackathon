import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BandChart, Waterfall } from '../lib/charts'
import type { FPData, FPEvent } from '../lib/data'
import { fairEventLead } from '../lib/data'
import { EVENT_TITLE_BN, TONE_BN, bnDate, bnNum, bnPrice, daysBetween, loadData, tone } from '../lib/data'
import './style.css'

const SPEEDS = [1, 2, 4]
const hashOf = (id: string) => id.replace(/_/g, '-')

function Bold({ text }: { text: string }) {
  return <>{text.split('**').map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t))}</>
}

function Replay({ data, ev }: { data: FPData; ev: FPEvent }) {
  const c = data.commodities[ev.commodity]
  const days = ev.days
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(2)

  useEffect(() => { setI(0); setPlaying(false) }, [ev.event_id])
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => setI((x) => {
      if (x >= days.length - 1) { setPlaying(false); return x }
      return x + 1
    }), 520 / speed)
    return () => clearInterval(id)
  }, [playing, speed, days.length])

  const step = useCallback((n: number) => { setPlaying(false); setI((x) => Math.max(0, Math.min(days.length - 1, x + n))) }, [days.length])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.key !== ' ') return
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => (i >= days.length - 1 ? (setI(0), true) : !p)) }
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    addEventListener('keydown', on); return () => removeEventListener('keydown', on)
  }, [step, i, days.length])

  const d = days[i]
  const t = tone(d)
  const flag = ev.model?.first_flag ?? null
  const flagged = !!flag && d.date >= flag
  const toPeak = daysBetween(d.date, ev.peak)
  const markers = [
    { date: ev.peak, label: 'পিক', color: 'var(--c-alarm)' },
    ...(flagged ? [{ date: flag!, label: 'প্রথম সংকেত', color: 'var(--c-watch)' }] : []),
  ]
  const pos = (date: string) => {
    const k = days.findIndex((x) => x.date >= date)
    return `${((k < 0 ? days.length - 1 : k) / (days.length - 1)) * 100}%`
  }

  return (
    <>
      <main className="stage" style={{ ['--tone' as string]: `var(--c-${t})` }}>
        <section className="left">
          <h1 className="headline">{EVENT_TITLE_BN[ev.event_id] ?? ev.description}</h1>
          <div className="now">
            <span className="date">{bnDate(d.date)}</span>
            <span className="price">{c.name_bn} {bnPrice(d.price)} <small>৳/{c.unit_bn}</small></span>
            <span className="count">{toPeak > 0 ? `পিকের আর ${bnNum(toPeak)} দিন বাকি` : toPeak === 0 ? 'আজ পিক' : `পিকের ${bnNum(-toPeak)} দিন পর`}</span>
          </div>
          <div className="chartbox">
            <BandChart days={days} height={330} cursorDate={d.date} bandAheadDays={data.horizon_days} markers={markers} />
            <div className="legend">
              <span><i style={{ background: 'var(--c-band80)' }} />প্রত্যাশিত সীমা, ১৪ দিন আগেই জানা</span>
              <span><i style={{ background: 'var(--c-line)', height: 2 }} />TCB দাম</span>
            </div>
          </div>
        </section>

        <aside className="right">
          <div className="lamp" aria-live="polite">
            <div className="bulb" aria-hidden="true" />
            <div>
              <div className="st">{TONE_BN[t]}</div>
              <div className="sub">প্রত্যাশিত {bnNum(d.lo80)}–{bnNum(d.hi80)} ৳, আসল {bnPrice(d.price)} ৳</div>
            </div>
          </div>
          {flagged && ev.model?.lead_days_to_peak != null && (
            <div className="callout">
              <b>প্রথম সংকেত {bnDate(flag!)}, পিকের {bnNum(ev.model.lead_days_to_peak)} দিন আগে</b>
              <span>সাধারণ ৮৪ দিনের গড়ের পদ্ধতি: {ev.baseline?.lead_days_to_peak != null ? `${bnNum(ev.baseline.lead_days_to_peak)} দিন আগে, কিন্তু স্বাভাবিক সময়ে প্রায় চার গুণ বেশি ভুল সংকেত দেয়` : 'ধরতে পারেনি'}</span>
              {(() => {
                const fl = fairEventLead(data.fair_compare, ev.event_id, 2)
                if (fl && fl.model == null && fl.baseline == null) return <span className="fair">সমান ভুল-সংকেতে (প্রতি ১০০ স্বাভাবিক দিনে ২টা): দুই পদ্ধতির কেউই আগে ধরেনি</span>
                return fl && <span className="fair">সমান ভুল-সংকেতে (প্রতি ১০০ স্বাভাবিক দিনে ২টা): মডেল {fl.model != null ? `${bnNum(fl.model)} দিন আগে` : 'ধরেনি'}, সাধারণ পদ্ধতি {fl.baseline != null ? `${bnNum(fl.baseline)} দিন আগে` : 'ধরেনি'}</span>
              })()}
            </div>
          )}
          <p className="para"><Bold text={d.text_bn ?? ''} /></p>
          {d.waterfall && (
            <div className="panel">
              <h2>এই দিনের দাম, টাকায় ভাঙা</h2>
              <Waterfall steps={d.waterfall} rowH={26} />
            </div>
          )}
        </aside>
      </main>

      <div>
        <div className="transport">
          <button className="btn" onClick={() => step(-1)} aria-label="এক দিন পেছনে">◀</button>
          <button className="btn play" onClick={() => { if (i >= days.length - 1) setI(0); setPlaying(!playing) }}>
            {playing ? 'থামান' : i >= days.length - 1 ? 'আবার চালান' : 'চালান'}
          </button>
          <button className="btn" onClick={() => step(1)} aria-label="এক দিন সামনে">▶</button>
          <div className="track">
            {flag && <span className="tick flag" style={{ left: pos(flag) }}>সংকেত</span>}
            <span className="tick" style={{ left: pos(ev.peak) }}>পিক</span>
            <input id="scrub" type="range" min={0} max={days.length - 1} value={i} aria-label="তারিখ বেছে নিন"
              onChange={(e) => { setPlaying(false); setI(+e.target.value) }} />
          </div>
          <div className="speed" role="group" aria-label="গতি">
            {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{bnNum(s)}×</button>)}
          </div>
        </div>
        <div className="hint">স্পেস দিয়ে চালু/বন্ধ, তীরচিহ্ন দিয়ে এক দিন করে। প্রতিটা দিনের সীমা আর ব্যাখ্যা শুধু সেই দিনের আগের তথ্য দিয়ে বানানো।</div>
      </div>
    </>
  )
}

function App() {
  const [data, setData] = useState<FPData | null>(null)
  const [err, setErr] = useState('')
  const [id, setId] = useState('')
  useEffect(() => { loadData().then(setData).catch((e) => setErr(String(e.message ?? e))) }, [])
  const events = useMemo(() => data?.events ?? [], [data])
  useEffect(() => {
    if (!events.length) return
    const fromHash = () => {
      const h = location.hash.slice(1)
      const e = events.find((x) => hashOf(x.event_id) === h)
      setId((e ?? events[0]).event_id)
    }
    fromHash()
    addEventListener('hashchange', fromHash); return () => removeEventListener('hashchange', fromHash)
  }, [events])

  if (err) return <p className="loading">{err}</p>
  if (!data || !id) return <p className="loading">রিপ্লে লোড হচ্ছে…</p>
  const ev = events.find((e) => e.event_id === id)!

  return (
    <div className="app">
      <nav className="chips" aria-label="ঘটনা">
        <a className="brand" href="./index.html">ন্যায্য দাম রিপ্লে</a>
        {events.map((e) => (
          <button key={e.event_id} className="chip" aria-pressed={e.event_id === id}
            onClick={() => { setId(e.event_id); history.replaceState(null, '', '#' + hashOf(e.event_id)) }}>
            {EVENT_TITLE_BN[e.event_id] ?? e.event_id}
          </button>
        ))}
      </nav>
      <Replay data={data} ev={ev} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
