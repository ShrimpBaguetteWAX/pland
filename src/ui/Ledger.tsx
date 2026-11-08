import { useMemo, useState } from 'react'

import { useCollectionTemplates, useOwnedBlendInputs, useTemplatePrices } from '@/data/blends'
import { useArmy, useGameBalance, usePlayer, useWalletNfts } from '@/data/game'
import { CATEGORY_LABEL, priceAt, useLedger, usePriceHistory, type Category, type LedgerEntry, type PriceHistory, type Token } from '@/data/ledger'
import { useListings, useSwapPools } from '@/data/market'
import { marketFrom, SALE_KEEP, valueOf } from '@/lib/blendEconomy'
import { formatNumber } from '@/lib/format'
import { midPrice, type Pool } from '@/lib/pool'

import { Icon } from './icons'

/*
 * The ledger as a balance sheet: everything the account spent on Planetary Defense facing
 * everything it got back, from the chain (see data/ledger.ts), each entry valued on the day it
 * happened. Spent on the left and Earned on the right, each one stacked bar split by category; the
 * net in the middle with what is still held and what selling it all today would leave. Under it the
 * running net over the last 30 days, then every entry. A category in either legend filters the list.
 */

type Unit = 'USD' | 'WAX'

const SPEND: Category[] = ['nft', 'forge-level', 'forge-slot', 'forge-other', 'entry']
const EARN: Category[] = ['mission', 'sale', 'v2']
/** Each category's colour, from the site's palette. */
const COLOR: Record<Category, string> = {
  nft: 'var(--r-rare)',
  'forge-level': 'var(--r-epic)',
  'forge-slot': 'var(--move)',
  'forge-other': 'var(--r-mythic)',
  entry: 'var(--r-common)',
  mission: 'var(--good)',
  sale: 'var(--r-rare)',
  v2: 'var(--r-common)'
}
const LIST_STEP = 50
const CHART_DAYS = 30
const DAY_MS = 86_400_000

/** WAX per one unit of `symbol` at the pool's mid price. */
const waxPer = (pool: Pool, symbol: string) => (pool.a.symbol === symbol ? midPrice(pool) : 1 / midPrice(pool))

/**
 * Values entries in WAX and USD at the time they happened: WAX and TLM at that day's price
 * (CoinGecko), DEF through today's Alcor DEF/WAX price (DEF has no price history anywhere).
 */
function valuer(prices: PriceHistory | undefined, tlmWaxNow: number, defWaxNow: number) {
  const waxUsd = (t: number) => (prices ? priceAt(prices.wax, t) : null)
  const tlmUsd = (t: number) => (prices ? priceAt(prices.tlm, t) : null)
  const wax = (e: { token: Token; amount: number; time: number }) => {
    if (e.token === 'WAX') return e.amount
    if (e.token === 'DEF') return e.amount * defWaxNow
    const w = waxUsd(e.time)
    const t = tlmUsd(e.time)
    return w && t ? (e.amount * t) / w : e.amount * tlmWaxNow
  }
  const usd = (e: { token: Token; amount: number; time: number }) => {
    const w = waxUsd(e.time)
    if (w === null) return null
    if (e.token === 'TLM') {
      const t = tlmUsd(e.time)
      return t === null ? null : e.amount * t
    }
    return wax(e) * w
  }
  return { wax, usd, waxUsdNow: prices ? (prices.wax[prices.wax.length - 1]?.[1] ?? null) : null }
}

const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** A WAX account name: up to 12 of a–z, 1–5 and dots. */
const ACCOUNT_RE = /^[a-z1-5.]{1,12}$/

export function Ledger({ account: own }: { account: string }) {
  // Whose ledger: the signed-in (or viewed) account unless another wallet was typed in.
  const [picked, setPicked] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const account = picked ?? own
  const ledger = useLedger(account)
  const player = usePlayer(account)
  const game = useGameBalance(account)
  const prices = usePriceHistory()
  const pools = useSwapPools()
  const army = useArmy(account)
  const wallet = useWalletNfts(account)
  const materials = useOwnedBlendInputs(account)
  const listings = useListings()
  const templates = useCollectionTemplates()
  const recent = useTemplatePrices()
  const [unit, setUnit] = useState<Unit>('USD')
  const [only, setOnly] = useState<Category | null>(null)
  const [shown, setShown] = useState(LIST_STEP)

  const v = useMemo(() => (pools.data ? valuer(prices.data, waxPer(pools.data.tlm, 'TLM'), waxPer(pools.data.def, 'DEF')) : null), [prices.data, pools.data])

  // What is still held (staked, in the wallet, materials and loot), at market value after sale fees.
  const holdings = useMemo(() => {
    if (!listings.data || !templates.data || !recent.data) return null
    const market = marketFrom(listings.data, new Map(), templates.data, account, recent.data)
    const counts = new Map<string, number>()
    const add = (templateId: string, n = 1) => counts.set(templateId, (counts.get(templateId) ?? 0) + n)
    for (const a of army.data?.assets.values() ?? []) add(a.templateId)
    for (const a of wallet.data ?? []) add(a.templateId)
    for (const [t, ids] of materials.data ?? []) add(t, ids.length)
    let wax = 0
    let nfts = 0
    let unpriced = 0
    for (const [t, n] of counts) {
      if (!templates.data.has(t)) continue
      nfts += n
      const val = valueOf(market, t)
      if (val === null) unpriced += n
      else wax += val * SALE_KEEP * n
    }
    return { wax, nfts, unpriced }
  }, [listings.data, templates.data, recent.data, army.data, wallet.data, materials.data, account])

  const head = (
    <>
  <header className="lg__hd">
    <h2>
      Ledger <small>{account} · from the chain</small>
    </h2>
    <div className="seg lg__unit" role="group" aria-label="Currency">
      {(['USD', 'WAX'] as Unit[]).map((u) => (
        <button key={u} type="button" className={unit === u ? 'is-on' : ''} onClick={() => setUnit(u)}>
          {u === 'USD' ? '$ USD' : 'WAX'}
        </button>
      ))}
    </div>
    <button
      type="button"
      className={`btn btn--sm lg__refresh${ledger.isFetching ? ' is-spinning' : ''}`}
      disabled={ledger.isFetching}
      title="Reads the history and today's prices again. The ledger otherwise refreshes every ten minutes."
      onClick={() => void Promise.all([ledger.refetch(), prices.refetch()])}
    >
      {ledger.isFetching ? 'Reading…' : 'Refresh'}
    </button>
  </header>
      {/* Any wallet's ledger: type a name, Read; Back returns to your own. */}
      <form
        className="lg__who"
        onSubmit={(e) => {
          e.preventDefault()
          const name = draft.trim().toLowerCase()
          if (!ACCOUNT_RE.test(name)) return
          setPicked(name === own ? null : name)
          setOnly(null)
          setShown(LIST_STEP)
          setDraft('')
        }}
      >
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Read another wallet, e.g. 42lra.wam"
          aria-label="Wallet to read"
          spellCheck={false}
          autoCapitalize="off"
          maxLength={12}
        />
        <button type="submit" className="btn btn--sm" disabled={!ACCOUNT_RE.test(draft.trim().toLowerCase())}>
          Read
        </button>
        {picked && (
          <button type="button" className="btn btn--sm" onClick={() => setPicked(null)}>
            Back to {own}
          </button>
        )}
      </form>
      {/* DEF the wallet holds right now: in the wallet itself and deposited in the game. */}
      <div className="lg__bal" aria-label="DEF held now">
        <span>
          <img src="./img/Logo_token_DEF.webp" alt="" />
          <span className="lg__lab">DEF in the wallet</span>
          <b>{player.data ? formatNumber(player.data.def, 2) : '…'}</b>
        </span>
        <span title="Deposited in the game (core.pdef): entry fees are taken from here first">
          <span className="lg__lab">Deposited in the game</span>
          <b>{game.data ? formatNumber(game.data.def, 2) : '…'}</b>
        </span>
        <span>
          <span className="lg__lab">Together</span>
          <b>{player.data && game.data ? formatNumber(player.data.def + game.data.def, 2) : '…'}</b>
        </span>
      </div>
    </>
  )

  if (!ledger.data || !v) {
    return (
      <main className="lg wrap">
        {head}
        <p className="muted page-msg">{ledger.isError ? 'The history could not be read from the chain right now. Try again in a moment.' : 'Reading your history from the chain…'}</p>
      </main>
    )
  }

  const entries = ledger.data
  const val = (e: LedgerEntry) => (unit === 'USD' ? v.usd(e) : v.wax(e))
  const signedVal = (e: LedgerEntry) => (val(e) ?? 0) * (e.direction === 'in' ? 1 : -1)
  const usdMissing = unit === 'USD' && !prices.data
  const sum = (list: LedgerEntry[]) => list.reduce((n, e) => n + (val(e) ?? 0), 0)
  const spent = sum(entries.filter((e) => e.direction === 'out'))
  const earned = sum(entries.filter((e) => e.direction === 'in'))
  const net = earned - spent
  const holdValue = holdings ? (unit === 'USD' ? (v.waxUsdNow !== null ? holdings.wax * v.waxUsdNow : null) : holdings.wax) : null
  const ifSold = holdValue === null ? null : net + holdValue
  // Sign first, then the currency: −$501.16, +1,200 WAX. Dollars always show their cents.
  const money = (n: number | null, signed = false) => {
    if (n === null) return '–'
    const sign = n < 0 ? '−' : signed && n > 0 ? '+' : ''
    const abs = Math.abs(n)
    return unit === 'USD' ? `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sign}${formatNumber(abs, abs < 10 ? 2 : 0)} WAX`
  }
  const tone = (n: number | null) => (n === null || n === 0 ? '' : n > 0 ? 'c-good' : 'c-bad')

  const side = (cats: Category[]) =>
    cats
      .map((c) => {
        const list = entries.filter((e) => e.category === c)
        const tokens = new Map<Token, number>()
        for (const e of list) tokens.set(e.token, (tokens.get(e.token) ?? 0) + e.amount)
        return { c, n: list.length, tokens, value: sum(list) }
      })
      .filter((r) => r.n > 0)

  const listed = [...entries].reverse().filter((e) => !only || e.category === only)
  const pick = (c: Category) => {
    setOnly((o) => (o === c ? null : c))
    setShown(LIST_STEP)
  }

  return (
    <main className="lg wrap">
      {head}
      {usdMissing && <p className="lg__warn">USD prices could not be loaded right now. Switch to WAX, or try again later.</p>}

      <div className="lg__top">
        <Side title="Spent" rows={side(SPEND)} money={money} total={spent} dir="out" only={only} onPick={pick} />
        <section className="lg__mid box">
          <span
            className="lg__lab"
            title="Earned minus spent. WAX and TLM are valued at their USD price on the day (CoinGecko, last 365 days; older entries use the oldest price). DEF has no price history, so it is valued at today's Alcor price. Token swaps are not counted: they only change what the money is held in. Since 7 Nov, rewards credited to the game balance count as earned, and entry fees taken from it as spent, each at the mission's entry cost; deposits and withdrawals only move your own money."
          >
            Net so far
          </span>
          <b className={`lg__net ${tone(net)}`}>{money(net, true)}</b>
          <small>earned minus spent</small>
          <hr />
          <div className="lg__pair">
            <span
              title={`What you still hold in the collection (${holdings ? formatNumber(holdings.nfts, 0) : '…'} NFTs, staked, in the wallet and materials), at market value after the 7% sale fees.${holdings?.unpriced ? ` ${holdings.unpriced} have no market price and count as nothing.` : ''}`}
            >
              <span className="lg__lab">Holding</span>
              <b>{money(holdValue)}</b>
            </span>
            <span title="Net so far plus what you hold, if you sold it all today at market value.">
              <span className="lg__lab">If sold</span>
              <b className={tone(ifSold)}>{money(ifSold, true)}</b>
            </span>
          </div>
        </section>
        <Side title="Earned" rows={side(EARN)} money={money} total={earned} dir="in" only={only} onPick={pick} />
      </div>

      <RunningNet entries={entries} signedVal={signedVal} money={money} unit={unit} />

      <section className="box lg__list">
        <header className="lg__listhd">
          <h3 className="h">
            {only ? CATEGORY_LABEL[only] : 'Every entry'}
            <small>{formatNumber(listed.length, 0)}</small>
          </h3>
          {only && (
            <button type="button" className="btn btn--sm" onClick={() => setOnly(null)}>
              <Icon name="x" size={13} /> Show all
            </button>
          )}
        </header>
        {listed.length === 0 ? (
          <p className="muted">Nothing on the chain yet.</p>
        ) : (
          <div className="lg__scroll">
            <table className="lg__tbl">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>What</th>
                  <th className="r">Amount</th>
                  <th className="r">Value</th>
                </tr>
              </thead>
              <tbody>
                {listed.slice(0, shown).map((e) => (
                  <tr key={e.id}>
                    <td className="num lg__date">{new Date(e.time).toLocaleDateString()}</td>
                    <td>
                      <span className="lg__cat">
                        <i style={{ background: COLOR[e.category] }} />
                        {CATEGORY_LABEL[e.category]}
                      </span>
                    </td>
                    <td className="lg__note">{e.note}</td>
                    <td className="r num lg__amt">
                      {e.direction === 'in' ? '+' : '−'}
                      {formatNumber(e.amount, e.token === 'WAX' ? 2 : 4)} {e.token}
                    </td>
                    <td className={`r num lg__val ${e.direction === 'in' ? 'c-good' : 'c-bad'}`}>
                      {e.direction === 'in' ? '+' : '−'}
                      {money(val(e))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {listed.length > shown && (
          <button type="button" className="lg__more" onClick={() => setShown((n) => n + LIST_STEP)}>
            Show {Math.min(LIST_STEP, listed.length - shown)} more of {formatNumber(listed.length - shown, 0)}
          </button>
        )}
      </section>
    </main>
  )
}

/** One side of the sheet: its total, one bar split by category, and a legend that filters the list. */
function Side({
  title,
  rows,
  money,
  total,
  dir,
  only,
  onPick
}: {
  title: string
  rows: { c: Category; n: number; tokens: Map<Token, number>; value: number }[]
  money: (n: number | null) => string
  total: number
  dir: 'in' | 'out'
  only: Category | null
  onPick: (c: Category) => void
}) {
  return (
    <section className="box lg__side">
      <header>
        <span className="lg__lab">{title}</span>
        <b className={dir === 'in' ? 'c-good' : 'c-bad'}>{money(total)}</b>
      </header>
      {rows.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <>
          <div className="lg__stack" aria-hidden="true">
            {rows.map((r) => (
              <i key={r.c} style={{ flexGrow: Math.max(r.value, total * 0.004), background: COLOR[r.c] }} title={CATEGORY_LABEL[r.c]} />
            ))}
          </div>
          <ul className="lg__legend">
            {rows.map((r) => (
              <li key={r.c}>
                <button
                  type="button"
                  className={only === r.c ? 'is-on' : ''}
                  aria-pressed={only === r.c}
                  title={`${r.n}× · ${[...r.tokens].map(([t, n]) => `${formatNumber(n, t === 'WAX' ? 0 : 2)} ${t}`).join(' + ')} · show only these below`}
                  onClick={() => onPick(r.c)}
                >
                  <i style={{ background: COLOR[r.c] }} />
                  <span className="lg__catname">{CATEGORY_LABEL[r.c]}</span>
                  <small>
                    {total > 0 ? Math.round((r.value / total) * 100) : 0}% · {formatNumber(r.n, 0)}×
                  </small>
                  <b>{money(r.value)}</b>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

type Range = '30d' | '1y' | 'all'
const RANGES: [Range, string][] = [
  ['30d', '30 days'],
  ['1y', '1 year'],
  ['all', 'All time']
]

/** The net at the end of each day of the range, counting everything before it too: a line with its area. */
function RunningNet({
  entries,
  signedVal,
  money,
  unit
}: {
  entries: LedgerEntry[]
  signedVal: (e: LedgerEntry) => number
  money: (n: number | null, signed?: boolean) => string
  unit: Unit
}) {
  const [range, setRange] = useState<Range>('30d')
  const points = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // All time starts the day before the first entry, so the line starts at zero.
    const firstDay = entries.length ? new Date(entries[0].time).setHours(0, 0, 0, 0) : +today
    const days = range === '30d' ? CHART_DAYS : range === '1y' ? 365 : Math.max(CHART_DAYS, Math.round((+today - firstDay) / DAY_MS) + 1)
    // The end of each day, oldest first: point 0 is the end of the day before the range opens, the
    // last point the end of today.
    const ends = Array.from({ length: days + 1 }, (_, i) => +today - (days - i) * DAY_MS + DAY_MS - 1)
    const out = ends.map((t) => ({ t, net: 0 }))
    let k = 0
    let run = 0
    for (const e of entries) {
      while (k < out.length && e.time > out[k].t) out[k++].net = run
      run += signedVal(e)
    }
    while (k < out.length) out[k++].net = run
    return out
  }, [entries, signedVal, range])

  const n = points.length - 1
  const long = n > 120
  const label = (t: number) => new Date(t).toLocaleDateString(undefined, long ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
  const W = 1000
  const H = 170
  const L = 70
  const R = 10
  const T = 10
  const values = points.map((p) => p.net)
  // Scaled to the net's own range, so a change shows; zero gets its dashed line only when it is in view.
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.01, 1e-6)
  lo -= pad
  hi += pad
  // Nice ticks: about four steps of 1, 2 or 5 × 10^n.
  const raw = (hi - lo) / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t / step) * step)
  const x = (i: number) => L + (i / n) * (W - L - R)
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.net).toFixed(1)}`).join(' ')
  const last = points[n].net
  const change = last - points[0].net
  const col = change >= 0 ? 'var(--good)' : 'var(--bad)'
  const short = (v: number) => {
    const a = Math.abs(v)
    const body = a >= 1000 ? `${formatNumber(a / 1000, a >= 10_000 ? 0 : 1)}k` : formatNumber(a, a < 10 ? 2 : 0)
    return `${v < 0 ? '−' : ''}${unit === 'USD' ? '$' : ''}${body}`
  }
  const span = range === '30d' ? 'last 30 days' : range === '1y' ? 'last 12 months' : `since ${label(points[1].t)}`
  // Hover targets: one per day for a short range, one per week beyond that (the line keeps every day).
  const every = n > 120 ? 7 : 1
  const band = ((W - L - R) / n) * every
  return (
    <section className="box lg__chart">
      <h3 className="h">
        Running net <small>{span}</small>
        <div className="seg lg__range" role="group" aria-label="Chart range">
          {RANGES.map(([r, l]) => (
            <button key={r} type="button" className={range === r ? 'is-on' : ''} onClick={() => setRange(r)}>
              {l}
            </button>
          ))}
        </div>
        <span className={`lg__change ${change >= 0 ? 'c-good' : 'c-bad'}`}>{money(change, true)} in that time</span>
      </h3>
      <svg viewBox={`0 0 ${W} ${H + 24}`} preserveAspectRatio="none" role="img" aria-label={`Running net, ${span}, now ${money(last, true)}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'lg__zero' : 'lg__grid'} x1={L} x2={W - R} y1={y(t)} y2={y(t)} vectorEffect="non-scaling-stroke" />
            <text x={L - 10} y={y(t) + 4} textAnchor="end">
              {short(t)}
            </text>
          </g>
        ))}
        <path d={`${line} L${x(n)} ${y(lo)} L${x(0)} ${y(lo)} Z`} fill={col} fillOpacity={0.12} />
        <path d={line} fill="none" stroke={col} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
        {points.map((p, i) =>
          i % every && i !== n ? null : (
            <rect key={i} x={x(i) - band / 2} y={T} width={band} height={H - T} fill="transparent">
              <title>{`${i === 0 ? 'Before ' + dayLabel(p.t + 1) : 'End of ' + new Date(p.t).toLocaleDateString()}: net ${money(p.net, true)}`}</title>
            </rect>
          )
        )}
        <circle cx={x(n)} cy={y(last)} r={4} fill={col} />
        <text x={x(0)} y={H + 20}>
          {label(points[1].t)}
        </text>
        <text x={x(n / 2)} y={H + 20} textAnchor="middle">
          {label(points[Math.round(n / 2)].t)}
        </text>
        <text x={x(n)} y={H + 20} textAnchor="end">
          Today
        </text>
      </svg>
    </section>
  )
}
