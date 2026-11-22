import { useMemo, useState, type CSSProperties } from 'react'

import { priceAt, useLedger, usePriceHistory, type Category, type LedgerEntry, type Token } from '@/data/ledger'
import { useSwapPools } from '@/data/market'
import { formatNumber } from '@/lib/format'
import { receiveFor } from '@/lib/pool'

import './Ledger.css'

/*
 * Couch mode's ledger: the last 14 days, from the same entries as the full Ledger page and valued the
 * same way: WAX in TLM at that day's prices (CoinGecko's daily WAX and TLM; today's Alcor rate until
 * they load), and DEF not counted where it is only paid or received (a Forge slot, an entry): it
 * counts where it is bought or sold on Alcor, so DEF bought and then spent is not counted twice.
 *
 * On top the 14 days' net, in and out; then a bar per day (its net, up when it gained, down when it
 * spent; today's still running); a tap on a bar opens that day below: its net, in and out, and every
 * kind of entry, what came in first, biggest first.
 */

const DAYS = 14

const LABEL: Record<Category, string> = {
  nft: 'NFTs bought',
  'forge-level': 'Forge levels',
  'forge-slot': 'Forge slots',
  'forge-other': 'Forge, other',
  entry: 'Mission entry fees',
  mission: 'Mission rewards',
  v2: 'Old game rewards',
  sale: 'NFTs sold',
  'def-buy': 'DEF bought on Alcor',
  'def-sell': 'DEF sold on Alcor',
  deposit: 'Deposited to the game',
  withdraw: 'Withdrawn from the game'
}

interface Line {
  key: string
  label: string
  direction: 'in' | 'out'
  token: Token
  amount: number
  tlm: number
  /** DEF only paid or received: listed, not counted (see the top of the file). */
  counted: boolean
}

interface Day {
  start: number
  back: number
  lines: Line[]
  inTlm: number
  outTlm: number
  net: number
}

const n0 = (n: number) => formatNumber(n, 0)
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${n0(Math.abs(n))}`

/** Local midnight of the day `back` days before today. */
function dayStart(back: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - back)
  return +d
}

const dateOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const titleOf = (d: Day) => (d.back === 0 ? 'Today' : d.back === 1 ? 'Yesterday' : new Date(d.start).toLocaleDateString(undefined, { weekday: 'long' }))
/** The weekday's first letter, under its bar. */
const initialOf = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'narrow' })

export function MiniLedger({ account }: { account: string }) {
  const ledger = useLedger(account)
  const pools = useSwapPools()
  const prices = usePriceHistory()
  /** The day open below the chart, as days back from today. */
  const [pick, setPick] = useState(0)

  /** An entry in TLM, as the full Ledger counts it: WAX at that day's prices, DEF not at all. */
  const tlmOf = useMemo(() => {
    if (!pools.data) return null
    const waxNow = receiveFor(pools.data.tlm, 'WAX', 1)
    return (e: LedgerEntry): number => {
      if (e.token === 'TLM') return e.amount
      if (e.token === 'DEF') return 0
      const w = prices.data ? priceAt(prices.data.wax, e.time) : null
      const t = prices.data ? priceAt(prices.data.tlm, e.time) : null
      return w && t ? (e.amount * w) / t : e.amount * waxNow
    }
  }, [pools.data, prices.data])

  /** The 14 days, oldest first. */
  const days = useMemo<Day[] | null>(() => {
    if (!ledger.data || !tlmOf) return null
    return Array.from({ length: DAYS }, (_, i) => {
      const back = DAYS - 1 - i
      const start = dayStart(back)
      const end = back === 0 ? Infinity : dayStart(back - 1)
      const lines = new Map<string, Line>()
      for (const e of ledger.data as LedgerEntry[]) {
        if (e.time < start || e.time >= end) continue
        const key = `${e.category}|${e.token}|${e.direction}`
        const line = lines.get(key) ?? { key, label: LABEL[e.category] ?? e.category, direction: e.direction, token: e.token, amount: 0, tlm: 0, counted: e.token !== 'DEF' }
        line.amount += e.amount
        line.tlm += tlmOf(e)
        lines.set(key, line)
      }
      // What came in first, then what went out; counted lines biggest first, then the DEF only listed.
      const list = [...lines.values()].sort(
        (a, b) => Number(a.direction === 'out') - Number(b.direction === 'out') || Number(b.counted) - Number(a.counted) || b.tlm - a.tlm || b.amount - a.amount
      )
      const inTlm = list.filter((l) => l.direction === 'in').reduce((n, l) => n + l.tlm, 0)
      const outTlm = list.filter((l) => l.direction === 'out').reduce((n, l) => n + l.tlm, 0)
      return { start, back, lines: list, inTlm, outTlm, net: inTlm - outTlm }
    })
  }, [ledger.data, tlmOf])

  const inAll = days?.reduce((n, d) => n + d.inTlm, 0) ?? 0
  const outAll = days?.reduce((n, d) => n + d.outTlm, 0) ?? 0
  const net = inAll - outAll
  // Full days only for the average: today is still running.
  const full = days?.filter((d) => d.back > 0) ?? []
  const avg = full.length ? full.reduce((n, d) => n + d.net, 0) / full.length : 0
  const top = Math.max(1, ...(days ?? []).map((d) => Math.abs(d.net)))
  const hasDown = (days ?? []).some((d) => d.net < 0)
  const day = days?.find((d) => d.back === pick) ?? null
  const ins = day?.lines.filter((l) => l.direction === 'in') ?? []
  const outs = day?.lines.filter((l) => l.direction === 'out') ?? []

  return (
    <section className="couch__bankpage cl2" aria-label="The last 14 days">
      <div className="cl2__head">
        <small>Last 14 days · net</small>
        <b className={`num ${net >= 0 ? 'is-good' : 'is-bad'}`}>
          {days ? signed(net) : '…'}
          <i>TLM</i>
        </b>
        <div className="cl2__figs num">
          {days ? (
            <>
              <span>
                in <b>{n0(inAll)}</b>
              </span>
              <span>
                out <b>{n0(outAll)}</b>
              </span>
              <span>
                a day <b className={avg >= 0 ? 'is-good' : 'is-bad'}>{signed(avg)}</b>
              </span>
            </>
          ) : (
            <span>{ledger.isError ? 'The history did not load. Swipe down to try again.' : 'Reading your history…'}</span>
          )}
        </div>
      </div>

      {days && (
        <div className={`cl2__chart${hasDown ? ' has-down' : ''}`} role="group" aria-label="Net per day, the last 14 days">
          {days.map((d) => {
            // Square-root scale: one big day does not flatten the rest; a bigger bar is still a bigger day.
            const h = Math.max(d.lines.length ? 3 : 0, Math.sqrt(Math.abs(d.net) / top) * 100)
            return (
              <button
                key={d.start}
                type="button"
                className={`cl2__bar${d.back === pick ? ' is-on' : ''}${d.back === 0 ? ' is-today' : ''}`}
                aria-pressed={d.back === pick}
                aria-label={`${titleOf(d)}, ${dateOf(d.start)}: ${signed(d.net)} TLM`}
                onClick={() => setPick(d.back)}
              >
                <span className="cl2__col">
                  <i className={d.net >= 0 ? 'is-up' : 'is-down'} style={{ '--h': h } as CSSProperties} />
                </span>
                <small>{d.back === 0 ? '•' : initialOf(d.start)}</small>
              </button>
            )
          })}
        </div>
      )}

      {day && (
        <article className="cl2__day">
          <div className="cl2__day-hd">
            <button type="button" className="cl2__step" aria-label="The day before" disabled={pick >= DAYS - 1} onClick={() => setPick((p) => Math.min(DAYS - 1, p + 1))}>
              ‹
            </button>
            <span>
              {titleOf(day)}
              <small>
                {dateOf(day.start)}
                {day.back === 0 ? ' · so far' : ''}
              </small>
            </span>
            <b className={`num ${!day.lines.length ? '' : day.net >= 0 ? 'is-good' : 'is-bad'}`}>{day.lines.length ? signed(day.net) : '0'}</b>
            <button type="button" className="cl2__step" aria-label="The day after" disabled={pick <= 0} onClick={() => setPick((p) => Math.max(0, p - 1))}>
              ›
            </button>
          </div>
          {!day.lines.length ? (
            <p className="cl2__none">Nothing that day.</p>
          ) : (
            <>
              {[
                { title: 'In', list: ins, total: day.inTlm, cls: 'is-good' },
                { title: 'Out', list: outs, total: day.outTlm, cls: 'is-bad' }
              ]
                .filter((g) => g.list.length)
                .map((g) => (
                  <div key={g.title} className="cl2__grp">
                    <div className="cl2__grp-hd">
                      <span>{g.title}</span>
                      <b className={`num ${g.cls}`}>
                        {g.title === 'In' ? '+' : '−'}
                        {n0(g.total)}
                      </b>
                    </div>
                    {g.list.map((l) => (
                      <div key={l.key} className="cl2__ln">
                        <span>{l.label}</span>
                        <span className="cl2__tok num">{l.token === 'TLM' ? 'TLM' : `${formatNumber(l.amount, l.amount >= 100 ? 0 : 2)} ${l.token}`}</span>
                        {l.counted ? (
                          <span className="cl2__v num">{n0(l.tlm)}</span>
                        ) : (
                          <span className="cl2__v cl2__nc" title="DEF counts where it is bought or sold on Alcor, so it is not counted twice">
                            not counted
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
            </>
          )}
        </article>
      )}
      {days && <p className="cl2__foot">TLM at each day's prices. DEF counts where it is bought or sold on Alcor. Bars on a square-root scale, so small days show; tap one for its figures.</p>}
    </section>
  )
}
