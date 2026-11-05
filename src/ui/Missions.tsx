import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'

import { useArmy, type Division } from '@/data/game'
import { formatDuration, formatNumber } from '@/lib/format'
import { costParts, cycleSeconds, isTokenLoop, meetsRequirements, rewardParts, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import { chainDate, shortDuration } from '@/lib/time'
import { useField } from '@/lib/useField'
import { useMarket } from '@/data/game'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'

/*
 * Missions: the table and the field on one screen. The left column is the field: divisions at home
 * on top (pick one or several, or drag them onto a mission), divisions out below with their clocks,
 * the ones that are back first with their claim. The right side is the mission table, ranked for
 * the picked divisions: what each mission asks, how long it holds them, what it pays, TLM per hour
 * for the picked divisions together, and the efficiency score. Deploying is a drag of the picked
 * pieces onto a row, or the row's Send button; several picked divisions go out one transaction
 * each, signed one after another (the contract takes one join per transaction). Claiming and
 * claim-and-redeploy sit on the pieces and above the field.
 *
 * Efficiency, as on the old deck: net TLM per hour for every 100 points of the strength the mission
 * asks for (attack, or defense when it asks for more of that), for a division carrying the move
 * this army carries per 100 strength. It compares missions with each other independent of which
 * division happens to be home; the TLM / h column is the figure for the picked divisions.
 */

const MOVE_DEFAULT = 40
const MOVE_MAX = 100
const RING_R = 20
const RING_C = 2 * Math.PI * RING_R

type Filter = 'fits' | 'all' | 'tlm' | 'def' | 'shards' | 'nft'
const FILTERS: [Filter, string][] = [
  ['fits', 'Fits'],
  ['all', 'All'],
  ['tlm', 'TLM'],
  ['def', 'DEF'],
  ['shards', 'Shards'],
  ['nft', 'NFT']
]

interface Row {
  e: MissionEconomics
  /** The picked divisions that meet it (with none picked: the home divisions that do). */
  fitting: Division[]
  /** Whether every picked division meets it (with none picked: whether any home division does). */
  fits: boolean
  /** TLM / h of the fitting picked divisions together, each at its own move. */
  perHour: number | null
  efficiency: number | null
  out: number
  back: number
  short: string
}

/** The efficiency score in a ring filled to its share of the best one in the list. */
function EffRing({ score, share }: { score: number; share: number }) {
  const r = Math.max(0, Math.min(1, share))
  return (
    <span className={`effring${score < 0 ? ' is-neg' : ''}`} title={`${formatNumber(score, 2)} TLM / h for every 100 points of strength the mission asks for`}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r={RING_R} className="effring__track" />
        {r > 0 && <circle cx="24" cy="24" r={RING_R} className="effring__fill" strokeDasharray={`${RING_C * r} ${RING_C}`} />}
      </svg>
      <b>{formatNumber(score, Math.abs(score) >= 10 ? 1 : 2)}</b>
    </span>
  )
}

export function Missions({ account, spectating }: { account: string; spectating: boolean }) {
  const army = useArmy(account)
  const market = useMarket()
  const f = useField(account)
  const { now, econ, byId, field, ready, loopable } = f

  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const [filter, setFilter] = useState<Filter>('fits')
  const [dropAt, setDropAt] = useState<number | null>(null)
  const dragRef = useRef<Division[] | null>(null)

  const divisions = useMemo(() => army.data?.divisions ?? [], [army.data])
  const outIds = useMemo(() => new Set(field.map((d) => d.divisionId)), [field])
  /** Divisions with crew that are neither out nor locked: the ones that can be sent. */
  const home = useMemo(
    () =>
      f.loaded
        ? divisions.filter((d) => d.units.length > 0 && !outIds.has(d.id) && !(d.lock && +chainDate(d.lock.locked_until) > now)).sort((a, b) => b.atk - a.atk || a.id - b.id)
        : [],
    [divisions, f.loaded, outIds, now]
  )
  const idle = divisions.filter((d) => !d.units.length && !outIds.has(d.id)).length
  /** The picked divisions that are still home (a pick survives a deployment only while the division is home). */
  const chosen = useMemo(() => home.filter((d) => picked.has(d.id)), [home, picked])
  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // How much move the army carries for its strength: what the efficiency score assumes.
  const movePer100 = useMemo(() => {
    const strength = divisions.reduce((n, d) => n + Math.max(d.atk, d.def), 0)
    return strength > 0 ? Math.min(MOVE_MAX, Math.round((divisions.reduce((n, d) => n + d.move, 0) / strength) * 100)) : MOVE_DEFAULT
  }, [divisions])

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = []
    const group = chosen.length ? chosen : home
    for (const e of econ.values()) {
      if (e.state === 'closed') continue
      const fitting = group.filter((d) => meetsRequirements(e, d.atk, d.def))
      const fits = chosen.length ? fitting.length === chosen.length : fitting.length > 0
      // With none picked, the figure is for the quickest home division that fits; with picks, for all of them together.
      const counted = chosen.length ? fitting : fitting.sort((a, b) => a.move - b.move).slice(0, 1)
      const perHour = counted.length ? counted.reduce((n, d) => n + tlmPerHour(e, d.move, market), 0) : null
      const need = Math.max(e.minAtk, e.minDef)
      const assumed = Math.round((need * movePer100) / 100)
      const efficiency = need > 0 && isTokenLoop(e) ? (tlmPerHour(e, assumed, market) / need) * 100 : null
      const mine = field.filter((d) => d.missionId === e.id)
      const missing = chosen.filter((d) => !meetsRequirements(e, d.atk, d.def))
      const short =
        missing.length === 1
          ? [missing[0].atk < e.minAtk && `${formatNumber(e.minAtk - missing[0].atk, 0)} atk`, missing[0].def < e.minDef && `${formatNumber(e.minDef - missing[0].def, 0)} def`].filter(Boolean).join(', ')
          : missing.length > 1
            ? `${missing.length} of ${chosen.length} fall short`
            : ''
      list.push({ e, fitting: counted, fits, perHour, efficiency, out: mine.length, back: mine.filter((d) => d.unlockAt <= now).length, short })
    }
    // With nothing at home, Fits would show nothing: the whole list then.
    const shown = list.filter(({ e, fits }) => {
      switch (group.length ? filter : filter === 'fits' ? 'all' : filter) {
        case 'fits':
          return fits
        case 'tlm':
          return e.rewardTlm > 0
        case 'def':
          return e.rewardDef > 0
        case 'shards':
          return e.rewardShards > 0
        case 'nft':
          return !!e.rewardNft
        default:
          return true
      }
    })
    // What the picked divisions earn first; missions they cannot take after, by efficiency.
    return shown.sort((a, b) => Number(b.fits) - Number(a.fits) || (b.perHour ?? -1e9) - (a.perHour ?? -1e9) || (b.efficiency ?? -1e9) - (a.efficiency ?? -1e9) || a.e.title.localeCompare(b.e.title))
  }, [econ, home, chosen, market, movePer100, field, now, filter])
  const bestEfficiency = rows.reduce((n, r) => Math.max(n, r.efficiency ?? 0), 0)

  if (army.isError) return <p className="wrap page-msg c-bad">The army could not be read: {String(army.error)}</p>
  if (!f.loaded) return <p className="wrap page-msg muted">Contacting the field…</p>

  // ---- Drag the picked divisions (or one) onto a mission ----
  const dragProps = (d: Division) =>
    spectating
      ? {}
      : {
          draggable: true,
          onDragStart: (ev: DragEvent) => {
            ev.dataTransfer.effectAllowed = 'move'
            ev.dataTransfer.setData('text/plain', String(d.id))
            // A picked piece drags every picked piece; an unpicked one drags alone.
            dragRef.current = picked.has(d.id) && chosen.length ? chosen : [d]
          },
          onDragEnd: () => {
            dragRef.current = null
            setDropAt(null)
          }
        }
  const takes = (e: MissionEconomics, list: Division[]) => list.every((d) => meetsRequirements(e, d.atk, d.def)) && !f.sendShort(e, list)
  const dropProps = (e: MissionEconomics) => ({
    onDragOver: (ev: DragEvent) => {
      const list = dragRef.current
      if (list && takes(e, list)) {
        ev.preventDefault()
        ev.dataTransfer.dropEffect = 'move'
        if (dropAt !== e.id) setDropAt(e.id)
      }
    },
    onDragLeave: () => dropAt === e.id && setDropAt(null),
    onDrop: (ev: DragEvent) => {
      const list = dragRef.current
      if (!list || !takes(e, list)) return
      ev.preventDefault()
      dragRef.current = null
      setDropAt(null)
      f.send(e, list)
    }
  })

  const busy = !!f.pending
  const rankLabel = chosen.length === 1 ? `ranked for #${chosen[0].id} ${chosen[0].leader?.name ?? ''}` : chosen.length ? `ranked for the ${chosen.length} picked divisions together` : home.length ? 'ranked for whichever home division fits best · pick divisions on the left' : 'no division at home to rank for'

  return (
    <main className="mis wrap">
      <aside className="mis__field">
        <div className="box panel">
          <h3 className="h">
            At home
            <small>
              {home.length} with crew{idle ? ` · ${idle} empty` : ''}
            </small>
            {home.length > 1 && (
              <button type="button" className="h__link" onClick={() => setPicked(chosen.length === home.length ? new Set() : new Set(home.map((d) => d.id)))}>
                {chosen.length === home.length ? 'Clear' : 'Pick all'}
              </button>
            )}
          </h3>
          {home.length ? (
            <div className="fps">
              {home.map((d) => {
                const on = picked.has(d.id)
                return (
                  <div key={d.id} className={`fp${on ? ' is-picked' : ''}`} style={{ '--rc': rarityColor(d.leader?.rarity) } as CSSProperties} onClick={() => toggle(d.id)} {...dragProps(d)}>
                    <Portrait img={d.leader?.img} rarity={d.leader?.rarity} className="fp__pic" />
                    <span className="fp__text">
                      <b>
                        #{d.id} {d.leader?.name ?? 'No warlord'}
                      </b>
                      <small className="trio">
                        <span className="c-atk">{formatNumber(d.atk, 0)}</span>
                        <span className="c-def">{formatNumber(d.def, 0)}</span>
                        <span className="c-move">{formatNumber(d.move, 0)}</span>
                      </small>
                    </span>
                    <span className={`fp__check${on ? ' is-on' : ''}`} aria-hidden="true">
                      {on && <Icon name="check" size={12} width={2.6} />}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="none">{field.length ? 'Every division with crew is out.' : 'No division with crew. Build one on the Divisions page.'}</p>
          )}
          {home.length > 0 && !spectating && (
            <p className="help">
              {chosen.length ? `${chosen.length} picked: drag them onto a mission, or press Send in the table. Several go out one transaction each.` : 'Click to pick one or more; drag a piece onto a mission to send it.'}
            </p>
          )}
        </div>

        <div className="box panel">
          <h3 className="h">
            In the field
            <small>
              {field.length} out{ready.length ? ` · ${ready.length} back` : ''} · {formatNumber(f.earning, 1)} TLM / h
            </small>
          </h3>
          {field.length ? (
            <div className="fps">
              {field.map((x) => {
                const e = econ.get(x.missionId)
                const d = byId.get(x.divisionId)
                const back = x.unlockAt <= now
                const loop = f.redeployShort([x])
                return (
                  <div key={`${x.missionId}-${x.divisionId}`} className={`fp fp--out${back ? ' is-back' : ''}`} style={{ '--rc': rarityColor(d?.leader?.rarity) } as CSSProperties}>
                    <Portrait img={d?.leader?.img} rarity={d?.leader?.rarity} className="fp__pic" />
                    <span className="fp__text">
                      <b>
                        #{x.divisionId} · {e?.title ?? `Mission ${x.missionId}`}
                      </b>
                      <small>{back ? <span className="c-good">back · {e ? rewardParts(e).join(' + ') : 'reward'} waiting</span> : <>back in {shortDuration(x.unlockAt - now)}</>}</small>
                    </span>
                    {back ? (
                      <span className="fp__acts">
                        <button type="button" className="btn btn--sm" disabled={busy || spectating} onClick={() => f.claim([x])}>
                          <Icon name="gift" size={14} /> Claim
                        </button>
                        <button type="button" className="btn btn--sm btn--go" disabled={busy || spectating || !!loop} title={loop || `Claim and send #${x.divisionId} straight back`} onClick={() => f.redeploy([x])}>
                          <Icon name="rocket" size={14} /> & redeploy
                        </button>
                      </span>
                    ) : (
                      <span className="fp__tag is-out">{shortDuration(x.unlockAt - now)}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="none">Nothing out. Pick a division and send it on a mission.</p>
          )}
          {ready.length > 1 && (
            <div className="fps__foot">
              <button type="button" className="btn btn--sm" disabled={busy || spectating} onClick={() => f.claim(ready)}>
                <Icon name="gift" size={14} /> Claim all ({ready.length})
              </button>
              <button
                type="button"
                className="btn btn--sm btn--go"
                disabled={busy || spectating || !loopable.length || !!f.redeployShort(loopable)}
                title={f.redeployShort(loopable) || 'Claims every ready reward and sends those divisions back to the same missions'}
                onClick={() => f.redeploy(loopable)}
              >
                <Icon name="rocket" size={14} /> Claim & redeploy ({loopable.length})
              </button>
            </div>
          )}
          {spectating && <p className="help">Read-only: {account}&apos;s field. Connect your wallet to act on your own.</p>}
        </div>
      </aside>

      <section className="box mis__table">
        <div className="mis__bar">
          <h3 className="h">
            Missions
            <small>{rankLabel}</small>
          </h3>
          <span className="seg seg--pick">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>
                {k === 'fits' && chosen.length ? (chosen.length === 1 ? `Fits #${chosen[0].id}` : `Fits all ${chosen.length}`) : label}
              </button>
            ))}
          </span>
        </div>
        <div className="mis__scroll">
          <table className="mt">
            <thead>
              <tr>
                <th>Mission</th>
                <th>Needs</th>
                <th>Holds for</th>
                <th>Pays</th>
                <th className="num" title={chosen.length ? 'Net TLM per hour of the picked divisions together on this mission, after swaps' : 'Net TLM per hour for the quickest home division that fits'}>
                  TLM / h
                </th>
                <th title={`Net TLM per hour for every 100 points of strength the mission asks for, for a division carrying ${movePer100} move per 100 strength (this army's ratio). The ring is its share of the best in the list.`}>
                  Efficiency
                </th>
                <th>Yours</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ e, fitting, fits, perHour, efficiency, out, back, short }) => {
                const open = e.state === 'active'
                const sendList = chosen.length ? chosen : fitting
                const canSend = !!sendList.length && fits && open && !spectating
                const fund = canSend ? f.sendShort(e, sendList) : ''
                const costs = costParts(e)
                const slowest = fitting.reduce((m, d) => Math.max(m, d.move), 0)
                return (
                  <tr key={e.id} className={`${fits ? '' : 'is-off'}${dropAt === e.id ? ' is-target' : ''}`} {...dropProps(e)}>
                    <td className="mt__title">
                      <b>{e.title}</b>
                      <small>
                        {e.planet}
                        {!open ? ` · ${e.state}` : ''}
                        {costs.length ? ` · entry ${costs.join(' + ')}` : ' · free entry'}
                      </small>
                    </td>
                    <td className="num">
                      {e.minAtk > 0 && <span className="c-atk">{formatNumber(e.minAtk, 0)} atk</span>}
                      {e.minAtk > 0 && e.minDef > 0 ? ' · ' : ''}
                      {e.minDef > 0 && <span className="c-def">{formatNumber(e.minDef, 0)} def</span>}
                      {short && <small className="mt__short">short {short}</small>}
                    </td>
                    <td className="num">
                      {formatDuration(e.cooldownBase)}
                      {fits && slowest > 0 && (
                        <small className="muted">
                          {' '}
                          · {formatDuration(cycleSeconds(e, slowest))} at {slowest} move
                        </small>
                      )}
                    </td>
                    <td>{rewardParts(e).join(' + ') || '—'}</td>
                    <td className="num mt__rate">
                      {perHour === null ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          <b className={perHour < 0 ? 'c-bad' : ''}>{formatNumber(perHour, 1)}</b>
                          {fitting.length > 1 && <small className="muted"> · {fitting.length} divisions</small>}
                        </>
                      )}
                    </td>
                    <td>{efficiency === null ? <span className="muted">—</span> : <EffRing score={efficiency} share={bestEfficiency > 0 ? efficiency / bestEfficiency : 0} />}</td>
                    <td className="num">
                      {out ? (
                        <>
                          {out} out{back ? <span className="c-good"> · {back} back</span> : ''}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mt__act">
                      {dropAt === e.id ? (
                        <span className="mt__drop">drop to send</span>
                      ) : canSend ? (
                        <button type="button" className="btn btn--sm" disabled={busy || !!fund} title={fund || (sendList.length > 1 ? `${sendList.length} transactions, one join each` : undefined)} onClick={() => f.send(e, sendList)}>
                          <Icon name="rocket" size={14} /> {sendList.length === 1 ? `Send #${sendList[0].id}` : `Send ${sendList.length}`}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={8}>
                    <p className="none">{filter === 'fits' ? (chosen.length ? 'No open mission that all picked divisions meet. Pick fewer, or try All.' : home.length ? 'No open mission any home division meets.' : 'Nothing at home to send.') : 'No mission matches.'}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="help">
          TLM / h is net of entry fees and swaps, at the divisions&apos; own move costs. Efficiency scores the mission itself: TLM / h per 100 strength asked, at {movePer100} move per 100 strength (this army&apos;s ratio), TLM
          and DEF only; shards and NFTs are not counted.
        </p>
      </section>
    </main>
  )
}
