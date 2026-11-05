import { Fragment, useMemo, useState } from 'react'
import type { AnyAction } from '@wharfkit/session'

import { atomic } from '@/chain/atomic'
import { ascendAction, sacrificeAction } from '@/chain/actions/ascend'
import { blendActions } from '@/chain/actions/blend'
import { buySalesActions, stakeBoughtAction } from '@/chain/actions/market'
import { addUnit, assignGear, buyShopItem, payForgeLevel, removeUnit, unassignGear, unstakeAsset } from '@/chain/actions/pd'
import { divisionAllowance, FRAGMENT_TEMPLATE } from '@/chain/config'
import { costKey, expectedYield, useAscensionConfig, type AscensionConfig } from '@/data/ascension'
import { makeAssetRef, type AssetRef } from '@/data/assets'
import { useBlends, useCollectionTemplates, useOwnedBlendInputs, useTemplatePrices } from '@/data/blends'
import {
  useArmy,
  useAssetStats,
  useDeployments,
  useForgeConfig,
  useMarket,
  useMissionConfig,
  usePlayer,
  useTemplates,
  useWalletNfts,
  type Army,
  type Division,
  type MissionConfig,
  type PlayerData,
  type Unit
} from '@/data/game'
import { useListings, useSwapPools, type Listing, type SwapPools } from '@/data/market'
import { marketFrom, mintable, planBlend, resultOf, valueOf, type Market as BlendMarket } from '@/lib/blendEconomy'
import { GEAR_KINDS, type Economy } from '@/lib/bundle'
import { buildEconomy, waxFor } from '@/lib/forgeEconomy'
import { formatNumber, parseAsset, sleep } from '@/lib/format'
import { isTokenLoop, meetsRequirements, missionEconomics, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import type { Market as TlmDefMarket } from '@/lib/market'
import { buyExactAction, receiveFor } from '@/lib/pool'
import { kindOfCategory } from '@/lib/stats'
import { shortDuration, useNow } from '@/lib/time'
import { findUpgrades, kindsOf, rankUpgrades, type Offer, type Ranked, type StepKind, type Upgrade, type UpgradeSlot } from '@/lib/upgrades'
import { buildScenarios, piecesOf, planOf, type Plan, type PlanScenario, type PlanSource } from '@/lib/upgradePlans'
import { usePlanSearch } from '@/lib/usePlanSearch'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait } from './Art'
import { divisionState } from './divisionState'
import { Icon } from './icons'
import { StarRail, useStarInfo } from './Stars'

import '@/styles/upgrade.css'

/*
 * The Market's Upgrade tab: everything that raises the TLM per hour of the player's divisions, by
 * how soon it pays back its WAX. Ported from the old deck's Upgrade tab (lib/upgrades.ts for single
 * changes, lib/upgradePlans.ts for whole divisions solved in the builder's workers), with the
 * ranking fixed to TLM per hour and a button on every row that carries the change out.
 *
 * Nothing is read or worked out until Scan: a scan takes a fresh snapshot of the army, the wallet,
 * the market and the pools, prices every single change at once, then solves the whole-division
 * scenarios one by one.
 */

/** Blend copies of one recipe the division search may use. */
const PLAN_BLEND_COPIES = 4
/** Rows that take longer than this to pay back are hidden. */
const MAX_PAYBACK_DAYS = 200
/** Sales per transaction, as the builder buys them. */
const SALES_PER_TX = 4

const KINDS: { key: StepKind; label: string }[] = [
  { key: 'owned', label: 'Owned' },
  { key: 'forge', label: 'Forge' },
  { key: 'blend', label: 'Blend' },
  { key: 'ascend', label: 'Ascend' },
  { key: 'market', label: 'Market' }
]

const SLOT_LABEL: Record<UpgradeSlot, string> = {
  warlord: 'Warlord',
  mercenary: 'Mercenary',
  weapon: 'Equipment',
  supply: 'Supply',
  creature: 'Creature',
  lavalux: 'Lava Lux'
}

const UPGRADE_SLOTS: UpgradeSlot[] = ['warlord', 'mercenary', 'weapon', 'supply', 'creature', 'lavalux']
const emptyOffers = (): Record<UpgradeSlot, Offer[]> => ({
  warlord: [],
  mercenary: [],
  weapon: [],
  supply: [],
  creature: [],
  lavalux: []
})
const slotOf = (a: AssetRef): UpgradeSlot | null => kindOfCategory(a.stats?.category) ?? null

const num = (n: number, digits = 1) => formatNumber(n, digits)
const chunk = <T,>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

/** A row of the list: one NFT somewhere, or a whole division. */
type Row = Upgrade | Plan

/** What a scan works on: a snapshot taken when Scan was pressed. */
interface Snapshot {
  id: number
  army: Army
  wallet: AssetRef[]
  listings: Listing[]
  player: PlayerData
  pools: SwapPools
  owned: Map<string, string[]>
  ascension: AscensionConfig | undefined
  config: MissionConfig
  tlmDef: TlmDefMarket
}

/** What the division search is working on, for the progress line. */
const workingLabel = (w: PlanScenario | null) =>
  !w
    ? 'starting'
    : w.kind === 'new'
      ? `a new division for ${w.mission.title}${w.input.maxMove ? ', faster' : ''}`
      : w.kind === 'rebuild'
        ? `#${w.division!.id} rebuilt for ${w.mission.title}${w.input.maxMove ? ', faster' : ''}`
        : `#${w.division!.id} with half the move`

/** Where a staked piece sits: as a warlord, a mercenary, gear on a mercenary, or in the reserve. */
type Place =
  | { at: 'leader'; division: Division }
  | { at: 'unit'; division: Division; unit: Unit }
  | { at: 'gear'; division: Division; unit: Unit }
  | { at: 'reserve' }
  | { at: 'wallet' }

/** One purchase picked to cover the Fragments an ascension still needs. */
interface FragmentPick {
  listing: Listing
  /** Fragments it gives for sure: 1 for a Fragment, the guaranteed yield for a card sacrificed. */
  gives: number
  burn: boolean
}

interface Action {
  label: string
  title: string
  disabled?: boolean
  go?: () => void
}

export function MarketUpgrade({
  account,
  spectating,
  onBuild
}: {
  account: string
  spectating: boolean
  onBuild: (target: { atk: number; def: number; maxMove?: number; missionId?: number }) => void
}) {
  const { run, runSequence, pending } = useTransaction()
  const player = usePlayer(account)
  const army = useArmy(account)
  const wallet = useWalletNfts(account)
  const listings = useListings()
  const config = useMissionConfig()
  const forge = useForgeConfig()
  const pools = useSwapPools()
  const tlmDef = useMarket()
  const blends = useBlends()
  const collection = useCollectionTemplates()
  const ownedInputs = useOwnedBlendInputs(account)
  const statsMap = useAssetStats()
  const templates = useTemplates()
  const ascension = useAscensionConfig()
  const prices = useTemplatePrices()
  const deployments = useDeployments(account)
  const starInfo = useStarInfo()
  const now = useNow(30_000)

  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [reading, setReading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [off, setOff] = useState<Set<StepKind>>(() => new Set())
  const [showAlt, setShowAlt] = useState(false)

  // The slow-changing game data a scan needs before it can start.
  const staticReady = !!config.data && !!forge.data && !!collection.data && !!statsMap.data && !!templates.data && !!blends.data

  async function scan() {
    setReading(true)
    setFailed(null)
    try {
      const [a, w, l, p, po, oi, asc] = await Promise.all([
        army.refetch(),
        wallet.refetch(),
        listings.refetch(),
        player.refetch(),
        pools.refetch(),
        ownedInputs.refetch(),
        ascension.refetch()
      ])
      void deployments.refetch()
      if (!a.data || !w.data || !l.data || !p.data || !po.data || !config.data)
        throw new Error('Some of your data could not be read. Try Scan again in a moment.')
      setSnap({
        id: Date.now(),
        army: a.data,
        wallet: w.data,
        listings: l.data,
        player: p.data,
        pools: po.data,
        owned: oi.data ?? new Map(),
        ascension: asc.data,
        config: config.data,
        tlmDef
      })
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  const blendMarket = useMemo<BlendMarket | null>(
    () => (snap && collection.data ? marketFrom(snap.listings, snap.owned, collection.data, account, prices.data) : null),
    [snap, collection.data, account, prices.data]
  )

  const missions = useMemo(
    () => (snap ? snap.config.missions.map((row) => missionEconomics(row, snap.config)) : []),
    [snap]
  )

  // ---- Single upgrades and the whole-division scenarios, from the snapshot ----------------------
  const built = useMemo(() => {
    if (!snap || !blendMarket || !forge.data || !statsMap.data || !templates.data) return null
    const a = snap.army
    const offers = emptyOffers()
    const capacity = new Map<string, number>()
    const addOwned = (list: AssetRef[], source: 'reserve' | 'wallet') => {
      const groups = new Map<string, AssetRef[]>()
      for (const x of list) if (slotOf(x)) groups.set(x.templateId, [...(groups.get(x.templateId) ?? []), x])
      for (const [t, copies] of groups) {
        const res = `${source}:${t}`
        capacity.set(res, copies.length)
        offers[slotOf(copies[0])!].push({ asset: copies[0], source, wax: 0, res, capacity: copies.length })
      }
    }
    addOwned(Object.values(a.free).flat(), 'reserve')
    addOwned(snap.wallet, 'wallet')

    // The cheapest listing of each playable template.
    const byTemplate = new Map<string, Listing[]>()
    for (const l of snap.listings) {
      if (l.seller === account || !l.kind) continue
      byTemplate.set(l.templateId, [...(byTemplate.get(l.templateId) ?? []), l])
    }
    for (const [t, list] of byTemplate) {
      const cheapest = list.reduce((m, l) => (l.price < m.price ? l : m))
      const slot = slotOf(cheapest.asset)
      if (!slot) continue
      const res = `sale:${t}`
      capacity.set(res, list.length)
      offers[slot].push({ asset: cheapest.asset, source: 'market', wax: cheapest.price, res, capacity: list.length, listing: cheapest })
    }

    // One blend of each recipe whose result goes into a division, owned materials first.
    for (const b of blends.data ?? []) {
      const r = resultOf(b)
      if (!b.active || !r || !statsMap.data.has(r) || mintable(blendMarket, b) < 1) continue
      const cost = planBlend(blendMarket, b).cost
      if (!Number.isFinite(cost)) continue
      const schema = blendMarket.templates.get(r)?.schema ?? ''
      const asset = makeAssetRef(`blend:${b.id}`, { t: r, s: schema, c: 'planetdefnft' }, statsMap.data, templates.data)
      const slot = slotOf(asset)
      if (slot) offers[slot].push({ asset, source: 'blend', wax: cost, res: `blend:${b.id}`, capacity: 1, blend: b })
    }

    // Raising a card a star. Fragments: owned ones first, then the cheaper of buying Fragments and
    // buying cheap cards to sacrifice for them (expected yield, bonus included).
    const ascensions = new Map<string, Offer>()
    const ascendOffers = emptyOffers()
    const cfg = snap.ascension
    if (cfg && !cfg.paused) {
      const owned = blendMarket.owned.get(FRAGMENT_TEMPLATE)?.length ?? 0
      let fragment: { price: number; via?: { name: string; perCard: number } } | null = null
      const listed = valueOf(blendMarket, FRAGMENT_TEMPLATE)
      if (listed !== null) fragment = { price: listed }
      for (const l of snap.listings) {
        const y = l.kind && l.seller !== account ? cfg.yields.get(l.asset.rarity) : undefined
        const perCard = y ? expectedYield(y) : 0
        if (perCard > 0 && (!fragment || l.price / perCard < fragment.price))
          fragment = { price: l.price / perCard, via: { name: l.asset.name, perCard } }
      }
      const ascendOf = (piece: AssetRef, staked: boolean, res: string, cap: number): Offer | null => {
        const to = cfg.next.get(piece.templateId)
        const need = cfg.costs.get(costKey(piece.rarity, Number(piece.stats?.min_forge_level ?? 0)))
        if (!to || !need || !statsMap.data!.has(to)) return null
        const buy = Math.max(0, need - owned)
        if (buy > 0 && !fragment) return null
        const asset = makeAssetRef(`asc:${piece.assetId}`, { t: to, s: piece.schema, c: 'planetdefnft' }, statsMap.data!, templates.data!)
        return {
          asset,
          source: 'ascend',
          wax: buy * (fragment?.price ?? 0),
          res,
          capacity: cap,
          ascend: { from: piece, fragments: need, owned, staked, via: buy > 0 ? fragment?.via : undefined }
        }
      }
      // Pieces in the divisions, the warlords included.
      for (const d of a.divisions)
        for (const piece of [d.leader, ...d.units.flatMap((u) => [u.asset, ...Object.values(u.gear)])]) {
          if (!piece) continue
          const o = ascendOf(piece, true, `asc:${piece.assetId}`, 1)
          if (o) ascensions.set(piece.assetId, o)
        }
      // Spare cards, raised a star before they go in.
      for (const [list, source] of [
        [Object.values(a.free).flat(), 'reserve'],
        [snap.wallet, 'wallet']
      ] as const) {
        const seen = new Set<string>()
        for (const card of list) {
          const slot = slotOf(card)
          if (!slot || seen.has(card.templateId)) continue
          seen.add(card.templateId)
          const res = `${source}:${card.templateId}`
          const o = ascendOf(card, source === 'reserve', res, capacity.get(res) ?? 1)
          if (o) {
            offers[slot].push(o)
            ascendOffers[slot].push(o)
          }
        }
      }
    }

    const economy = buildEconomy({
      forgeLevel: snap.player.forgeLevel,
      progress: snap.player.forgeProgress,
      levels: forge.data.levels,
      shopItems: forge.data.shopItems,
      powerups: snap.player.powerups,
      used: { weapon: a.gearUsed.weapon, supply: a.gearUsed.supply, lavalux: a.gearUsed.lavalux },
      pools: snap.pools
    })
    for (const k of ['weapon', 'supply', 'lavalux'] as const) capacity.set(`slot:${k}`, economy.slots[k].free)
    for (const s of UPGRADE_SLOTS) offers[s].sort((x, y) => x.wax - y.wax)

    const base = { divisions: a.divisions, missions, market: snap.tlmDef, economy, capacity }
    const singles = new Map<string, Upgrade>()
    for (const u of findUpgrades({ ...base, offers, ascensions })) singles.set(u.id, u)
    // Ascensions even where a swap is cheaper per TLM: findUpgrades keeps only the best offer per
    // place, so the ascensions are run again on their own. A worse one folds under the better row.
    for (const u of findUpgrades({ ...base, offers: ascendOffers, ascensions })) if (!singles.has(u.id)) singles.set(u.id, u)

    // Whole divisions: everything the solver may use, keyed the way the builder keys it.
    const shared: { key: string; source: PlanSource }[] = []
    for (const x of Object.values(a.free).flat()) shared.push({ key: `own:${x.assetId}`, source: { from: 'reserve', asset: x, wax: 0 } })
    for (const x of snap.wallet) shared.push({ key: `wal:${x.assetId}`, source: { from: 'wallet', asset: x, wax: 0 } })
    for (const l of snap.listings)
      if (l.seller !== account && l.kind) shared.push({ key: `sale:${l.saleId}`, source: { from: 'market', asset: l.asset, wax: l.price } })
    for (const b of blends.data ?? []) {
      const r = resultOf(b)
      if (!b.active || !r || !statsMap.data.has(r)) continue
      const reserved = new Map<string, number>()
      const schema = blendMarket.templates.get(r)?.schema ?? ''
      for (let k = 0; k < Math.min(mintable(blendMarket, b), PLAN_BLEND_COPIES); k++) {
        const cost = planBlend(blendMarket, b, reserved).cost
        if (!Number.isFinite(cost)) break
        const key = `blend:${b.id}:${k}`
        const asset = makeAssetRef(key, { t: r, s: schema, c: 'planetdefnft' }, statsMap.data, templates.data)
        shared.push({ key, source: { from: 'blend', asset, wax: cost } })
      }
    }
    const economyFor = (freeing: Division | null) => {
      const minus = (k: 'weapon' | 'supply' | 'lavalux') => a.gearUsed[k] - (freeing ? freeing.units.filter((u) => u.gear[k]).length : 0)
      return buildEconomy({
        forgeLevel: snap.player.forgeLevel,
        progress: snap.player.forgeProgress,
        levels: forge.data!.levels,
        shopItems: forge.data!.shopItems,
        powerups: snap.player.powerups,
        used: { weapon: minus('weapon'), supply: minus('supply'), lavalux: minus('lavalux') },
        pools: snap.pools
      })
    }
    const freePlaces = Math.max(0, divisionAllowance(snap.player.powerups) - a.divisions.length)
    const divItem = forge.data.shopItems
      .filter((i) => String(i.reward_powerup) === 'divslot')
      .sort((x, y) => Number(x.min_forge_level) - Number(y.min_forge_level) || Number(x.id) - Number(y.id))[
      snap.player.powerups.get('divslot') ?? 0
    ]
    const divDef = divItem ? parseAsset(divItem.price).amount : 0
    const divSlot = divItem ? { def: divDef, wax: waxFor(snap.pools.def, 'DEF', divDef) } : null
    const scenarios = buildScenarios({ divisions: a.divisions, missions, market: snap.tlmDef, pool: { shared }, economyFor, freePlaces, divSlot })
    capacity.set('newdiv', freePlaces)
    const searchKey = `${account}|${snap.id}|${a.divisions.map((d) => `${d.id}:${piecesOf(d).length}`).join(',')}`
    // What one TLM fetches in WAX on Alcor, for the payback.
    const tlmInWax = receiveFor(snap.pools.tlm, 'TLM', 100) / 100
    return { list: [...singles.values()], capacity, scenarios, searchKey, economy, tlmInWax }
  }, [snap, blendMarket, blends.data, forge.data, statsMap.data, templates.data, missions, account])

  const search = usePlanSearch(built?.searchKey ?? null, built?.scenarios ?? null)
  const plansDone = !!built && (search.finished || built.scenarios.length === 0)
  const forgeLevel = snap?.player.forgeLevel ?? 0
  const plans = useMemo(
    () =>
      snap
        ? search.solved.map((x) => planOf(x.scenario, x.bundle, missions, snap.tlmDef, forgeLevel)).filter((x): x is Plan => !!x)
        : [],
    [search.solved, missions, snap, forgeLevel]
  )

  const paybackDays = (wax: number, tlm: number) =>
    wax <= 0 ? 0 : tlm > 0 && built && built.tlmInWax > 0 ? wax / (tlm * 24 * built.tlmInWax) : null

  // ---- Filter, hide what does not pay, rank by payback ---------------------------------------
  const ranked = useMemo(() => {
    if (!built) return null
    let filtered = 0
    let noGain = 0
    let slow = 0
    const keep: Row[] = []
    for (const r of [...built.list, ...plans]) {
      if ([...kindsOf(r)].some((k) => off.has(k))) {
        filtered++
        continue
      }
      if (r.gain.tlm <= 1e-9) {
        noGain++
        continue
      }
      const days = paybackDays(r.wax, r.gain.tlm)
      if (days === null || days > MAX_PAYBACK_DAYS) {
        slow++
        continue
      }
      keep.push(r)
    }
    // TLM per hour per WAX, free ones first: the same order as payback days, best first.
    return { list: rankUpgrades(keep, 'tlm', built.capacity), filtered, noGain, slow }
    // paybackDays reads only built.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, plans, off])

  // ---- Where divisions stand right now -------------------------------------------------------
  const unlockById = useMemo(() => {
    const m = new Map<number, number>()
    for (const d of deployments.data ?? []) m.set(d.divisionId, d.unlockAt)
    return m
  }, [deployments.data])
  const liveDivision = (d: Division) => army.data?.divisions.find((x) => x.id === d.id) ?? d
  /** null when the division can be changed now; otherwise why not. */
  const awayLabel = (d: Division): string | null => {
    const st = divisionState(liveDivision(d), unlockById.get(d.id), now)
    if (st.editable) return null
    if (st.tone === 'claim') return 'after its reward is claimed'
    return `after it's back${st.until ? ` · ${shortDuration(st.until - now)}` : ''}`
  }

  const locate = (assetId: string): Place => {
    for (const d of snap?.army.divisions ?? []) {
      if (d.leader?.assetId === assetId) return { at: 'leader', division: d }
      for (const u of d.units) {
        if (u.asset.assetId === assetId) return { at: 'unit', division: d, unit: u }
        if (GEAR_KINDS.some((k) => u.gear[k]?.assetId === assetId)) return { at: 'gear', division: d, unit: u }
      }
    }
    return snap?.army.assets.has(assetId) ? { at: 'reserve' } : { at: 'wallet' }
  }

  const bestMission = (atk: number, def: number, move: number): MissionEconomics | undefined =>
    missions
      .filter((m) => m.state === 'active' && isTokenLoop(m) && meetsRequirements(m, atk, def))
      .sort((x, y) => tlmPerHour(y, move, snap!.tlmDef) - tlmPerHour(x, move, snap!.tlmDef))[0]

  // ---- Building the transactions ---------------------------------------------------------------
  const tlmContract = forge.data?.tokens?.tlm_contract || 'alien.worlds'

  /** The Forge level and slot a single upgrade needs, with the DEF and TLM bought on Alcor if short. */
  function forgeNeed(u: Upgrade, economy: Economy) {
    const slotBuy = u.slotNeed?.buy ?? null
    const slotPrice = slotBuy ? parseAsset(slotBuy.price) : null
    const levels: { level: number; quantity: string }[] = []
    for (let L = economy.forgeLevel + 1; L <= u.level; L++) {
      const tlm = (economy.levelTlm[L] ?? 0) - (economy.levelTlm[L - 1] ?? 0)
      if (tlm > 0) levels.push({ level: L, quantity: `${tlm.toFixed(4)} TLM` })
    }
    const def = slotPrice?.symbol === 'DEF' ? slotPrice.amount : 0
    const tlm = (u.level > economy.forgeLevel ? (economy.levelTlm[u.level] ?? 0) : 0) + (slotPrice?.symbol === 'TLM' ? slotPrice.amount : 0)
    return { slotBuy, levels, def, tlm, any: !!slotBuy || levels.length > 0 }
  }

  function forgeActions(u: Upgrade, economy: Economy, a: string, p: string): AnyAction[] {
    const f = forgeNeed(u, economy)
    const have = player.data ?? snap!.player
    const livePools = pools.data ?? snap!.pools
    const defShort = Math.max(0, f.def - have.def)
    const tlmShort = Math.max(0, f.tlm - have.tlm)
    return [
      ...(defShort > 0 ? [buyExactAction(a, p, livePools.def, 'DEF', defShort).action] : []),
      ...(tlmShort > 0 ? [buyExactAction(a, p, livePools.tlm, 'TLM', tlmShort).action] : []),
      ...f.levels.map((s) => payForgeLevel(a, p, s.level, s.quantity, tlmContract)),
      ...(f.slotBuy ? [buyShopItem(a, p, f.slotBuy.itemId, f.slotBuy.price, f.slotBuy.priceContract)] : [])
    ]
  }

  /** Where the new piece goes, in words, for the success texts. */
  const placeLabel = (u: Upgrade) =>
    u.slot === 'warlord'
      ? `warlord of #${u.division.id}`
      : !u.unit
        ? `a new mercenary in #${u.division.id}`
        : u.slot === 'mercenary'
          ? `mercenary in #${u.division.id}`
          : `${SLOT_LABEL[u.slot].toLowerCase()} on ${u.unit.asset.name} in #${u.division.id}`

  /** Gear, mercenary or warlord from the reserve, the wallet or a listing: one transaction. */
  async function applySingle(u: Upgrade, economy: Economy) {
    const o = u.offer
    const d = u.division
    const id = o.listing?.assetId ?? o.asset.assetId
    await run(
      (a, p) => [
        ...forgeActions(u, economy, a, p),
        ...(o.listing ? buySalesActions(a, p, [{ saleId: o.listing.saleId, assetId: o.listing.assetId, listingPrice: o.listing.listingPrice }]) : []),
        ...(o.source === 'wallet' || o.source === 'market' ? [stakeBoughtAction(a, p, [id])] : []),
        ...(u.replaces && u.unit ? [unassignGear(a, p, d.id, u.unit.asset.assetId, u.replaces.assetId)] : []),
        u.slot === 'mercenary' ? addUnit(a, p, d.id, id) : assignGear(a, p, d.id, u.unit!.asset.assetId, u.slot as (typeof GEAR_KINDS)[number], id)
      ],
      `${o.asset.name} is in Division #${d.id}`,
      `up:${u.id}`,
      { split: true }
    )
  }

  /** The cheapest sure way to the Fragments an ascension still needs: Fragment listings, or cards to sacrifice. */
  function fragmentPicks(short: number): { picks: FragmentPick[]; wax: number; ok: boolean } {
    if (short <= 0) return { picks: [], wax: 0, ok: true }
    const cfg = snap?.ascension
    if (!cfg || !blendMarket) return { picks: [], wax: 0, ok: false }
    const options: FragmentPick[] = [
      ...(blendMarket.listings.get(FRAGMENT_TEMPLATE) ?? []).map((listing) => ({ listing, gives: 1, burn: false })),
      ...snap!.listings.flatMap((listing) => {
        const y = listing.kind && listing.seller !== account ? cfg.yields.get(listing.asset.rarity) : undefined
        return y && y.guaranteed > 0 ? [{ listing, gives: y.guaranteed, burn: true }] : []
      })
    ].sort((x, y) => x.listing.price / x.gives - y.listing.price / y.gives)
    const picks: FragmentPick[] = []
    let got = 0
    for (const o of options) {
      if (got >= short) break
      picks.push(o)
      got += o.gives
    }
    return { picks, wax: picks.reduce((n, x) => n + x.listing.price, 0), ok: got >= short }
  }

  /** Fragments in the wallet, read fresh; waits for a sacrifice's reveal when one was just sent. */
  async function fragmentIds(owner: string, need: number, wait: boolean): Promise<string[]> {
    for (let attempt = 0; attempt < (wait ? 20 : 3); attempt++) {
      const assets = await atomic.getOwnedAssets(owner, 'planetdefnft').catch(() => [])
      const ids = assets.filter((x) => x.template?.template_id === FRAGMENT_TEMPLATE).map((x) => x.asset_id)
      if (ids.length >= need) return ids.slice(0, need)
      await sleep(4000)
    }
    throw new Error(
      `Fewer than ${need} Fragments in the wallet yet (a sacrifice is revealed by the game's oracle a little later). ` +
        'Scan again in a minute and ascend from the row: the card is already out of the game.'
    )
  }

  /** The steps that take a staked piece out of the game, so it can be sent to ascend.pdef. */
  function takeOut(place: Place, piece: AssetRef, a: string, p: string): AnyAction[] {
    if (place.at === 'gear') return [unassignGear(a, p, place.division.id, place.unit.asset.assetId, piece.assetId), unstakeAsset(a, p, piece.assetId)]
    if (place.at === 'unit')
      return [
        ...GEAR_KINDS.filter((k) => place.unit.gear[k]).map((k) => unassignGear(a, p, place.division.id, place.unit.asset.assetId, place.unit.gear[k]!.assetId)),
        removeUnit(a, p, piece.assetId),
        unstakeAsset(a, p, piece.assetId)
      ]
    if (place.at === 'reserve') return [unstakeAsset(a, p, piece.assetId)]
    return []
  }

  async function applyAscend(u: Upgrade, economy: Economy, frag: ReturnType<typeof fragmentPicks>) {
    const asc = u.offer.ascend!
    const from = asc.from
    const place = locate(from.assetId)
    const stars = starInfo(from.templateId, from.rarity)?.stars ?? 0
    const burns = frag.picks.some((x) => x.burn)
    const parts: { build: (a: string, p: string) => AnyAction[] | Promise<AnyAction[] | AnyAction>; success: string; settle?: boolean }[] = []
    if (forgeNeed(u, economy).any) parts.push({ build: (a, p) => forgeActions(u, economy, a, p), success: 'Forge level and slot paid' })
    if (place.at === 'gear' || place.at === 'unit' || place.at === 'reserve')
      parts.push({ build: (a, p) => takeOut(place, from, a, p), success: `${from.name} is out of the game`, settle: true })
    for (const group of chunk(frag.picks, SALES_PER_TX)) {
      const burn = group.filter((x) => x.burn).map((x) => x.listing.assetId)
      parts.push({
        build: (a, p) => [
          ...buySalesActions(a, p, group.map((x) => ({ saleId: x.listing.saleId, assetId: x.listing.assetId, listingPrice: x.listing.listingPrice }))),
          ...(burn.length ? [sacrificeAction(a, p, burn)] : [])
        ],
        success: burn.length ? `Bought ${group.length}, sacrificed ${burn.length} for Fragments` : `Bought ${group.length} Fragment${group.length === 1 ? '' : 's'}`,
        settle: true
      })
    }
    const placed =
      place.at === 'unit'
        ? `Put it back in #${place.division.id} and its gear on it`
        : place.at === 'gear'
          ? `Stake it and put it back on ${place.unit.asset.name} in #${place.division.id}`
          : `Stake it and make it the ${placeLabel(u)}`
    parts.push({
      build: async (a, p) => ascendAction(a, p, from.assetId, await fragmentIds(a, asc.fragments, burns)),
      success: `${from.name} is ★${stars + 1}. It is a new NFT in your wallet: ${placed} on the Divisions page`
    })
    await runSequence(parts, `up:${u.id}`, `Ascend ${from.name}`)
  }

  async function applyBlend(u: Upgrade, economy: Economy) {
    const b = u.offer.blend!
    const plan = planBlend(blendMarket!, b)
    const parts: { build: (a: string, p: string) => AnyAction[]; success: string; settle?: boolean }[] = []
    if (forgeNeed(u, economy).any) parts.push({ build: (a, p) => forgeActions(u, economy, a, p), success: 'Forge level and slot paid' })
    for (const group of chunk(plan.buy, SALES_PER_TX))
      parts.push({
        build: (a, p) => buySalesActions(a, p, group.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))),
        success: `Bought ${group.length} material${group.length === 1 ? '' : 's'}`
      })
    parts.push({
      build: (a, p) => blendActions(a, p, [{ blendId: b.id, assetIds: plan.assets }]),
      success: `Blended ${u.offer.asset.name}. It is a new NFT in your wallet, minted in a few seconds: stake it and make it the ${placeLabel(u)} on the Divisions page`
    })
    await runSequence(parts, `up:${u.id}`, `Blend ${u.offer.asset.name}`)
  }

  // ---- What each row's button does -------------------------------------------------------------
  function actionOf(r: Row): Action {
    const busy = pending !== null
    const ro = spectating ? 'You are viewing this account read-only.' : ''
    if (r.kind === 'plan') {
      const s = r.scenario
      const away = s.division ? awayLabel(s.division) : null
      return {
        label: 'Open in builder',
        title:
          'The builder finds this division again, buys what it needs and builds it.' +
          (s.division ? ` Take #${s.division.id} apart on the Divisions page first so its NFTs are free${away ? `, ${away}` : ''}.` : ''),
        disabled: busy,
        go: () => onBuild({ atk: s.input.atk, def: s.input.def, maxMove: s.input.maxMove, missionId: (r.mission ?? s.mission).id })
      }
    }
    const u = r
    const o = u.offer
    const economy = built!.economy
    if (u.slot === 'warlord' && o.source !== 'ascend') {
      const m = bestMission(u.after.atk, u.after.def, u.after.move)
      return {
        label: 'Open in builder',
        title: `The contract has no warlord swap: #${u.division.id} has to be disbanded and built again around ${o.asset.name}. The builder works that division out and buys what it needs.`,
        disabled: busy,
        go: () => onBuild({ atk: u.after.atk, def: u.after.def, maxMove: u.after.move, missionId: m?.id })
      }
    }
    if (o.source === 'ascend') {
      const asc = o.ascend!
      const place = locate(asc.from.assetId)
      if (place.at === 'leader')
        return {
          label: 'Not here',
          title: `${asc.from.name} leads #${place.division.id}: a warlord can only leave the game once its division is emptied and disbanded. Do that on the Divisions page, then ascend it.`,
          disabled: true
        }
      if (u.slot === 'warlord')
        return {
          label: 'Not here',
          title: `Ascending ${asc.from.name} works, but making it the warlord means disbanding #${u.division.id} and building it again. Use the builder for that.`,
          disabled: true
        }
      if (place.at === 'gear' || place.at === 'unit') {
        const away = awayLabel(place.division)
        if (away) return { label: away.replace(/^a/, 'A'), title: `#${place.division.id} is out on a mission: the card can be taken out ${away}.`, disabled: true }
      }
      const frag = fragmentPicks(Math.max(0, asc.fragments - asc.owned))
      if (!frag.ok)
        return { label: 'No Fragments', title: 'Not enough Fragments listed, nor cards to sacrifice for them, to cover this ascension.', disabled: true }
      const steps = [
        place.at === 'unit' ? `take ${asc.from.name} out of #${place.division.id} (its gear goes to the reserve) and unstake it` : '',
        place.at === 'gear' ? `take ${asc.from.name} off and unstake it` : '',
        place.at === 'reserve' ? `unstake ${asc.from.name}` : '',
        frag.picks.length
          ? `buy ${frag.picks.filter((x) => !x.burn).length} Fragment(s)${frag.picks.some((x) => x.burn) ? ` and ${frag.picks.filter((x) => x.burn).length} card(s) to sacrifice` : ''} for ${num(frag.wax, 2)} WAX`
          : '',
        `send it with ${asc.fragments} Fragments to ascend.pdef`
      ].filter(Boolean)
      return {
        label: 'Ascend',
        title: ro || `Signs in steps: ${steps.join(', then ')}. The ascended card is a new NFT; put it back on the Divisions page.`,
        disabled: busy || spectating,
        go: () => void applyAscend(u, economy, frag)
      }
    }
    if (o.source === 'blend') {
      const plan = blendMarket ? planBlend(blendMarket, o.blend!) : null
      if (!plan || !Number.isFinite(plan.cost)) return { label: 'Can’t blend', title: 'The materials for this blend are no longer there.', disabled: true }
      return {
        label: 'Blend',
        title:
          ro ||
          `Buys ${plan.buy.length} material(s) for ${num(plan.cost, 2)} WAX and blends ${o.asset.name}. The result is minted to your wallet a few seconds later; stake it and place it on the Divisions page.`,
        disabled: busy || spectating,
        go: () => void applyBlend(u, economy)
      }
    }
    const away = awayLabel(u.division)
    if (away) return { label: away.replace(/^a/, 'A'), title: `#${u.division.id} is out on a mission and can be changed ${away}.`, disabled: true }
    const f = forgeNeed(u, economy)
    const what = [
      f.def > 0 && `${num(f.def, 2)} DEF slot`,
      f.levels.length && `Forge level ${u.level}`,
      o.source === 'market' && `buy for ${num(o.wax, 2)} WAX`,
      (o.source === 'wallet' || o.source === 'market') && 'stake',
      u.replaces && `take off ${u.replaces.name}`,
      u.slot === 'mercenary' ? 'add to the division' : `equip on ${u.unit!.asset.name}`
    ].filter(Boolean)
    return {
      label: o.source === 'market' ? 'Buy & equip' : 'Do it',
      title: ro || `One transaction: ${what.join(', ')}.`,
      disabled: busy || spectating,
      go: () => void applySingle(u, economy)
    }
  }

  // ---- Rendering -------------------------------------------------------------------------------
  const describe = (r: Row): { title: string; sub: string } => {
    if (r.kind === 'plan') {
      const s = r.scenario
      const m = r.mission ?? s.mission
      if (s.kind === 'new') return { title: `New division for ${m.title}`, sub: s.extra ? 'with a Division slot bought first' : 'in a free division place' }
      if (s.kind === 'rebuild') return { title: `Rebuild #${s.division!.id} for ${m.title}`, sub: 'its own NFTs free, plus what it needs' }
      return { title: `#${s.division!.id} faster on ${m.title}`, sub: `move ${s.before.move} → ${r.after.move}` }
    }
    const u = r
    const o = u.offer
    if (o.source === 'ascend') {
      const from = o.ascend!.from
      const st = starInfo(from.templateId, from.rarity)?.stars
      const inPlace = u.replaces?.assetId === from.assetId
      return {
        title: `Ascend ${from.name} ${st !== undefined ? `★${st}→★${st + 1}` : 'one star'}`,
        sub: inPlace ? placeLabel(u) : `from your ${locate(from.assetId).at === 'wallet' ? 'wallet' : 'reserve'}, as ${placeLabel(u)}${u.replaces ? ` instead of ${u.replaces.name}` : ''}`
      }
    }
    const title =
      u.slot === 'warlord'
        ? `New warlord for #${u.division.id}`
        : !u.unit
          ? `Mercenary into #${u.division.id}`
          : `${SLOT_LABEL[u.slot]} on ${u.unit.asset.name} in #${u.division.id}`
    return { title, sub: `${o.asset.name}${u.replaces ? ` instead of ${u.replaces.name}` : ''}` }
  }

  /** DEF and TLM a row needs besides its NFTs (already counted in its WAX). */
  const tokensOf = (r: Row): string[] => {
    if (r.kind === 'plan') {
      const def = (r.scenario.extra?.def ?? 0) + Object.values(r.bundle.slotsBought).flat().reduce((n, o) => n + o.def, 0)
      const tlm = r.bundle.level > forgeLevel ? (r.scenario.input.economy.levelTlm[r.bundle.level] ?? 0) : 0
      return [def > 0 ? `${num(def, 0)} DEF` : '', tlm > 0 ? `${num(tlm, 0)} TLM` : ''].filter(Boolean)
    }
    const f = forgeNeed(r, built!.economy)
    return [f.def > 0 ? `${num(f.def, 0)} DEF` : '', f.tlm > 0 ? `${num(f.tlm, 0)} TLM` : ''].filter(Boolean)
  }

  const awayOf = (r: Row): string | null => {
    if (r.kind === 'plan') return r.scenario.division ? awayLabel(r.scenario.division) : null
    return awayLabel(r.division)
  }

  const counted = ranked?.list.filter((r) => !r.instead) ?? []
  const alts = new Map<string, Ranked<Row>[]>()
  for (const r of ranked?.list ?? []) if (r.instead) alts.set(r.instead.id, [...(alts.get(r.instead.id) ?? []), r])
  const altCount = (ranked?.list.length ?? 0) - counted.length
  const position = new Map(counted.map((r, i) => [r.upgrade.id, i + 1]))
  const free = counted.filter((r) => r.upgrade.wax <= 0)
  const totalWax = counted.at(-1)?.runWax ?? 0
  const totalGain = counted.at(-1)?.runGain ?? 0

  const row = (r: Ranked<Row>) => {
    const x = r.upgrade
    const { title, sub } = describe(x)
    const before = x.kind === 'plan' ? x.scenario.before.rate : x.before.rate
    const after = x.after.rate
    const days = paybackDays(x.wax, x.gain.tlm)
    const tokens = tokensOf(x)
    const away = awayOf(x)
    const act = actionOf(x)
    const art = x.kind === 'plan' ? null : x.offer.asset
    return (
      <article key={x.id} className={`up-row${r.instead ? ' is-alt' : ''}${x.wax <= 0 ? ' is-free' : ''}`}>
        <span className="up-rank num">{r.instead ? '↳' : position.get(x.id)}</span>
        {art ? (
          <Portrait img={art.img} rarity={art.rarity} className="up-art" />
        ) : (
          <span className="up-art up-art--plan" aria-hidden="true">
            <Icon name={x.kind === 'plan' && x.scenario.kind === 'new' ? 'plus' : 'army'} size={20} />
          </span>
        )}
        <div className="up-what">
          <h3>
            {title}
            {art && <StarRail asset={art} size="sm" className="up-stars" />}
          </h3>
          <p className="up-sub">
            {sub}
            {away && <span className="pill is-fund up-away">{away}</span>}
            {r.instead && <span className="up-instead"> · alternative to #{position.get(r.instead.id)}</span>}
          </p>
          <div className="up-steps">
            {x.steps.map((s, i) => (
              <span key={i} className={`pill up-k up-k--${s.kind}`} title={s.detail}>
                <em>{s.kind}</em> {s.label}
                {s.detail && <small> · {s.detail}</small>}
              </span>
            ))}
          </div>
        </div>
        <div className="up-nums">
          <span className="up-cost">
            <b className={`num${x.wax <= 0 ? ' c-good' : ''}`}>{x.wax <= 0 ? 'Free' : `${num(x.wax, 2)} WAX`}</b>
            {tokens.length > 0 && <small className="muted">incl. {tokens.join(' + ')}</small>}
          </span>
          <span className="up-rate">
            <span className="num muted">
              {num(before)} → {num(after)} TLM/h
            </span>
            <b className="num c-good">+{num(x.gain.tlm)}</b>
          </span>
          <span className="up-days num">{x.wax <= 0 ? 'free' : days !== null ? `${num(days, days < 10 ? 1 : 0)} d` : '—'}</span>
        </div>
        <div className="up-act">
          <button
            type="button"
            className={`btn btn--sm${!act.disabled && act.go && x.kind !== 'plan' ? ' btn--go' : ''}`}
            disabled={act.disabled}
            title={act.title}
            onClick={act.go}
          >
            {pending === `up:${x.id}` ? 'Signing…' : act.label}
          </button>
        </div>
      </article>
    )
  }

  const scanning = reading || (!!built && !plansDone)
  const progress = reading ? 0.05 : built && !plansDone ? 0.1 + 0.9 * (search.total ? search.done / search.total : 0) : 1

  return (
    <div className="up">
      <section className="box up-head">
        <h2 className="h">
          Upgrade
          <small>every change that raises your TLM per hour, by how soon it pays back</small>
        </h2>
        <div className="up-head__row">
          <p className="help up-head__help">
            Gear, mercenaries, warlords, ascensions, blends, Forge slots and whole new or rebuilt divisions, priced in WAX against the TLM per hour they add.
          </p>
          <button type="button" className="btn btn--go" disabled={!staticReady || reading} onClick={() => void scan()}>
            <Icon name="spark" size={16} /> {snap ? 'Scan again' : 'Scan'}
          </button>
        </div>
        {!staticReady && <p className="help">Reading the game…</p>}
        {failed && <p className="help c-bad">{failed}</p>}
        {(scanning || (snap && built)) && (
          <div className="up-progress" aria-live="polite">
            <span className="bar2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
            <small className="muted">
              {reading
                ? 'Reading your army, wallet, the market and the pools…'
                : !plansDone
                  ? `Single upgrades priced. Whole divisions: ${Math.min(search.done + 1, search.total)} of ${search.total}, ${workingLabel(search.working)}.`
                  : `Done: ${built!.list.length} single upgrades and ${plans.length} whole-division plans that add TLM per hour.`}
            </small>
          </div>
        )}
      </section>

      {built && ranked && (
        <>
          <section className="box up-filter">
            <div className="seg seg--pick up-kinds" role="group" aria-label="Ways to upgrade">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  className={off.has(k.key) ? '' : 'is-on'}
                  aria-pressed={!off.has(k.key)}
                  onClick={() =>
                    setOff((s) => {
                      const n = new Set(s)
                      if (n.has(k.key)) n.delete(k.key)
                      else n.add(k.key)
                      return n
                    })
                  }
                >
                  <i className={`up-dot up-k--${k.key}`} /> {k.label}
                </button>
              ))}
            </div>
            <button type="button" className={`btn btn--sm${showAlt ? ' is-on' : ''}`} aria-pressed={showAlt} onClick={() => setShowAlt((v) => !v)}>
              {showAlt ? <Icon name="check" size={14} /> : null} Show alternatives{altCount ? ` (${altCount})` : ''}
            </button>
          </section>

          {counted.length > 0 && (
            <p className="up-sum">
              <span>
                <b className="c-good num">+{num(free.reduce((n, r) => n + r.upgrade.gain.tlm, 0))} TLM/h</b> free with what you own ({free.length})
              </span>
              <span>
                <b className="num">+{num(totalGain)} TLM/h</b> for {num(totalWax, 2)} WAX if you do all {counted.length}
              </span>
            </p>
          )}

          {counted.length === 0 ? (
            <p className="none">
              {plansDone ? 'Nothing pays back within 200 days right now.' : 'Nothing that pays back within 200 days so far; whole divisions are still being worked out.'}
            </p>
          ) : (
            <div className="up-list">
              <div className="up-row up-row--head" aria-hidden="true">
                <span>#</span>
                <span />
                <span>Upgrade</span>
                <span className="up-nums">
                  <span>Costs</span>
                  <span>TLM per hour</span>
                  <span>Pays back</span>
                </span>
                <span />
              </div>
              {counted.map((r) => (
                <Fragment key={r.upgrade.id}>
                  {row(r)}
                  {showAlt && (alts.get(r.upgrade.id) ?? []).map(row)}
                </Fragment>
              ))}
            </div>
          )}

          <p className="help up-foot">
            {[
              ranked.slow > 0 && `${ranked.slow} hidden that take over ${MAX_PAYBACK_DAYS} days to pay back`,
              ranked.noGain > 0 && `${ranked.noGain} hidden that add no TLM per hour (more attack or less move that reaches no better-paying mission)`,
              ranked.filtered > 0 && `${ranked.filtered} hidden by the filter`,
              altCount > 0 && !showAlt && `${altCount} alternative${altCount === 1 ? '' : 's'} folded (they need the same place, NFT or last free slot as a better row)`
            ]
              .filter(Boolean)
              .join(' · ')}
            {ranked.slow + ranked.noGain + ranked.filtered + (showAlt ? 0 : altCount) > 0 ? '. ' : ''}
            Each single upgrade is valued alone against the division as it is now; a whole-division plan replaces the division (or adds one).
            Payback sells the TLM gained at today's Alcor price. Divisions out on a mission are included and can be changed once they are back.
          </p>
        </>
      )}
    </div>
  )
}
