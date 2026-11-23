import { useState } from 'react'
import type { Commodity, MarketData, Tone } from '../lib/data'
import { TONE_BN, bnDate, bnNum, bnPrice } from '../lib/data'
import { checkAvailable, localRange, localStatus, parsePrice, ratioUnstable } from '../lib/localcheck'
import { marketLabel, resolveDistrict } from '../lib/markets'

/** Type today's local retail price; see whether it looks normal against Dhaka's range moved by WFP's district/Dhaka ratio. */
type Props = { market: MarketData; commodity: Commodity; district: string; latestAll: string }

/** Keyed by product and place so a typed price never carries over to another product or district. */
export function LocalCheck(props: Props) {
  return <LocalCheckInner key={`${props.commodity.name_bn}|${props.district}`} {...props} />
}

function LocalCheckInner({ market, commodity, district, latestAll }: Props) {
  const [raw, setRaw] = useState('')
  const keys = Object.keys(market.districts ?? {})
  const key = resolveDistrict(district, keys)
  const entry = key ? market.districts?.[key] : undefined
  const latest = commodity.latest
  if (!entry?.ratio || !checkAvailable(latest.date, latestAll, entry)) return null

  const label = marketLabel(key)
  const range = localRange(latest, entry.ratio)
  const unit = commodity.unit_bn === 'হালি' ? '৳/হালি' : '৳/কেজি'
  const price = parsePrice(raw)
  const t: Tone | null = Number.isFinite(price) ? localStatus(price, range) : null
  const unstable = ratioUnstable(entry.ratio)
  const where = t === 'down' ? 'নিচে' : t === 'ok' ? 'ভেতরে' : 'উপরে'

  return (
    <section className="panel">
      <h2>দাম যাচাই: {label} (আনুমানিক)</h2>
      {key !== district && <p className="muted-note" role="status">{marketLabel(district)}: এই পণ্যের WFP তথ্য নেই, {label} দেখানো হচ্ছে</p>}
      <p className="sub">{bnDate(latest.date)}-এর ঢাকার সীমা আর WFP অনুপাত ধরে {label} এলাকায় প্রত্যাশিত দাম প্রায় {bnNum(range.lo80)}–{bnNum(range.hi80)} ৳</p>
      <div className="local-input">
        <input type="text" inputMode="decimal" value={raw} placeholder={bnNum(range.mid)}
          aria-label={`আজকের দাম, ${label} (${unit})`} onChange={(e) => setRaw(e.target.value)} />
        <span>{unit}</span>
      </div>
      {unstable && (
        <p className="muted-note">সতর্কতা: এই এলাকায় এই পণ্যের দাম ঢাকার তুলনায় মাসে মাসে অনেক ওঠানামা করে (WFP অনুপাত {bnNum(entry.ratio.p10, 2)}–{bnNum(entry.ratio.p90, 2)}), তাই এখানে যাচাই নির্ভরযোগ্য নয়।</p>
      )}
      {t && unstable && <p className="local-result">আপনার দাম {bnPrice(price)} ৳ সীমার {where}</p>}
      {t && !unstable && (
        <p className="local-result" style={{ ['--tone' as string]: `var(--c-${t})` }}>
          <span className="pill" data-testid="local-pill">{TONE_BN[t]}</span>
          <span>আপনার দাম {bnPrice(price)} ৳: {TONE_BN[t]}</span>
        </p>
      )}
      <p className="muted-note">আনুমানিক: ঢাকার TCB দৈনিক সীমাকে WFP-র মাসিক জেলা/ঢাকা অনুপাতে সরানো হয়েছে; জেলার দৈনিক তথ্য নেই বলে এটা অতীতে যাচাই করা যায়নি। কারসাজির প্রমাণ নয়।</p>
    </section>
  )
}
