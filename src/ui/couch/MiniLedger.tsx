import { useMemo, useState } from 'react'

import { priceAt, useLedger, usePriceHistory, type Category, type LedgerEntry, type Token } from '@/data/ledger'
import { useSwapPools } from '@/data/market'
import { formatNumber } from '@/lib/format'
import { receiveFor } from '@/lib/pool'


/*
 * Couch mode's mini ledger: the last three days (today so far, yesterday, the day before), from the
 * same entries as the full Ledger page and valued the same way: WAX in TLM at that day's prices
 * (CoinGecko's daily WAX and TLM; today's Alcor rate until they load), and DEF not counted where it
 * is only paid or received (a Forge slot, an entry): it counts where it is bought or sold on Alcor,
 * so DEF bought and then spent is not counted twice. The three days' net on top; then a card per
 * day with its net and every kind of entry that day, biggest first. A long day shows its four
 * biggest lines and folds the rest until tapped.
 */

const DAYS = 3
const SHOWN = 4

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
  title: string
  date: string
  lines: Line[]
  inTlm: number
  outTlm: number
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

export function MiniLedger({ account }: { account: string }) {
  const ledger = useLedger(account)
  const pools = useSwapPools()
  const prices = usePriceHistory()
  const [open, setOpen] = useState<Set<number>>(() => new Set())

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

  const days = useMemo<Day[] | null>(() => {
    if (!ledger.data || !tlmOf) return null
    return Array.from({ length: DAYS }, (_, back) => {
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
      // Counted lines biggest first, then the DEF that is only listed.
      const list = [...lines.values()].sort((a, b) => Number(b.counted) - Number(a.counted) || b.tlm - a.tlm || b.amount - a.amount)
      const date = new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      const title = back === 0 ? 'Today' : back === 1 ? 'Yesterday' : new Date(start).toLocaleDateString(undefined, { weekday: 'long' })
      return {
        start,
        title,
        date: back === 0 ? `${date} · so far` : date,
        lines: list,
        inTlm: list.filter((l) => l.direction === 'in').reduce((n, l) => n + l.tlm, 0),
        outTlm: list.filter((l) => l.direction === 'out').reduce((n, l) => n + l.tlm, 0)
      }
    })
  }, [ledger.data, tlmOf])

  const inAll = days?.reduce((n, d) => n + d.inTlm, 0) ?? 0
  const outAll = days?.reduce((n, d) => n + d.outTlm, 0) ?? 0
  const net = inAll - outAll

  return (
    <section className="couch__bankpage cl" aria-label="The last three days">
      <div className="cl__head">
        <small>Last 3 days · net</small>
        <b className={`num ${net >= 0 ? 'is-good' : 'is-bad'}`}>
          {days ? signed(net) : '…'}
          <i>TLM</i>
        </b>
        <span className="num">{days ? `in ${n0(inAll)} · out ${n0(outAll)} · at each day's prices` : ledger.isError ? 'The history did not load. Swipe down to try again.' : 'Reading your history…'}</span>
      </div>

      {days?.map((d) => {
        const dayNet = d.inTlm - d.outTlm
        const expanded = open.has(d.start)
        const shown = expanded ? d.lines : d.lines.slice(0, SHOWN)
        const hidden = d.lines.length - shown.length
        return (
          <article key={d.start} className="cl__day">
            <div className="cl__day-hd">
              <span>
                {d.title}
                <small>{d.date}</small>
              </span>
              <b className={`num ${!d.lines.length ? '' : dayNet >= 0 ? 'is-good' : 'is-bad'}`}>{d.lines.length ? signed(dayNet) : '0'}</b>
            </div>
            {!d.lines.length && <p className="cl__none">Nothing that day.</p>}
            {shown.map((l) => (
              <div key={l.key} className="cl__ln">
                <i className={!l.counted ? '' : l.direction === 'in' ? 'is-good' : 'is-bad'}>{l.direction === 'in' ? '+' : '−'}</i>
                <span>{l.label}</span>
                <span className="cl__tok num">{l.token === 'TLM' ? 'TLM' : `${formatNumber(l.amount, l.amount >= 100 ? 0 : 2)} ${l.token}`}</span>
                {l.counted ? (
                  <span className="cl__v num">{n0(l.tlm)}</span>
                ) : (
                  <span className="cl__v cl__nc" title="DEF counts where it is bought or sold on Alcor, so it is not counted twice">
                    not counted
                  </span>
                )}
              </div>
            ))}
            {(hidden > 0 || expanded) && d.lines.length > SHOWN && (
              <button
                type="button"
                className="cl__more"
                onClick={() =>
                  setOpen((o) => {
                    const next = new Set(o)
                    if (next.has(d.start)) next.delete(d.start)
                    else next.add(d.start)
                    return next
                  })
                }
              >
                {expanded ? 'Show less' : `+ ${hidden} more`}
              </button>
            )}
          </article>
        )
      })}
    </section>
  )
}
