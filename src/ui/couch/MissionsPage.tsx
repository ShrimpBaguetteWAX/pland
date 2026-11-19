import { useMemo, useState, type CSSProperties } from 'react'

import { useArmy } from '@/data/game'
import { formatDuration, formatNumber } from '@/lib/format'
import { costParts, meetsRequirements, rewardParts, type MissionEconomics } from '@/lib/loop'
import { chainDate } from '@/lib/time'
import { useField } from '@/lib/useField'
import { useMissionScores } from '@/lib/useMissionScores'

import './Army.css'

/*
 * Couch mode's Missions page: every open mission on one line, best first, to read at a glance.
 * The score is the Missions page's efficiency (TLM / h per 100 strength asked), with a bar for its
 * share of the best one; the second line says what it asks, the entry and what it pays; the hold
 * time sits on the right with how many of your divisions are on it, or could go. Shard-only
 * missions have their own switch, their score is in shards. Nothing is sent from here.
 */

type View = 'tlm' | 'shards' | 'fits'
const VIEWS: [View, string][] = [
  ['tlm', 'TLM & DEF'],
  ['shards', 'Shards'],
  ['fits', 'Fits now']
]

interface Row {
  e: MissionEconomics
  score: number | null
  unit: 'TLM' | 'shards'
  out: number
  fit: number
  fitHome: number
}

const short = (n: number) => formatNumber(n, Math.abs(n) >= 10 ? 1 : 2)

export function MissionsPage({ account }: { account: string }) {
  const army = useArmy(account)
  const f = useField(account)
  const [view, setView] = useState<View>('tlm')
  const divisions = useMemo(() => army.data?.divisions ?? [], [army.data])
  const econList = useMemo(() => [...f.econ.values()], [f.econ])
  const { score } = useMissionScores(divisions, econList)

  const outIds = useMemo(() => new Set(f.field.map((d) => d.divisionId)), [f.field])
  const withCrew = useMemo(() => divisions.filter((d) => d.units.length > 0), [divisions])
  const home = useMemo(
    () => withCrew.filter((d) => !outIds.has(d.id) && !(d.lock && +chainDate(d.lock.locked_until) > f.now)),
    [withCrew, outIds, f.now]
  )

  const rows = useMemo<Row[]>(
    () =>
      econList
        .filter((e) => e.state !== 'closed')
        .map((e) => {
          const s = score(e)
          return {
            e,
            score: s.efficiency ?? s.shardEff,
            unit: s.efficiency === null && s.shardEff !== null ? ('shards' as const) : ('TLM' as const),
            out: f.field.filter((d) => d.missionId === e.id).length,
            fit: withCrew.filter((d) => meetsRequirements(e, d.atk, d.def)).length,
            fitHome: home.filter((d) => meetsRequirements(e, d.atk, d.def)).length
          }
        }),
    [econList, score, f.field, withCrew, home]
  )
  const shown = useMemo(() => {
    const list = rows.filter((r) => (view === 'shards' ? r.unit === 'shards' : view === 'tlm' ? r.unit === 'TLM' : r.fitHome > 0 && r.e.state === 'active'))
    return list.sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9) || a.e.title.localeCompare(b.e.title))
  }, [rows, view])
  // Each unit's bar is a share of its own best.
  const best = useMemo(() => {
    const m = { TLM: 0, shards: 0 }
    for (const r of rows) if (r.score !== null) m[r.unit] = Math.max(m[r.unit], r.score)
    return m
  }, [rows])
  const live = rows.filter((r) => r.e.state === 'active').length

  return (
    <section className="couch__bankpage ca" aria-label="Missions">
      <div className="ca__head">
        <h3>Missions</h3>
        <small className="num">
          {f.loaded ? `${live} live · ${f.field.length} of yours out` : 'Reading…'}
        </small>
      </div>
      <div className="ca__seg" role="tablist" aria-label="Which missions">
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'is-on' : ''} onClick={() => setView(k)}>
            {label}
            {k === 'fits' && <small className="num">{home.length}</small>}
          </button>
        ))}
      </div>

      <ul className="ca__list">
        {shown.map(({ e, score: sc, unit, out, fit, fitHome }) => {
          const costs = costParts(e)
          const pays = rewardParts(e)
          const share = sc !== null && sc > 0 && best[unit] > 0 ? sc / best[unit] : 0
          const where = e.state !== 'active' ? e.state : out ? `${out} out` : view === 'fits' ? `${fitHome} at home fit` : fit ? `${fit} fit` : 'none fit'
          return (
            <li key={e.id} className={`ca__m${fit ? '' : ' is-off'}`}>
              <span
                className={`ca__eff${sc !== null && sc < 0 ? ' is-neg' : ''}${unit === 'shards' ? ' is-shards' : ''}`}
                title={sc === null ? 'No score: it pays nothing priced' : `${formatNumber(sc, 2)} ${unit} / h for every 100 points of strength it asks for`}
              >
                <b className="num">{sc === null ? '–' : short(sc)}</b>
                <i style={{ '--w': `${Math.round(share * 100)}%` } as CSSProperties} />
              </span>
              <span className="ca__nm">{e.title}</span>
              <span className="ca__tm num">{formatDuration(e.cooldownBase)}</span>
              <span className="ca__rq">
                {e.minAtk > 0 && <em className="num">{formatNumber(e.minAtk, 0)} atk</em>}
                {e.minDef > 0 && <em className="is-def num">{formatNumber(e.minDef, 0)} def</em>}
                <span className="num">
                  {costs.length ? `${costs.join(' + ')} in` : 'free'}
                  {pays.length ? ` · ${pays.join(' + ')}` : ''}
                </span>
              </span>
              <span className={`ca__ft num${out ? ' is-out' : fit && e.state === 'active' ? ' is-fit' : ''}`}>{where}</span>
            </li>
          )
        })}
        {f.loaded && !shown.length && (
          <p className="ca__none">{view === 'fits' ? (home.length ? 'No open mission fits a division at home.' : 'Every division is out.') : 'No mission of this kind is open.'}</p>
        )}
      </ul>
    </section>
  )
}
