import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import { addUnit, assignGear, createDivision } from '@/chain/actions/pd'
import { toast } from '@/components/toast'
import type { AssetRef } from '@/data/assets'
import { useArmy, useMissionConfig } from '@/data/game'
import type { SlotKind } from '@/lib/bundle'
import { formatDuration, formatNumber } from '@/lib/format'
import { missionEconomics, rewardParts, type MissionEconomics } from '@/lib/loop'
import { FAST_MOVE_WEIGHT, planMissionDivision, type MissionPlan } from '@/lib/missionDivision'
import { GEAR_KINDS, missionLockSeconds, type Kind } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'

/*
 * A division built for one mission, from the reserve alone (staked NFTs in no division). The player
 * picks the mission and what matters most; the solver from the deck picks the warlord, the
 * mercenaries and their gear, and the result is shown in place before anything is signed.
 *
 *   Fastest   every move point weighs heavily: the shortest mission lock that still qualifies.
 *   Move cap  the cheapest division whose move cost stays at or under the number given.
 *   Cheapest  move does not count: the least valuable cards (by rarity) that still reach the
 *             requirement, so commons fill the places and the rare ones stay free.
 */

export type BuildMode = 'fast' | 'move' | 'cheap'

const MODES: { id: BuildMode; label: string; help: string }[] = [
  { id: 'fast', label: 'Fastest', help: 'The shortest mission lock that still meets the requirement.' },
  { id: 'move', label: 'Move cap', help: 'The cheapest division that stays at or under the move cost you set.' },
  {
    id: 'cheap',
    label: 'Cheapest',
    help: 'Your least valuable cards that still reach the requirement: commons fill the places, the rare ones stay free.'
  }
]

const MOVE_KEY = 'pd-army.build-move'
const readMove = () => {
  try {
    return localStorage.getItem(MOVE_KEY) ?? '400'
  } catch {
    return '400'
  }
}

/** The plan's NFTs, grouped by template for a short list. */
function grouped(list: AssetRef[]) {
  const m = new Map<string, { a: AssetRef; n: number }>()
  for (const a of list) {
    const g = m.get(a.templateId)
    if (g) g.n++
    else m.set(a.templateId, { a, n: 1 })
  }
  return [...m.values()]
}

/**
 * What tying up a card costs, by rarity: each step up is worth several of the one below, so a
 * common is always spent before a rare. The card's strength only breaks ties (the weaker one goes).
 */
const RARITY_COST: Record<string, number> = { common: 1, uncommon: 4, rare: 16, epic: 64, legendary: 256, mythic: 1024 }
const byRarity = (a: AssetRef, usual: number) => (RARITY_COST[a.rarity] ?? 1) * 100 + usual / 100

const optionsFor = (mode: BuildMode, maxMove: number) =>
  mode === 'fast'
    ? { moveWeight: FAST_MOVE_WEIGHT }
    : mode === 'cheap'
      ? { moveWeight: 0, costOf: byRarity }
      : { maxMove, costOf: byRarity }

interface Result {
  key: string
  plan: MissionPlan | null
  /** With a move cap no division fits under: the fastest one there is, to say how low it can go. */
  fastest?: MissionPlan | null
}

export function MissionBuilder({
  account,
  free,
  forgeLevel,
  slotsFree,
  blocked,
  onBuilt
}: {
  account: string
  free: Record<Kind, AssetRef[]>
  forgeLevel: number
  slotsFree: Record<SlotKind, number>
  /** Why no division can be raised now (read-only, no places left), or null. */
  blocked: string | null
  /** Called with the new division's warlord once it is built. */
  onBuilt: (leaderAssetId: string) => void
}) {
  const config = useMissionConfig()
  const army = useArmy(account)
  const { run, pending } = useTransaction()
  const [missionId, setMissionId] = useState<number | null>(null)
  const [mode, setMode] = useState<BuildMode>('fast')
  const [moveText, setMoveText] = useState(readMove)
  const maxMove = Math.max(0, Math.floor(Number(moveText) || 0))
  const [result, setResult] = useState<Result | null>(null)

  const missions = useMemo(() => {
    if (!config.data) return []
    const seen = new Set<string>()
    return config.data.missions
      .map((row) => missionEconomics(row, config.data!))
      .filter((e) => e.state === 'active' && (e.minAtk > 0 || e.minDef > 0))
      .sort((a, b) => a.minAtk + a.minDef - (b.minAtk + b.minDef))
      .filter((e) => {
        // Missions with the same title and requirement build the same division: one is enough.
        const k = `${e.title}/${e.minAtk}/${e.minDef}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
  }, [config.data])
  const mission = missions.find((m) => m.id === missionId) ?? null

  // The reserve by content: the army hands over new objects on every read.
  const reserveKey = useMemo(
    () => JSON.stringify([Object.values(free).map((l) => l.map((a) => a.assetId)), forgeLevel, slotsFree]),
    [free, forgeLevel, slotsFree]
  )
  const planKey = mission ? `${reserveKey}|${mission.id}|${mode}|${mode === 'move' ? maxMove : ''}` : ''

  useEffect(() => {
    try {
      localStorage.setItem(MOVE_KEY, moveText)
    } catch {
      /* storage unavailable */
    }
  }, [moveText])

  // Planned a moment after the last change, off the click, so the page never stalls.
  useEffect(() => {
    if (!mission || (mode === 'move' && !(maxMove > 0))) return
    let cancelled = false
    const t = setTimeout(() => {
      const target = { atk: mission.minAtk, def: mission.minDef }
      const plan = planMissionDivision(free, target, forgeLevel, slotsFree, optionsFor(mode, maxMove))
      const fastest = mode === 'move' && !plan ? planMissionDivision(free, target, forgeLevel, slotsFree, optionsFor('fast', 0)) : undefined
      if (!cancelled) setResult({ key: planKey, plan, fastest })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // The reserve's content is in planKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey])

  const ready = result?.key === planKey
  const plan = ready ? result!.plan : null

  async function build(m: MissionEconomics, p: MissionPlan) {
    const b = p.bundle
    const ref = (key: string) => p.assets.get(key)!
    const leader = ref(b.warlord.key).assetId
    const created = await run((a, pm) => createDivision(a, pm, leader), 'Division raised, now adding the crew…', 'build')
    if (!created) return
    // The new division's number is only known once the chain shows it.
    let divisionId: number | null = null
    for (let i = 0; i < 10 && divisionId === null; i++) {
      const fresh = await army.refetch()
      divisionId = fresh.data?.divisions.find((d) => d.leader?.assetId === leader)?.id ?? null
      if (divisionId === null) await new Promise((r) => setTimeout(r, 1500))
    }
    if (divisionId === null) {
      toast.error('The new division has not shown up yet. Open it in a moment and add the crew from the Reserve tab.')
      onBuilt(leader)
      return
    }
    const div = divisionId
    await run(
      (a, pm) => [
        ...b.units.map((u) => addUnit(a, pm, div, ref(u.merc.key).assetId)),
        ...b.units.flatMap((u) =>
          GEAR_KINDS.filter((k) => u.gear[k]).map((k) => assignGear(a, pm, div, ref(u.merc.key).assetId, k, ref(u.gear[k]!.key).assetId))
        )
      ],
      `Division #${div} is ready for ${m.title}`,
      'build',
      { split: true }
    )
    onBuilt(leader)
  }

  if (!config.data) return <p className="none">Reading the missions…</p>

  const lock = (move: number) => (mission ? formatDuration(missionLockSeconds(mission.cooldownBase, move)) : '')

  return (
    <div className="mb">
      <div className="mb__missions">
        <span className="group__h">1 · Mission</span>
        <div className="mb__list">
          {missions.map((m) => (
            <button key={m.id} type="button" className={`mbm${m.id === missionId ? ' is-on' : ''}`} onClick={() => setMissionId(m.id)}>
              <Portrait img={m.image} className="mbm__pic" whole />
              <span className="mbm__text">
                <b>{m.title || `Mission ${m.id}`}</b>
                <small>
                  <span className="c-atk">{formatNumber(m.minAtk, 0)} atk</span> · <span className="c-def">{formatNumber(m.minDef, 0)} def</span>
                </small>
                <small className="muted">{rewardParts(m).join(' · ') || 'No token reward'}</small>
              </span>
            </button>
          ))}
          {!missions.length && <p className="none">No mission is open right now.</p>}
        </div>
      </div>

      <div className="mb__plan">
        <span className="group__h">2 · What matters most</span>
        <div className="seg">
          {MODES.map((x) => (
            <button key={x.id} type="button" className={mode === x.id ? 'is-on' : ''} onClick={() => setMode(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <p className="help mb__help">{MODES.find((x) => x.id === mode)!.help}</p>
        {mode === 'move' && (
          <label className="mb__move">
            <span>Move cost at most</span>
            <input className="input" inputMode="numeric" value={moveText} onChange={(e) => setMoveText(e.target.value.replace(/[^\d]/g, ''))} />
            {mission && maxMove > 0 && <small className="muted">a lock of up to {lock(maxMove)}</small>}
          </label>
        )}

        <span className="group__h">3 · Your division</span>
        {!mission ? (
          <p className="none">Pick a mission on the left.</p>
        ) : mode === 'move' && !(maxMove > 0) ? (
          <p className="none">Enter the highest move cost you want.</p>
        ) : !ready ? (
          <p className="none">Working out the best division…</p>
        ) : !plan ? (
          <p className="none">
            {mode === 'move' && result?.fastest
              ? `No division from your reserve meets ${mission.title} under ${formatNumber(maxMove, 0)} move. The fastest one there is needs ${formatNumber(result.fastest.bundle.move, 0)}.`
              : `Your reserve cannot reach ${formatNumber(mission.minAtk, 0)} attack and ${formatNumber(mission.minDef, 0)} defense. Stake more, or free some mercenaries from a division.`}
          </p>
        ) : (
          <PlanView plan={plan} mission={mission} lock={lock(plan.bundle.move)} />
        )}

        {plan && mission && (
          <div className="mb__go">
            <button type="button" className="btn btn--go" disabled={!!blocked || !!pending} title={blocked ?? undefined} onClick={() => void build(mission, plan)}>
              <Icon name="army" />
              {pending === 'build' ? 'Signing…' : 'Build this division'}
            </button>
            <small className="muted">{blocked ?? 'Two signatures: one raises the division, the next adds its crew and gear.'}</small>
          </div>
        )}
      </div>
    </div>
  )
}

function PlanView({ plan, mission, lock }: { plan: MissionPlan; mission: MissionEconomics; lock: string }) {
  const b = plan.bundle
  const warlord = plan.assets.get(b.warlord.key)!
  const mercs = grouped(b.units.map((u) => plan.assets.get(u.merc.key)!))
  const gear = grouped(GEAR_KINDS.flatMap((k) => b.gear[k].map((g) => plan.assets.get(g.key)!)))
  return (
    <div className="pv">
      <div className="pv__lead" style={{ '--rc': rarityColor(warlord.rarity) } as CSSProperties}>
        <Portrait img={warlord.img} rarity={warlord.rarity} className="pv__pic" />
        <span>
          <b>{warlord.name}</b>
          <small className="muted">
            leads {b.units.length} of {b.warlord.slots} places
          </small>
        </span>
      </div>
      <div className="pv__stats">
        <div className="stat">
          <small className="c-atk">
            <Icon name="atk" size={14} /> Attack
          </small>
          <b>{formatNumber(b.atk, 0)}</b>
          <small className="muted">needs {formatNumber(mission.minAtk, 0)}</small>
        </div>
        <div className="stat">
          <small className="c-def">
            <Icon name="def" size={14} /> Defense
          </small>
          <b>{formatNumber(b.def, 0)}</b>
          <small className="muted">needs {formatNumber(mission.minDef, 0)}</small>
        </div>
        <div className="stat">
          <small className="c-move">
            <Icon name="move" size={14} /> Move cost
          </small>
          <b>{formatNumber(b.move, 0)}</b>
          <small className="muted">lock {lock}</small>
        </div>
      </div>
      <div className="pv__rows">
        {mercs.map(({ a, n }) => (
          <span key={a.templateId} className="pv__row" style={{ '--rc': rarityColor(a.rarity) } as CSSProperties}>
            <Portrait img={a.img} rarity={a.rarity} className="pv__mini" />
            <b>{a.name}</b>
            <em className="times">×{n}</em>
          </span>
        ))}
        {gear.map(({ a, n }) => (
          <span key={a.templateId} className="pv__row is-gear" style={{ '--rc': rarityColor(a.rarity) } as CSSProperties}>
            <Portrait img={a.img} rarity={a.rarity} className="pv__mini" />
            <b>{a.name}</b>
            <em className="times">×{n}</em>
          </span>
        ))}
      </div>
    </div>
  )
}
