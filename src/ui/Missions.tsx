import { useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'

import { useArmy, useMissionEntries, type Division } from '@/data/game'
import { formatDuration, formatNumber } from '@/lib/format'
import { costParts, cycleSeconds, isTokenLoop, meetsRequirements, rewardParts, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import { chainDate, shortDuration } from '@/lib/time'
import { useField } from '@/lib/useField'
import { useMarket, useRewardPool } from '@/data/game'
import { useNftFloors, useSwapPools } from '@/data/market'
import { receiveFor } from '@/lib/pool'

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
function EffRing({ score, share, note }: { score: number; share: number; note?: string }) {
  const r = Math.max(0, Math.min(1, share))
  return (
    <span className={`effring${score < 0 ? ' is-neg' : ''}`} title={`${formatNumber(score, 2)} TLM / h for every 100 points of strength the mission asks for${note ? `. ${note}` : ''}`}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r={RING_R} className="effring__track" />
        {r > 0 && <circle cx="24" cy="24" r={RING_R} className="effring__fill" strokeDasharray={`${RING_C * r} ${RING_C}`} />}
      </svg>
      <b>{formatNumber(score, Math.abs(score) >= 10 ? 1 : 2)}</b>
    </span>
  )
}

/** A per-day amount, short: 4,120 · 312 · 8.4 · 0.36. */
const perDayNum = (n: number) => formatNumber(n, n >= 100 ? 0 : n >= 10 ? 1 : 2)

/** What a mission pays out per day to every division out on it now (cycles per day × its reward). */
function outputCell(e: MissionEconomics, perDay: number) {
  if (perDay <= 0) return <span className="muted">—</span>
  const parts: string[] = []
  if (e.rewardTlm > 0) parts.push(`${perDayNum(e.rewardTlm * perDay)} TLM`)
  if (e.rewardDef > 0) parts.push(`${perDayNum(e.rewardDef * perDay)} DEF`)
  if (e.rewardNft) parts.push(`${perDayNum(e.rewardNft.count * perDay)} NFTs`)
  if (e.rewardShards > 0) parts.push(`${perDayNum(e.rewardShards * perDay)} shards`)
  if (!parts.length) return <span className="muted">—</span>
  return parts.map((p, i) => (
    <span key={p}>
      {i > 0 && <br />}
      {p}
    </span>
  ))
}

export function Missions({ account, spectating }: { account: string; spectating: boolean }) {
  const army = useArmy(account)
  const market = useMarket()
  const f = useField(account)
  const { now, econ, byId, field, ready, loopable } = f

  const [picked, setPicked] = useState<Set<number>>(() => new Set())
  const [filter, setFilter] = useState<Filter>('fits')
  /** The list sorted by when each mission ends (the Ends header). */
  const [byEnd, setByEnd] = useState(false)
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

  // NFT rewards are valued at the floor (the cheapest WAX listing of the template), then as TLM
  // through the WAX → TLM pool, so NFT missions get an efficiency too.
  const pools = useSwapPools()
  const nftIds = useMemo(() => [...econ.values()].flatMap((e) => (e.rewardNft ? [String(e.rewardNft.templateId)] : [])), [econ])
  const floors = useNftFloors(nftIds)
  /** The TLM a mission's NFT reward is worth per cycle; 0 without one, null while its floor is unknown. */
  const nftTlm = useMemo(() => {
    const tlmPool = pools.data?.tlm
    return (e: MissionEconomics): number | null => {
      if (!e.rewardNft) return 0
      const wax = floors.data?.get(String(e.rewardNft.templateId))
      if (wax === undefined || !tlmPool) return null
      return receiveFor(tlmPool, 'WAX', wax * e.rewardNft.count)
    }
  }, [floors.data, pools.data])

  /** How an NFT reward was valued, for the efficiency tooltip. */
  const nftNote = (e: MissionEconomics): string | undefined => {
    if (!e.rewardNft) return undefined
    const wax = floors.data?.get(String(e.rewardNft.templateId))
    const tlm = nftTlm(e)
    if (wax === undefined || tlm === null) return floors.isLoading ? 'Reading the NFT floor…' : 'The NFT has no listing, so it is not counted'
    return `The NFT counts at its floor: ${formatNumber(wax, 2)} WAX${e.rewardNft.count > 1 ? ` each, ×${e.rewardNft.count}` : ''} ≈ ${formatNumber(tlm, 1)} TLM a cycle (the cheapest listing, before market fees)`
  }

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
      // Tokens after swaps, plus the NFT at its floor when it has one; an NFT-only mission waits for its floor.
      const nft = nftTlm(e)
      const nftPerHour = nft && cycleSeconds(e, assumed) > 0 ? (nft / cycleSeconds(e, assumed)) * 3600 : 0
      const efficiency = need > 0 && (isTokenLoop(e) || nft !== null && nft > 0) ? ((tlmPerHour(e, assumed, market) + nftPerHour) / need) * 100 : null
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
  }, [econ, home, chosen, market, movePer100, field, now, filter, nftTlm])
  const bestEfficiency = rows.reduce((n, r) => Math.max(n, r.efficiency ?? 0), 0)

  // The whole game's flow per hour, from every player's divisions still running (as on the old deck):
  // each one joins again as soon as its cycle ends (its own join-to-unlock time), paying the entry
  // and collecting the reward. Divisions back and waiting for the claim are left out.
  const open = useMemo(() => [...econ.values()].filter((e) => e.state !== 'closed'), [econ])
  const flowIds = useMemo(() => open.filter((e) => e.joined > 0).map((e) => e.id), [open])
  const entries = useMissionEntries(flowIds)
  const flow = useMemo(() => {
    const t = { divisions: 0, atk: 0, def: 0, tlmIn: 0, defIn: 0, tlmOut: 0, defOut: 0, chestsOut: 0 }
    /** Per mission: the divisions still out on it, their players, and its cycles per day (to price its output). */
    const crowd = new Map<number, { players: number; divisions: number; perDay: number }>()
    for (const e of open) {
      const list = (entries.data?.get(e.id) ?? []).filter((r) => +chainDate(r.unlock_time) > now)
      if (!list.length) continue
      const cycles = list.reduce((n, r) => {
        const ms = +chainDate(r.unlock_time) - +chainDate(r.join_time)
        return ms > 0 ? n + 3_600_000 / ms : n
      }, 0)
      crowd.set(e.id, { players: new Set(list.map((r) => r.owner)).size, divisions: list.length, perDay: cycles * 24 })
      t.divisions += list.length
      for (const r of list) {
        t.atk += Number(r.atk) || 0
        t.def += Number(r.def) || 0
      }
      t.tlmIn += cycles * e.costTlm
      t.defIn += cycles * e.costDef
      t.tlmOut += cycles * e.rewardTlm
      t.defOut += cycles * e.rewardDef
      if (e.rewardNft) t.chestsOut += cycles * e.rewardNft.count
    }
    return { ...t, crowd }
  }, [open, entries.data, now])
  // Until every entry is read the figures wait, rather than show a guess.
  const flowReady = !!entries.data || !flowIds.length
  // How long the TLM left for player rewards lasts: entry fees flow back into the pool, so only the
  // payout above them drains it.
  const pool = useRewardPool()
  const drain = flow.tlmOut - flow.tlmIn
  const lasts = (() => {
    if (!flowReady || pool.data === undefined) return '…'
    if (drain <= 0) return 'not draining'
    const h = pool.data / drain
    if (h >= 24 * 365) return 'over a year'
    const d = Math.floor(h / 24)
    const rest = Math.floor(h % 24)
    return d ? `${d} d ${rest} h` : `${Math.max(0, Math.floor(h))} h ${Math.floor((h % 1) * 60)} m`
  })()

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

  // ---- How long each mission stays open: an Ends column, sortable, and this week's endings first ----
  const DAY = 86_400_000
  const ends = (e: (typeof rows)[number]['e']) => (e.state === 'upcoming' ? Infinity : e.endAt - f.now)
  const endsText = (ms: number) => {
    const d = ms / DAY
    return d < 1 ? `${Math.max(0, Math.round(ms / 3_600_000))} h` : d < 3 ? `${Math.floor(d)} d ${Math.round((d % 1) * 24)} h` : `${Math.round(d)} d`
  }
  const endsCell = (e: (typeof rows)[number]['e']) => {
    if (e.state === 'upcoming')
      return (
        <>
          <span className="muted">starts</span>
          <small>{new Date(e.startAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small>
        </>
      )
    if (!Number.isFinite(e.endAt)) return <span className="muted">—</span>
    const left = e.endAt - f.now
    return (
      <span title={`Open until ${new Date(e.endAt).toLocaleString()}. A division already out when it ends keeps its lock and reward.`}>
        <b className={left < 3 * DAY ? 'c-bad' : left < 7 * DAY ? 'mt__soon' : ''}>{left <= 0 ? 'ended' : endsText(left)}</b>
        <small>{new Date(e.endAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small>
      </span>
    )
  }
  const ordered = byEnd ? [...rows].sort((a, b) => ends(a.e) - ends(b.e)) : rows
  const soon = ordered.filter((x) => ends(x.e) < 7 * DAY)
  const later = ordered.filter((x) => ends(x.e) >= 7 * DAY)
  const renderRow = ({ e, fitting, fits, perHour, efficiency, out, back, short }: (typeof rows)[number]) => {
            const open = e.state === 'active'
            const sendList = chosen.length ? chosen : fitting
            const canSend = !!sendList.length && fits && open && !spectating
            const fund = canSend ? f.sendShort(e, sendList) : ''
            const costs = costParts(e)
            const slowest = fitting.reduce((m, d) => Math.max(m, d.move), 0)
            return (
              <tr key={e.id} className={`${fits ? '' : 'is-off'}${dropAt === e.id ? ' is-target' : ''}`} {...dropProps(e)}>
                <td className="mt__title">
                  <b>
                    {e.title}
                    {(() => {
                      const c = flow.crowd.get(e.id)
                      return c ? (
                        <span
                          className="mt__crowd"
                          title={`${c.divisions} division${c.divisions === 1 ? '' : 's'} out on this mission right now, from ${c.players} player${c.players === 1 ? '' : 's'}, your own counted too. Divisions back and waiting for the claim are not counted.`}
                        >
                          <Icon name="army" size={12} />
                          {formatNumber(c.divisions, 0)}
                        </span>
                      ) : null
                    })()}
                  </b>
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
                <td className="num mt__out">{outputCell(e, flow.crowd.get(e.id)?.perDay ?? 0)}</td>
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
                <td>{efficiency === null ? <span className="muted">—</span> : <EffRing score={efficiency} share={bestEfficiency > 0 ? efficiency / bestEfficiency : 0} note={nftNote(e)} />}</td>
                <td className="num mt__ends">{endsCell(e)}</td>
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
  }
  const tbody = soon.length ? (
    <>
      <tr className="mt__group">
        <td colSpan={10}>
          <em>Ending this week</em> · {soon.length} mission{soon.length === 1 ? '' : 's'}
        </td>
      </tr>
      {soon.map(renderRow)}
      {later.length > 0 && (
        <tr className="mt__group">
          <td colSpan={10}>Later</td>
        </tr>
      )}
      {later.map(renderRow)}
    </>
  ) : (
    ordered.map(renderRow)
  )

  return (
    <main className="mis wrap">
      <section className="box mis__flow" aria-label="The whole game's flow, from every player's divisions out now">
        {(
          [
            ['Divisions out', flow.divisions, '', "Every player's divisions still running on an open mission right now; those back and waiting for the claim are not counted."],
            ['Attack out', flow.atk, 'c-atk', 'The attack of all those divisions together, as each had it when it joined.'],
            ['Defense out', flow.def, 'c-def', 'The defense of all those divisions together, as each had it when it joined.'],
            [
              drain >= 0 ? 'TLM deficit / h' : 'TLM surplus / h',
              Math.abs(drain),
              drain > 0 ? 'c-bad' : 'c-good',
              `TLM per hour if every division out joins its mission again as soon as its cycle ends: the missions pay out ${formatNumber(flow.tlmOut, 0)} TLM and take in ${formatNumber(flow.tlmIn, 0)} TLM in entry fees, so the reward pool ${drain >= 0 ? `loses ${formatNumber(drain, 0)}` : `gains ${formatNumber(-drain, 0)}`} TLM an hour.`
            ],
            ['DEF demand / h', flow.defIn, 'c-def', 'DEF paid in entry fees per hour if every division out joins its mission again as soon as its cycle ends.'],
            ['DEF payout / h', flow.defOut, 'c-def', 'DEF the missions pay out per hour to the divisions out now, each on its own cycle.'],
            ['Chests / h', flow.chestsOut, '', 'NFT chests the missions pay out per hour to the divisions out now, each on its own cycle.']
          ] as const
        ).map(([label, value, tone, help]) => (
          <div key={label} className="mis__fig" title={help}>
            <small className={tone}>{label}</small>
            <b>{flowReady ? formatNumber(value, value > 0 && value < 10 ? 1 : 0) : '…'}</b>
          </div>
        ))}
        <div
          className="mis__fig"
          title={
            pool.data === undefined
              ? 'Reading the reward pool…'
              : `${formatNumber(pool.data, 0)} TLM left for player rewards (miss.pdef). The payout per hour minus the entry fees per hour that flow back in drains it by ${formatNumber(Math.max(0, drain), 0)} TLM an hour${drain > 0 ? ', so it lasts this long at today\'s pace.' : '; at today\'s pace it is not shrinking.'}`
          }
        >
          <small className={drain > 0 && pool.data !== undefined && pool.data / drain < 72 ? 'c-bad' : ''}>Rewards last</small>
          <b>{lasts}</b>
        </div>
      </section>
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
                <th className="num" title="What this mission pays out per day to every division out on it now, from all players: each division is counted as rejoining as soon as its cycle ends.">
                  Out / day
                </th>
                <th className="num" title={chosen.length ? 'Net TLM per hour of the picked divisions together on this mission, after swaps' : 'Net TLM per hour for the quickest home division that fits'}>
                  TLM / h
                </th>
                <th title={`Net TLM per hour for every 100 points of strength the mission asks for, for a division carrying ${movePer100} move per 100 strength (this army's ratio). The ring is its share of the best in the list.`}>
                  Efficiency
                </th>
                <th className="num">
                  <button type="button" className={`mt__sort${byEnd ? ' is-on' : ''}`} aria-pressed={byEnd} title={byEnd ? 'Sorted by when the mission ends; click for the usual order' : 'Sort by when the mission ends'} onClick={() => setByEnd((v) => !v)}>
                    Ends {byEnd ? '▴' : '▾'}
                  </button>
                </th>
                <th>Yours</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tbody}
              {!rows.length && (
                <tr>
                  <td colSpan={10}>
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
