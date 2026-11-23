import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchSession, type AuthUser } from '../lib/auth'
import { TONE_BN, bnDate, bnPrice, loadData, tone, type FPData } from '../lib/data'
import './style.css'

const ORDER = ['egg_farm', 'green_chili', 'potato', 'onion_local', 'onion_import']

function LandingPage() {
  const [data, setData] = useState<FPData | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    loadData().then(setData).catch(() => {})
    fetchSession().then(setUser)
  }, [])

  const keys = data ? ORDER.filter((k) => data.commodities[k]) : []
  const latestDate = data
    ? Object.values(data.commodities).map((c) => c.latest.date).sort().pop() ?? ''
    : ''

  return (
    <>
      <header className="band">
        <a className="wordmark" href="./landing.html">ন্যায্য দাম</a>
        <a className="nav-link" href="./replay.html">অতীতের ঘটনা রিপ্লে</a>
        <a className="nav-link" href="./login.html">{user ? `${user.name} · অ্যাকাউন্ট` : 'লগইন'}</a>
        <a className="nav-link solid" href="./index.html">ড্যাশবোর্ড দেখুন →</a>
      </header>

      <main className="wrap">
        <section className="hero">
          <span className="eyebrow">
            TCB + WFP + AgriPriceBD · প্রতিদিন সন্ধ্যা ৬:৩০টায় অটো-আপডেট
          </span>
          <h1>আমরা “দাম বেশি না কম” মাপি না — মাপি দাম হঠাৎ স্বাভাবিকের বাইরে লাফ দিল কি না।</h1>
          <p>
            <strong>FairPrice BD (ন্যায্য দাম)</strong> ১৪ দিন আগের (<code>H = 14</code>) বাজারদর, মৌসুম,
            উৎসব, ডলার রেট ও বৃষ্টিপাত থেকে <strong>LightGBM + CQR</strong> মডেল দিয়ে আজকের স্বাভাবিক দামের সীমা
            বের করে এবং <strong>TreeSHAP</strong> দিয়ে প্রতিটি টাকার কারণ আলাদা করে দেখায়।
          </p>
          <div className="cta-row">
            <a className="btn-primary" href="./index.html">লাইভ ড্যাশবোর্ড দেখুন →</a>
            <a className="btn-secondary" href="./replay.html">৭টি সংকট রিপ্লে দেখুন</a>
            <a className="btn-secondary" href="./login.html">
              {user ? 'আমার ওয়াচলিস্ট ও জেলা' : 'লগইন / ওয়াচলিস্ট সেভ করুন'}
            </a>
          </div>
        </section>

        <section className="stats" aria-label="মূল প্রমাণ ও পরিসংখ্যান">
          <div className="stat">
            <span className="num">৪× কম</span>
            <span className="lbl">ভুল অ্যালার্ম (False Alarm)</span>
            <span className="desc">৮৪ দিনের সাধারণ গড় পদ্ধতির তুলনায় ২.৯৫× থেকে ৪.৪২× কম মিথ্যা সংকেত।</span>
          </div>
          <div className="stat">
            <span className="num">২–৭ সপ্তাহ আগে</span>
            <span className="lbl">আগাম সতর্কসংকেত</span>
            <span className="desc">সমান ১–২% ভুল হারে গড়ে ১৬–১৯ দিন আগে সংকট ধরে (সাধারণ পদ্ধতি ৭–১০ দিন)।</span>
          </div>
          <div className="stat">
            <span className="num">৬৬টি জেলা</span>
            <span className="lbl">নিজ জেলার দাম যাচাই</span>
            <span className="desc">WFP জেলা/ঢাকা অনুপাত (p10–p90) দিয়ে কুমিল্লাসহ সারা দেশের আনুমানিক সীমা।</span>
          </div>
          <div className="stat">
            <span className="num">০ টাকা</span>
            <span className="lbl">দৈনিক সার্ভার খরচ</span>
            <span className="desc">GitHub Actions প্রতিদিন সন্ধ্যা ৬:৩০টায় TCB ডেটা এনে মডেল রিট্রেইন করে।</span>
          </div>
        </section>

        {data && keys.length > 0 && (
          <section aria-labelledby="live-snap-title">
            <div className="sec-head">
              <h2 id="live-snap-title">আজকের বাজারের একনজর চিত্র (ঢাকা TCB)</h2>
              <span>সর্বশেষ হালনাগাদ: {bnDate(latestDate)}</span>
            </div>
            <div className="live-grid">
              {keys.map((k) => {
                const c = data.commodities[k]
                const d = c.latest
                const t = tone(d)
                return (
                  <a
                    key={k}
                    className="live-card"
                    href={`./index.html#${k.replace(/_/g, '-')}`}
                    style={{ ['--tone' as string]: `var(--c-${t})` }}
                  >
                    <span className="name">{c.name_bn}</span>
                    <span className="price">{bnPrice(d.price)}<small> ৳/{c.unit_bn}</small></span>
                    <span className="verdict">● {TONE_BN[t]}</span>
                    <span className="band-txt">স্বাভাবিক সীমা: {bnPrice(d.lo80)}–{bnPrice(d.hi80)} ৳</span>
                  </a>
                )
              })}
            </div>
          </section>
        )}

        <section aria-labelledby="how-title">
          <div className="sec-head">
            <h2 id="how-title">কীভাবে কাজ করে?</h2>
            <span>Walk-Forward Validation · Zero Data Leakage</span>
          </div>
          <div className="steps">
            <article className="step">
              <span className="tag">ধাপ ১ · Predictive AI</span>
              <h3>১৪ দিনের চলমান সীমা (LightGBM + CQR)</h3>
              <p>
                স্থির কোনো দাম নয়—মডেল ১৪ দিন আগের ডেটা থেকে ৫টি কোয়ান্টাইল প্রেডিক্ট করে এবং CQR ক্যালিব্রেশনের
                মাধ্যমে বাস্তবে ~৮০% ও ~৯৫% কভারেজ নিশ্চিত করে।
              </p>
            </article>
            <article className="step">
              <span className="tag">ধাপ ২ · Explainable AI</span>
              <h3>টাকায় কারণ বিশ্লেষণ (TreeSHAP)</h3>
              <p>
                মৌসুম, আগের দামের গতি, ডলার রেট (ডিম) বা বৃষ্টিপাত (আলু)—কোন কারণে ঠিক কত টাকা বেড়েছে এবং কত টাকা
                ব্যাখ্যার বাইরে, তা ওয়াটারফল চার্টে সরাসরি দেখানো হয়।
              </p>
            </article>
            <article className="step">
              <span className="tag">ধাপ ৩ · Guardrailed GenAI</span>
              <h3>Number-Guard সারাংশ ও জেলা যাচাই</h3>
              <p>
                AI বাংলা সারাংশে ফ্যাক্ট-শিটের বাইরে একটি সংখ্যাও বানালে সার্ভারের Number-Guard তা বাতিল করে। পাশাপাশি
                লগইন করে পছন্দের জেলা ও ওয়াচলিস্ট সেভ রাখা যায়।
              </p>
            </article>
          </div>
        </section>

        <footer className="foot">
          <div>
            <strong>সৎ সীমাবদ্ধতা:</strong> FairPrice BD সরাসরি “সিন্ডিকেট” বা কারসাজি প্রমাণ করার দাবি করে না—এটি
            শুধুমাত্র সরকারি ও আন্তর্জাতিক ডেটা দিয়ে ব্যাখ্যাহীন অস্বাভাবিক মূল্যবৃদ্ধি চিহ্নিত করে।
          </div>
          <div>
            ডেটা উৎস: TCB (`tcb.gov.bd`), WFP / HDX, AgriPriceBD (DAM, CC BY 4.0), Bangladesh Bank, Open-Meteo।
          </div>
        </footer>
      </main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><LandingPage /></StrictMode>)
