import { useEffect, useMemo, useState } from 'react'

import { createDivision, deployActions, stakeAssets } from '@/chain/actions/pd'
import { divisionAllowance } from '@/chain/config'
import { toast } from '@/components/toast'
import { useArmy, useDeployments, useGameBalance, useMarket, useMissionConfig, usePlayer, useWalletNfts, type Division } from '@/data/game'
import { useNftFloors, useSwapPools } from '@/data/market'
import { diffArmy } from '@/lib/armyDiff'
import { bestLoop, candidateMissions, poolOf } from '@/lib/armyOptimizer'
import { readPresets, snapshot, writePresets, type Preset, type PresetDivision } from '@/lib/armyPresets'
import { EFFORTS, type EffortLevel, type PlannedDivision, type SearchInput } from '@/lib/armySearch'
import type { SlotKind } from '@/lib/bundle'
import { coveredBy, walletCosts, walletPart } from '@/lib/deposit'
import { formatNumber } from '@/lib/format'
import { missionEconomics, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import { receiveFor } from '@/lib/pool'
import { GEAR_KINDS, kindOf, type Kind } from '@/lib/stats'
import { useClockFor } from '@/lib/time'
import { useArmyPotential } from '@/lib/useArmyPotential'
import { useArmySearch } from '@/lib/useArmySearch'
import { divisionState } from '@/ui/divisionState'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * The optimizer's state and work, shared by Divisions → Optimize army and couch mode's Army page:
 * the settings (kept in this browser), the search, the answer, saving it as a preset, and signing
 * it (stake, take apart, raise, fill) step by step. "Ready" leaves divisions that are out as they
 * are and works with the rest; "all" pretends everything were home: a comparison only.
 */

export type Mode = 'ready' | 'all'
export type Step = 'stake' | 'free' | 'create' | 'fill'

export const SLOT_POWERUP: Record<SlotKind, string> = { weapon: 'eqpslot', supply: 'supslot', lavalux: 'lavaslot' }
/**
 * How hard the search works, counted in work rather than time, so the same army gives the same
 * answer whatever else the computer is doing. Several seeds run side by side and the best wins.
 */
export const EFFORT_LEVELS: { key: EffortLevel; label: string; what: string }[] = [
  { key: 'quick', label: 'Quick', what: 'The 6 most promising missions, a short rearrange. One to three minutes on a big army, the longer with balancing.' },
  { key: 'normal', label: 'Normal', what: 'The 12 most promising missions at more counts, a longer rearrange. Four to six minutes on a big army with balancing.' },
  { key: 'thorough', label: 'Thorough', what: 'Up to 30 missions at many counts, a long rearrange that stops only when it stops finding anything. Fifteen minutes or more on a big army.' }
]
export const STORE_EFFORT = 'pd-army.opt.effort'
/** The phases of a search, in order, with what each one does. */
export const PHASES: { id: string; label: string; what: string; balancingOnly?: boolean }[] = [
  { id: 'starting', label: 'Read', what: 'The army as it stands, scored; a trimmed copy of it as a first improvement.' },
  { id: 'coverage', label: 'Coverage', what: 'Every mission at every count, each a whole army: the systematic sweep, most promising first.' },
  { id: 'annealing', label: 'Rearrange', what: 'Millions of small changes from the best starting points, taking turns; this finds the best TLM / h.' },
  { id: 'polishing', label: 'Polish', what: 'Every single change tried once more; the answer is a true local optimum.' },
  { id: 'balancing', label: 'Balance', what: 'The second answer: same divisions, cards shuffled so each mission length comes back close together.', balancingOnly: true },
  { id: 'checking', label: 'Check', what: 'Every division recomputed with the contract formula and checked against its mission, slots and allowance.' }
]
export const PHASE: Record<string, string> = Object.fromEntries(PHASES.map((p) => [p.id, p.what]))

export const STORE_ALIGN = 'pd-army.opt.align'
export const STORE_OFF = 'pd-army.opt.off'
export const STORE_WALLET = 'pd-army.opt.wallet'
export const STORE_WEIGHT = 'pd-army.opt.match-weight'
export const STORE_GOAL = 'pd-army.opt.match-goal'
/** Goal slider stops: minutes apart the divisions of one length may come back; ten seconds per move point. */
export const GOALS = [0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30]
/** Within-goal slider stops: TLM an hour per move point it may still give up once the goal is reached. */
export const WITHIN = [0, 0.02, 0.05, 0.1, 0.25, 0.5, 1]
export const STORE_WITHIN = 'pd-army.opt.within'
/** Slider stops: TLM an hour the balancing may give up per move point of spread; the last is any price. */
export const WEIGHTS = [2, 5, 10, 25, 100, Infinity]
export const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
export const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export interface Run {
  done: Step[]
  failed: Step | null
  /** New division numbers by warlord, known after "create". */
  created: Map<string, number>
}

/** A planned division, or one of the player's own shown the same way (then it may have no paying mission, and says where it is). */
export type ShownDivision = Omit<PlannedDivision, 'mission'> & { mission?: MissionEconomics; tag?: string }

export function useOptimizer(
  account: string,
  opts: {
    sessionAccount: string
    spectating: boolean
    /** The army was deployed: show it. */
    onDone: (divisionId: number | null) => void
    /** Also work out what the wallet could field with everything home (Divisions page only: it costs a background search). */
    potential: boolean
  }
) {
  const { sessionAccount, spectating, onDone } = opts
  const [mode, setMode] = useState<Mode>('ready')
  const [alignMove, setAlignMove] = useState(() => read(STORE_ALIGN, false))
  const [effort, setEffortState] = useState<EffortLevel>(() => {
    const v = read<string>(STORE_EFFORT, 'normal')
    return v === 'quick' || v === 'thorough' ? v : 'normal'
  })
  const setEffort = (v: EffortLevel) => {
    setEffortState(v)
    write(STORE_EFFORT, v)
  }
  const [off, setOff] = useState<Set<number>>(() => new Set(read<number[]>(STORE_OFF, [])))
  /** Cards still in the wallet count too; the rebuild stakes the ones the plan uses. */
  const [includeWallet, setIncludeWallet] = useState(() => read(STORE_WALLET, true))
  /** Index into WEIGHTS. */
  const [weightIx, setWeightIx] = useState(() => Math.min(WEIGHTS.length - 1, Math.max(0, read(STORE_WEIGHT, WEIGHTS.length - 1))))
  const matchWeight = WEIGHTS[weightIx]
  const [goalIx, setGoalIx] = useState(() => Math.min(GOALS.length - 1, Math.max(0, read(STORE_GOAL, 4))))
  const goalMin = GOALS[goalIx]
  const matchGoal = Math.round(goalMin * 6)
  const [withinIx, setWithinIx] = useState(() => Math.min(WITHIN.length - 1, Math.max(0, read(STORE_WITHIN, 4))))
  const withinGoalWeight = WITHIN[withinIx]
  const [runState, setRunState] = useState<Run | null>(null)
  const [presetName, setPresetName] = useState('')
  /**
   * Which divisions the list shows: the player's as they are now (to compare, nothing to sign), the
   * best TLM/h answer, or the one balanced for move cost. The answers are what gets signed.
   */
  const [pick, setPick] = useState<'now' | 'best' | 'balanced'>('best')

  const army = useArmy(account)
  const player = usePlayer(account)
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const market = useMarket()
  const balance = useGameBalance(account)
  const walletNfts = useWalletNfts(account)
  const walletCards = useMemo(() => (includeWallet ? (walletNfts.data ?? []).filter((a) => kindOf(a.stats)) : []), [includeWallet, walletNfts.data])
  const walletIds = useMemo(() => new Set(walletCards.map((a) => a.assetId)), [walletCards])
  const { run, runSequence, pending } = useTransaction()

  const rawMissions = useMemo(() => (config.data ? config.data.missions.map((row) => missionEconomics(row, config.data!)) : []), [config.data])
  // NFT rewards count at their floor, as on the Missions page: the cheapest WAX listing of the
  // template, swapped to TLM through the WAX → TLM pool, added to the mission's TLM reward. So NFT
  // missions are weighed with the token ones; an NFT with no listing adds nothing.
  const pools = useSwapPools()
  const nftIds = useMemo(() => rawMissions.flatMap((e) => (e.rewardNft ? [String(e.rewardNft.templateId)] : [])), [rawMissions])
  const floors = useNftFloors(nftIds)
  /** Per mission with an NFT reward: the TLM it counts for a cycle (shown in the mission list). */
  const nftTlm = useMemo(() => {
    const m = new Map<number, number>()
    const pool = pools.data?.tlm
    if (!pool) return m
    for (const e of rawMissions) {
      if (!e.rewardNft) continue
      const wax = floors.data?.get(String(e.rewardNft.templateId))
      if (wax !== undefined) m.set(e.id, receiveFor(pool, 'WAX', wax * e.rewardNft.count))
    }
    return m
  }, [rawMissions, floors.data, pools.data])
  const missions = useMemo(
    () => rawMissions.map((e) => (nftTlm.has(e.id) ? { ...e, rewardTlm: e.rewardTlm + nftTlm.get(e.id)! } : e)),
    [rawMissions, nftTlm]
  )
  const candidates = useMemo(() => candidateMissions(missions), [missions])
  const chosen = useMemo(() => missions.filter((m) => !off.has(m.id)), [missions, off])

  const unlockByDivision = useMemo(() => {
    const m = new Map<number, { unlock: number; missionId: number }>()
    for (const d of deployments.data ?? []) m.set(d.divisionId, { unlock: d.unlockAt, missionId: d.missionId })
    return m
  }, [deployments.data])
  const now = useClockFor([...unlockByDivision.values()].map((x) => x.unlock))

  const divisions = useMemo(() => army.data?.divisions ?? [], [army.data])
  const away = useMemo(() => divisions.filter((d) => !divisionState(d, unlockByDivision.get(d.id)?.unlock, now).editable), [divisions, unlockByDivision, now])
  const kept = mode === 'ready' ? away : []
  const rearrange = useMemo(() => divisions.filter((d) => !kept.includes(d)), [divisions, kept])

  /** What a division that stays earns: on the mission it is out on, or the best it could take. */
  const keptRate = (d: Division): { mission: MissionEconomics; perHour: number } | null => {
    const out = unlockByDivision.get(d.id)
    const m = out ? missions.find((x) => x.id === out.missionId) : undefined
    if (m) return { mission: m, perHour: tlmPerHour(m, d.move, market) }
    return bestLoop(d, missions, market)
  }
  const keptPerHour = kept.reduce((n, d) => n + (keptRate(d)?.perHour ?? 0), 0)
  const loading = !army.data || !player.data || !config.data

  const input = useMemo<SearchInput | null>(() => {
    if (!army.data || !player.data || !config.data) return null
    const { free } = army.data
    const { powerups, forgeLevel } = player.data
    const usedByKept = { weapon: 0, supply: 0, lavalux: 0 }
    for (const d of kept) for (const u of d.units) for (const k of ['weapon', 'supply', 'lavalux'] as SlotKind[]) if (u.gear[k]) usedByKept[k]++
    const slotsFree = Object.fromEntries(
      (['weapon', 'supply', 'lavalux'] as SlotKind[]).map((k) => [k, Math.max(0, (powerups.get(SLOT_POWERUP[k]) ?? 0) - usedByKept[k])])
    ) as Record<SlotKind, number>
    const pool = poolOf(free, rearrange)
    for (const a of walletCards) pool[kindOf(a.stats) as Kind].push(a)
    return {
      pool,
      existing: rearrange,
      missions: chosen,
      market,
      forgeLevel,
      slotsFree,
      maxDivisions: Math.max(0, divisionAllowance(powerups) - kept.length),
      alignMove,
      matchWeight,
      matchGoal,
      withinGoalWeight,
      anchors: kept.flatMap((d) => {
        const r = keptRate(d)
        return r ? [{ cooldownBase: r.mission.cooldownBase, move: d.move }] : []
      }),
      budgetMs: Infinity,
      effort: EFFORTS[effort]
    }
    // keptRate is derived from the same data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [army.data, player.data, config.data, kept, rearrange, chosen, market, alignMove, matchWeight, matchGoal, withinGoalWeight, effort, walletCards])

  // What the wallet can field at once, whatever is out: every card, every division rebuilt. Worked out
  // on its own as soon as the army is read, so the answer is there before any search is asked for.
  const allInput = useMemo<SearchInput | null>(() => {
    if (!army.data || !player.data || !config.data) return null
    const { powerups, forgeLevel } = player.data
    const pool = poolOf(army.data.free, divisions)
    for (const a of walletCards) pool[kindOf(a.stats) as Kind].push(a)
    return {
      pool,
      existing: divisions,
      missions: chosen,
      market,
      forgeLevel,
      slotsFree: Object.fromEntries(('weapon supply lavalux'.split(' ') as SlotKind[]).map((k) => [k, powerups.get(SLOT_POWERUP[k]) ?? 0])) as Record<SlotKind, number>,
      maxDivisions: divisionAllowance(powerups),
      alignMove: false,
      anchors: [],
      budgetMs: 15_000
    }
  }, [army.data, player.data, config.data, divisions, chosen, market, walletCards])
  const inPlay = useMemo(() => {
    const inDivs = rearrange.reduce((n, d) => n + 1 + d.units.reduce((m, u) => m + 1 + GEAR_KINDS.filter((k) => u.gear[k]).length, 0), 0)
    const reserve = army.data ? Object.values(army.data.free).reduce((n, l) => n + l.length, 0) : 0
    return { divisions: inDivs, reserve }
  }, [rearrange, army.data])
  const search = useArmySearch(input)
  // The background "can field at once" pass waits while a search is still in its first phases.
  const potential = useArmyPotential(opts.potential ? allInput : null, search.running && ['starting', 'coverage'].includes(search.progress?.phase ?? 'starting'))
  const result = search.result
  useEffect(() => setRunState(null), [result])
  const balanced = result?.balanced
  const showBalanced = pick === 'balanced' && !!balanced
  /** The Balanced tab is picked but no balanced army has been found yet (the search is still before or early in balancing). */
  const balancedPending = pick === 'balanced' && !balanced
  // A new search opens on the answer the player asked for: balanced when move-matching is on.
  const [wasRunning, setWasRunning] = useState(false)
  if (search.running !== wasRunning) {
    setWasRunning(search.running)
    if (search.running) setPick(alignMove ? 'balanced' : 'best')
  }
  /** The answer that would be signed (the steps, the preset, the deploy), whichever list is on screen. */
  const shown = useMemo(() => (pick === 'balanced' ? (balanced?.divisions ?? []) : (result?.divisions ?? [])), [pick, balanced, result])
  /** The player's divisions as they are now, in the same rows: out on their mission, or at home valued at the best mission they could take. */
  const nowRows = useMemo<ShownDivision[]>(
    () =>
      divisions
        .filter((d) => d.leader)
        .map((d) => {
          const rate = d.units.length ? keptRate(d) : null
          const out = unlockByDivision.has(d.id)
          return {
            warlord: d.leader!,
            units: d.units.map((x) => ({ merc: x.asset, gear: x.gear, atk: 0, def: 0, move: 0 })),
            mission: rate?.mission,
            atk: d.atk,
            def: d.def,
            move: d.move,
            pace: d.move,
            perHour: rate?.perHour ?? 0,
            existingId: d.id,
            unchanged: true,
            tag: out ? 'out on this mission' : d.units.length ? 'at home' : 'at home, no crew'
          }
        }),
    // keptRate reads the same data these do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [divisions, unlockByDivision, missions, market]
  )

  // What the army earns now: each division on the mission it is out on, or the best it could take.
  const pageNow = divisions.reduce((n, d) => n + (d.units.length ? (keptRate(d)?.perHour ?? 0) : 0), 0)
  const nowTotal = loading ? null : pageNow
  const bestTotal = result ? keptPerHour + result.perHour : null
  const gain = nowTotal !== null && bestTotal !== null ? bestTotal - nowTotal : null

  /** The shown answer (plus the divisions that stay as they are) kept as a preset of this account. */
  /** Saves it and returns the preset (null when this browser would not keep it). */
  function savePreset(): Preset | null {
    const planned: PresetDivision[] = shown.map((d) => ({
      leader: d.warlord.assetId,
      units: d.units.map((x) => ({
        merc: x.merc.assetId,
        gear: Object.fromEntries(GEAR_KINDS.flatMap((k) => (x.gear[k] ? [[k, x.gear[k]!.assetId]] : [])))
      }))
    }))
    const divisionsOf = [...snapshot(kept), ...planned]
    const list = readPresets(account)
    const name = presetName.trim() || `Optimized ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${showBalanced ? ' (balanced)' : ''}`
    const preset: Preset = { id: `${Date.now()}`, name, savedAt: Date.now(), divisions: divisionsOf }
    if (!writePresets(account, [preset, ...list])) {
      toast.error('This browser would not keep the preset (storage blocked or full).')
      return null
    }
    setPresetName('')
    toast.success(`"${name}" saved as a preset of ${account}: ${divisionsOf.length} division${divisionsOf.length === 1 ? '' : 's'}`)
    return preset
  }

  // ---- Signing the result ------------------------------------------------------------------------

  const own = account === sessionAccount && !spectating
  const diff = useMemo(() => (result ? diffArmy(rearrange, shown) : null), [result, rearrange, shown])
  const toStake = useMemo(
    () =>
      shown.flatMap((d) =>
        [d.warlord, ...d.units.flatMap((x) => [x.merc, ...GEAR_KINDS.flatMap((k) => (x.gear[k] ? [x.gear[k]!] : []))])].filter((a) => walletIds.has(a.assetId))
      ),
    [shown, walletIds]
  )
  const steps: Step[] = diff
    ? [
        ...(toStake.length ? (['stake'] as Step[]) : []),
        ...(diff.counts.free ? (['free'] as Step[]) : []),
        ...(diff.create.length ? (['create'] as Step[]) : []),
        ...(diff.counts.fill ? (['fill'] as Step[]) : [])
      ]
    : []
  const state: Run = runState ?? { done: [], failed: null, created: new Map() }
  const finished = steps.length > 0 && state.done.length === steps.length
  const nothingToDo = !!result && steps.length === 0
  const busy = pending === 'optimize' || pending === 'opt-deploy'
  const canSign = own && mode === 'ready' && search.done && !!diff && !busy

  const stepLabel = (s: Step) =>
    s === 'stake'
      ? `Stake ${toStake.length} card${toStake.length === 1 ? '' : 's'} from the wallet`
      : s === 'free'
      ? `Take apart: ${diff!.counts.free} action${diff!.counts.free === 1 ? '' : 's'}${diff!.disband.length ? `, ${diff!.disband.length} division${diff!.disband.length === 1 ? '' : 's'} disbanded` : ''}`
      : s === 'create'
        ? `Raise ${diff!.create.length} new division${diff!.create.length === 1 ? '' : 's'}`
        : `Put every mercenary and piece of gear in place: ${diff!.counts.fill} action${diff!.counts.fill === 1 ? '' : 's'}`

  async function execute(from: Run) {
    if (!diff || !result) return
    let cur: Run = { ...from, failed: null }
    setRunState(cur)
    const nowByLeader = new Map(rearrange.flatMap((d) => (d.leader ? [[d.leader.assetId, d.id] as const] : [])))
    for (const step of steps) {
      if (cur.done.includes(step)) continue
      let ok = false
      if (step === 'stake') {
        ok = await run((a, p) => stakeAssets(a, p, toStake.map((x) => x.assetId)), `${toStake.length} card${toStake.length === 1 ? '' : 's'} staked`, 'optimize', {
          refresh: false
        })
      } else if (step === 'free') {
        ok = await run((a, p) => diff.free(a, p), 'Divisions taken apart', 'optimize', { split: true, refresh: false })
      } else if (step === 'create') {
        ok = await run((a, p) => diff.create.map((l) => createDivision(a, p, l)), `${diff.create.length} division${diff.create.length === 1 ? '' : 's'} raised`, 'optimize', {
          refresh: false
        })
        if (ok) {
          const created = new Map<string, number>()
          for (let i = 0; i < 10 && created.size < diff.create.length; i++) {
            const fresh = await army.refetch()
            for (const d of fresh.data?.divisions ?? []) if (d.leader && diff.create.includes(d.leader.assetId)) created.set(d.leader.assetId, d.id)
            if (created.size < diff.create.length) await new Promise((r) => setTimeout(r, 1500))
          }
          if (created.size < diff.create.length) {
            toast.error('The new divisions have not all shown up yet. Wait a moment and press Resume.')
            ok = false
          }
          cur = { ...cur, created }
        }
      } else {
        const created = cur.created
        ok = await run(
          (a, p) => diff.fill(a, p, (leader) => created.get(leader) ?? nowByLeader.get(leader)),
          `The army is rearranged: about ${formatNumber(bestTotal ?? 0, 1)} TLM an hour`,
          'optimize',
          { split: true }
        )
      }
      if (!ok) {
        cur = { ...cur, failed: step }
        setRunState(cur)
        return
      }
      cur = { ...cur, done: [...cur.done, step] }
      setRunState(cur)
    }
  }

  /** Every planned division that is at home, sent to its mission, one transaction each. */
  async function deployAll() {
    if (!result) return
    const nowByLeader = new Map((army.data?.divisions ?? []).flatMap((d) => (d.leader ? [[d.leader.assetId, d] as const] : [])))
    const parts = shown.flatMap((d) => {
      const div = nowByLeader.get(d.warlord.assetId)
      if (!div || !divisionState(div, unlockByDivision.get(div.id)?.unlock, now).editable) return []
      const entry = { tlm: d.mission.costTlm, def: d.mission.costDef }
      const fromDeposit = coveredBy(entry, balance.data)
      return [
        {
          build: (a: string, p: string) => deployActions(a, p, d.mission.id, div.id, true, walletCosts(d.mission.costs, fromDeposit)),
          success: `#${div.id} sent to ${d.mission.title}`,
          settle: false
        }
      ]
    })
    if (!parts.length) return
    const done = await runSequence(parts, 'opt-deploy', `Deploying ${parts.length} divisions`)
    if (done === parts.length) onDone(null)
  }
  const walletShort = (() => {
    if (!result || !player.data) return ''
    let tlm = 0
    let def = 0
    for (const d of shown) {
      const w = walletPart({ tlm: d.mission.costTlm, def: d.mission.costDef }, coveredBy({ tlm: d.mission.costTlm, def: d.mission.costDef }, balance.data))
      tlm += w.tlm
      def += w.def
    }
    if (tlm > player.data.tlm) return `${formatNumber(tlm - player.data.tlm, 2)} TLM short for the entries`
    if (def > player.data.def) return `${formatNumber(def - player.data.def, 2)} DEF short for the entries`
    return ''
  })()

  // What was tried, with the divisions that are out (which the search never sees) counted in: they
  // field their missions as they stand, at what the army earns now.
  const triedRows = useMemo(() => {
    const rows = new Map<number, { mission: MissionEconomics; count: number; perHour: number }>()
    // Before any search: what the army fields as it stands, every division counted.
    if (!result) {
      for (const m of candidates) {
        const have = divisions.filter((d) => d.units.length && d.atk >= m.minAtk && d.def >= m.minDef).length
        if (have) rows.set(m.id, { mission: m, count: have, perHour: pageNow })
      }
      return [...rows.values()].sort((a, b) => b.count - a.count)
    }
    for (const t of result.tried) rows.set(t.mission.id, { mission: t.mission, count: t.count, perHour: keptPerHour + t.perHour })
    for (const m of candidates) {
      const have = kept.filter((d) => d.units.length && d.atk >= m.minAtk && d.def >= m.minDef).length
      if (!have) continue
      const row = rows.get(m.id)
      if (row) row.count += have
      else rows.set(m.id, { mission: m, count: have, perHour: keptPerHour + result.nowPerHour })
    }
    return [...rows.values()].sort((a, b) => b.perHour - a.perHour || b.count - a.count)
    // keptPerHour and pageNow follow kept and divisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, kept, candidates, divisions])

  // With move-matching: per mission length, how close the divisions came.
  const groups = useMemo(() => {
    if (!alignMove || !result) return []
    const g = new Map<number, { moves: number[]; out: number; pace: number }>()
    for (const d of shown) {
      const e = g.get(d.mission.cooldownBase) ?? { moves: [], out: 0, pace: d.pace }
      e.moves.push(d.move)
      g.set(d.mission.cooldownBase, e)
    }
    for (const a of input?.anchors ?? []) {
      const e = g.get(a.cooldownBase)
      if (e) e.out++
    }
    return [...g].filter(([, e]) => e.moves.length + e.out > 1).map(([base, e]) => ({ base, ...e, min: Math.min(...e.moves), max: Math.max(...e.moves) }))
  }, [alignMove, result, input, shown])

  const toggleMission = (id: number) =>
    setOff((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      write(STORE_OFF, [...next])
      return next
    })

  /**
   * The missions by what they pay, to switch on and off together. A mission that pays two kinds is in
   * both. Shard-only missions are never in the search (shards have no price), so Shards lists the
   * allowed missions that pay shards on top.
   */
  const categories = useMemo(() => {
    const ownTlm = (m: MissionEconomics) => m.rewardTlm - (nftTlm.get(m.id) ?? 0) > 1e-9
    const of = (test: (m: MissionEconomics) => boolean) => candidates.filter(test).map((m) => m.id)
    return [
      { key: 'tlm', label: 'TLM', ids: of(ownTlm) },
      { key: 'def', label: 'DEF', ids: of((m) => m.rewardDef > 0) },
      { key: 'nft', label: 'NFT', ids: of((m) => !!m.rewardNft) },
      { key: 'shards', label: 'Shards', ids: of((m) => m.rewardShards > 0) }
    ].map((c) => {
      const on = c.ids.filter((id) => !off.has(id)).length
      return { ...c, state: !c.ids.length ? ('none' as const) : on === c.ids.length ? ('on' as const) : on === 0 ? ('off' as const) : ('some' as const) }
    })
  }, [candidates, nftTlm, off])
  /** All of a kind on; or, when all of them already are, all of them off. */
  const toggleCategory = (key: string) => {
    const c = categories.find((x) => x.key === key)
    if (!c || !c.ids.length) return
    setOff((prev) => {
      const next = new Set(prev)
      if (c.state === 'on') for (const id of c.ids) next.add(id)
      else for (const id of c.ids) next.delete(id)
      write(STORE_OFF, [...next])
      return next
    })
  }

  return { categories, toggleCategory, mode, setMode, alignMove, setAlignMove, effort, setEffort, off, setOff, includeWallet, setIncludeWallet, weightIx, setWeightIx, matchWeight, goalIx, setGoalIx, goalMin, matchGoal, withinIx, setWithinIx, withinGoalWeight, runState, setRunState, presetName, setPresetName, pick, setPick, army, player, deployments, config, market, balance, walletNfts, walletCards, walletIds, run, runSequence, pending, nftTlm, missions, candidates, chosen, unlockByDivision, now, divisions, away, kept, rearrange, keptRate, keptPerHour, loading, input, allInput, inPlay, search, potential, result, balanced, showBalanced, balancedPending, shown, nowRows, pageNow, nowTotal, bestTotal, gain, savePreset, own, diff, toStake, steps, state, finished, nothingToDo, busy, canSign, stepLabel, execute, deployAll, walletShort, triedRows, groups, toggleMission }
}
