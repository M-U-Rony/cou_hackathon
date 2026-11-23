// WFP market names (keys in markets.json -> districts) and their Bangla labels.
import type { MarketData } from './data'

export const DEFAULT_DISTRICT = 'Comilla Sadar'

export const MARKET_BN: Record<string, string> = {
  'Bagerhat Sadar': 'বাগেরহাট সদর',
  'Bandarban Sadar': 'বান্দরবান সদর',
  'Barguna Sadar': 'বরগুনা সদর',
  'Barisal Sadar': 'বরিশাল সদর',
  'Bhashan Char': 'ভাসানচর',
  'Bhola Sadar': 'ভোলা সদর',
  'Bogra Sadar': 'বগুড়া সদর',
  'Brahmonbaria Sadar': 'ব্রাহ্মণবাড়িয়া সদর',
  'Chandpur Sadar': 'চাঁদপুর সদর',
  'Chittagong Sadar': 'চট্টগ্রাম সদর',
  'Chuadanga Sadar': 'চুয়াডাঙ্গা সদর',
  'Comilla Sadar': 'কুমিল্লা সদর',
  'Cox`s Bazar Sadar': 'কক্সবাজার সদর',
  'Dinajpur Sadar': 'দিনাজপুর সদর',
  'Faridpur Sadar': 'ফরিদপুর সদর',
  'Feni Sadar': 'ফেনী সদর',
  'Gaibandha Sadar': 'গাইবান্ধা সদর',
  'Gazipur Sadar': 'গাজীপুর সদর',
  'Gopalgonj Sadar': 'গোপালগঞ্জ সদর',
  'Habigonj Sadar': 'হবিগঞ্জ সদর',
  'Jaipurhat Sadar': 'জয়পুরহাট সদর',
  'Jamalpur Sadar': 'জামালপুর সদর',
  'Jessore Sadar': 'যশোর সদর',
  'Jhalokati Sadar': 'ঝালকাঠি সদর',
  'Jhenaidah Sadar': 'ঝিনাইদহ সদর',
  'Khagrachari Sadar': 'খাগড়াছড়ি সদর',
  'Khulna Sadar': 'খুলনা সদর',
  'Kishoregonj Sadar': 'কিশোরগঞ্জ সদর',
  'Kurigram Sadar': 'কুড়িগ্রাম সদর',
  'Kushtia Sadar': 'কুষ্টিয়া সদর',
  'Lalmonirhat Sadar': 'লালমনিরহাট সদর',
  'Laxmipur Sadar': 'লক্ষ্মীপুর সদর',
  'Madaripur Sadar': 'মাদারীপুর সদর',
  'Magura Sadar': 'মাগুরা সদর',
  'Manikganj Sadar': 'মানিকগঞ্জ সদর',
  'Maulavibazar Sadar': 'মৌলভীবাজার সদর',
  'Meherpur Sadar': 'মেহেরপুর সদর',
  'Munshiganj Sadar': 'মুন্সীগঞ্জ সদর',
  'Mymensing Sadar': 'ময়মনসিংহ সদর',
  'Naogaon Sadar': 'নওগাঁ সদর',
  'Narail Sadar': 'নড়াইল সদর',
  'Narayanganj Sadar': 'নারায়ণগঞ্জ সদর',
  'Narsingdi Sadar': 'নরসিংদী সদর',
  'Natore Sadar': 'নাটোর সদর',
  'Nawabgonj Sadar': 'নবাবগঞ্জ সদর',
  'Netrakona Sadar': 'নেত্রকোণা সদর',
  'Nilphamari Sadar': 'নীলফামারী সদর',
  'Noakhali Sadar': 'নোয়াখালী সদর',
  'Pabna Sadar': 'পাবনা সদর',
  'Panchagarh Sadar': 'পঞ্চগড় সদর',
  'Patuakhali Sadar': 'পটুয়াখালী সদর',
  'Pirojpur Sadar': 'পিরোজপুর সদর',
  'Rajbari Sadar': 'রাজবাড়ী সদর',
  'Rajshahi Sadar': 'রাজশাহী সদর',
  'Rangamati Sadar': 'রাঙামাটি সদর',
  'Rangpur Municipality Market': 'রংপুর বাজার',
  'Satkhira Sadar': 'সাতক্ষীরা সদর',
  'Shariatpur Sadar': 'শরীয়তপুর সদর',
  'Sherpur Sadar': 'শেরপুর সদর',
  'Sirajgonj Sadar': 'সিরাজগঞ্জ সদর',
  'Sunamgonj Sadar': 'সুনামগঞ্জ সদর',
  'Sylhet Sadar': 'সিলেট সদর',
  'Tangail sadar Market': 'টাঙ্গাইল সদর বাজার',
  'Teknaf Market': 'টেকনাফ বাজার',
  'Thakurgaon Sadar': 'ঠাকুরগাঁও সদর',
  'Ukhia Market': 'উখিয়া বাজার',
}
export const marketLabel = (name: string) => MARKET_BN[name] ?? name

/** Every place that has data for at least one commodity, sorted by Bangla label. */
export function allDistricts(markets: Record<string, MarketData> | undefined): string[] {
  const keys = new Set<string>()
  for (const m of Object.values(markets ?? {})) for (const k of Object.keys(m.districts ?? {})) keys.add(k)
  return [...keys].sort((a, b) => marketLabel(a).localeCompare(marketLabel(b), 'bn'))
}

/** The place to draw for one commodity: the selection, else Comilla Sadar, else the first, else ''. */
export function resolveDistrict(selected: string, keysForCommodity: string[]): string {
  if (keysForCommodity.includes(selected)) return selected
  if (keysForCommodity.includes(DEFAULT_DISTRICT)) return DEFAULT_DISTRICT
  return keysForCommodity[0] ?? ''
}

export interface DistrictOverlay {
  key: string
  label: string
  /** the chosen place had no data for this product, so key is the fallback */
  fellBack: boolean
  points: { date: string; price: number }[]
}

/** WFP monthly prices of one place as points on the 15th, limited to [from, to] (ISO dates, inclusive). */
export function districtOverlay(
  market: MarketData | undefined, districtKey: string, from: string, to: string,
): DistrictOverlay | null {
  const keys = Object.keys(market?.districts ?? {})
  if (!market || keys.length === 0) return null
  const key = resolveDistrict(districtKey, keys)
  const prices = market.districts?.[key]?.prices ?? {}
  const points = Object.entries(prices)
    .map(([month, price]) => ({ date: `${month}-15`, price }))
    .filter((p) => p.date >= from && p.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date))
  return { key, label: marketLabel(key), fellBack: key !== districtKey, points }
}
