import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { create } from 'zustand'

import type { AnyAction } from '@wharfkit/session'

import { atomic } from '@/chain/atomic'
import { blendActions, type BlendRun } from '@/chain/actions/blend'
import { buySalesActions, stakeBoughtAction } from '@/chain/actions/market'
import { addUnit, assignGear as assignGearAction, buyShopItem, createDivision, payForgeLevel } from '@/chain/actions/pd'
import { toast } from '@/components/toast'
import { makeAssetRef, type AssetRef } from '@/data/assets'
import { useBlends, useCollectionTemplates, useOwnedBlendInputs, type Blend } from '@/data/blends'
import {
  useArmy,
  useAssetStats,
  useForgeConfig,
  useMarket,
  useMissionConfig,
  usePlayer,
  useTemplates,
  useWalletNfts,
  type Division,
  type PlayerData
} from '@/data/game'
import { useListings, useSwapPools, type Listing, type SwapPools } from '@/data/market'
import {
  marketFrom,
  mintable,
  openingsOf,
  planBlend,
  resultOf,
  type Market as BlendMarket,
  type Opening
} from '@/lib/blendEconomy'
import {
  GEAR_KINDS,
  type Bundle,
  type Candidate,
  type GearKind,
  type SlotKind,
  type SolveInput,
  type WarlordOption
} from '@/lib/bundle'
import { forecastOpenings, type ChestForecast as Forecast } from '@/lib/chestOdds'
import { buildEconomy, waxFor } from '@/lib/forgeEconomy'
import { formatDuration, formatNumber, formatToken, percent, titleCase } from '@/lib/format'
import { cycleSeconds, isTokenLoop, missionEconomics, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import type { Market as TlmDefMarket } from '@/lib/market'
import { buyExactAction, receiveFor } from '@/lib/pool'
import { kindOfCategory, KIND_LABEL, type Kind } from '@/lib/stats'
import { useBundleSolver } from '@/lib/useBundleSolver'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'
import { RoiSweep, type RoiRow } from './RoiSweep'
import { StarRail } from './Stars'

import '@/styles/market.css'

/*
 * The division builder: the cheapest division that reaches an attack and defense target, from
 * market listings, blends and (when allowed) the NFTs you already own. Ported from the old deck's
 * Market page; the search, the price corrections and the purchase steps work exactly as there.
 */

/**
 * Where a bundle item comes from: a market listing to buy, your reserve, one of your divisions
 * (to take out first), your wallet (to stake), or a blend (materials bought or owned, burned in a
 * recipe; `asset` only describes the result).
 */
type Source =
  | { from: 'market'; listing: Listing }
  | { from: 'reserve'; asset: AssetRef }
  | { from: 'division'; asset: AssetRef; division: number; locked: boolean }
  | { from: 'wallet'; asset: AssetRef }
  | { from: 'blend'; blend: Blend; asset: AssetRef }

/** Copies of one recipe offered to the solver: plenty for one division. */
const MAX_BLEND_COPIES = 12
/** Correction rounds per pass at most; a pass also stops as soon as a round no longer improves. */
const MAX_ROUNDS = 8
/** Stand-in price for a blend whose materials have run out. */
const UNMAKEABLE = 1e12
/** How long the search may sit with nothing to solve before it counts as finished. */
const WATCHDOG_MS = 1500
/** A pass ends after this many rounds in a row without getting cheaper. */
const PATIENCE = 2

/** Where the search for the cheapest bundle stands for one target (see the correction loop). */
interface Refinement {
  target: string
  prices: Map<string, number>
  rounds: number
  phase: 'owned' | 'market'
  /** Cheapest real cost this pass has reached so far. */
  lastTotal: number
  /** Rounds in a row that did not get below lastTotal. */
  stale: number
  /** Solves finished for this target. */
  step: number
  done: boolean
}

const FRESH_REFINEMENT: Refinement = {
  target: '',
  prices: new Map(),
  rounds: 0,
  phase: 'owned',
  lastTotal: Infinity,
  stale: 0,
  step: 0,
  done: false
}

/** Everything staked inside a division: its leader, its units and their gear. */
const divisionPieces = (d: Division): AssetRef[] =>
  [d.leader, ...d.units.flatMap((u) => [u.asset, u.gear.weapon, u.gear.supply, u.gear.creature, u.gear.lavalux])].filter(
    (a): a is AssetRef => !!a
  )

/** A short, stable fingerprint of a long string. */
function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i)
  return (h >>> 0).toString(36)
}

const SOLVABLE: Kind[] = ['mercenary', 'weapon', 'supply', 'creature', 'lavalux']
const GEAR_ORDER: GearKind[] = GEAR_KINDS
const SLOT_LABEL: Record<SlotKind, string> = { weapon: 'equipment', supply: 'supply', lavalux: 'Lava Lux' }

/**
 * The candidates each solver input was built from. While a new input is being solved the page still
 * shows the previous answer, which must be read with its own candidates: after "Use my NFTs" is
 * switched off, for one, the new candidates no longer contain the wallet NFTs that answer uses.
 */
const SOURCES_OF = new WeakMap<SolveInput, Map<string, Source>>()

/** Rarities a player may leave out of the bundle, cheapest first. */
const RARITY_LIST = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']

const assetOf = (s: Source) => (s.from === 'market' ? s.listing.asset : s.asset)

/**
 * One transaction of a purchase. Each is complete in itself (a group of sales is checked, paid and
 * bought together; a group of blends deposits and blends its own materials), so a purchase that
 * stops half way never leaves WAX or NFTs in limbo, and the steps after it can be resumed.
 */
interface PurchaseStep {
  label: string
  build: (account: string, permission: string) => AnyAction[]
}

/** Sales per transaction: 4 checks, 1 deposit and 4 purchases make 9 actions (each purchase moves an NFT and pays fees). */
const SALES_PER_TX = 4
/** Blend runs per transaction (their materials are deposited in the same transaction). */
const BLENDS_PER_TX = 4
/** NFTs staked per transaction. */
const STAKE_PER_TX = 20

const chunk = <T,>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

/** A plan being carried out: kept as it was bought, so the division is built from exactly these NFTs. */
interface Locked {
  bundle: Bundle
  sources: Map<string, Source>
  phase: 'buying' | 'bought' | 'building' | 'done'
  /** While buying: the steps, how many are done, and the one that failed (if it stopped). */
  steps?: PurchaseStep[]
  done?: number
  failed?: string
  /** Wallet asset ids of the blended templates before blending, so the new ones can be told apart. */
  known: Set<string>
}

type MaterialBuy = { templateId: string; price: number }

/**
 * Shared between the builder and the Chests & keys shelf: the materials the last priced bundle
 * buys (null before any), and how many chests the "open chests first?" forecast assumes.
 */
const useChestShare = create<{
  buys: MaterialBuy[] | null
  counts: { chest: number; key: number }
  setBuys: (b: MaterialBuy[] | null) => void
  setCounts: (c: { chest: number; key: number }) => void
}>((set) => ({
  buys: null,
  counts: { chest: 10, key: 10 },
  setBuys: (buys) => set({ buys }),
  setCounts: (counts) => set({ counts })
}))

export function MarketBuilder({
  account,
  spectating,
  onMissions,
  view = 'builder',
  onLoaded,
  request
}: {
  account: string
  spectating: boolean
  /** Opens the Missions page after the division is built. */
  onMissions?: () => void
  /** The builder, or the payback table for every mission (both stay mounted so neither loses its work). */
  view?: 'builder' | 'payback'
  /** A payback row was loaded into the builder: show the builder. */
  onLoaded?: () => void
  /** A target handed over from elsewhere (the Upgrade tab): filled in and searched. `nonce` makes a repeat count. */
  request?: { atk: number; def: number; maxMove?: number; missionId?: number; nonce: number } | null
}) {
  const { run, pending } = useTransaction()
  const player = usePlayer(account)
  const army = useArmy(account)
  const wallet = useWalletNfts(account)
  const listings = useListings()
  const config = useMissionConfig()
  const forge = useForgeConfig()
  const pools = useSwapPools()
  const blends = useBlends()
  const collection = useCollectionTemplates()
  const ownedInputs = useOwnedBlendInputs(account)
  const statsMap = useAssetStats()
  const templatesJson = useTemplates()
  const tlmDef = useMarket()
  const chestCounts = useChestShare((s) => s.counts)
  const setChestCounts = useChestShare((s) => s.setCounts)
  const setSharedBuys = useChestShare((s) => s.setBuys)

  const [atkText, setAtkText] = useState('1000')
  const [defText, setDefText] = useState('0')
  // Optional: the division's move cost may not go above this (blank: no limit).
  const [moveText, setMoveText] = useState('')
  // The scan the user started: its targets and toggles, plus a counter so the same values can be rescanned.
  const [scanKey, setScanKey] = useState<string | null>(null)
  // Staked NFTs (the reserve), wallet NFTs and wallet blend materials can each be used or not.
  const [useStaked, setUseStaked] = useState(true)
  const [useDivisions, setUseDivisions] = useState(false)
  const [useWallet, setUseWallet] = useState(true)
  const [useMaterials, setUseMaterials] = useState(true)
  /** Rarities left out of the bundle: no listing, blend or owned NFT of these is offered. */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const excludedKey = [...excluded].sort().join('+') || 'all'
  const useOwned = useStaked || useDivisions || useWallet || useMaterials
  const [locked, setLocked] = useState<Locked | null>(null)
  /*
   * Blend prices corrected after a solve (see below), keyed by candidate; cleared when the targets
   * change. Two passes: 'owned' prices each recipe as if your materials were free for it alone;
   * 'market' prices every blend at market cost and lets your materials lower the real cost only when
   * the chosen blends are planned together. Owning more can then never make the answer dearer.
   */
  const [blendPrices, setBlendPrices] = useState<Refinement>(FRESH_REFINEMENT)
  // The cheapest bundle any correction round found for the current target, at its real (joint) cost.
  const [best, setBest] = useState<{
    target: string
    bundle: Bundle
    input: SolveInput
    total: number
    /** The corrections and pass that produced it, so a refresh can rebuild the same answer. */
    prices: Map<string, number>
    phase: Refinement['phase']
  } | null>(null)

  const atk = Math.max(0, Math.round(Number(atkText) || 0))
  const def = Math.max(0, Math.round(Number(defText) || 0))
  const maxMove = Math.round(Number(moveText) || 0) > 0 ? Math.round(Number(moveText)) : undefined
  const forgeLevel = player.data?.forgeLevel ?? 0

  // Nothing is searched until the user asks: typing a target should not start a long search.
  const paramsKey = `${atk}/${def}/${maxMove ?? '-'}/${useStaked}/${useDivisions}/${useWallet}/${useMaterials}/${excludedKey}`
  const scanning = !!scanKey && scanKey.startsWith(paramsKey + '#')
  /*
   * A scan works on a snapshot of the market and your NFTs taken when it starts. Pool prices refresh
   * every minute and listings every two; if those fed into a running scan, every refresh would change
   * its input and restart the search, and a search step longer than a minute would never finish.
   * "Scan again" takes a fresh snapshot.
   */
  const live = {
    listings: listings.data,
    army: army.data,
    wallet: wallet.data,
    player: player.data,
    forge: forge.data,
    pools: pools.data,
    ownedInputs: ownedInputs.data
  }
  const [frozen, setFrozen] = useState<{ key: string; at: number; data: typeof live } | null>(null)
  const scan = () => {
    if (atk <= 0 && def <= 0) return
    const key = `${paramsKey}#${Date.now()}`
    setScanKey(key)
    setFrozen({ key, at: Date.now(), data: live })
  }
  /** Set when a payback row is loaded: the full search starts once its values are in the fields. */
  const [scanWhen, setScanWhen] = useState<string | null>(null)
  useEffect(() => {
    if (!scanWhen || scanWhen !== `${atk}/${def}/${maxMove ?? '-'}`) return
    setScanWhen(null)
    scan()
    // Runs once the loaded values have rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanWhen, atk, def, maxMove])
  /** Fills the goal and runs the full search once the values are in the fields. */
  const loadTarget = (t: { atk: number; def: number; maxMove?: number; missionId?: number }) => {
    setPresetId(t.missionId ?? null)
    setAtkText(String(t.atk))
    setDefText(String(t.def))
    setMoveText(t.maxMove !== undefined && t.maxMove > 0 ? String(t.maxMove) : '')
    setScanWhen(`${t.atk}/${t.def}/${t.maxMove !== undefined && t.maxMove > 0 ? t.maxMove : '-'}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    onLoaded?.()
  }
  const loadRoi = (r: RoiRow) => loadTarget({ atk: r.e.minAtk, def: r.e.minDef, maxMove: r.maxMove, missionId: r.e.id })
  useEffect(() => {
    if (request) loadTarget(request)
    // Only a new request (its nonce) loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce])
  const snapshot = scanning && frozen?.key === scanKey ? frozen : null
  const snap = snapshot?.data ?? live

  // Every current mission, for the payback panel.
  const missionList = useMemo(
    () => (config.data ? config.data.missions.map((row) => missionEconomics(row, config.data!)) : []),
    [config.data]
  )

  // One-click targets: the requirements of the missions running now.
  const [presetId, setPresetId] = useState<number | null>(null)
  const presets = useMemo(() => {
    if (!config.data) return []
    // Every running mission by name, even when two ask for the same (Veles Intelligence and Sword and Shield both ask 2,000 atk).
    const list: { id: number; atk: number; def: number; title: string; planet: string }[] = []
    for (const row of config.data.missions) {
      const e = missionEconomics(row, config.data)
      if (e.state !== 'active' || (!e.minAtk && !e.minDef)) continue
      list.push({ id: e.id, atk: e.minAtk, def: e.minDef, title: e.title, planet: e.planet })
    }
    return list.sort((a, b) => a.atk + a.def - (b.atk + b.def) || a.title.localeCompare(b.title))
  }, [config.data])

  /*
   * The goal: the missions you want to be able to run at once, with how many divisions each
   * ("3× Veles Intelligence, 1× Neri"). Your divisions that already meet a mission count towards it
   * (the hardest missions are matched first, each to the weakest division that meets it). They stay
   * an ordinary source for the builder: a build may take them apart when that is cheaper. The rest
   * is built one division at a time with the usual search. Remembered per account in this browser.
   */
  const goalKey = `pd:market-goal:${account}`
  const readGoal = (key: string): [number, number][] => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? '[]')
      return Array.isArray(raw) ? raw.filter((x) => Array.isArray(x) && x.length === 2 && x[1] > 0) : []
    } catch {
      return []
    }
  }
  // The list with the account it belongs to, so switching accounts shows that account's goal.
  const [goalState, setGoalState] = useState(() => ({ key: goalKey, list: readGoal(goalKey) }))
  const goal = goalState.key === goalKey ? goalState.list : readGoal(goalKey)
  const setGoal = (f: (g: [number, number][]) => [number, number][]) => {
    const list = f(goal)
    setGoalState({ key: goalKey, list })
    try {
      localStorage.setItem(goalKey, JSON.stringify(list))
    } catch {
      // Private mode: the goal holds for this visit.
    }
  }
  const setGoalCount = (id: number, n: number) =>
    setGoal((g) => (n <= 0 ? g.filter(([x]) => x !== id) : g.some(([x]) => x === id) ? g.map(([x, c]) => [x, x === id ? n : c]) : [...g, [id, n]]))
  const coverage = useMemo(() => {
    const req = new Map(presets.map((p) => [p.id, p]))
    const divs = (army.data?.divisions ?? []).filter((d) => d.units.length > 0)
    const slots = goal
      .flatMap(([id, n]) => (req.has(id) ? Array.from({ length: n }, () => req.get(id)!) : []))
      .sort((a, b) => b.atk + b.def - (a.atk + a.def))
    const kept = new Set<number>()
    const have = new Map<number, number>()
    for (const s of slots) {
      const fit = divs
        .filter((d) => !kept.has(d.id) && d.atk >= s.atk && d.def >= s.def)
        .sort((a, b) => a.atk + a.def - (b.atk + b.def))[0]
      if (!fit) continue
      kept.add(fit.id)
      have.set(s.id, (have.get(s.id) ?? 0) + 1)
    }
    // The next to build: the hardest mission still short.
    const next = [...goal]
      .map(([id, n]) => ({ p: req.get(id), short: n - (have.get(id) ?? 0) }))
      .filter((x): x is { p: (typeof presets)[number]; short: number } => !!x.p && x.short > 0)
      .sort((a, b) => b.p.atk + b.p.def - (a.p.atk + a.p.def))[0]
    return { kept, have, next: next?.p ?? null, missing: goal.reduce((n, [id, c]) => n + Math.max(0, c - (have.get(id) ?? 0)), 0) }
  }, [goal, presets, army.data])
  const [goalAdd, setGoalAdd] = useState('')

  /*
   * Corrected blend prices only apply to the target they were found for. A new target, or a change in
   * what you own, starts the search over. A scan works on its own snapshot (see above), so market
   * refreshes never disturb it.
   */
  const ownedSig = useMemo(
    () =>
      hashOf(
        [
          (snap.wallet ?? []).map((a) => a.assetId).join(','),
          snap.army
            ? Object.values(snap.army.free)
                .flatMap((list) => list.map((a) => a.assetId))
                .join(',')
            : '',
          snap.army ? snap.army.divisions.flatMap((d) => divisionPieces(d).map((a) => a.assetId)).join(',') : '',
          [...(snap.ownedInputs?.entries() ?? [])].map(([t, ids]) => `${t}:${ids.length}`).join(',')
        ].join('|')
      ),
    [snap.wallet, snap.army, snap.ownedInputs]
  )
  const targetKey = `${scanKey}|${ownedSig}`
  // The best bundle is only comparable within one market snapshot.
  const bestKey = targetKey
  const correctedPrices = useMemo(
    () => (blendPrices.target === targetKey ? blendPrices.prices : new Map<string, number>()),
    [blendPrices, targetKey]
  )
  const phase = blendPrices.target === targetKey ? blendPrices.phase : 'owned'

  // Materials on the market and in the wallet, for pricing blends (owned ones only when allowed).
  const blendMarket = useMemo(
    () =>
      snap.listings && collection.data
        ? marketFrom(snap.listings, useMaterials ? (snap.ownedInputs ?? new Map()) : new Map(), collection.data, account)
        : null,
    [snap.listings, collection.data, snap.ownedInputs, useMaterials, account]
  )

  // The two Quantum Chest recipes, for the "open chests first?" forecast.
  const openings = useMemo(() => (blends.data ? openingsOf(blends.data) : null), [blends.data])

  // Everything the solver may use, and where each piece comes from.
  const { input, sources, base } = useMemo(() => {
    const sources = new Map<string, Source>()
    const items: Candidate[] = []
    const warlords: WarlordOption[] = []
    const add = (key: string, source: Source, cost: number) => {
      const a = assetOf(source)
      if (excluded.has(String(a.rarity ?? '').toLowerCase())) return
      const st = a.stats
      const kind = kindOfCategory(st?.category)
      if (!st || !kind) return
      // Ascended NFTs need a Forge level; the solver weighs paying for it.
      const minLevel = Number(st.min_forge_level || 0)
      if (kind === 'warlord') {
        if (st.slots_max > 0) {
          sources.set(key, source)
          warlords.push({ key, slots: Number(st.slots_max), minLevel, cost, moveReduction: Number(st.movecost_reduction || 0) })
        }
        return
      }
      if (!SOLVABLE.includes(kind)) return
      sources.set(key, source)
      items.push({
        key,
        kind: kind as Candidate['kind'],
        group: `${source.from}:${a.templateId}`,
        atk: Number(st.attack || 0),
        def: Number(st.defense || 0),
        move: Number(st.movecost || 0),
        moveReduction: Number(st.movecost_reduction || 0),
        ...(kind === 'lavalux'
          ? {
              atkMult: Number(st.attack_mult_bp || 10000) / 10000,
              defMult: Number(st.defense_mult_bp || 10000) / 10000,
              moveMult: Number(st.movecost_mult_bp || 10000) / 10000
            }
          : {}),
        minLevel,
        cost
      })
    }
    for (const l of snap.listings ?? [])
      if (l.seller !== account) add(`sale:${l.saleId}`, { from: 'market', listing: l }, l.price)
    if (useStaked && snap.army)
      for (const kind of Object.keys(snap.army.free) as Kind[])
        for (const a of snap.army.free[kind]) add(`own:${a.assetId}`, { from: 'reserve', asset: a }, 0)
    // NFTs inside divisions count as free too: the player takes them out (or disbands) to build
    // this one. Gear that moves over keeps the Forge slot it already has, so a bundle that reuses
    // it needs one slot fewer than counted; a small overstatement on the safe side.
    if (useDivisions && snap.army)
      for (const d of snap.army.divisions)
        for (const a of divisionPieces(d))
          add(`own:${a.assetId}`, { from: 'division', asset: a, division: d.id, locked: !!d.lock }, 0)
    if (useWallet) {
      for (const a of snap.wallet ?? []) add(`wal:${a.assetId}`, { from: 'wallet', asset: a }, 0)
    }
    // Blended NFTs: every recipe whose result goes into a division, a few copies each. Each copy is
    // priced by the materials it still needs (owned ones first), so later copies cost more.
    if (blendMarket && blends.data && statsMap.data && templatesJson.data) {
      for (const b of blends.data) {
        const r = resultOf(b)
        if (!b.active || !r || !statsMap.data.has(r)) continue
        const copies = Math.min(mintable(blendMarket, b), MAX_BLEND_COPIES)
        const reserved = new Map<string, number>()
        const pricing = phase === 'market' ? { ...blendMarket, owned: new Map<string, string[]>() } : blendMarket
        for (let k = 0; k < copies; k++) {
          const planned = planBlend(pricing, b, reserved).cost
          // A price corrected by the joint plan of an earlier solve wins over the stand-alone estimate.
          const cost = Math.max(planned, correctedPrices.get(`blend:${b.id}:${k}`) ?? 0)
          if (!Number.isFinite(cost)) break
          const key = `blend:${b.id}:${k}`
          const schema = blendMarket.templates.get(r)?.schema ?? ''
          add(
            key,
            {
              from: 'blend',
              blend: b,
              asset: makeAssetRef(key, { t: r, s: schema, c: 'planetdefnft' }, statsMap.data, templatesJson.data)
            },
            cost
          )
        }
      }
    }
    const base: Omit<SolveInput, 'atk' | 'def' | 'maxMove'> | null =
      snap.listings && snap.player && snap.army && snap.forge && snap.pools
        ? {
            warlords,
            items,
            economy: buildEconomy({
              forgeLevel,
              progress: snap.player.forgeProgress,
              levels: snap.forge.levels,
              shopItems: snap.forge.shopItems,
              powerups: snap.player.powerups,
              used: { weapon: snap.army.gearUsed.weapon, supply: snap.army.gearUsed.supply, lavalux: snap.army.gearUsed.lavalux },
              pools: snap.pools
            })
          }
        : null
    const input: SolveInput | null = (atk > 0 || def > 0) && base ? { atk, def, ...(maxMove ? { maxMove } : {}), ...base } : null
    if (input) SOURCES_OF.set(input, sources)
    return { input, sources, base }
  }, [
    snap.listings,
    snap.army,
    snap.wallet,
    snap.player,
    snap.forge,
    snap.pools,
    blendMarket,
    blends.data,
    correctedPrices,
    phase,
    statsMap.data,
    templatesJson.data,
    useStaked,
    useDivisions,
    useWallet,
    excluded,
    atk,
    def,
    maxMove,
    account,
    forgeLevel
  ])

  const solver = useBundleSolver(locked || !scanning ? null : input)

  /*
   * Each recipe's copies are priced on their own, so two recipes can both count the same owned
   * material as free. After a solve, the chosen blends are planned together; any that turn out
   * dearer get their real price and the bundle is solved again, while that keeps helping.
   * A later round is not always cheaper in truth than an earlier one, so the cheapest is kept.
   */
  useEffect(() => {
    const b = solver.bundle
    // Only an answer to the current input can correct its prices. Refreshes rebuild an input of the
    // same content without solving again, so compare with the solver's own copy.
    const solved = solver.solvedFor
    if (!b || locked || !solved || solved !== solver.current) return
    const sources = SOURCES_OF.get(solved)
    if (!sources) return
    const st: Refinement = blendPrices.target === targetKey ? blendPrices : { ...FRESH_REFINEMENT, target: targetKey }
    let usesBlends = false
    const assumed = new Map(solved.items.map((i) => [i.key, i.cost]))
    const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_ORDER.flatMap((k) => b.gear[k].map((g) => g.key))]
    const reserved = new Map<string, number>()
    const prices = new Map(correctedPrices)
    let changed = false
    let total = b.slotCost + b.forgeCost
    for (const key of keys) {
      const s = sources.get(key)
      if (s?.from === 'market') total += s.listing.price
      if (s?.from !== 'blend' || !blendMarket) continue
      usesBlends = true
      const real = planBlend(blendMarket, s.blend, reserved).cost
      total += real
      // A blend that cannot be made any more gets a stand-in price far above anything real.
      const next = Number.isFinite(real) ? real : UNMAKEABLE
      if (next > (assumed.get(key) ?? 0) + 0.5) {
        prices.set(key, next)
        changed = true
      }
    }
    // Every blend the solver did not pick: what one more of it really costs on top of the chosen ones.
    // Those use up the cheap materials, so recipes needing the same ones get dearer too; without
    // this the next round would pick them at prices that no longer exist.
    if (blendMarket) {
      const chosen = new Set(keys)
      const byRecipe = new Map<number, { key: string; copy: number; blend: Blend }[]>()
      for (const it of solved.items) {
        if (chosen.has(it.key)) continue
        const s = sources.get(it.key)
        if (s?.from !== 'blend') continue
        const list = byRecipe.get(s.blend.id) ?? []
        list.push({ key: it.key, copy: Number(it.key.split(':')[2] ?? 0), blend: s.blend })
        byRecipe.set(s.blend.id, list)
      }
      for (const list of byRecipe.values()) {
        const after = new Map(reserved)
        for (const c of list.sort((x, y) => x.copy - y.copy)) {
          const real = planBlend(blendMarket, c.blend, after).cost
          const next = Number.isFinite(real) ? real : UNMAKEABLE
          if (next > (assumed.get(c.key) ?? 0) + 0.5) {
            prices.set(c.key, next)
            changed = true
          }
        }
      }
    }
    // Only a price that really moved starts another round: the same prices would mean the same
    // input, which the solver does not solve twice, and the search would wait forever.
    if (changed) changed = [...prices].some(([k, v]) => correctedPrices.get(k) !== v)
    const prevBest = best?.target === bestKey ? best : null
    const winner =
      prevBest && prevBest.total <= total
        ? prevBest
        : { target: bestKey, bundle: b, input: solved, total, prices: correctedPrices, phase: st.phase }
    if (winner !== prevBest) setBest(winner)
    if (st.done) return
    const step = st.step + 1
    // Both passes run until PATIENCE rounds in a row bring nothing cheaper (at most MAX_ROUNDS). The
    // second pass needs its rounds: it is what keeps owning more materials from raising the price.
    // After its first two rounds, the second pass has to beat the best overall, not just itself.
    const bar = st.phase === 'market' && st.rounds >= 2 ? Math.min(st.lastTotal, prevBest?.total ?? Infinity) : st.lastTotal
    const better = total < bar - 1
    const stale = better ? 0 : st.stale + 1
    if (changed && stale < PATIENCE && st.rounds < MAX_ROUNDS)
      setBlendPrices({ ...st, prices, rounds: st.rounds + 1, lastTotal: Math.min(st.lastTotal, total), stale, step })
    // The first pass is done. When it blended and you own materials, try the market-priced pass too.
    else if (st.phase === 'owned' && usesBlends && (blendMarket?.owned.size ?? 0) > 0)
      setBlendPrices({ ...st, prices: new Map(), rounds: 0, phase: 'market', lastTotal: Infinity, stale: 0, step })
    // Done: keep the winning round's corrections, so a market refresh rebuilds that answer (the
    // solver remembers recent answers, so this costs no extra search).
    else setBlendPrices({ ...st, step, done: true, prices: winner.prices, phase: winner.phase })
    // Only a new answer from the solver starts a round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solver.bundle, solver.solvedFor])
  const bestNow = best?.target === bestKey ? best : null
  const refinement = blendPrices.target === targetKey ? blendPrices : null
  // After the search, background refreshes still re-solve, but that is not shown as a search.
  const refining = !locked && scanning && !!input && !refinement?.done
  // Watchdog: the search is not done, yet nothing is being solved. A round that changed nothing the
  // solver sees would otherwise leave it waiting forever, so the search ends with the best found.
  useEffect(() => {
    if (!refining || solver.solving) return
    const timer = setTimeout(
      () => setBlendPrices((st) => (st.target === targetKey && !st.done ? { ...st, done: true } : st)),
      WATCHDOG_MS
    )
    return () => clearTimeout(timer)
  }, [refining, solver.solving, blendPrices, targetKey])
  // The solver keeps its last answer while a new input is solved; before this scan's first answer
  // that would be the previous scan's bundle, shown as "best so far" and then replaced by a number
  // that may well be higher. Only an answer to the current input is shown.
  const answered = solver.solvedFor && solver.solvedFor === solver.current ? solver : null
  const shownInput = bestNow?.input ?? answered?.solvedFor ?? null
  const shown = locked?.bundle ?? bestNow?.bundle ?? answered?.bundle ?? null
  const shownSources = locked?.sources ?? (shownInput ? SOURCES_OF.get(shownInput) : undefined) ?? sources

  const ready = !!(listings.data && player.data && army.data && forge.data && pools.data)
  const plan =
    ready && shown ? summarize(shown, shownSources, player.data!, pools.data!, input?.economy ?? null, blendMarket) : null

  // The Chests & keys shelf forecasts against the materials of the bundle shown here.
  const buysSig = plan ? plan.materialBuys.map((l) => l.saleId).join(',') : '-'
  useEffect(() => {
    setSharedBuys(plan ? plan.materialBuys.map((l) => ({ templateId: l.templateId, price: l.price })) : null)
    // The signature stands for the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buysSig])

  if (!ready) return <div className="box mb-box none">Reading the market…</div>

  const affordable = !plan || player.data!.wax >= plan.waxTotal
  const twoPasses = !!blendMarket && blendMarket.owned.size > 0 && useMaterials

  /**
   * The purchase as a list of small transactions, in the order the contracts need: Alcor swaps for
   * the DEF and TLM the wallet is short of, Forge levels and slots; then the NFTs and materials in
   * groups (each group checked, paid and bought together); then the blends; then staking. Each step
   * is signed on its own, and a stopped purchase can be resumed at the step that failed.
   */
  function purchaseSteps(): PurchaseStep[] {
    if (!shown || !plan) return []
    const b = shown
    const purchases = [...plan.toBuy, ...plan.materialBuys]
    const stakeIds = [...plan.toBuy.map((l) => l.assetId), ...plan.fromWallet.map((a) => a.assetId)]
    const tlmContract = forge.data?.tokens?.tlm_contract || 'alien.worlds'
    const steps: PurchaseStep[] = []
    const slots = (Object.keys(b.slotsBought) as SlotKind[]).flatMap((k) => b.slotsBought[k])
    if (plan.defShort > 0 || plan.tlmShort > 0 || plan.levelSteps.length || slots.length) {
      const defShort = plan.defShort
      const tlmShort = plan.tlmShort
      const levels = plan.levelSteps
      steps.push({
        label: [
          (defShort > 0 || tlmShort > 0) && 'swap on Alcor',
          levels.length && `Forge level ${b.level}`,
          slots.length && `${slots.length} Forge slot${slots.length === 1 ? '' : 's'}`
        ]
          .filter(Boolean)
          .join(', ')
          .replace(/^./, (c) => c.toUpperCase()),
        build: (a, p) => [
          ...(defShort > 0 ? [buyExactAction(a, p, pools.data!.def, 'DEF', defShort).action] : []),
          ...(tlmShort > 0 ? [buyExactAction(a, p, pools.data!.tlm, 'TLM', tlmShort).action] : []),
          ...levels.map((step) => payForgeLevel(a, p, step.level, step.quantity, tlmContract)),
          ...slots.map((o) => buyShopItem(a, p, o.itemId, o.price, o.priceContract))
        ]
      })
    }
    for (const group of chunk(purchases, SALES_PER_TX)) {
      const wax = group.reduce((n, l) => n + l.price, 0)
      steps.push({
        label: `Buy ${group.length} listing${group.length === 1 ? '' : 's'} (${formatNumber(wax, 2)} WAX)`,
        build: (a, p) =>
          buySalesActions(
            a,
            p,
            group.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
          )
      })
    }
    for (const group of chunk(plan.blendRuns, BLENDS_PER_TX))
      steps.push({
        label: `Blend ${group.length}`,
        build: (a, p) =>
          blendActions(
            a,
            p,
            group.map((r) => ({ blendId: r.blendId, assetIds: r.assetIds }))
          )
      })
    for (const group of chunk(stakeIds, STAKE_PER_TX))
      steps.push({ label: `Stake ${group.length}`, build: (a, p) => [stakeBoughtAction(a, p, group)] })
    return steps
  }

  async function buy() {
    if (!shown || !plan) return
    // What of the blended templates is already in the wallet, so the build step can spot the new ones.
    const blendedTemplates = new Set(plan.blendRuns.map((r) => r.templateId))
    const known = new Set((wallet.data ?? []).filter((a) => blendedTemplates.has(a.templateId)).map((a) => a.assetId))
    const steps = purchaseSteps()
    const start: Locked = { bundle: shown, sources: shownSources, phase: 'buying', known, steps, done: 0 }
    if (!steps.length) {
      setLocked({ ...start, phase: 'bought' })
      return
    }
    setLocked(start)
    await runSteps(start)
  }

  /** Signs the remaining purchase steps one by one; stops at the first that fails, so it can resume. */
  async function runSteps(from: Locked) {
    const steps = from.steps ?? []
    let cur: Locked = { ...from, failed: undefined }
    setLocked(cur)
    for (let i = cur.done ?? 0; i < steps.length; i++) {
      const ok = await run(steps[i].build, `Step ${i + 1} of ${steps.length} done: ${steps[i].label}`, 'buy', {
        split: true
      })
      if (!ok) {
        cur = { ...cur, done: i, failed: steps[i].label }
        setLocked(cur)
        return
      }
      cur = { ...cur, done: i + 1 }
      setLocked(cur)
    }
    setLocked({ ...cur, phase: 'bought', steps: undefined, failed: undefined })
    toast.success('Everything is bought. Build the division next.')
  }

  /**
   * Waits for the blended NFTs to be minted (the random oracle answers within seconds), stakes them
   * with the new division's warlord, then adds the mercenaries and their gear.
   */
  async function build() {
    if (!locked || !account) return
    const b = locked.bundle
    const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_ORDER.flatMap((k) => b.gear[k].map((g) => g.key))]
    const blended = keys.filter((k) => locked.sources.get(k)?.from === 'blend')
    const minted = new Map<string, string>()
    setLocked({ ...locked, phase: 'building' })

    if (blended.length) {
      toast.info(`Waiting for ${blended.length} blended NFT${blended.length === 1 ? '' : 's'} to be minted…`)
      for (let attempt = 0; attempt < 30 && minted.size < blended.length; attempt++) {
        const assets = await atomic.getOwnedAssets(account, 'planetdefnft').catch(() => [])
        const fresh = assets.filter(
          (a) => a.template && !locked.known.has(a.asset_id) && ![...minted.values()].includes(a.asset_id)
        )
        for (const key of blended) {
          if (minted.has(key)) continue
          const want = assetOf(locked.sources.get(key)!).templateId
          const hit = fresh.find((a) => a.template!.template_id === want && ![...minted.values()].includes(a.asset_id))
          if (hit) minted.set(key, hit.asset_id)
        }
        if (minted.size < blended.length) await new Promise((r) => setTimeout(r, 3000))
      }
      if (minted.size < blended.length) {
        toast.error('The blended NFTs have not arrived yet. Try Build again in a moment.')
        setLocked({ ...locked, phase: 'bought' })
        return
      }
    }
    const idOf = (key: string) => {
      const s = locked.sources.get(key)!
      return s.from === 'market' ? s.listing.assetId : s.from === 'blend' ? minted.get(key)! : s.asset.assetId
    }

    const leader = idOf(b.warlord.key)
    const created = await run(
      (a, p) => [...(minted.size ? [stakeBoughtAction(a, p, [...minted.values()])] : []), createDivision(a, p, leader)],
      'Division created, adding the troops…',
      'build',
      { split: true }
    )
    if (!created) {
      setLocked({ ...locked, phase: 'bought' })
      return
    }
    let divisionId: number | null = null
    for (let i = 0; i < 10 && divisionId === null; i++) {
      const fresh = await army.refetch()
      divisionId = fresh.data?.divisions.find((d) => String(d.row.leader_asset_id) === leader)?.id ?? null
      if (divisionId === null) await new Promise((r) => setTimeout(r, 1500))
    }
    if (divisionId === null) {
      toast.error('The new division has not shown up yet. Open Divisions in a moment and fill it from there.')
      setLocked({ ...locked, phase: 'bought' })
      return
    }
    const units = b.units
    const id = divisionId
    const equipped = await run(
      (a, p) => [
        ...units.map((u) => addUnit(a, p, id, idOf(u.merc.key))),
        ...units.flatMap((u) =>
          GEAR_ORDER.filter((k) => u.gear[k]).map((k) => assignGearAction(a, p, id, idOf(u.merc.key), k, idOf(u.gear[k]!.key)))
        )
      ],
      `Division #${id} is ready: ${formatNumber(b.atk, 0)} ATK / ${formatNumber(b.def, 0)} DEF`,
      'equip',
      { split: true }
    )
    setLocked({ ...locked, phase: equipped ? 'done' : 'bought' })
  }

  const field = (
    label: string,
    tone: string,
    value: string,
    set: (v: string) => void,
    opts: { step?: number; placeholder?: string; title?: string } = {}
  ) => (
    <label className={`mb-field ${tone}`} title={opts.title}>
      <span>{label}</span>
      <span className="mb-field__ctl">
        <input
          className="input num"
          inputMode="numeric"
          value={value}
          placeholder={opts.placeholder}
          disabled={!!locked}
          onChange={(e) => set(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && scan()}
        />
        {opts.step && (
          <span className="stepper">
            <button
              type="button"
              aria-label="Less"
              disabled={!!locked}
              onClick={() => set(String(Math.max(0, (Number(value) || 0) - opts.step!)))}
            >
              −
            </button>
            <button
              type="button"
              aria-label="More"
              disabled={!!locked}
              onClick={() => set(String((Number(value) || 0) + opts.step!))}
            >
              +
            </button>
          </span>
        )}
      </span>
    </label>
  )

  const toggle = (label: string, on: boolean, set: (v: boolean) => void, title: string) => (
    <label className={`opt__toggle ${on ? 'is-on' : ''}`} title={title}>
      <input type="checkbox" checked={on} disabled={!!locked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  )

  // The picked mission stays shown while its requirements are in the fields; editing them clears it.
  const pickedPreset = presets.find((p) => p.id === presetId && p.atk === atk && p.def === def)
  const presetValue = pickedPreset ? String(pickedPreset.id) : ''

  return (
    <>
      <div hidden={view !== 'payback'}>
        <RoiSweep
          base={base}
          missions={missionList}
          tlmDef={tlmDef}
          pools={pools.data}
          disabled={!!locked || refining}
          onLoad={loadRoi}
        />
      </div>
      <div className="mb-wrap" hidden={view === 'payback'}>
        <section className="box mb-box mb-goal">
          <h2 className="h">
            Build a division <small>The cheapest mix from the market{useOwned ? ' and what you own' : ''}</small>
          </h2>

          <div className="mb-plan" aria-label="Goal: the missions you want to run">
            <div className="mb-plan__hd">
              <b>Goal</b>
              <small>
                {goal.length
                  ? coverage.missing
                    ? `${coverage.missing} division${coverage.missing === 1 ? '' : 's'} still to build`
                    : 'Reached: your divisions can run all of it'
                  : 'Add the missions you want to run at once, with how many divisions each.'}
              </small>
            </div>
            {goal.length > 0 && (
              <ul className="mb-plan__list">
                {goal.map(([id, n]) => {
                  const p = presets.find((x) => x.id === id)
                  const have = coverage.have.get(id) ?? 0
                  return (
                    <li key={id} className={have >= n ? 'is-done' : ''}>
                      <span className="mb-plan__name">
                        <b>{p ? p.title : `Mission #${id} (ended)`}</b>
                        {p && (
                          <small className="num">
                            {p.atk ? formatNumber(p.atk, 0) : '–'} ATK / {p.def ? formatNumber(p.def, 0) : '–'} DEF
                          </small>
                        )}
                      </span>
                      <span className="mb-plan__count" role="group" aria-label={`Divisions for ${p?.title ?? id}`}>
                        <button type="button" disabled={!!locked} aria-label="One fewer" onClick={() => setGoalCount(id, n - 1)}>
                          −
                        </button>
                        <b className="num">{n}×</b>
                        <button type="button" disabled={!!locked} aria-label="One more" onClick={() => setGoalCount(id, n + 1)}>
                          +
                        </button>
                      </span>
                      <span className="mb-plan__have num" title="Your divisions that already meet this mission, each counted once across the goal">
                        {have >= n ? '✓ ' : ''}
                        {Math.min(have, n)} of {n}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="mb-plan__foot">
              <select
                className="input mb-select"
                value={goalAdd}
                disabled={!!locked || presets.length === 0}
                onChange={(e) => {
                  const id = Number(e.target.value)
                  if (id) setGoalCount(id, (goal.find(([x]) => x === id)?.[1] ?? 0) + 1)
                  setGoalAdd('')
                }}
              >
                <option value="">Add a mission…</option>
                {presets.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.title}
                    {p.planet ? ` (${titleCase(p.planet)})` : ''}: {p.atk ? formatNumber(p.atk, 0) : '–'} ATK / {p.def ? formatNumber(p.def, 0) : '–'} DEF
                  </option>
                ))}
              </select>
              {coverage.next && (
                <button
                  type="button"
                  className="btn btn--go btn--sm"
                  disabled={!!locked}
                  title="Loads the hardest mission still short into the builder and searches for the cheapest division for it"
                  onClick={() => loadTarget({ atk: coverage.next!.atk, def: coverage.next!.def, missionId: coverage.next!.id })}
                >
                  Build next: {coverage.next.title}
                </button>
              )}
              {goal.length > 0 && (
                <button type="button" className="btn btn--sm" disabled={!!locked} onClick={() => setGoal(() => [])}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="mb-goal__row">
            <label className="mb-field mb-field--preset">
              <span>Mission</span>
              <select
                className="input mb-select"
                value={presetValue}
                disabled={!!locked || presets.length === 0}
                onChange={(e) => {
                  const p = presets.find((x) => String(x.id) === e.target.value)
                  if (!p) return
                  setPresetId(p.id)
                  setAtkText(String(p.atk))
                  setDefText(String(p.def))
                }}
              >
                <option value="">{presets.length ? 'Pick a mission…' : 'No missions running'}</option>
                {presets.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.title}
                    {p.planet ? ` (${titleCase(p.planet)})` : ''}: {p.atk ? formatNumber(p.atk, 0) : '–'} ATK /{' '}
                    {p.def ? formatNumber(p.def, 0) : '–'} DEF
                  </option>
                ))}
              </select>
            </label>
            {field('Attack', 'c-atk', atkText, setAtkText, { step: 100 })}
            {field('Defense', 'c-def', defText, setDefText, { step: 100 })}
            {field('Move at most', 'c-move', moveText, setMoveText, {
              placeholder: 'any',
              title: 'Optional. Every move point adds 10 s to each mission. Leave empty for no limit.'
            })}
          </div>

          <div className="mb-goal__row mb-goal__opts">
            <div className="opt__toggles">
              {toggle('Reserve', useStaked, setUseStaked, 'Staked NFTs that are in no division count as free.')}
              {toggle(
                'Divisions',
                useDivisions,
                setUseDivisions,
                'NFTs in your divisions count as free too: you take them out first. Divisions on a mission are included; their NFTs are free once they return.'
              )}
              {toggle('Wallet', useWallet, setUseWallet, 'NFTs in your wallet count as free and are staked with the purchase.')}
              {toggle(
                'Blend materials',
                useMaterials,
                setUseMaterials,
                'Blend materials in your wallet count as free when the bundle blends. Off: every material is bought.'
              )}
            </div>
            <span className="mb-rarities" role="group" aria-label="Rarities">
              {RARITY_LIST.map((r) => {
                const off = excluded.has(r)
                return (
                  <button
                    key={r}
                    type="button"
                    className={`mb-rarity ${off ? 'is-off' : ''}`}
                    style={{ '--rc': rarityColor(r) } as CSSProperties}
                    disabled={!!locked}
                    aria-pressed={!off}
                    title={
                      off ? `${titleCase(r)} is left out. Click to allow it again.` : `Click to leave ${titleCase(r)} cards out.`
                    }
                    onClick={() =>
                      setExcluded((prev) => {
                        const next = new Set(prev)
                        if (next.has(r)) next.delete(r)
                        else next.add(r)
                        return next
                      })
                    }
                  >
                    {titleCase(r)}
                  </button>
                )
              })}
            </span>
          </div>

          <div className="mb-goal__go">
            <button
              type="button"
              className="btn btn--go"
              disabled={!!locked || (atk === 0 && def === 0) || !input || refining}
              onClick={scan}
            >
              {refining && <span className="mb-spin" />}
              {scanning ? 'Search again' : 'Find the cheapest'}
            </button>
            <span className="muted mb-goal__status">
              {locked
                ? 'A purchase is under way.'
                : atk === 0 && def === 0
                  ? 'Set attack or defense above 0.'
                  : !input
                    ? 'Reading the market…'
                    : !scanning
                      ? scanKey
                        ? 'The goal changed. Search again for these values.'
                        : `Searches ${listings.data!.length} listings${useOwned ? ' and your NFTs' : ''}.`
                      : snapshot
                        ? `Prices as of ${new Date(snapshot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                        : ''}
            </span>
          </div>

          {refining && (
            <RefineProgress refinement={refinement} solving={solver.solving} lastMs={solver.ms} twoPasses={twoPasses} />
          )}
          {scanning && input && !locked && !solver.solving && !plan && refinement?.done && (
            <p className="none mb-nothing">
              No division can reach this. The market{useOwned ? ' and your NFTs' : ''} do not hold enough attack and defense
              {maxMove ? ` within ${maxMove} move` : ''} for one warlord's slots right now.
            </p>
          )}
        </section>

        {plan && shown && (
          <div className="mb-cols">
            <section className="box mb-box">
              <h2 className="h">
                The bundle
                <small>
                  {shown.mercs.length} mercenar{shown.mercs.length === 1 ? 'y' : 'ies'} under a {shown.warlord.slots}-slot warlord
                  {plan.gearCount ? `, ${plan.gearCount} gear` : ''}
                  {solver.ms !== null && !locked ? ` · ${formatNumber(solver.ms, 0)} ms` : ''}
                </small>
              </h2>
              <div className="tablewrap">
                <table className="t mb-table">
                  <thead>
                    <tr>
                      <th>Card</th>
                      <th>From</th>
                      <th className="num">Atk</th>
                      <th className="num">WAX</th>
                    </tr>
                  </thead>
                  <tbody>
                    <BundleRow
                      source={shownSources.get(shown.warlord.key)!}
                      role={`Warlord · ${shown.warlord.slots} slots`}
                      plan={plan}
                      itemKey={shown.warlord.key}
                    />
                    {plan.units.map((u) => (
                      <UnitRows key={u.merc.key} unit={u} sources={shownSources} plan={plan} />
                    ))}
                    {plan.slotCount > 0 && (
                      <tr className="mb-extra">
                        <td>
                          <span className="mb-card">
                            <span className="mb-card__icon">
                              <Icon name="plus" size={16} />
                            </span>
                            <span
                              className="mb-card__text"
                              title="Equipment, supplies and Lava Lux each need a Forge slot. The DEF is priced at what it costs in WAX on Alcor."
                            >
                              <b>Forge slots</b>
                              <small>
                                {slotSummary(shown)} · {formatToken(plan.defNeed)} DEF
                              </small>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="pill">Forge</span>
                        </td>
                        <td className="num muted">–</td>
                        <td className="num">{formatNumber(shown.slotCost, 2)}</td>
                      </tr>
                    )}
                    {shown.level > forgeLevel && (
                      <tr className="mb-extra">
                        <td>
                          <span className="mb-card">
                            <span className="mb-card__icon">
                              <Icon name="flame" size={16} />
                            </span>
                            <span
                              className="mb-card__text"
                              title="These slots or cards need a higher Forge level. The TLM is priced at what it costs in WAX on Alcor."
                            >
                              <b>
                                Forge level {forgeLevel} → {shown.level}
                              </b>
                              <small>{formatToken(plan.tlmNeed)} TLM</small>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="pill">Forge</span>
                        </td>
                        <td className="num muted">–</td>
                        <td className="num">{formatNumber(shown.forgeCost, 2)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="help">
                You have {input?.economy.slots.weapon.free ?? 0} equipment, {input?.economy.slots.supply.free ?? 0} supply and{' '}
                {input?.economy.slots.lavalux.free ?? 0} Lava Lux slots free; more are bought when that is cheaper. Supplies go to
                the highest move costs, Lava Lux to the strongest mercenaries.
              </p>
            </section>

            <aside className="box mb-box mb-side">
              {locked && locked.phase === 'buying' ? (
                <PurchaseProgress
                  locked={locked}
                  pending={pending}
                  onResume={() => void runSteps(locked)}
                  onRescan={() => {
                    setLocked(null)
                    scan()
                  }}
                />
              ) : locked ? (
                <BuildSteps
                  locked={locked}
                  pending={pending}
                  onBuild={build}
                  onReset={() => setLocked(null)}
                  onMissions={onMissions}
                />
              ) : (
                <>
                  <div className="mb-price">
                    <span className="eyebrow">{refining ? 'Best so far' : 'Total'}</span>
                    <b className="num">
                      {formatNumber(plan.total, 2)} <small>WAX</small>
                    </b>
                    {solver.solving && <span className="mb-spin" title="Updating" />}
                  </div>
                  <ul className="mb-lines">
                    <li>
                      <span>
                        Cards{' '}
                        <small>
                          ({plan.toBuy.length} to buy, {plan.owned} yours)
                        </small>
                      </span>
                      <b className="num">{formatNumber(plan.nftWax, 2)}</b>
                    </li>
                    {plan.blendRuns.length > 0 && (
                      <li title="Made by blending: your materials are used first, the rest are bought and burned in the recipe. The card arrives a few seconds later.">
                        <span>
                          Blends{' '}
                          <small>
                            ({plan.blendRuns.length} to make, {plan.materialBuys.length} materials to buy)
                          </small>
                        </span>
                        <b className="num">{formatNumber(plan.blendWax, 2)}</b>
                      </li>
                    )}
                    {!plan.blendsFeasible && (
                      <li className="c-bad">
                        <span>Two recipes need the same scarce material: one cannot be made right now.</span>
                      </li>
                    )}
                    {plan.slotCount > 0 && (
                      <li>
                        <span>Forge slots</span>
                        <b className="num">{formatNumber(shown.slotCost, 2)}</b>
                      </li>
                    )}
                    {shown.level > forgeLevel && (
                      <li>
                        <span>Forge level</span>
                        <b className="num">{formatNumber(shown.forgeCost, 2)}</b>
                      </li>
                    )}
                    {(plan.defNeed > 0 || plan.tlmNeed > 0 || plan.blendRuns.length > 0) && (
                      <li
                        className="mb-lines__pay"
                        title={`DEF and TLM you hold are used first${
                          plan.defShort || plan.tlmShort
                            ? `; the rest (${[
                                plan.defShort && `${formatToken(plan.defShort)} DEF`,
                                plan.tlmShort && `${formatToken(plan.tlmShort)} TLM`
                              ]
                                .filter(Boolean)
                                .join(', ')}) is bought with WAX on Alcor, with 2% slippage room`
                            : ''
                        }.`}
                      >
                        <span>From your wallet</span>
                        <b className="num">{formatNumber(plan.waxTotal, 2)} WAX</b>
                      </li>
                    )}
                  </ul>
                  <div className="mb-reached">
                    <span className="trio">
                      <span className="c-atk num">{formatNumber(shown.atk, 0)}</span>
                      <span className="c-def num">{formatNumber(shown.def, 0)}</span>
                      <span className="c-move num">{formatNumber(plan.move, 0)}</span>
                    </span>
                    <small className="muted num">+{formatDuration(plan.move * 10)} per mission</small>
                  </div>
                  <div className="mb-have">
                    <span className="muted">Your WAX</span>
                    <b className={`num ${affordable ? '' : 'c-bad'}`}>{formatNumber(player.data!.wax, 0)}</b>
                  </div>
                  <button
                    type="button"
                    className="btn btn--go mb-buy"
                    disabled={!affordable || spectating || pending === 'buy'}
                    onClick={
                      plan.toBuy.length ||
                      plan.blendRuns.length ||
                      plan.fromWallet.length ||
                      plan.slotCount ||
                      plan.levelSteps.length
                        ? buy
                        : () => setLocked({ bundle: shown, sources: shownSources, phase: 'bought', known: new Set() })
                    }
                  >
                    {pending === 'buy' ? <span className="mb-spin" /> : <Icon name="cart" size={16} />} {buyLabel(plan)}
                  </button>
                  {!affordable && (
                    <small className="c-bad">You need {formatNumber(plan.waxTotal - player.data!.wax, 2)} more WAX.</small>
                  )}
                  {spectating && <small className="muted">Viewing read-only: connect your wallet to buy.</small>}
                  {plan.fromDivisions.length > 0 && (
                    <small className="c-move">
                      {plan.fromDivisions.length === 1
                        ? 'One of these cards is'
                        : plan.fromDivisions.length + ' of these cards are'}{' '}
                      in your divisions (
                      {[...new Set(plan.fromDivisions.map((s) => s.division))].map((id) => `#${id}`).join(', ')}
                      ): take them out before building this one.
                      {plan.fromDivisions.some((s) => s.locked) &&
                        (plan.fromDivisions.length === 1
                          ? ' It is on a mission until it returns.'
                          : ' Some are on a mission until it returns.')}
                    </small>
                  )}
                  <small className="muted">
                    Signed in small steps: swaps and Forge first, then the listings {SALES_PER_TX} at a time, then blends and
                    staking. A step that fails costs nothing and can be resumed.
                  </small>
                </>
              )}
              <RoiPanel
                atk={shown.atk}
                def={shown.def}
                move={plan.move}
                invest={plan.waxTotal}
                missions={missionList}
                tlmDef={tlmDef}
                pools={pools.data!}
              />
            </aside>
          </div>
        )}

        {plan && blendMarket && openings && plan.blendRuns.length > 0 && !locked && (
          <ChestPanel
            buys={plan.materialBuys}
            market={blendMarket}
            openings={openings}
            counts={chestCounts}
            onCounts={setChestCounts}
          />
        )}
      </div>
    </>
  )
}

// ---- The bundle's rows ------------------------------------------------------------------------------

type Plan = ReturnType<typeof summarize>

/** What a card adds, short: "ATK 120 · DEF 30 · 12 move", "+40 ATK", "×1.2". */
function shortStats(a: AssetRef): string {
  const st = a.stats
  if (!st) return ''
  const kind = kindOfCategory(st.category)
  if (kind === 'warlord') return st.movecost_reduction > 0 ? `−${st.movecost_reduction} move for the division` : ''
  if (kind === 'lavalux') return `×${formatNumber(Number(st.attack_mult_bp || 10000) / 10000, 2)} attack and defense`
  if (kind === 'mercenary') return `${st.attack} ATK · ${st.defense} DEF · ${st.movecost} move`
  return [
    st.attack > 0 && `+${st.attack} ATK`,
    st.defense > 0 && `+${st.defense} DEF`,
    st.movecost_reduction > 0 && `−${st.movecost_reduction} move`
  ]
    .filter(Boolean)
    .join(' · ')
}

function FromPill({ source }: { source: Source }) {
  switch (source.from) {
    case 'market':
      return <span className="pill is-live">listing</span>
    case 'reserve':
      return <span className="pill is-met">reserve</span>
    case 'division':
      return (
        <span className="pill is-fund" title={source.locked ? 'That division is on a mission' : undefined}>
          division #{source.division}
        </span>
      )
    case 'wallet':
      return <span className="pill">wallet</span>
    case 'blend':
      return <span className="pill mb-pill--blend">blend</span>
  }
}

function BundleRow({
  source,
  role,
  plan,
  itemKey,
  gear = false
}: {
  source: Source
  role: string
  plan: Plan
  itemKey: string
  gear?: boolean
}) {
  const a = assetOf(source)
  const st = a.stats
  const kind = kindOfCategory(st?.category)
  const wax =
    source.from === 'market'
      ? source.listing.price
      : source.from === 'blend'
        ? plan.blendRuns.find((r) => r.key === itemKey)?.cost
        : null
  return (
    <tr className={gear ? 'mb-gear' : ''}>
      <td>
        <span className="mb-card">
          <Portrait img={a.img} rarity={a.rarity} className={`mb-card__pic ${gear ? 'is-small' : ''}`} />
          <span className="mb-card__text">
            <b title={a.name}>{a.name}</b>
            <small>
              <span style={{ color: rarityColor(a.rarity) }}>{role}</span>
              {shortStats(a) && ` · ${shortStats(a)}`}
            </small>
            <StarRail asset={a} size="sm" />
          </span>
        </span>
      </td>
      <td>
        <FromPill source={source} />
      </td>
      <td className="num c-atk">{st && kind !== 'warlord' && kind !== 'lavalux' ? (gear ? `+${st.attack}` : st.attack) : '–'}</td>
      <td className="num">{wax == null ? <span className="muted">yours</span> : formatNumber(wax, 2)}</td>
    </tr>
  )
}

function UnitRows({ unit, sources, plan }: { unit: Plan['units'][number]; sources: Map<string, Source>; plan: Plan }) {
  const gear = GEAR_ORDER.filter((k) => unit.gear[k])
  return (
    <>
      <BundleRow source={sources.get(unit.merc.key)!} role="Mercenary" plan={plan} itemKey={unit.merc.key} />
      {gear.map((k) => (
        <BundleRow
          key={k}
          source={sources.get(unit.gear[k]!.key)!}
          role={KIND_LABEL[k]}
          plan={plan}
          itemKey={unit.gear[k]!.key}
          gear
        />
      ))}
      {gear.length > 0 && (
        <tr className="mb-gear mb-with">
          <td colSpan={4}>
            With gear: <span className="c-atk num">{formatNumber(unit.atk, 0)} ATK</span> ·{' '}
            <span className="c-def num">{formatNumber(unit.def, 0)} DEF</span> ·{' '}
            <span className="c-move num">{formatNumber(unit.move, 0)} move</span>
          </td>
        </tr>
      )}
    </>
  )
}

// ---- Totals -----------------------------------------------------------------------------------------

/**
 * What carrying out a bundle takes from the wallet. The bundle's own cost values DEF and TLM you
 * already hold at market price; here only what you are short of is bought, so the WAX actually
 * spent can be lower.
 */
function summarize(
  b: Bundle,
  sources: Map<string, Source>,
  player: PlayerData,
  pools: SwapPools,
  economy: SolveInput['economy'] | null,
  blendMarket: BlendMarket | null
) {
  const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_ORDER.flatMap((k) => b.gear[k].map((g) => g.key))]
  const src = keys.map((k) => sources.get(k)!).filter(Boolean)
  const toBuy = src.flatMap((s) => (s.from === 'market' ? [s.listing] : []))
  const fromWallet = src.flatMap((s) => (s.from === 'wallet' ? [s.asset] : []))
  const fromDivisions = src.flatMap((s) => (s.from === 'division' ? [s] : []))
  // The chosen blends, planned together so two recipes never count the same material twice.
  const blendRuns: (BlendRun & { key: string; templateId: string; cost: number })[] = []
  const materialBuys: Listing[] = []
  let blendWax = 0
  let blendsFeasible = true
  if (blendMarket) {
    const reserved = new Map<string, number>()
    for (const key of keys) {
      const s = sources.get(key)
      if (s?.from !== 'blend') continue
      const p = planBlend(blendMarket, s.blend, reserved)
      if (!Number.isFinite(p.cost)) {
        blendsFeasible = false
        continue
      }
      blendRuns.push({ blendId: s.blend.id, assetIds: p.assets, key, templateId: s.asset.templateId, cost: p.cost })
      materialBuys.push(...p.buy)
      blendWax += p.cost
    }
  }
  const slots = Object.values(b.slotsBought).flat()
  const defNeed = slots.reduce((n, o) => n + o.def, 0)
  const tlmNeed = economy?.levelTlm[b.level] ?? 0
  const defShort = Math.max(0, defNeed - player.def)
  const tlmShort = Math.max(0, tlmNeed - player.tlm)
  const swapWax = (defShort ? waxFor(pools.def, 'DEF', defShort) : 0) + (tlmShort ? waxFor(pools.tlm, 'TLM', tlmShort) : 0)
  const levelSteps: { level: number; quantity: string }[] = []
  for (let L = (economy?.forgeLevel ?? b.level) + 1; L <= b.level; L++) {
    const tlm = (economy!.levelTlm[L] ?? 0) - (economy!.levelTlm[L - 1] ?? 0)
    if (tlm > 0) levelSteps.push({ level: L, quantity: `${tlm.toFixed(4)} TLM` })
  }
  return {
    units: b.units,
    move: b.move,
    toBuy,
    fromWallet,
    fromDivisions,
    owned: src.length - toBuy.length - blendRuns.length,
    blendRuns,
    materialBuys,
    blendWax,
    blendsFeasible,
    nftWax: toBuy.reduce((n, l) => n + l.price, 0),
    slotCount: slots.length,
    defNeed,
    tlmNeed,
    defShort,
    tlmShort,
    levelSteps,
    // Swaps get the same slippage room the transaction gives them.
    waxTotal: toBuy.reduce((n, l) => n + l.price, 0) + blendWax + swapWax * 1.02,
    // What the bundle really costs: NFTs, blends as planned together, slots and Forge levels.
    total: toBuy.reduce((n, l) => n + l.price, 0) + blendWax + b.slotCost + b.forgeCost,
    gearCount: GEAR_ORDER.reduce((n, k) => n + b.gear[k].length, 0),
    needsBuild: true
  }
}

/** Says what the button will do: buy, blend, slots, or only stake. */
function buyLabel(plan: Plan): string {
  const n = (count: number, word: string) => count + ' ' + word + (count === 1 ? '' : 's')
  const parts: string[] = []
  if (plan.toBuy.length) parts.push('Buy ' + n(plan.toBuy.length, 'card'))
  if (plan.materialBuys.length) parts.push(n(plan.materialBuys.length, 'material'))
  if (plan.blendRuns.length) parts.push('blend ' + plan.blendRuns.length)
  if (plan.slotCount) parts.push(n(plan.slotCount, 'slot'))
  if (parts.length) return parts.join(', ') + ' & stake'
  if (plan.levelSteps.length) return 'Upgrade the Forge & stake'
  if (plan.fromWallet.length) return 'Stake ' + plan.fromWallet.length + ' from wallet'
  return 'Use what I own'
}

/** "3 equipment · 1 Lava Lux" */
const slotSummary = (b: Bundle) =>
  (Object.keys(b.slotsBought) as SlotKind[])
    .filter((k) => b.slotsBought[k].length)
    .map((k) => `${b.slotsBought[k].length} ${SLOT_LABEL[k]}`)
    .join(' · ')

// ---- Payback ----------------------------------------------------------------------------------------

interface Payback {
  e: MissionEconomics
  perHour: number
  waxPerDay: number
  days: number
  cycle: number
}

/**
 * How fast the division pays for itself on each mission it qualifies for: net TLM per hour after the
 * DEF/TLM swaps its loop needs, sold for WAX on Alcor, against the WAX this bundle takes from the
 * wallet. Assumes today's rewards and prices hold and the division is always redeployed on time.
 */
function RoiPanel({
  atk,
  def,
  move,
  invest,
  missions,
  tlmDef,
  pools
}: {
  atk: number
  def: number
  move: number
  invest: number
  missions: MissionEconomics[]
  tlmDef: TlmDefMarket
  pools: SwapPools
}) {
  const rows: Payback[] = missions
    .filter((e) => e.state === 'active' && isTokenLoop(e) && atk >= e.minAtk && def >= e.minDef)
    .map((e) => {
      const perHour = tlmPerHour(e, move, tlmDef)
      // A day's TLM sold at once, so the price impact of that size is included.
      const waxPerDay = perHour > 0 ? receiveFor(pools.tlm, 'TLM', perHour * 24) : 0
      return { e, perHour, waxPerDay, days: waxPerDay > 0 ? invest / waxPerDay : Infinity, cycle: cycleSeconds(e, move) }
    })
    .sort((a, b) => a.days - b.days)
  const best = rows.find((r) => Number.isFinite(r.days))
  const days = (d: number) => (d < 1 ? `${formatNumber(d * 24, 1)} hours` : `${formatNumber(d, 1)} days`)

  return (
    <div className="mb-roi">
      <span className="eyebrow">Payback</span>
      {invest <= 0.01 ? (
        <p className="mb-roi__head">Nothing to pay back: everything in it is already yours.</p>
      ) : best ? (
        <p className="mb-roi__head">
          Pays back in <b className="c-good num">{days(best.days)}</b> on {best.e.title}
        </p>
      ) : (
        <p className="mb-roi__head">No mission pays TLM for this division yet.</p>
      )}
      {best && invest > 0.01 && (
        <small className="muted">
          Send it on {best.e.title}
          {best.e.planet ? ` (${titleCase(best.e.planet)})` : ''} and claim every {formatDuration(best.cycle)}: about{' '}
          {formatNumber(best.perHour, 1)} TLM an hour after costs, {formatNumber(best.waxPerDay, 0)} WAX a day. Counts only the
          WAX you spend; the cards keep their resale value.
        </small>
      )}
      {rows.length > 0 && invest > 0.01 && (
        <ul className="mb-roi__rows">
          {rows.slice(0, 5).map((r) => (
            <li key={r.e.id} className={r === best ? 'is-best' : ''}>
              <span className="mb-roi__name">
                <b>{r.e.title}</b>
                <small className="muted num">
                  every {formatDuration(r.cycle)} ·{' '}
                  <span className={r.perHour > 0 ? '' : 'c-bad'}>
                    {r.perHour > 0 ? '+' : ''}
                    {formatNumber(r.perHour, 1)} TLM/h
                  </span>{' '}
                  · {formatNumber(r.waxPerDay, 0)} WAX/day
                </small>
              </span>
              <b className="num">{Number.isFinite(r.days) ? `${formatNumber(r.days, 1)} d` : 'never'}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- Buying and building ----------------------------------------------------------------------------

/** A purchase in progress: every step, which are signed, and a way on when one fails. */
function PurchaseProgress({
  locked,
  pending,
  onResume,
  onRescan
}: {
  locked: Locked
  pending: string | null
  onResume: () => void
  onRescan: () => void
}) {
  const steps = locked.steps ?? []
  const done = locked.done ?? 0
  const busy = pending === 'buy'
  return (
    <div className="mb-steps">
      <p className="mb-steps__head">
        <b>
          Buying: {done} of {steps.length} signed
        </b>
        <small className="muted">Each step is complete on its own, so nothing is left half done between them.</small>
      </p>
      <ol className="mb-steps__list">
        {steps.map((st, i) => (
          <li key={i} className={i < done ? 'is-done' : i === done ? (locked.failed ? 'is-failed' : 'is-now') : ''}>
            {i < done ? <Icon name="check" size={14} /> : <span className="mb-steps__dot" />} {st.label}
          </li>
        ))}
      </ol>
      {locked.failed && !busy && (
        <>
          <p className="c-bad mb-steps__note">
            Step {done + 1} did not go through.{done > 0 ? ` Steps 1 to ${done} are done and stay done.` : ''}
          </p>
          <button type="button" className="btn btn--go mb-buy" onClick={onResume}>
            Resume at step {done + 1}
          </button>
          <small className="muted">
            If a listing was sold or changed price meanwhile, resuming fails again: search again instead. What you already bought
            now counts as yours.
          </small>
          <button type="button" className="link mb-link" onClick={onRescan}>
            Search again with what I have now
          </button>
        </>
      )}
    </div>
  )
}

function BuildSteps({
  locked,
  pending,
  onBuild,
  onReset,
  onMissions
}: {
  locked: Locked
  pending: string | null
  onBuild: () => void
  onReset: () => void
  onMissions?: () => void
}) {
  const busy = pending === 'build' || pending === 'equip' || locked.phase === 'building'
  return (
    <div className="mb-steps">
      <ol className="mb-steps__list">
        <li className="is-done">
          <Icon name="check" size={14} /> Cards bought and staked
        </li>
        <li className={locked.phase === 'done' ? 'is-done' : 'is-now'}>
          {locked.phase === 'done' ? <Icon name="check" size={14} /> : <span className="mb-steps__dot" />} Division built and
          equipped
        </li>
      </ol>
      {locked.phase === 'done' ? (
        <>
          {onMissions && (
            <button type="button" className="btn btn--go mb-buy" onClick={onMissions}>
              <Icon name="rocket" size={16} /> Send it on a mission
            </button>
          )}
          <button type="button" className="link mb-link" onClick={onReset}>
            Build another
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn--go mb-buy" disabled={busy} onClick={onBuild}>
            {busy && <span className="mb-spin" />} Build the division
          </button>
          <small className="muted">Two signatures: create the division, then add the mercenaries and their gear.</small>
          <button type="button" className="link mb-link" onClick={onReset} disabled={busy}>
            Keep them in the reserve instead
          </button>
        </>
      )}
    </div>
  )
}

// ---- Search progress --------------------------------------------------------------------------------

/**
 * How far the search for the cheapest bundle has come: which pass, which step, and roughly how long
 * is left, estimated from how long the last solve took and how many more steps usually follow.
 */
function RefineProgress({
  refinement,
  solving,
  lastMs,
  twoPasses
}: {
  refinement: Refinement | null
  solving: boolean
  lastMs: number | null
  twoPasses: boolean
}) {
  const step = refinement?.step ?? 0
  const phase = refinement?.phase ?? 'owned'
  const rounds = refinement?.rounds ?? 0
  // Typical: two or three rounds in the first pass, one or two in the second.
  const remaining = phase === 'owned' ? Math.max(1, 2 - rounds) + (twoPasses ? 2 : 0) : Math.max(1, 2 - rounds)
  const fraction = Math.min(0.95, (step + (solving ? 0.5 : 0)) / (step + 1 + remaining))
  const eta = lastMs !== null ? (lastMs * (remaining + 0.5)) / 1000 : null
  const passes = twoPasses ? 2 : 1
  const passLabel = phase === 'owned' ? `Pass 1 of ${passes}: your materials first` : 'Pass 2 of 2: every blend at market prices'

  return (
    <div className="mb-refine" role="status">
      <div className="mb-refine__text">
        <b>{passLabel}</b>
        <span className="muted num">
          Step {step + 1}
          {lastMs !== null && ` · about ${formatNumber(lastMs / 1000, lastMs < 10_000 ? 1 : 0)} s each`}
          {eta !== null && ` · about ${eta < 60 ? `${Math.max(1, Math.round(eta))} s` : `${Math.round(eta / 60)} min`} left`}
        </span>
      </div>
      <div className="mb-refine__bar">
        <span className="mb-refine__fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      <small className="muted">
        Each step re-prices blends that share materials and searches again. The price only goes down.
      </small>
    </div>
  )
}

// ---- Open chests first? -----------------------------------------------------------------------------

/** A number of openings, typed or stepped; blank counts as none. */
function CountField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const set = (n: number) => onChange(Math.max(0, Math.min(500, Math.round(n || 0))))
  return (
    <label className="mb-count">
      <span>{label}</span>
      <input
        className="input num"
        type="number"
        inputMode="numeric"
        min={0}
        max={500}
        step={1}
        value={value || ''}
        placeholder="0"
        onChange={(e) => set(Number(e.target.value))}
      />
      <span className="stepper">
        <button type="button" aria-label="Fewer" disabled={value <= 0} onClick={() => set(value - 1)}>
          −
        </button>
        <button type="button" aria-label="More" disabled={value >= 500} onClick={() => set(value + 1)}>
          +
        </button>
      </span>
    </label>
  )
}

/**
 * Whether opening Quantum Chests first would make the bundle cheaper: for so many chests and
 * chests with keys, what they cost, how many of the materials the bundle buys they would cover
 * on average, and what the rest would sell for. With no bundle (`buys` null) every pull is valued
 * at what it would sell for.
 */
function ChestPanel({
  buys,
  market,
  openings,
  counts,
  onCounts
}: {
  buys: MaterialBuy[] | null
  market: BlendMarket
  openings: { chest: Opening | null; chestKey: Opening | null }
  counts: { chest: number; key: number }
  onCounts: (c: { chest: number; key: number }) => void
}) {
  const list = buys ?? []
  const rows: { label: string; forecast: Forecast }[] = []
  if (openings.chest && counts.chest > 0)
    rows.push({
      label: `${counts.chest} Chest${counts.chest === 1 ? '' : 's'}`,
      forecast: forecastOpenings([{ opening: openings.chest, count: counts.chest }], list, market)
    })
  if (openings.chestKey && counts.key > 0)
    rows.push({
      label: `${counts.key} Chest${counts.key === 1 ? '' : 's'} + Key`,
      forecast: forecastOpenings([{ opening: openings.chestKey, count: counts.key }], list, market)
    })
  if (rows.length === 2 && openings.chest && openings.chestKey)
    rows.push({
      label: 'Both together',
      forecast: forecastOpenings(
        [
          { opening: openings.chest, count: counts.chest },
          { opening: openings.chestKey, count: counts.key }
        ],
        list,
        market
      )
    })
  const net = (f: Forecast) => (f.cost === null ? null : f.saving + f.surplus - f.cost)
  const best = rows.reduce<{ label: string; forecast: Forecast } | null>((b, r) => {
    const n = net(r.forecast)
    return n !== null && n > 0 && (b === null || n > net(b.forecast)!) ? r : b
  }, null)
  const bought = list.reduce((n, b) => n + b.price, 0)

  return (
    <section className="box mb-box mb-chest">
      <div className="mb-chest__head">
        <div>
          <h2 className="h">Open chests first?</h2>
          <p className="muted mb-chest__lead">
            {buys === null
              ? 'Every chest pulls one material at random. With no division priced yet, this values the pulls at what they sell for. Price a division in the builder to see what chests would save on it.'
              : `The division buys ${list.length} material${list.length === 1 ? '' : 's'} for ${formatNumber(bought, 0)} WAX. Every chest pulls one material at random; here is what opening some first would do to the price, on average.`}
          </p>
        </div>
        <div className="mb-chest__fields">
          <CountField label="Chests" value={counts.chest} onChange={(n) => onCounts({ ...counts, chest: n })} />
          <CountField label="Chests + keys" value={counts.key} onChange={(n) => onCounts({ ...counts, key: n })} />
        </div>
      </div>
      {buys !== null && list.length === 0 ? (
        <p className="none">Every material this division blends is already yours, so chests could not lower the price.</p>
      ) : rows.length === 0 ? (
        <p className="none">Enter how many chests you would open.</p>
      ) : (
        <>
          <div className="tablewrap">
            <table className="t mb-chest__table">
              <thead>
                <tr>
                  <th>Openings</th>
                  <th className="num" title="Chests and keys at today's lowest prices.">
                    Cost
                  </th>
                  {buys !== null && (
                    <th className="num" title="Of the materials the division buys, how many the openings cover on average.">
                      Covered
                    </th>
                  )}
                  {buys !== null && (
                    <th className="num" title="How much lower the division's price would be on average.">
                      Saves
                    </th>
                  )}
                  <th className="num" title="Pulls the division does not need, at market value after the 7% sale fees.">
                    Surplus
                  </th>
                  <th className="num" title="Savings plus surplus, minus the cost. Above zero, opening pays on average.">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ label, forecast: f }) => {
                  const n = net(f)
                  return (
                    <tr key={label} className={best?.label === label ? 'is-me' : ''}>
                      <td>
                        <b>{label}</b>
                      </td>
                      <td className="num">{f.cost === null ? 'not listed' : formatNumber(f.cost, 0)}</td>
                      {buys !== null && (
                        <td className="num">
                          {formatNumber(f.covered, 1)} <small className="muted">of {f.needed}</small>
                        </td>
                      )}
                      {buys !== null && <td className="num c-good">−{formatNumber(f.saving, 0)}</td>}
                      <td className="num">
                        +{formatNumber(f.surplus, 0)}
                        {f.unpriced > 0.05 && <small className="muted"> · {percent(f.unpriced, 0)} unpriced</small>}
                      </td>
                      <td className={`num ${n === null ? '' : n > 0 ? 'c-good' : 'c-bad'}`}>
                        <b>{n === null ? '–' : `${n > 0 ? '+' : ''}${formatNumber(n, 0)}`}</b>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="help">
            {best
              ? buys === null
                ? `Opening should pay: ${best.label.toLowerCase()} comes out about ${formatNumber(net(best.forecast)!, 0)} WAX ahead on average, selling the pulls.`
                : `Opening first should pay: ${best.label.toLowerCase()} comes out about ${formatNumber(net(best.forecast)!, 0)} WAX ahead on average, counting the surplus sold. The price itself drops by about ${formatNumber(best.forecast.saving, 0)} WAX.`
              : buys === null
                ? 'On average the pulls sell for less than the chests cost.'
                : 'Buying the materials directly is cheaper on average than opening chests for them, even counting the surplus sold.'}{' '}
            Averages only: a single run can land far from them.
            {buys !== null && ' After opening, search again with Blend materials on; the new materials are used first.'}
          </p>
        </>
      )}
    </section>
  )
}

/**
 * The "open chests first?" forecast on its own, for the Chests & keys shelf. It reads the market,
 * the recipes and your materials itself; the materials it weighs against are those of the division
 * last priced in the builder (none yet: the pulls are valued at resale).
 */
export function ChestForecast({ account }: { account: string }) {
  const listings = useListings()
  const blends = useBlends()
  const collection = useCollectionTemplates()
  const ownedInputs = useOwnedBlendInputs(account)
  const buys = useChestShare((s) => s.buys)
  const counts = useChestShare((s) => s.counts)
  const setCounts = useChestShare((s) => s.setCounts)

  const market = useMemo(
    () =>
      listings.data && collection.data
        ? marketFrom(listings.data, ownedInputs.data ?? new Map(), collection.data, account)
        : null,
    [listings.data, collection.data, ownedInputs.data, account]
  )
  const openings = useMemo(() => (blends.data ? openingsOf(blends.data) : null), [blends.data])

  if (!market || !openings) return <div className="box mb-box none">Reading the market…</div>
  if (!openings.chest && !openings.chestKey) return <div className="box mb-box none">No chest recipe is running right now.</div>
  return <ChestPanel buys={buys} market={market} openings={openings} counts={counts} onCounts={setCounts} />
}
