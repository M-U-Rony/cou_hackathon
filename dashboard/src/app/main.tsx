// FairPrice BD app: monitor depth (prototype A) + plain words (prototype B).
// Desktop: product rail + detail. Phone (<900px): board list, tap -> detail.
// URL hash = selected product (#onion-local), so a detail view can be shared.
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BandChart, MultiLine, OverlayLegendItem, OverlayNote, RangeBar, Waterfall } from '../lib/charts'
import type { Commodity, Day, FairRow, FPData, MarketData, SpreadData, Tone } from '../lib/data'
import {
  EVENT_TITLE_BN, SURGE_BN, TONE_BN, TONE_HELP, TRUST_BN, addDays, fairAt, fairEventLead, bnDate, bnMonthYear, bnNum, bnPrice, isEmerging, loadData, plain, tone,
} from '../lib/data'
import { DEFAULT_DISTRICT, allDistricts, districtOverlay, marketLabel, resolveDistrict } from '../lib/markets'
import { checkAvailable, localRange } from '../lib/localcheck'
import { MarketPicker } from './MarketPicker'
import { LocalCheck } from './LocalCheck'
import type { AiSummary, Health } from '../lib/ai'
import { aiHealth, aiSummary, prefetchAudio, speak, stopSpeaking } from '../lib/ai'
import { fetchSession, logoutSession, saveUserPreferences, type AuthUser } from '../lib/auth'
import './style.css'

const ORDER = ['egg_farm', 'green_chili', 'potato', 'onion_local']
const RANGES = { '3m': ['৩ মাস', 92], '1y': ['১ বছর', 366], all: ['সব', 99999] } as const
type RangeKey = keyof typeof RANGES
const toHash = (k: string) => k.replace(/_/g, '-')
// Hosted inside a sandboxed frame (claude.ai artifact) downloads and print are
// blocked, so those buttons only appear on the app's own deployment.
const CAN_DOWNLOAD = (() => { try { return window.self === window.top } catch { return false } })()

function downloadCsv(c: Commodity, k: string) {
  const head = 'date,price_tk,expected_low80,expected_high80,expected_low95,expected_high95,verdict,surge_stage,data_trust'
  const rows = c.series.map((d) => [d.date, d.price, d.lo80, d.hi80, d.lo95, d.hi95, TONE_BN[tone(d)], d.surge_stage ?? 'none', d.data_trust ?? 'high'].join(','))
  const blob = new Blob(['\ufeff' + [head, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `fairprice_${k}_${c.latest.date}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
const DISTRICT_KEY = 'fairprice.district'
const readDistrict = () => { try { return localStorage.getItem(DISTRICT_KEY) || DEFAULT_DISTRICT } catch { return DEFAULT_DISTRICT } }
const saveDistrict = (k: string) => { try { localStorage.setItem(DISTRICT_KEY, k) } catch { /* private mode: keep it in memory only */ } }
const fromHash = () => location.hash.slice(1).replace(/-/g, '_')

function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const mq = matchMedia(q); const on = () => setM(mq.matches)
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

function Bold({ text }: { text: string }) {
  return <>{text.split('**').map((t, i) => (i % 2 ? <strong key={i}>{t}</strong> : t))}</>
}

const weekAgo = (c: Commodity): Day | undefined => {
  const target = addDays(c.latest.date, -7)
  return [...c.series].reverse().find((d) => d.date <= target)
}

function Item({ k, c, current, stale, onPick }: {
  k: string; c: Commodity; current: boolean; stale: boolean; onPick: (k: string) => void
}) {
  const d = c.latest, t = tone(d), w = weekAgo(c)
  return (
    <button className={`item${stale ? ' stale' : ''}`} aria-current={current} onClick={() => onPick(k)}
      style={{ ['--tone' as string]: `var(--c-${t})` }}>
      <span className="name">{c.name_bn}</span>
      <span className="price">{bnPrice(d.price)}<small> ৳/{c.unit_bn}</small></span>
      {stale
        ? <span className="wk" style={{ justifySelf: 'start', gridColumn: '1 / -1' }}>TCB শেষ দর দিয়েছে {bnDate(d.date)}</span>
        : <>
          <span className="verdict">
            {TONE_BN[t]}
            {isEmerging(d) && <span className="surge-chip">▲ আগাম চাপ</span>}
          </span>
          <span className="wk">{w ? `গত সপ্তাহে ${bnPrice(w.price)} ৳` : ''}</span>
          <span className="rb"><RangeBar d={d} width={170} /></span>
        </>}
    </button>
  )
}

function Why({ d }: { d: Day }) {
  const steps = (d.waterfall ?? []).filter((s) => s.kind === 'step' && Math.abs(s.value) >= 0.5)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 4)
  const resid = d.waterfall?.find((s) => s.key === 'unexplained')
  const sign = (v: number) => (v > 0 ? '+' : '−') + bnNum(Math.abs(v), 1) + ' ৳'
  return (
    <ul className="why">
      {steps.map((s) => (
        <li key={s.key}><span className={`ar ${s.value > 0 ? 'up' : 'dn'}`}>{s.value > 0 ? '↑' : '↓'}</span>
          <span>{s.label}</span><span className="amt">{sign(s.value)}</span></li>
      ))}
      {resid && Math.abs(resid.value) >= 0.5 && (
        <li className="resid"><span className="ar">?</span><span>যা ব্যাখ্যা করা যায়নি</span><span className="amt">{sign(resid.value)}</span></li>
      )}
    </ul>
  )
}

function Cmp({ label, note, a, b, max, unit }: { label: string; note: string; a: number; b: number; max: number; unit: string }) {
  const row = (name: string, v: number, color: string) => (
    <div className="bar"><span>{name}</span>
      <div className="track"><div className="fill" style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }} /></div>
      <span className="n">{bnNum(v, unit ? 0 : 1)}{unit}</span></div>
  )
  return (
    <div><div className="lbl">{label}<span>{note}</span></div>
      <div className="bars">{row('মডেল', a, 'var(--c-wf-total)')}{row('সাধারণ', b, 'var(--c-axis)')}</div></div>
  )
}

/** F5 extras: listen, and an AI rewrite whose numbers are checked on the server. */
function SummaryBlock({ d, k, health }: { d: Day; k: string; health: Health }) {
  const [copied, setCopied] = useState(false)
  const [ai, setAi] = useState<AiSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const playRun = useRef(0)
  useEffect(() => {
    playRun.current += 1
    setCopied(false); setAi(null); setMsg(''); stopSpeaking(); setAudioState('idle')
  }, [k, d.date])
  useEffect(() => () => { playRun.current += 1; stopSpeaking() }, [])

  const shown = ai?.ai ? ai.text : plain(d.text_bn)
  const variant: 'template' | 'ai' = ai?.ai ? 'ai' : 'template'
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${shown}\nন্যায্য দাম, উৎস: TCB`); setCopied(true) } catch { setCopied(false) }
  }
  const askAi = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await aiSummary(k, d.date)
      setAi(r)
      if (!r.ai) setMsg(r.note?.startsWith('number_check')
        ? 'AI-র লেখায় এমন সংখ্যা ছিল যা মডেলে নেই, তাই মডেলের নিজের লেখাই রাখা হলো।'
        : 'AI সারাংশ এখন পাওয়া যায়নি, মডেলের নিজের লেখাই দেখানো হচ্ছে।')
    } catch (e) { setMsg(`AI সারাংশ পাওয়া যায়নি: ${(e as Error).message}`) }
    setBusy(false)
  }
  const listen = async () => {
    if (audioState !== 'idle') {
      playRun.current += 1
      stopSpeaking()
      setAudioState('idle')
      return
    }
    const run = ++playRun.current
    setAudioState('loading'); setMsg('')
    const r = await speak({
      text: shown, commodity: k, date: d.date, variant, server: health.tts,
      onPlay: () => { if (run === playRun.current) setAudioState('playing') },
      onEnd: () => { if (run === playRun.current) setAudioState('idle') },
    })
    if (run !== playRun.current) return
    if (r !== 'played') {
      setAudioState('idle')
      setMsg(r === 'no-voice'
        ? 'এই ব্রাউজারে বাংলা ভয়েস নেই। Android-এ Chrome, বা সার্ভারে ভয়েস key দিলে শোনা যাবে।'
        : 'শোনানো গেল না, আবার চেষ্টা করুন।')
    }
  }

  return (
    <div className="summary">
      {ai?.ai
        ? <div className="ai-box"><p className="para">{ai.text}</p>
            <p className="ai-note">AI দিয়ে সহজ করে লেখা ({ai.model})। প্রতিটা সংখ্যা মডেলের সাথে মিলিয়ে দেখা হয়েছে।</p></div>
        : <p className="para"><Bold text={d.text_bn ?? ''} /></p>}
      <div className="actions">
        <button className="copy" onClick={copy}>{copied ? 'কপি হয়েছে' : 'সারাংশ কপি করুন'}</button>
        <button
          className="ghost"
          onClick={listen}
          onMouseEnter={() => prefetchAudio({ commodity: k, date: d.date, variant, server: health.tts })}
          onFocus={() => prefetchAudio({ commodity: k, date: d.date, variant, server: health.tts })}
          aria-pressed={audioState !== 'idle'}
        >
          {audioState === 'playing' ? 'থামান' : audioState === 'loading' ? 'চালু হচ্ছে…' : 'শুনুন'}
        </button>
        {health.llm && !ai?.ai && (
          <button className="ghost" onClick={askAi} disabled={busy}>{busy ? 'লেখা হচ্ছে…' : 'AI দিয়ে আরও সহজ করে'}</button>
        )}
        {ai?.ai && <button className="ghost" onClick={() => setAi(null)}>মডেলের মূল লেখা</button>}
      </div>
      {msg && <p className="ai-note" role="status">{msg}</p>}
    </div>
  )
}

/** F8: same product in other markets, all three lines from WFP's monthly survey. */
function MarketPanel({ m, unit, district }: { m: MarketData; unit: string; district: string }) {
  const districtKeys = Object.keys(m.districts ?? {})
  const activeKey = resolveDistrict(district, districtKeys)
  const dist = activeKey ? m.districts?.[activeKey] : undefined
  const distLabel = dist ? marketLabel(dist.name) : marketLabel(DEFAULT_DISTRICT)
  // chosen place has no data for this product (without districts the panel itself shows Comilla)
  const fellBack = !districtKeys.includes(district) && !(districtKeys.length === 0 && district === DEFAULT_DISTRICT)

  const rows = m.months.filter((x) => {
    const dv = dist ? (dist.prices[x.month] ?? null) : x.comilla
    return x.national != null || x.dhaka != null || dv != null
  })
  const distValues = rows.map((r) => (dist ? (dist.prices[r.month] ?? null) : r.comilla))
  const lastIdx = rows.map((r, i) => (r.dhaka != null && distValues[i] != null ? i : -1)).filter((i) => i >= 0).pop()
  const pct = dist ? dist.vs_dhaka_pct : m.comilla_vs_dhaka_pct
  const overlap = dist ? dist.overlap_months : m.overlap_months

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>ঢাকা বনাম {distLabel} বনাম সারা দেশ</h2>
          <p className="sub">WFP-র মাসিক খুচরা দর (একই জরিপ, তাই তুলনাযোগ্য); সারা দেশ = সেই মাসে জরিপ করা সব বাজারের মধ্যমা। একক: {m.unit_note}</p>
        </div>
      </div>
      {fellBack && <p className="muted-note" role="status">{marketLabel(district)}-এর এই পণ্যের WFP তথ্য নেই, {distLabel} দেখানো হচ্ছে</p>}
      <MultiLine x={rows.map((r) => r.month)} unit={unit}
        series={[
          { key: 'dhaka', label: 'ঢাকা সদর', color: 'var(--c-wf-total)', values: rows.map((r) => r.dhaka) },
          { key: 'district', label: distLabel, color: 'var(--c-wf-up)', values: distValues },
          { key: 'national', label: 'সারা দেশের মধ্যমা', color: 'var(--c-axis)', values: rows.map((r) => r.national), dashed: true },
        ]} />
      <div className="legend">
        <span><i style={{ background: 'var(--c-wf-total)' }} />ঢাকা সদর</span>
        <span><i style={{ background: 'var(--c-wf-up)' }} />{distLabel}</span>
        <span><i style={{ background: 'var(--c-axis)' }} />সারা দেশের মধ্যমা</span>
      </div>
      <p className="para small-para">
        {lastIdx != null && <>{bnMonthYear(rows[lastIdx].month + '-01')}-এ ঢাকায় {bnNum(rows[lastIdx].dhaka!)} ৳, {distLabel}-এ {bnNum(distValues[lastIdx]!)} ৳। </>}
        {pct != null && <>{bnNum(overlap)} মাসের মধ্যমায় {distLabel} ঢাকার চেয়ে {bnNum(Math.abs(pct))}% {pct < 0 ? 'সস্তা' : 'দামি'}।</>}
      </p>
    </section>
  )
}

/** F7: retail / wholesale ratio for Dhaka (AgriPriceBD), with its usual range. */
function SpreadPanel({ s }: { s: SpreadData }) {
  const L = s.latest
  return (
    <section className="panel">
      <h2>পাইকারি থেকে খুচরায় দাম কতটা বাড়ে</h2>
      <p className="sub">ঢাকা, খুচরা ÷ পাইকারি দাম, AgriPriceBD (DAM) দৈনিক তথ্য। ছায়া = আগের এক বছরের সাধারণ সীমা (১০–৯০%)। তথ্য {bnDate(s.until)} পর্যন্ত।</p>
      <MultiLine x={s.months.map((r) => r.month)} unit="গুণ" digits={2}
        band={{ lo: s.months.map((r) => r.p10), hi: s.months.map((r) => r.p90), label: 'সাধারণ সীমা' }}
        series={[{ key: 'ratio', label: 'খুচরা ÷ পাইকারি', color: 'var(--c-wf-total)', values: s.months.map((r) => r.ratio) }]} />
      <p className="para small-para">
        সাধারণত খুচরা দাম পাইকারির {bnNum(s.typical_ratio, 2)} গুণ। শেষ দিনে ({bnDate(L.date)}) পাইকারি {bnPrice(L.wholesale)} ৳, খুচরা {bnPrice(L.retail)} ৳, অনুপাত {bnNum(L.ratio, 2)}: {L.flag ? 'সাধারণ সীমার উপরে' : 'সাধারণ সীমার ভেতরে'}।
        মোট {bnNum(s.days)} দিনের {bnNum(s.flagged_days)} দিন ব্যবধান অস্বাভাবিক বেশি ছিল।
      </p>
    </section>
  )
}

function Detail({ data, k, desktop, latestAll, onBack, health, district, user, onToggleWatch }: {
  data: FPData; k: string; desktop: boolean; latestAll: string; onBack: () => void; health: Health; district: string
  user: AuthUser | null; onToggleWatch: (k: string) => void
}) {
  const c = data.commodities[k]
  const d = c.latest
  const t: Tone = tone(d)
  const stale = d.date < latestAll
  const [range, setRange] = useState<RangeKey>(desktop ? '1y' : '3m')

  const series = useMemo(() => {
    const from = addDays(d.date, -RANGES[range][1])
    return c.series.filter((x) => x.date >= from)
  }, [c, d.date, range])
  const overlay = useMemo(
    () => series.length ? districtOverlay(data.markets?.[k], district, series[0].date, series[series.length - 1].date) : null,
    [data.markets, k, district, series])
  const evs = data.events.filter((e) => e.commodity === k)
  const markers = evs.filter((e) => series.length && e.peak >= series[0].date).map((e) => ({ date: e.peak, label: 'ঘটনার পিক' }))
  const mm = data.metrics.find((x) => x.commodity === k && x.method === 'model')
  const mb = data.metrics.find((x) => x.commodity === k && x.method === 'baseline')

  const market = data.markets?.[k]
  const distKeys = Object.keys(market?.districts ?? {})
  const activeDistKey = resolveDistrict(district, distKeys)
  const distEntry = activeDistKey ? market?.districts?.[activeDistKey] : undefined
  const distHasData = distKeys.includes(district)
  const distRange = distEntry?.ratio && checkAvailable(d.date, latestAll, distEntry)
    ? localRange(d, distEntry.ratio)
    : null

  return (
    <main className="main" style={{ ['--tone' as string]: `var(--c-${t})` }}>
      {!desktop && <button className="back" onClick={onBack}>← সব পণ্য</button>}
      <div className="head">
        <h1>{c.name_bn}</h1>
        <div className="figure"><span className="k">ঢাকার {stale ? 'শেষ দাম' : 'আজকের দাম'} (TCB · {bnDate(d.date)})</span>
          <span className="v">{bnPrice(d.price)} ৳/{c.unit_bn}</span></div>
        <div className="figure"><span className="k">ঢাকার স্বাভাবিক সীমা</span>
          <span className="v">{bnNum(d.lo80)}–{bnNum(d.hi80)} ৳</span></div>
        {distRange && (
          <div className="figure figure-district">
            <span className="k">{marketLabel(activeDistKey)} (আনুমানিক সীমা)</span>
            <span className="v">{bnNum(distRange.lo80)}–{bnNum(distRange.hi80)} ৳</span>
          </div>
        )}
        <span className="pill">{TONE_BN[t]}</span>
        {user ? (
          <button
            type="button"
            className="watch-btn"
            aria-pressed={user.watchlist.includes(k)}
            onClick={() => onToggleWatch(k)}
          >
            {user.watchlist.includes(k) ? '★ ওয়াচলিস্টে আছে' : '☆ ওয়াচলিস্টে রাখুন'}
          </button>
        ) : (
          <a className="watch-btn" href="./login.html">☆ ওয়াচলিস্টে রাখুন</a>
        )}
      </div>
      <p className="help">{stale ? 'ফেব্রুয়ারি ২০২৬-এর পর TCB এই পণ্যের দর প্রকাশ করছে না, তাই এটা শেষ পাওয়া দিনের অবস্থা।' : TONE_HELP[t]}</p>
      <div className="signal-strip" aria-label="আগাম চাপ ও তথ্যের মান">
        <span className={`sig-pill sig-${d.surge_stage ?? 'none'}`}>
          {isEmerging(d) ? '▲ ' : ''}{SURGE_BN[d.surge_stage ?? 'none']}
          {d.surge_score != null && <> · চাপ সূচক {bnNum(Math.round(d.surge_score * 100))}%</>}
        </span>
        <span className={`sig-pill trust-${d.data_trust ?? 'high'}`}>
          ডেটা মান: {TRUST_BN[d.data_trust ?? 'high']}
        </span>
        {d.trust_note_bn && <span className="sig-note">{d.trust_note_bn}</span>}
      </div>
      {market && !distHasData && (
        <p className="district-fallback-note" role="status">
          {marketLabel(district)}-এর এই পণ্যের WFP জেলা তথ্য নেই — ঢাকার দৈনিক মডেল{activeDistKey ? ` ও ${marketLabel(activeDistKey)}-এর তথ্য` : ''} দেখানো হচ্ছে।
        </p>
      )}

      <SummaryBlock d={d} k={k} health={health} />
      {CAN_DOWNLOAD && (
        <div className="actions">
          <button className="ghost" onClick={() => downloadCsv(c, k)}>দামের তালিকা (CSV)</button>
          <button className="ghost" onClick={() => window.print()}>রিপোর্ট প্রিন্ট / PDF</button>
        </div>
      )}

      {market && <LocalCheck market={market} commodity={c} district={district} latestAll={latestAll} />}

      <section className="panel">
        <div className="panel-head">
          <div><h2>ঢাকার দাম বনাম প্রত্যাশিত সীমা</h2>
            <p className="sub">লাইনটা ঢাকার TCB-র দৈনিক দাম। প্রতিটা দিনের সীমা ১৪ দিন আগের তথ্য দিয়ে, আর শুধু আগের ডেটায় শেখা মডেল দিয়ে বানানো</p></div>
          <div className="seg" role="group" aria-label="সময়কাল">
            {(Object.keys(RANGES) as RangeKey[]).map((r) => (
              <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{RANGES[r][0]}</button>
            ))}
          </div>
        </div>
        <BandChart days={series} height={desktop ? 300 : 220} markers={markers} overlay={overlay ?? undefined} />
        <div className="legend">
          <span><i style={{ background: 'var(--c-band80)' }} />৮০% সীমা</span>
          <span><i style={{ background: 'var(--c-band95)' }} />৯৫% সীমা</span>
          <span><i className="dot" style={{ background: 'var(--c-watch)' }} />একটু বেশি</span>
          <span><i className="dot" style={{ background: 'var(--c-alarm)' }} />অনেক বেশি</span>
          <span><i className="dot" style={{ background: 'var(--c-down)' }} />স্বাভাবিকের চেয়ে কম</span>
          <span><i className="tri">▲</i>আগাম ঊর্ধ্বমুখী চাপ</span>
          {overlay && <OverlayLegendItem label={overlay.label} />}
        </div>
        <OverlayNote hasMarkets={!!overlay} fellBack={overlay?.fellBack ?? false}
          requested={marketLabel(district)} label={overlay?.label ?? ''} />
      </section>

      <div className="two">
        <section className="panel">
          <div className="panel-head">
            <h2>কেন এই দাম</h2>
            <span className="scope-tag">ঢাকা TCB দৈনিক মডেল</span>
          </div>
          <p className="sub">১৪ দিন আগে ঢাকায় দাম ছিল {bnPrice(d.waterfall?.[0].value ?? 0)} ৳। তারপর মডেলের হিসাবে যা যোগ-বিয়োগ হলো:</p>
          {distEntry?.vs_dhaka_pct != null && (
            <p className="muted-note" style={{ marginTop: 0, marginBottom: 8 }}>
              WFP জরিপ অনুযায়ী {marketLabel(activeDistKey)}-এ দাম সাধারণত ঢাকার চেয়ে প্রায় {bnNum(Math.abs(distEntry.vs_dhaka_pct))}% {distEntry.vs_dhaka_pct < 0 ? 'কম' : 'বেশি'} থাকে।
            </p>
          )}
          <Why d={d} />
          {d.waterfall && (
            <details open={desktop}>
              <summary>টাকার পুরো হিসাব</summary>
              <Waterfall steps={d.waterfall} />
            </details>
          )}
        </section>
        {mm && mb && (
          <section className="panel">
            <div className="panel-head">
              <h2>মডেল কতটা নির্ভরযোগ্য</h2>
              <span className="scope-tag">ঢাকা TCB দৈনিক মডেল</span>
            </div>
            <p className="sub">২০২৩ থেকে {bnNum(mm.n_days)} দিনের পরীক্ষা, সাধারণ ৮৪ দিনের গড়ের পদ্ধতির সাথে তুলনা</p>
            <div className="cmp">
              <Cmp label="৮০% সীমার ভেতরে দাম ছিল" note="লক্ষ্য ৮০%" a={mm.coverage80 * 100} b={mb.coverage80 * 100} max={100} unit="%" />
              <Cmp label="৯৫% সীমার ভেতরে দাম ছিল" note="লক্ষ্য ৯৫%" a={mm.coverage95 * 100} b={mb.coverage95 * 100} max={100} unit="%" />
              <Cmp label="ভুল সংকেত, প্রতি ১০০ স্বাভাবিক দিনে" note="কম হলে ভালো" a={mm.unusual_per100_normal_days} b={mb.unusual_per100_normal_days} max={35} unit="" />
            </div>
            {data.resilience && (
              <div className="resilience-box">
                <div><b>আগাম চাপ শনাক্তকরণ:</b> {bnNum(data.resilience.early_surge.events_total)} সংকটের মধ্যে <b>{bnNum(data.resilience.early_surge.events_flagged_before_confirm)}টিতে</b> অসঙ্গতি নিশ্চিত হওয়ার আগেই সতর্ক সংকেত (স্বাভাবিক দিনে মাত্র {bnNum(data.resilience.early_surge.mean_normal_emerging_per_100d, 1)}%)</div>
                <div><b>মিসিং/লেট/ইউনিট সুরক্ষা:</b> {bnNum(data.resilience.reporting_guard.gap_widened_days)} গ্যাপ দিনে অনিশ্চয়তার সীমা প্রসারিত · {bnNum(data.resilience.reporting_guard.quarantined_implicit_unit_rows)}টি সন্দেহজনক ইউনিট-স্কেল তথ্য পৃথক করা হয়েছে</div>
              </div>
            )}
          </section>
        )}
      </div>

      {(data.markets?.[k] || data.spread?.[k]) && (
        <div className="two">
          {data.markets?.[k] && <MarketPanel m={data.markets[k]} unit={c.unit_bn === 'হালি' ? '৳/হালি' : '৳/কেজি'} district={district} />}
          {data.spread?.[k] && <SpreadPanel s={data.spread[k]} />}
        </div>
      )}

      {evs.length > 0 && (
        <section className="panel">
          <h2>অতীতের ঘটনায় কত আগে ধরা পড়ত</h2>
          <p className="sub">দাম প্রথম কবে উপরের দিকে প্রত্যাশিত সীমা ছাড়াল, ঘটনার পিকের তুলনায়</p>
          {data.fair_compare ? (
            <div className="faircard">
              <h3>সমান ভুল-সংকেতে তুলনা</h3>
              {[1, 2].map((t) => {
                const f = fairAt(data.fair_compare, t)
                if (!f.model || !f.baseline) return null
                const fmt = (r: FairRow) => `${r.mean_lead_detected != null ? bnNum(r.mean_lead_detected) : '–'} দিন আগে (${bnNum(r.detected)}/${bnNum(r.events)} ঘটনা)`
                return <p key={t}>প্রতি ১০০ স্বাভাবিক দিনে {bnNum(t)}টা ভুল সংকেত ধরলে: মডেল গড়ে <b>{fmt(f.model)}</b>, সাধারণ পদ্ধতি {fmt(f.baseline)}</p>
              })}
              <p className="sub">বেশি ভুল সংকেত (৫–১০) মেনে নিলে সাধারণ পদ্ধতি সামান্য আগে ধরে; মডেলের সুবিধা বিশ্বাসযোগ্য, কম-ভুলের সতর্কসংকেতে।</p>
            </div>
          ) : (
            <p className="sub caveat">সাধারণ পদ্ধতি কখনো আগে সংকেত দেয়, কিন্তু স্বাভাবিক সময়ে প্রায় চার গুণ বেশি ভুল সংকেতের বিনিময়ে।</p>
          )}
          <ul className="events">
            {evs.map((e) => (
              <li key={e.event_id}>
                <span className="t">{EVENT_TITLE_BN[e.event_id] ?? e.description}</span>
                <span className="s">
                  {e.model?.lead_days_to_peak != null
                    ? <>প্রথম সংকেত {bnDate(e.model.first_flag!)}, পিকের <b>{bnNum(e.model.lead_days_to_peak)} দিন আগে</b></>
                    : 'মডেল আগে ধরতে পারেনি'}
                  {e.model?.first_emerging && (e.model.days_before_confirmed ?? 0) > 0 && (
                    <> · <span className="em-ev">আগাম চাপ {bnDate(e.model.first_emerging)} (নিশ্চিত হওয়ার {bnNum(e.model.days_before_confirmed!)} দিন আগে)</span></>
                  )}
                  {e.baseline?.lead_days_to_peak != null && <>। সাধারণ পদ্ধতি: {bnNum(e.baseline.lead_days_to_peak)} দিন আগে</>}
                  {data.fair_compare && e.baseline?.lead_days_to_peak != null &&
                    (e.model?.lead_days_to_peak == null || e.baseline.lead_days_to_peak > e.model.lead_days_to_peak) && (() => {
                      const fl = fairEventLead(data.fair_compare, e.event_id, 2)
                      const both = fl && fl.model == null && fl.baseline == null
                      return <> (প্রায় চার গুণ বেশি ভুল সংকেতে){both && <>। সমান ভুল-সংকেতে (প্রতি ১০০ দিনে ২টা) দুই পদ্ধতির কেউই আগে ধরেনি</>}{fl && !both && <>। সমান ভুল-সংকেতে: মডেল {fl.model != null ? `${bnNum(fl.model)} দিন আগে` : 'ধরেনি'}, সাধারণ {fl.baseline != null ? `${bnNum(fl.baseline)} দিন আগে` : 'ধরেনি'}</>}</>
                    })()}
                </span>
                <a href={`./replay.html#${toHash(e.event_id)}`}>রিপ্লে দেখুন</a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="foot">{data.note_bn}{data.fair_compare ? ' সাধারণ পদ্ধতি কখনো আগে সংকেত দেয়, কিন্তু স্বাভাবিক সময়ে প্রায় চার গুণ বেশি ভুল সংকেতের বিনিময়ে।' : ''}</p>
    </main>
  )
}

function App() {
  const desktop = useMedia('(min-width: 900px)')
  const [data, setData] = useState<FPData | null>(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState<string>(fromHash())
  const [health, setHealth] = useState<Health>({ llm: false, tts: false, model: null })
  const [district, setDistrict] = useState<string>(readDistrict)
  const [user, setUser] = useState<AuthUser | null>(null)
  const pickDistrict = (k: string) => {
    setDistrict(k)
    saveDistrict(k)
    if (user) saveUserPreferences({ district: k }).then((u) => { if (u) setUser(u) })
  }
  const toggleWatch = (k: string) => {
    if (!user) return
    const next = user.watchlist.includes(k)
      ? user.watchlist.filter((x) => x !== k)
      : [...user.watchlist, k]
    setUser({ ...user, watchlist: next })
    saveUserPreferences({ watchlist: next }).then((u) => { if (u) setUser(u) })
  }
  const onLogout = async () => {
    await logoutSession()
    setUser(null)
  }
  useEffect(() => { aiHealth().then(setHealth) }, [])
  useEffect(() => {
    fetchSession().then((u) => {
      if (!u) return
      setUser(u)
      if (u.district) { setDistrict(u.district); saveDistrict(u.district) }
    })
  }, [])
  useEffect(() => { loadData().then(setData).catch((e) => setErr(String(e.message ?? e))) }, [])
  useEffect(() => {
    const on = () => setSel(fromHash())
    addEventListener('hashchange', on); return () => removeEventListener('hashchange', on)
  }, [])

  if (err) return <p className="loading">{err}</p>
  if (!data) return <p className="loading">দাম আনা হচ্ছে…</p>

  const keys = ORDER.filter((k) => data.commodities[k])
  const latestAll = Object.values(data.commodities).map((x) => x.latest.date).sort().pop()!
  const valid = keys.includes(sel) ? sel : ''
  const current = valid || (desktop ? keys[0] : '')
  const currentDistricts = current && data.markets?.[current]?.districts
    ? Object.keys(data.markets[current].districts!).sort((a, b) => marketLabel(a).localeCompare(marketLabel(b), 'bn'))
    : []
  const districts = currentDistricts.length > 0 ? currentDistricts : allDistricts(data.markets)
  const activeDistrict = resolveDistrict(district, districts)
  const pick = (k: string) => { location.hash = toHash(k); window.scrollTo(0, 0) }
  const back = () => { history.pushState(null, '', location.pathname); setSel('') }
  const showList = desktop || !current

  return (
    <>
      <header className="band">
        <a className="wordmark" href="./landing.html">ন্যায্য দাম</a>
        <span className="meta">ঢাকা, TCB দর। সর্বশেষ <b>{bnDate(latestAll)}</b></span>
        {(!current || currentDistricts.length > 0) && (
          <MarketPicker options={districts} value={activeDistrict} onChange={pickDistrict} />
        )}
        <a className="replay-link" href="./replay.html">অতীতের ঘটনা রিপ্লে</a>
        {user ? (
          <span className="user-box">
            <span className="user-name">{user.name}</span>
            <button type="button" className="replay-link" onClick={onLogout}>লগআউট</button>
          </span>
        ) : (
          <a className="replay-link" href="./login.html">লগইন</a>
        )}
      </header>
      <div className="layout">
        {showList && (
          <nav className="rail" aria-label="পণ্য">
            {!desktop && <p className="rail-intro">দাম কি স্বাভাবিক? পণ্যে ট্যাপ করে কারণ দেখুন।</p>}
            {keys.map((k) => (
              <Item key={k} k={k} c={data.commodities[k]} current={desktop && k === current}
                stale={data.commodities[k].latest.date < latestAll} onPick={pick} />
            ))}
            {!desktop && (
              <div className="legend-board">
                {(['ok', 'watch', 'alarm', 'down'] as Tone[]).map((t) => (
                  <span key={t}><i style={{ background: `var(--c-${t})` }} />{TONE_BN[t]}: {TONE_HELP[t]}</span>
                ))}
              </div>
            )}
          </nav>
        )}
        {current && <Detail data={data} k={current} desktop={desktop} latestAll={latestAll} onBack={back} health={health} district={activeDistrict} user={user} onToggleWatch={toggleWatch} />}
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
