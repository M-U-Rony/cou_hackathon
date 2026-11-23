import { marketLabel } from '../lib/markets'

interface Props {
  /** WFP market names (keys of markets.json districts). */
  options: string[]
  value: string
  onChange: (key: string) => void
}

/** Header selector: which place the market comparison follows. */
export function MarketPicker({ options, value, onChange }: Props) {
  if (options.length === 0) return null
  return (
    <label className="market-pick">
      <span className="market-pick-label">তুলনার বাজার</span>
      <select className="market-select" aria-label="তুলনার জেলা/বাজার" value={value}
        onChange={(e) => onChange(e.target.value)}>
        {options.map((k) => <option key={k} value={k}>{marketLabel(k)}</option>)}
      </select>
      <span className="market-pick-hint">জেলার তুলনা: WFP মাসিক দর</span>
    </label>
  )
}
