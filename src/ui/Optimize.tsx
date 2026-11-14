import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import { createDivision, deployActions, stakeAssets } from '@/chain/actions/pd'
import { divisionAllowance } from '@/chain/config'
import { toast } from '@/components/toast'
import { useArmy, useDeployments, useGameBalance, useMarket, useMissionConfig, usePlayer, useWalletNfts, type Division } from '@/data/game'
import { bestLoop, poolOf } from '@/lib/armyOptimizer'
import { useNftFloors, useSwapPools } from '@/data/market'
import { diffArmy } from '@/lib/armyDiff'
import { receiveFor } from '@/lib/pool'
import { readPresets, snapshot, writePresets, type PresetDivision } from '@/lib/armyPresets'
import { EFFORTS, type EffortLevel, type PlannedDivision, type SearchInput } from '@/lib/armySearch'
import type { SlotKind } from '@/lib/bundle'
import { coveredBy, walletCosts, walletPart } from '@/lib/deposit'
import { formatDuration, formatNumber } from '@/lib/format'
import { candidateMissions } from '@/lib/armyOptimizer'
import { missionEconomics, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import { GEAR_KINDS, kindOf, missionLockSeconds, type GearKind, type Kind } from '@/lib/stats'
import { useClockFor } from '@/lib/time'
import { useArmyPotential } from '@/lib/useArmyPotential'
import { useArmySearch } from '@/lib/useArmySearch'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { divisionState } from './divisionState'
import { Icon } from './icons'

/*
 * Optimize the army: the arrangement of warlords, mercenaries and gear into divisions, each on a
 * mission, that earns the most TLM an hour (see lib/armySearch). Any account can be looked at;
 * only the signed-in one can have the result signed. "Ready divisions only" leaves divisions that
 * are out as they are and works with the rest; "all divisions" pretends everything were home, to
 * see whether the army as a whole is the best it could be.
 */

type Mode = 'ready' | 'all'
type Step = 'stake' | 'free' | 'create' | 'fill'

const SLOT_POWERUP: Record<SlotKind, string> = { weapon: 'eqpslot', supply: 'supslot', lavalux: 'lavaslot' }
/**
 * How hard the search works, counted in work rather than time, so the same army gives the same
 * answer whatever else the computer is doing. Several seeds run side by side and the best wins.
 */
const EFFORT_LEVELS: { key: EffortLevel; label: string; what: string }[] = [
  { key: 'quick', label: 'Quick', what: 'The 6 most promising missions, a short rearrange. One to three minutes on a big army, the longer with balancing.' },
  { key: 'normal', label: 'Normal', what: 'The 12 most promising missions at more counts, a longer rearrange. Four to six minutes on a big army with balancing.' },
  { key: 'thorough', label: 'Thorough', what: 'Up to 30 missions at many counts, a long rearrange that stops only when it stops finding anything. Fifteen minutes or more on a big army.' }
]
const STORE_EFFORT = 'pd-army.opt.effort'
/** The phases of a search, in order, with what each one does. */
const PHASES: { id: string; label: string; what: string; balancingOnly?: boolean }[] = [
  { id: 'starting', label: 'Read', what: 'The army as it stands, scored; a trimmed copy of it as a first improvement.' },
  { id: 'coverage', label: 'Coverage', what: 'Every mission at every count, each a whole army: the systematic sweep, most promising first.' },
  { id: 'annealing', label: 'Rearrange', what: 'Millions of small changes from the best starting points, taking turns; this finds the best TLM / h.' },
  { id: 'polishing', label: 'Polish', what: 'Every single change tried once more; the answer is a true local optimum.' },
  { id: 'balancing', label: 'Balance', what: 'The second answer: same divisions, cards shuffled so each mission length comes back close together.', balancingOnly: true },
  { id: 'checking', label: 'Check', what: 'Every division recomputed with the contract formula and checked against its mission, slots and allowance.' }
]
const PHASE: Record<string, string> = Object.fromEntries(PHASES.map((p) => [p.id, p.what]))

const STORE_ALIGN = 'pd-army.opt.align'
const STORE_OFF = 'pd-army.opt.off'
const STORE_WALLET = 'pd-army.opt.wallet'
const STORE_WEIGHT = 'pd-army.opt.match-weight'
const STORE_GOAL = 'pd-army.opt.match-goal'
/** Goal slider stops: minutes apart the divisions of one length may come back; ten seconds per move point. */
const GOALS = [0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30]
/** Within-goal slider stops: TLM an hour per move point it may still give up once the goal is reached. */
const WITHIN = [0, 0.02, 0.05, 0.1, 0.25, 0.5, 1]
const STORE_WITHIN = 'pd-army.opt.within'
/** Slider stops: TLM an hour the balancing may give up per move point of spread; the last is any price. */
const WEIGHTS = [2, 5, 10, 25, 100, Infinity]
const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

interface Run {
  done: Step[]
  failed: Step | null
  /** New division numbers by warlord, known after "create". */
  created: Map<string, number>
}

/** The plan's cards by name, for a short list. */
function grouped<T extends { name: string; templateId: string; rarity: string; img: string }>(list: T[]) {
  const m = new Map<string, { a: T; n: number }>()
  for (const a of list) {
    const g = m.get(a.templateId)
    if (g) g.n++
    else m.set(a.templateId, { a, n: 1 })
  }
  return [...m.values()]
}

/** Ids of cards still in the wallet, for the rows to say so. */
let walletIdsForRows = new Set<string>()

export function OptimizePanel({
  sessionAccount,
  spectating,
  initialAccount,
  onClose,
  onDone
}: {
  sessionAccount: string
  spectating: boolean
  initialAccount: string
  onClose: () => void
  /** The army was changed: show it, the given division first. */
  onDone: (divisionId: number | null) => void
}) {
  const [accountText, setAccountText] = useState(initialAccount)
  const [account, setAccount] = useState(initialAccount)
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

  walletIdsForRows = walletIds
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
  const potential = useArmyPotential(allInput, search.running && ['starting', 'coverage'].includes(search.progress?.phase ?? 'starting'))
  /** Find the best army with a new account typed: look it up, then start as soon as it is read. */
  const [startWhenReady, setStartWhenReady] = useState(false)
  const go = () => {
    if (!accountText) return
    if (accountText !== account) {
      setAccount(accountText)
      setStartWhenReady(true)
    } else search.start()
  }
  useEffect(() => {
    if (startWhenReady && input) {
      setStartWhenReady(false)
      search.start()
    }
    // search.start is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWhenReady, input])
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
  function savePreset() {
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
    if (!writePresets(account, [{ id: `${Date.now()}`, name, savedAt: Date.now(), divisions: divisionsOf }, ...list])) {
      toast.error('This browser would not keep the preset (storage blocked or full).')
      return
    }
    setPresetName('')
    toast.success(`"${name}" saved as a preset of ${account}: ${divisionsOf.length} division${divisionsOf.length === 1 ? '' : 's'}`)
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

  return (
    <section className="opt">
      <div className="box opt__head">
        <div className="opt__title">
          <h2>
            <Icon name="spark" /> Optimize the army
          </h2>
          <span className="muted">The arrangement of everything staked that earns the most TLM an hour from the missions on offer.</span>
          <span className="gap" />
          <button type="button" className="btn btn--sm" onClick={onClose} disabled={busy}>
            Back to the army
          </button>
        </div>
        <label className="opt__field opt__field--account">
          Account
          <input
            className="input"
            value={accountText}
            spellCheck={false}
            placeholder="any WAX account"
            onChange={(e) => setAccountText(e.target.value.trim().toLowerCase())}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </label>
        <div className="opt__controls">
          <span className="opt__field">
            Divisions
            <span className="seg">
              <button type="button" className={mode === 'ready' ? 'is-on' : ''} onClick={() => setMode('ready')} title="Divisions that are out stay as they are">
                Only ready ones
              </button>
              <button
                type="button"
                className={mode === 'all' ? 'is-on' : ''}
                onClick={() => setMode('all')}
                title="Every staked card, in a division or not, plus the wallet, as if all of it were home: the best army these cards can make, with as many divisions as the allowance permits"
              >
                Everything
              </button>
            </span>
          </span>
        </div>
        <div className="opt__toggles">
          <label className={`opt__toggle${includeWallet ? ' is-on' : ''}`} title="Game cards still in the wallet count too; the rebuild stakes the ones the plan uses first.">
            <input
              type="checkbox"
              checked={includeWallet}
              onChange={(e) => {
                setIncludeWallet(e.target.checked)
                write(STORE_WALLET, e.target.checked)
              }}
            />
            Wallet cards
            <small>{walletNfts.isLoading ? '…' : (walletNfts.data ?? []).filter((a) => kindOf(a.stats)).length}</small>
          </label>
          <label className={`opt__toggle${alignMove ? ' is-on' : ''}`} title="A second answer next to the best one: same divisions, cards shuffled so divisions of one mission length come back close together.">
            <input
              type="checkbox"
              checked={alignMove}
              onChange={(e) => {
                setAlignMove(e.target.checked)
                write(STORE_ALIGN, e.target.checked)
              }}
            />
            Also balance for move cost
          </label>
          <span className="opt__field">
            Effort
            <span className="seg">
              {EFFORT_LEVELS.map((l) => (
                <button key={l.key} type="button" className={effort === l.key ? 'is-on' : ''} title={l.what} onClick={() => setEffort(l.key)}>
                  {l.label}
                  {l.key === 'normal' ? ' ★' : ''}
                </button>
              ))}
            </span>
          </span>
          {alignMove && (
            <details className="opt__more">
              <summary>
                Balancing: within {goalMin < 1 ? '30 s' : `${goalMin} min`} · {Number.isFinite(matchWeight) ? `${matchWeight} TLM/h per point` : 'any price'} ·{' '}
                {withinGoalWeight === 0 ? 'stop at the goal' : `then ${withinGoalWeight}`}
              </summary>
              <div className="opt__sliders">
                <span className="opt__slider">
                  <span className="opt__slider-row">
                    <span>Goal: back within</span>
                    <b>{goalMin < 1 ? '30 s' : `${goalMin} min`}</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={GOALS.length - 1}
                    step={1}
                    value={goalIx}
                    onChange={(e) => {
                      const ix = Number(e.target.value)
                      setGoalIx(ix)
                      write(STORE_GOAL, ix)
                    }}
                  />
                </span>
                <span className="opt__slider">
                  <span className="opt__slider-row">
                    <span>Income it may give up per move point, beyond the goal</span>
                    <b>{Number.isFinite(matchWeight) ? `${matchWeight} TLM / h` : 'any price'}</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={WEIGHTS.length - 1}
                    step={1}
                    value={weightIx}
                    onChange={(e) => {
                      const ix = Number(e.target.value)
                      setWeightIx(ix)
                      write(STORE_WEIGHT, ix)
                    }}
                  />
                </span>
                <span className="opt__slider">
                  <span className="opt__slider-row">
                    <span>Within the goal, keep tightening if a point costs at most</span>
                    <b>{withinGoalWeight === 0 ? 'nothing' : `${withinGoalWeight} TLM / h`}</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={WITHIN.length - 1}
                    step={1}
                    value={withinIx}
                    onChange={(e) => {
                      const ix = Number(e.target.value)
                      setWithinIx(ix)
                      write(STORE_WITHIN, ix)
                    }}
                  />
                </span>
              </div>
              <p className="help">
                Earnings always assume each division is claimed as soon as it is back. Balancing brings the divisions of each mission length as close
                together in move cost as the cards allow, at any price until the goal is reached by default; it never drops a real division, only
                small side divisions may come and go.
              </p>
            </details>
          )}
          {candidates.length > 0 && (
            <details className="opt__more">
              <summary>
                Missions: {candidates.length - off.size} of {candidates.length} allowed
              </summary>
              <span className="opt__chips">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={off.size === 0}
                  onClick={() => {
                    setOff(new Set())
                    write(STORE_OFF, [])
                  }}
                >
                  All
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={off.size >= candidates.length}
                  onClick={() => {
                    const all = new Set(candidates.map((m) => m.id))
                    setOff(all)
                    write(STORE_OFF, [...all])
                  }}
                >
                  None
                </button>
                {candidates.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`opt__chip${off.has(m.id) ? '' : ' is-on'}`}
                    title={nftTlm.has(m.id) ? `Its NFT reward counts at its floor: ≈ ${formatNumber(nftTlm.get(m.id)!, 0)} TLM a cycle` : undefined}
                    onClick={() => toggleMission(m.id)}
                  >
                    {m.title}
                    {nftTlm.has(m.id) && <small> · NFT ≈ {formatNumber(nftTlm.get(m.id)!, 0)} TLM</small>}
                  </button>
                ))}
              </span>
              <p className="help">
                Click a mission to leave it out. Missions, requirements and rewards come from the chain each time. NFT rewards count
                at their floor (the cheapest listing, swapped to TLM), as on the Missions page; an NFT with no listing counts for
                nothing.
              </p>
            </details>
          )}
        </div>
        <div className="opt__run">
          {search.running ? (
            <button type="button" className="btn" onClick={search.stop}>
              Stop and keep the best so far
            </button>
          ) : (
            <button type="button" className="btn btn--go" disabled={!accountText || (accountText === account && (loading || !input))} onClick={go}>
              <Icon name="spark" />
              {startWhenReady ? 'Reading…' : search.done && accountText === account ? 'Search again' : 'Find the best army'}
            </button>
          )}
          <span className="muted">
            {loading
              ? `Reading ${account}…`
              : army.isError
                ? `Could not read ${account}.`
                : `${divisions.length} division${divisions.length === 1 ? '' : 's'}, ${away.length} out${mode === 'ready' && away.length ? ' (kept as they are)' : ''} · in play: ${inPlay.divisions} cards in divisions, ${inPlay.reserve} in the reserve${walletCards.length ? `, ${walletCards.length} in the wallet` : ''} · up to ${input?.maxDivisions ?? 0} division${input?.maxDivisions === 1 ? '' : 's'}.`}
            {search.error && <b className="c-bad"> {search.error}</b>}
          </span>
        </div>
      </div>

      {!loading && !army.isError && (
        <div className="box opt__compare">
          <div className="opt__fig">
            <small>Now</small>
            <b>
              {nowTotal === null ? '…' : formatNumber(nowTotal, 1)}
              <em>TLM / h</em>
            </b>
            <small>{divisions.filter((d) => d.units.length).length} divisions with crew</small>
          </div>
          <span className="opt__arrow">→</span>
          <div className="opt__fig">
            <small>{search.running ? 'Best so far' : 'Optimized'}</small>
            <b>
              {bestTotal === null ? (search.running ? '…' : '–') : formatNumber(bestTotal, 1)}
              <em>TLM / h</em>
            </b>
            {bestTotal === null && !search.running && <span className="gain muted">press Find the best army</span>}
            {gain !== null && (
              <span className={`gain ${gain > 0.05 ? 'is-good' : 'muted'}`}>
                {gain > 0.05
                  ? `+${formatNumber(gain, 1)} TLM / h`
                  : result?.reason
                    ? 'nothing to rearrange'
                    : alignMove && gain < -0.05
                      ? `${formatNumber(gain, 1)} TLM / h, for matched move costs`
                      : 'nothing better found'}
                {result ? ` · ${kept.length + result.divisions.length} divisions` : ''}
              </span>
            )}
          </div>
          {search.stale && (search.running || search.done) && (
            <div className="opt__progress opt__stale">
              <span>
                <b>Prices or cards changed since this search started.</b> It keeps working on what it read then; search again for today&apos;s numbers.
              </span>
              <button type="button" className="btn btn--sm" onClick={() => search.start()}>
                Search again
              </button>
            </div>
          )}
          {search.done && search.seeds.length > 1 && (() => {
            const values = search.seeds.map((s) => s.result?.perHour).filter((v): v is number => v !== undefined).sort((a, b) => b - a)
            if (values.length < 2) return null
            const spread = values[0] - values[values.length - 1]
            return (
              <div className="opt__progress opt__seeds">
                <span>
                  <b>Best of {values.length} searches:</b> {formatNumber(keptPerHour + values[0], 1)} TLM / h · the others reached{' '}
                  {values
                    .slice(1)
                    .map((v) => formatNumber(keptPerHour + v, 1))
                    .join(', ')}
                  {spread < 0.05 ? ' — all agree, a solid answer.' : spread < values[0] * 0.02 ? ' — close, the answer is solid.' : ' — they differ: Thorough may find more.'}
                </span>
              </div>
            )
          })()}
          {balanced && !search.running && (
            <div className="opt__progress opt__balanced">
              <span>
                <b>Balanced for move cost:</b> {formatNumber(keptPerHour + balanced.perHour, 1)} TLM / h
                {bestTotal !== null ? ` (${formatNumber(keptPerHour + balanced.perHour - bestTotal, 1)} against the best)` : ''} · {balanced.divisions.length} divisions
              </span>
            </div>
          )}
          {(search.running || search.done) && (
            <ol className="opt__phases">
              {PHASES.filter((p) => alignMove || !p.balancingOnly).map((p, i, list) => {
                const at = search.running ? list.findIndex((x) => x.id === search.progress?.phase) : list.length
                const state = i < at ? 'is-done' : i === at ? 'is-now' : ''
                return (
                  <li key={p.id} className={state} title={p.what}>
                    <i>{i < at ? '✓' : i + 1}</i>
                    <span>{p.label}</span>
                  </li>
                )
              })}
            </ol>
          )}
          {search.running && search.progress && (
            <div className="opt__progress">
              <span>
                <b>{PHASES.find((p) => p.id === search.progress!.phase)?.label ?? search.progress.phase}:</b> {PHASE[search.progress.phase] ?? ''}{' '}
                {(() => {
                  const list = PHASES.filter((p) => alignMove || !p.balancingOnly)
                  const next = list[list.findIndex((x) => x.id === search.progress!.phase) + 1]
                  return next ? `Next: ${next.label.toLowerCase()}.` : ''
                })()}{' '}
                {formatNumber(search.progress.moves, 0)} changes tried by {search.seeds.length} searches side by side · {formatNumber(search.progress.ms / 1000, 0)} s ·
                Stop keeps the best so far
              </span>
              <span className={`opt__bar${search.progress.pct < 0 ? ' is-endless' : ''}`}>
                <i style={search.progress.pct < 0 ? undefined : { width: `${Math.max(2, search.progress.pct * 100)}%` }} />
              </span>
            </div>
          )}
          {result && !search.running && result.reason && (
            <div className="opt__progress">
              <span className="muted">{result.reason}</span>
            </div>
          )}
          {result && !search.running && !result.reason && (
            <div className="opt__progress">
              <span className="muted">
                {formatNumber(result.moves, 0)} changes tried in {formatNumber(result.ms / 1000, 0)} s
                {result.converged ? ' · nothing more was found in the last rounds' : ' · stopped at the time limit; more time may find a little more'}
                {result.greedyPerHour > result.nowPerHour + 0.05 && result.perHour > result.greedyPerHour + 0.05
                  ? ` · building division by division, the old way, reaches ${formatNumber(keptPerHour + result.greedyPerHour, 1)}`
                  : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {!loading && (
        <div className="box opt__tried">
          <span className="group__h">
            What this wallet can field at once · every division rebuilt from all its cards, and the whole-army TLM / h with that many
          </span>
          {potential.running ? (
            <span className="muted">Working it out…{potential.tried.length ? ' (updating)' : ''}</span>
          ) : potential.error ? (
            <span className="c-bad">{potential.error}</span>
          ) : !potential.tried.length ? (
            <span className="muted">No paying mission this wallet can field.</span>
          ) : (
            <div className="opt__tried-list">
              {potential.tried.map((t) => (
                <span key={t.mission.id} className="opt__try">
                  <b>
                    {t.count} × {t.mission.title}
                  </b>
                  <small>{formatNumber(t.perHour, 1)} TLM / h</small>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && triedRows.length > 0 && (
        <div className="box opt__tried">
          <span className="group__h">
            {result
              ? 'What was tried · the most divisions of each mission the search managed to field at once, and the best whole-army TLM / h with that many'
              : 'What the army fields now · divisions that meet each mission, and the TLM / h it earns'}
          </span>
          <div className="opt__tried-list">
            {triedRows.map((t) => (
              <span key={t.mission.id} className="opt__try">
                <b>
                  {t.count} × {t.mission.title}
                </b>
                <small>{formatNumber(t.perHour, 1)} TLM / h</small>
              </span>
            ))}
          </div>
        </div>
      )}

      {!loading && mode === 'ready' && away.length > 0 && (
        <p className="notice notice--read opt__kept">
          <Icon name="lock" size={16} />
          <span>
            {away.length} of {divisions.length} division{divisions.length === 1 ? ' is' : 's are'} out and stay{away.length === 1 ? 's' : ''} exactly as {away.length === 1 ? 'it is' : 'they are'}; only the reserve ({inPlay.reserve} cards){walletCards.length ? ` and the wallet (${walletCards.length})` : ''} can be rearranged right now.
            {potential.perHour !== null && bestTotal !== null && potential.perHour > bestTotal + 5
              ? ` With everything home, these cards could reach about ${formatNumber(potential.perHour, 0)} TLM / h: switch to Everything to see that army.`
              : ' Everything shows what the whole army could do.'}
          </span>
        </p>
      )}

      {showBalanced && !search.running && balanced!.note && (
        <p className="notice notice--read opt__kept">
          <Icon name="lock" size={16} />
          <span>{balanced!.note}</span>
        </p>
      )}
      {showBalanced &&
        balanced!.warnings.map((w) => (
          <p key={w} className="opt__warn">
            {w}
          </p>
        ))}
      {result?.warnings.map((w) => (
        <p key={w} className="opt__warn">
          {w}
        </p>
      ))}

      {result && groups.length > 0 && (
        <p className="opt__groups">
          <b className="opt__groups-which">{showBalanced ? 'Balanced for move cost' : 'Best TLM / h (not matched for move)'}:</b>{' '}
          {groups.map((g) => (
            <span key={g.base}>
              <b>{formatDuration(g.base)} missions</b>: {g.moves.length} division{g.moves.length === 1 ? '' : 's'}
              {g.out ? ` (+${g.out} out now)` : ''} at {g.max - g.min <= 3 ? `${g.max} move` : `${g.min}–${g.max} move, ${g.max - g.min} apart (${formatDuration((g.max - g.min) * 10)})`}
              {g.max - g.min <= matchGoal ? ' · within the goal' : showBalanced ? ' · the goal was not reached' : ' · beyond the goal (see Balanced for move cost)'}.{' '}
            </span>
          ))}
        </p>
      )}

      {result && (
        <div className="opt__list">
          <div className="opt__pickbar">
            <span className="group__h">
              {pick === 'now'
                ? `Your divisions as they are now · ${nowTotal === null ? '…' : formatNumber(nowTotal, 1)} TLM / h · nothing here is signed`
                : pick === 'balanced'
                  ? balancedPending
                    ? 'Balanced for move cost · comes after the rearrange'
                    : `Balanced for move cost · ${search.running ? 'the best so far, still balancing' : 'what gets signed if you rearrange now'}`
                  : `Best TLM / h · ${search.running ? 'the best so far, still searching' : 'what gets signed if you rearrange now'}`}
            </span>
            <span className="seg seg--pick">
              <button type="button" className={pick === 'now' ? 'is-on' : ''} onClick={() => setPick('now')}>
                Now
                <small className="seg__value">{nowTotal === null ? '…' : `${formatNumber(nowTotal, 1)} TLM / h`}</small>
              </button>
              <button type="button" className={pick === 'best' ? 'is-on' : ''} onClick={() => setPick('best')}>
                Best TLM / h
                <small className="seg__value">
                  {bestTotal === null ? '…' : `${formatNumber(bestTotal, 1)} TLM / h`}
                  {search.running ? ' so far' : ''}
                </small>
              </button>
              {(balanced || alignMove) && (
                <button type="button" className={pick === 'balanced' ? 'is-on' : ''} onClick={() => setPick('balanced')}>
                  Balanced for move cost
                  <small className="seg__value">
                    {balanced
                      ? `${formatNumber(keptPerHour + balanced.perHour, 1)} TLM / h${search.running ? ' so far' : balanced.goalReached === false ? ' · goal not reached' : balanced.goalReached ? ' · within the goal' : ''}`
                      : search.running
                        ? 'after the rearrange'
                        : '–'}
                  </small>
                </button>
              )}
            </span>
          </div>
          {pick === 'now' && nowRows.map((d) => <PlannedRow key={d.warlord.assetId} d={d} />)}
          {pick === 'now' && !nowRows.length && <p className="none">No divisions yet.</p>}
          {pick !== 'now' &&
            shown.map((d) => (
              <PlannedRow key={d.warlord.assetId} d={d} />
            ))}
          {balancedPending && (
            <p className="none">
              {search.running
                ? 'Balancing starts once the rearrange and polish are done; the balanced army shows here as soon as it is found, and keeps updating.'
                : 'No balanced army: switch on Also balance for move cost and search again.'}
            </p>
          )}
          {pick !== 'now' && !balancedPending && !shown.length && (
            <p className="none">
              {input && input.maxDivisions <= 0
                ? 'Every division place is taken by a division that is out right now.'
                : 'No staked warlord and mercenaries together reach a mission that pays TLM among the ones allowed.'}
            </p>
          )}
        </div>
      )}

      {result && search.done && pick !== 'now' && shown.length > 0 && (
        <form
          className="box opt__save"
          onSubmit={(e) => {
            e.preventDefault()
            savePreset()
          }}
        >
          <span className="group__h">Keep this army as a preset</span>
          <input className="input" value={presetName} placeholder={`Optimized ${showBalanced ? '(balanced)' : ''}`.trim()} maxLength={40} onChange={(e) => setPresetName(e.target.value)} />
          <button type="submit" className="btn btn--sm">
            <Icon name="chest" size={16} /> Save as preset
          </button>
          <span className="muted">
            {kept.length ? `With the ${kept.length} division${kept.length === 1 ? '' : 's'} that stay as they are. ` : ''}Restore it any time from Presets.
          </span>
        </form>
      )}

      {result && search.done && pick !== 'now' && (
        <div className="box opt__steps">
          {mode === 'all' ? (
            <p className="muted" style={{ margin: 0 }}>
              This is the best army all these cards can make, as if everything were home: a comparison only. Switch to <b>Only ready ones</b> to rearrange what can be rearranged now.
            </p>
          ) : !own ? (
            <p className="muted" style={{ margin: 0 }}>
              This is {account}&apos;s army. Only the signed-in account&apos;s army can be changed from here.
            </p>
          ) : nothingToDo ? (
            <p className="muted" style={{ margin: 0 }}>
              Your divisions at home are already arranged the way the search would arrange them. Nothing to sign.
            </p>
          ) : (
            <>
              <ol>
                {steps.map((s, i) => {
                  const done = state.done.includes(s)
                  const current = !done && state.done.length === i && busy
                  return (
                    <li key={s} className={done ? 'is-done' : state.failed === s ? 'is-failed' : current ? 'is-now' : ''}>
                      <i>{done ? '✓' : i + 1}</i> {stepLabel(s)}
                    </li>
                  )
                })}
              </ol>
              <div className="opt__foot">
                {finished ? (
                  <span className="is-good">Done: the army is rearranged.</span>
                ) : state.failed ? (
                  <>
                    <span className="c-bad">Step {steps.indexOf(state.failed) + 1} did not go through. The steps before it are done and stay done.</span>
                    <button type="button" className="btn btn--go" disabled={!canSign} onClick={() => void execute(state)}>
                      Resume at step {steps.indexOf(state.failed) + 1}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--go" disabled={!canSign} onClick={() => void execute(state)}>
                      <Icon name="army" />
                      {busy ? 'Signing…' : 'Rearrange the army'}
                    </button>
                    <span className="muted">
                      {steps.length} transaction{steps.length === 1 ? '' : 's'}
                      {diff && diff.changed.length < shown.length ? ` · ${shown.length - diff.changed.length} division${shown.length - diff.changed.length === 1 ? ' stays' : 's stay'} as they are` : ''}
                      . Long steps are signed in parts of 25 actions.
                    </span>
                  </>
                )}
              </div>
            </>
          )}
          {own && mode === 'ready' && (finished || nothingToDo) && shown.length > 0 && (
            <div className="opt__foot">
              <button type="button" className="btn btn--go" disabled={busy || !!walletShort} title={walletShort || undefined} onClick={() => void deployAll()}>
                <Icon name="rocket" />
                {pending === 'opt-deploy' ? 'Deploying…' : `Deploy ${shown.length} division${shown.length === 1 ? '' : 's'} to their missions`}
              </button>
              <span className="muted">{walletShort || 'One transaction per division. Entry fees come from your game balance where it covers them.'}</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** A planned division, or one of the player's own shown the same way (then it may have no paying mission, and says where it is). */
type ShownDivision = Omit<PlannedDivision, 'mission'> & { mission?: MissionEconomics; tag?: string }

function PlannedRow({ d }: { d: ShownDivision }) {
  const mercs = grouped(d.units.map((u) => u.merc))
  const gear = grouped(GEAR_KINDS.flatMap((k: GearKind) => d.units.flatMap((u) => (u.gear[k] ? [u.gear[k]!] : []))))
  const lock = d.mission ? missionLockSeconds(d.mission.cooldownBase, d.pace) : null
  return (
    <div className="box od" style={{ '--rc': rarityColor(d.warlord.rarity) } as CSSProperties}>
      <Portrait img={d.warlord.img} rarity={d.warlord.rarity} className="od__pic" />
      <div className="od__body">
        <div className="od__top">
          <b>{d.mission?.title ?? (d.units.length ? 'No mission pays for this division' : 'No crew')}</b>
          {d.mission && (
            <span className="muted">
              needs {formatNumber(d.mission.minAtk, 0)} atk{d.mission.minDef ? ` · ${formatNumber(d.mission.minDef, 0)} def` : ''}
            </span>
          )}
          {d.tag ? (
            <span className="od__tag is-kept">
              #{d.existingId} · {d.tag}
            </span>
          ) : d.unchanged ? (
            <span className="od__tag is-kept">#{d.existingId} as it is</span>
          ) : d.existingId !== undefined ? (
            <span className="od__tag">#{d.existingId} adjusted</span>
          ) : (
            <span className="od__tag is-new">new division</span>
          )}
        </div>
        <div className="od__meta">
          <span>
            <b>{d.warlord.name}</b> · {d.units.length} of {d.warlord.stats?.slots_max} crew · {gear.reduce((n, g) => n + g.n, 0)} gear
          </span>
          <span className="c-atk">{formatNumber(d.atk, 0)} atk</span>
          <span className="c-def">{formatNumber(d.def, 0)} def</span>
          <span className="c-move">{formatNumber(d.move, 0)} move</span>
          {lock !== null && <span>back in {formatDuration(lock)}</span>}
          {(() => {
            const n = [d.warlord, ...d.units.flatMap((x) => [x.merc, ...GEAR_KINDS.flatMap((k) => (x.gear[k] ? [x.gear[k]!] : []))])].filter((a) => walletIdsForRows.has(a.assetId)).length
            return n ? <span className="c-move">{n} from the wallet, staked first</span> : null
          })()}
        </div>
        <div className="od__crew">
          {mercs.map(({ a, n }) => (
            <span key={a.templateId} className="od__u" style={{ '--rc': rarityColor(a.rarity) } as CSSProperties}>
              <Portrait img={a.img} rarity={a.rarity} className="od__mini" />
              {a.name}
              {n > 1 && <em className="times">×{n}</em>}
            </span>
          ))}
          {gear.map(({ a, n }) => (
            <span key={a.templateId} className="od__u is-gear" style={{ '--rc': rarityColor(a.rarity) } as CSSProperties}>
              <Portrait img={a.img} rarity={a.rarity} className="od__mini" />
              {a.name}
              {n > 1 && <em className="times">×{n}</em>}
            </span>
          ))}
        </div>
      </div>
      <div className="od__rate">
        <b>{d.mission ? `+${formatNumber(d.perHour, 1)}` : '–'}</b>
        <small>TLM / h</small>
      </div>
    </div>
  )
}
