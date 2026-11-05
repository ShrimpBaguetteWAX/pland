import { useEffect, useRef, useState } from 'react'

import type { SwapPools } from '@/data/market'
import type { Bundle, SolveInput } from '@/lib/bundle'
import { formatDuration, formatNumber, titleCase } from '@/lib/format'
import { cycleSeconds, isTokenLoop, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import type { Market as TlmDefMarket } from '@/lib/market'
import { solveBundleParallel } from '@/lib/parallelSolve'
import { receiveFor } from '@/lib/pool'
import { Cancelled, SolverPool, poolSize } from '@/lib/solverPool'

/*
 * "Quickest payback": which division, for which mission, earns back what it costs the soonest.
 * For every running mission that pays TLM or DEF, the builder's solver finds the cheapest division
 * that meets it, at no move limit and again at tighter limits (a quicker division earns more an
 * hour and may pay back sooner even when it costs more). Each answer is valued the way the payback
 * panel values a bundle: net TLM an hour on that mission at the division's own move, a day of it
 * sold for WAX on Alcor, against the WAX the division costs. Cards you own count as free, as in the
 * builder. The cost here is the solver's estimate (blends priced one by one); loading a row runs
 * the full search for that mission and gives the exact price.
 */

export interface RoiRow {
  e: MissionEconomics
  bundle: Bundle
  maxMove?: number
  cost: number
  perHour: number
  waxPerDay: number
  days: number
}

/** Move limits tried per mission, as shares of the move the unlimited answer has. */
const MOVE_SHARES = [0.6, 0.3]

export function RoiSweep({
  base,
  missions,
  tlmDef,
  pools,
  disabled,
  onLoad
}: {
  /** The builder's candidates and economy, without a target. */
  base: Omit<SolveInput, 'atk' | 'def' | 'maxMove'> | null
  missions: MissionEconomics[]
  tlmDef: TlmDefMarket
  pools: SwapPools | undefined
  disabled: boolean
  onLoad: (row: RoiRow) => void
}) {
  const [rows, setRows] = useState<RoiRow[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; title: string } | null>(null)
  const pool = useRef<SolverPool | null>(null)
  const run = useRef(0)

  useEffect(() => () => pool.current?.terminate(), [])

  // Every running mission with a requirement; those that pay no TLM or DEF are priced too and show "pays no TLM".
  const targets = missions
    .filter((e) => e.state === 'active' && (e.minAtk > 0 || e.minDef > 0))
    .sort((a, b) => Number(isTokenLoop(b)) - Number(isTokenLoop(a)) || a.minAtk + a.minDef - (b.minAtk + b.minDef))

  const value = (e: MissionEconomics, b: Bundle, maxMove?: number): RoiRow => {
    const perHour = tlmPerHour(e, b.move, tlmDef)
    // A day's TLM sold at once, so the price impact of that size is counted.
    const waxPerDay = perHour > 0 && pools ? receiveFor(pools.tlm, 'TLM', perHour * 24) : 0
    const cost = b.cost
    return { e, bundle: b, maxMove, cost, perHour, waxPerDay, days: !isTokenLoop(e) ? Infinity : cost <= 0.01 ? 0 : waxPerDay > 0 ? cost / waxPerDay : Infinity }
  }

  const stop = () => {
    ++run.current
    pool.current?.terminate()
    pool.current = null
    setProgress(null)
  }

  const start = async () => {
    if (!base || !targets.length) return
    stop()
    const id = ++run.current
    pool.current = new SolverPool(poolSize())
    const workers = pool.current
    const found: RoiRow[] = []
    setRows([])
    const total = targets.length * (1 + MOVE_SHARES.length)
    let done = 0
    const solve = async (e: MissionEconomics, maxMove?: number) => {
      setProgress({ done, total, title: e.title })
      try {
        const b = await solveBundleParallel({ ...base, atk: e.minAtk, def: e.minDef, ...(maxMove !== undefined ? { maxMove } : {}) }, workers)
        return b && Number.isFinite(b.cost) ? b : null
      } finally {
        done++
      }
    }
    try {
      for (const e of targets) {
        if (run.current !== id) return
        const free = await solve(e)
        if (!free) {
          done += MOVE_SHARES.length
          continue
        }
        let best = value(e, free)
        // A mission that pays no TLM gains nothing from a quicker division: one search is enough.
        for (const share of isTokenLoop(e) ? MOVE_SHARES : []) {
          if (run.current !== id) return
          const cap = Math.floor(free.move * share)
          if (free.move <= 0) {
            done++
            continue
          }
          const b = await solve(e, cap)
          if (b && b.move <= cap) {
            const v = value(e, b, cap)
            if (v.days < best.days) best = v
          }
        }
        if (!isTokenLoop(e)) done += MOVE_SHARES.length
        found.push(best)
        setRows([...found].sort((a, b) => a.days - b.days || a.cost - b.cost))
      }
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err
    } finally {
      if (run.current === id) {
        setProgress(null)
        pool.current?.terminate()
        pool.current = null
      }
    }
  }

  const days = (r: RoiRow) =>
    !isTokenLoop(r.e) ? 'pays no TLM' : r.days === 0 ? 'already yours' : !Number.isFinite(r.days) ? 'never' : r.days < 1 ? `${formatNumber(r.days * 24, 1)} h` : `${formatNumber(r.days, 1)} d`

  return (
    <section className="box mb-box mb-roiSweep">
      <h2 className="h">
        Mission ROI
        <small>what a division for each running mission costs, and how soon it earns that back</small>
        {progress ? (
          <button type="button" className="btn btn--sm h__end" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn--sm btn--go h__end" disabled={disabled || !base || !targets.length} onClick={() => void start()}>
            {rows ? 'Work it out again' : 'Work it out for every mission'}
          </button>
        )}
      </h2>
      {progress && (
        <div className="mb-roiSweep__progress">
          <span className="bar2">
            <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </span>
          <small className="muted">
            {progress.title} · {progress.done} of {progress.total} searches
          </small>
        </div>
      )}
      {!rows && !progress && (
        <p className="help">
          For each of the {targets.length} running missions, the builder finds the cheapest division that meets it (also at tighter move limits, since a
          quicker division earns more an hour), then ranks them by how many days that division takes to earn its cost back. Cards you own count as free;
          the sources and rarities are the ones set on the Division builder. This takes a minute or two.
        </p>
      )}
          {rows && rows.length > 0 && progress && <p className="help">Ranked as they come in.</p>}
      {rows && rows.length > 0 && (
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>Mission</th>
                <th className="num">Division</th>
                <th className="num">Costs</th>
                <th className="num">Earns</th>
                <th className="num">Pays back</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.e.id} className={i === 0 ? 'is-me' : ''}>
                  <td>
                    <b>{r.e.title}</b>
                    <small className="muted">
                      {' '}
                      {r.e.planet ? `(${titleCase(r.e.planet)})` : ''} · {r.e.minAtk ? `${formatNumber(r.e.minAtk, 0)} atk` : ''}
                      {r.e.minAtk && r.e.minDef ? ' · ' : ''}
                      {r.e.minDef ? `${formatNumber(r.e.minDef, 0)} def` : ''}
                    </small>
                  </td>
                  <td className="num">
                    {r.bundle.mercs.length} crew · <span className="c-move">{r.bundle.move} move</span>
                    <small className="muted"> · back every {formatDuration(cycleSeconds(r.e, r.bundle.move))}</small>
                  </td>
                  <td className="num">{formatNumber(r.cost, 0)} WAX</td>
                  <td className="num">
                    {formatNumber(r.perHour, 1)} TLM/h
                    <small className="muted"> · {formatNumber(r.waxPerDay, 0)} WAX/day</small>
                  </td>
                  <td className="num">
                    <b className={i === 0 ? 'c-good' : ''}>{days(r)}</b>
                  </td>
                  <td className="mb-roiSweep__act">
                    <button type="button" className="btn btn--sm" disabled={disabled || !!progress} onClick={() => onLoad(r)}>
                      Load
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && !rows.length && !progress && <p className="none">No paying mission can be reached with these sources.</p>}
      {rows && rows.length > 0 && (
        <p className="help">
          Estimated costs (blends priced one by one). Load a row to run the full search for that mission at that move limit and get the exact price and the
          buy steps.
        </p>
      )}
    </section>
  )
}
