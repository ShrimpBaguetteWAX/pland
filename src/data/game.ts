import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { atomic } from '@/chain/atomic'
import { ALCOR_TLM_DEF_POOL_ID, COLLECTIONS, CONTRACTS } from '@/chain/config'
import { getRow, getRows } from '@/chain/rpc'
import type { GameBalance } from '@/lib/deposit'
import { parseAsset } from '@/lib/format'
import { chainDate } from '@/lib/time'
import { fallbackMarket, marketFromPool, type Market } from '@/lib/market'
import { kindOfCategory, unitTotals, type Kind } from '@/lib/stats'

import { cachedOf, makeAssetRef, resolveTemplates, type AssetRef } from './assets'
import { queryClient } from './queryClient'
import type {
  AssetStats,
  DivisionRow,
  DivLockRow,
  DivUnitRow,
  EntryCostRow,
  ForgeLevelRow,
  ForgeProgressRow,
  ForgeTokensRow,
  GlobalStatsRow,
  MissionEntryRow,
  MissionRow,
  PlayerRow,
  PlayerTotals,
  PowerupRow,
  RewardConfigRow,
  RewardPoolRow,
  ShardCapRow,
  ShardRewardRow,
  ShopItemRow,
  StakeRow,
  TemplateInfo,
  UserPointsRow
} from './types'

// ---- Static and global configuration -----------------------------------------------------------

export function useTemplates(): UseQueryResult<Record<string, TemplateInfo>> {
  return useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}data/templates.json`)
      if (!res.ok) throw new Error('templates.json missing')
      return (await res.json()) as Record<string, TemplateInfo>
    },
    staleTime: Infinity
  })
}

const fetchAssetStats = async () => {
  const rows = await getRows<AssetStats>({ code: CONTRACTS.CORE, table: 'assetstats' })
  return new Map(rows.map((r) => [String(r.template_id), r]))
}

export function useAssetStats(): UseQueryResult<Map<string, AssetStats>> {
  return useQuery({ queryKey: ['assetstats'], queryFn: fetchAssetStats, staleTime: 10 * 60_000 })
}

export interface MissionConfig {
  missions: MissionRow[]
  rewardConfigs: Map<number, RewardConfigRow>
  pools: Map<number, RewardPoolRow>
  entryCosts: Map<number, EntryCostRow[]>
  shardRewards: Map<number, ShardRewardRow>
  shardCaps: Map<number, ShardCapRow>
  epoch: number
}

async function fetchMissionConfig(): Promise<MissionConfig> {
  const miss = CONTRACTS.MISSIONS
  const [missions, cfgs, pools, costs, shardRews, shardCaps, epochRow] = await Promise.all([
    getRows<MissionRow>({ code: miss, table: 'missions' }),
    getRows<RewardConfigRow>({ code: miss, table: 'rewardcfgs' }),
    getRows<RewardPoolRow>({ code: miss, table: 'rewardpools' }),
    getRows<EntryCostRow>({ code: miss, table: 'entrycosts' }),
    getRows<ShardRewardRow>({ code: miss, table: 'shardrews' }).catch(() => []),
    getRows<ShardCapRow>({ code: miss, table: 'shardcaps' }).catch(() => []),
    getRow<{ id: number; epoch: number }>({ code: CONTRACTS.CORE, table: 'statsepoch' })
  ])
  const entryCosts = new Map<number, EntryCostRow[]>()
  for (const c of costs) entryCosts.set(Number(c.mission_id), [...(entryCosts.get(Number(c.mission_id)) ?? []), c])
  return {
    missions,
    rewardConfigs: new Map(cfgs.map((c) => [Number(c.reward_config_id), c])),
    pools: new Map(pools.map((p) => [Number(p.mission_id), p])),
    entryCosts,
    shardRewards: new Map(shardRews.map((s) => [Number(s.reward_config_id), s])),
    shardCaps: new Map(shardCaps.map((s) => [Number(s.mission_id), s])),
    epoch: Number(epochRow?.epoch ?? 0)
  }
}

export function useMissionConfig(): UseQueryResult<MissionConfig> {
  return useQuery({ queryKey: ['missions'], queryFn: fetchMissionConfig, staleTime: 60_000, refetchInterval: 120_000 })
}

/** The Alcor TLM/DEF pool: price, active liquidity and fee, for swap quotes. */
async function fetchMarket(): Promise<Market> {
  const row = await getRow<{ currSlot: { sqrtPriceX64: string }; liquidity: string; fee: number }>({
    code: CONTRACTS.ALCOR_SWAP,
    table: 'pools',
    lower_bound: ALCOR_TLM_DEF_POOL_ID,
    upper_bound: ALCOR_TLM_DEF_POOL_ID
  })
  if (!row) throw new Error('pool missing')
  const m = marketFromPool(row.currSlot.sqrtPriceX64, row.liquidity, Number(row.fee))
  if (!Number.isFinite(m.rate) || m.rate <= 0 || !(m.liquidity > 0)) throw new Error('bad pool state')
  return m
}

/** Falls back to a typical rate when the pool cannot be read; `live` says which. */
export function useMarket(): Market {
  const q = useQuery({ queryKey: ['market'], queryFn: fetchMarket, staleTime: 2 * 60_000, refetchInterval: 5 * 60_000, retry: 2 })
  return q.data ?? fallbackMarket()
}

/**
 * The pool as it is right now, for a swap about to be signed: the hook's copy may be minutes old,
 * and a swap's minimum output is set from it. Falls back to what the caller has if the read fails.
 */
export async function freshMarket(fallback: Market): Promise<Market> {
  try {
    return await queryClient.fetchQuery({ queryKey: ['market'], queryFn: fetchMarket, staleTime: 0 })
  } catch {
    return fallback
  }
}

export function useGlobalStats() {
  return useQuery({
    queryKey: ['globalstats'],
    queryFn: () => getRow<GlobalStatsRow>({ code: CONTRACTS.CORE, table: 'globalstats' }),
    staleTime: 5 * 60_000
  })
}

export interface ForgeConfig {
  levels: ForgeLevelRow[]
  shopItems: ShopItemRow[]
  tokens: ForgeTokensRow | null
}

export function useForgeConfig(): UseQueryResult<ForgeConfig> {
  return useQuery({
    queryKey: ['forge-config'],
    queryFn: async () => {
      const [levels, shopItems, tokens] = await Promise.all([
        getRows<ForgeLevelRow>({ code: CONTRACTS.FORGE, table: 'forgelvls' }),
        getRows<ShopItemRow>({ code: CONTRACTS.FORGE, table: 'shopitems' }),
        getRow<ForgeTokensRow>({ code: CONTRACTS.FORGE, table: 'forgetokens' })
      ])
      return { levels: levels.sort((a, b) => Number(a.level) - Number(b.level)), shopItems, tokens }
    },
    staleTime: 10 * 60_000
  })
}

// ---- The player ---------------------------------------------------------------------------------

export interface PlayerData {
  registered: boolean
  forgeLevel: number
  totals: PlayerTotals | null
  tlm: number
  def: number
  /** WAX, which AtomicMarket listings are priced in. */
  wax: number
  shards: number
  powerups: Map<string, number>
  forgeProgress: ForgeProgressRow | null
}

/** A token balance, read from the token contract's accounts table (goes through the endpoint pool). */
async function balance(code: string, account: string, symbol: string): Promise<number> {
  const acc = await getRows<{ balance: string }>({ code, table: 'accounts', scope: account, limit: 50 }).catch(() => [])
  const hit = acc.find((r) => r.balance.endsWith(` ${symbol}`))
  return hit ? Number(hit.balance.split(' ')[0]) : 0
}

async function fetchPlayer(account: string): Promise<PlayerData> {
  const [player, totals, tlm, def, wax, points, powerups, progress] = await Promise.all([
    getRow<PlayerRow>({ code: CONTRACTS.CORE, table: 'players', lower_bound: account, upper_bound: account }),
    getRow<PlayerTotals>({ code: CONTRACTS.CORE, table: 'playertotals', lower_bound: account, upper_bound: account }),
    balance(CONTRACTS.TLM, account, 'TLM'),
    balance(CONTRACTS.DEF, account, 'DEF'),
    balance('eosio.token', account, 'WAX'),
    getRow<UserPointsRow>({ code: CONTRACTS.USER_POINTS, table: 'userpoints', lower_bound: account, upper_bound: account }).catch(
      () => null
    ),
    getRows<PowerupRow>({ code: CONTRACTS.FORGE, table: 'powerups', scope: account }),
    // forge.pdef dropped its forgeprog table (2026-11-07), so nothing counts as paid towards the next
    // level. Not read at all: nodes answer a missing table with HTTP 500, which benches healthy nodes.
    Promise.resolve([] as ForgeProgressRow[])
  ])
  return {
    registered: !!player && player.owner === account,
    forgeLevel: Number(player?.forge_level ?? 0),
    totals: totals && totals.owner === account ? totals : null,
    tlm,
    def,
    wax,
    shards: Number(points?.user === account ? points.redeemable_points : 0) / 10,
    powerups: new Map(powerups.map((p) => [String(p.powerup_id), Number(p.amount)])),
    forgeProgress: progress[0] ?? null
  }
}

export function usePlayer(account: string | null): UseQueryResult<PlayerData> {
  return useQuery({
    queryKey: ['player', account],
    queryFn: () => fetchPlayer(account!),
    enabled: !!account,
    staleTime: 30_000
  })
}

// ---- The army: divisions, units, gear and the free pool -------------------------------------------

export interface Unit {
  asset: AssetRef
  gear: Partial<Record<'weapon' | 'supply' | 'creature' | 'lavalux', AssetRef>>
}

export interface Division {
  row: DivisionRow
  id: number
  leader: AssetRef | null
  units: Unit[]
  slotsMax: number
  atk: number
  def: number
  move: number
  /** Whether the contract's cached stats are current for this epoch (a join recalculates otherwise). */
  fresh: boolean
  /** The contract's cached stats, and the stats computed from the roster (null when a unit could not be resolved). */
  cached: { atk: number; def: number; move: number }
  live: { atk: number; def: number; move: number } | null
  lock: DivLockRow | null
}

/** A division's stats from its roster, the way the contract sums them; null if any unit is unresolved. */
/** A division as the contract adds it up; the warlord takes its move reduction off the total. */
export function liveStats(
  units: Unit[],
  rowCount: number,
  leader?: AssetRef | null
): { atk: number; def: number; move: number } | null {
  if (units.length !== rowCount || units.some((u) => !u.asset.stats)) return null
  let atk = 0
  let def = 0
  let move = 0
  for (const u of units) {
    const t = unitTotals({
      unit: u.asset.stats,
      weapon: u.gear.weapon?.stats,
      supply: u.gear.supply?.stats,
      creature: u.gear.creature?.stats,
      lavalux: u.gear.lavalux?.stats
    })
    atk += t.atk
    def += t.def
    move += t.move
  }
  return { atk, def, move: Math.max(0, move - Number(leader?.stats?.movecost_reduction || 0)) }
}

export interface Army {
  divisions: Division[]
  /** Staked NFTs not in any division, by kind. */
  free: Record<Kind, AssetRef[]>
  /** Every staked asset by id. */
  assets: Map<string, AssetRef>
  stakes: StakeRow[]
  locks: DivLockRow[]
  /** How many pieces of each gear kind are attached across all divisions. */
  gearUsed: Record<'weapon' | 'supply' | 'creature' | 'lavalux', number>
}

const emptyByKind = (): Record<Kind, AssetRef[]> => ({
  warlord: [],
  mercenary: [],
  weapon: [],
  supply: [],
  creature: [],
  lavalux: []
})

async function fetchArmy(account: string, epoch: number): Promise<Army> {
  const core = CONTRACTS.CORE
  const [divisions, units, stakes, locks, statsMap, templates] = await Promise.all([
    getRows<DivisionRow>({ code: core, table: 'divisions', scope: account }),
    getRows<DivUnitRow>({ code: core, table: 'divunits', scope: account }),
    getRows<StakeRow>({ code: core, table: 'stakes', scope: account }),
    getRows<DivLockRow>({ code: core, table: 'divlocks', scope: account }),
    queryClient.fetchQuery({ queryKey: ['assetstats'], queryFn: fetchAssetStats, staleTime: 10 * 60_000 }),
    queryClient.fetchQuery({
      queryKey: ['templates'],
      queryFn: async () =>
        (await fetch(`${import.meta.env.BASE_URL}data/templates.json`)).json() as Promise<Record<string, TemplateInfo>>,
      staleTime: Infinity
    })
  ])

  const ids = stakes.map((s) => String(s.asset_id))
  const resolved = await resolveTemplates(ids)
  const assets = new Map<string, AssetRef>()
  for (const id of ids) {
    const hit = resolved.get(id)
    if (hit) assets.set(id, makeAssetRef(id, hit, statsMap, templates))
  }

  const locksByDivision = new Map(locks.map((l) => [Number(l.division_id), l]))
  const unitsByDivision = new Map<number, DivUnitRow[]>()
  for (const u of units) unitsByDivision.set(Number(u.division_id), [...(unitsByDivision.get(Number(u.division_id)) ?? []), u])

  const gearUsed = { weapon: 0, supply: 0, creature: 0, lavalux: 0 }
  const ref = (id: string | number) => (id && String(id) !== '0' ? assets.get(String(id)) : undefined)

  const built: Division[] = divisions
    .map((row) => {
      const divUnits: Unit[] = (unitsByDivision.get(Number(row.division_id)) ?? [])
        .map((u) => {
          const asset = ref(u.unit_asset_id)
          if (!asset) return null
          const gear: Unit['gear'] = {}
          const slots = [
            ['weapon', u.weapon_asset_id],
            ['supply', u.supply_asset_id],
            ['creature', u.creature_asset_id],
            ['lavalux', u.lavalux_asset_id]
          ] as const
          for (const [kind, id] of slots) {
            const piece = ref(id)
            if (!piece) continue
            gear[kind] = piece
            gearUsed[kind]++
          }
          return { asset, gear }
        })
        .filter((u): u is Unit => !!u)
      const valid = row.cache_valid === true || Number(row.cache_valid) === 1
      const fresh = valid && Number(row.stats_epoch) === epoch
      const cached = {
        atk: Number(row.atk_cached || 0),
        def: Number(row.def_cached || 0),
        move: Number(row.movecost_cached || 0)
      }
      const live = liveStats(divUnits, (unitsByDivision.get(Number(row.division_id)) ?? []).length, ref(row.leader_asset_id))
      // A stale cache understates (or overstates) what the division really fields after a roster
      // change; the join recalculates it first, so requirements are judged on the live roster.
      const stats = !fresh && live ? live : cached
      return {
        row,
        id: Number(row.division_id),
        leader: ref(row.leader_asset_id) ?? null,
        units: divUnits,
        slotsMax: Number(row.slots_max || 0),
        ...stats,
        cached,
        live,
        fresh,
        lock: locksByDivision.get(Number(row.division_id)) ?? null
      }
    })
    .sort((a, b) => a.id - b.id)

  const free = emptyByKind()
  for (const s of stakes) {
    if (Number(s.division_id) !== 0) continue
    const a = assets.get(String(s.asset_id))
    if (!a) continue
    const kind = kindOfCategory(a.stats?.category) ?? kindOfCategory(Number(s.role))
    if (kind) free[kind].push(a)
  }

  return { divisions: built, free, assets, stakes, locks, gearUsed }
}

export function useArmy(account: string | null): UseQueryResult<Army> {
  const config = useMissionConfig()
  const epoch = config.data?.epoch ?? 0
  return useQuery({
    queryKey: ['army', account, epoch],
    queryFn: () => fetchArmy(account!, epoch),
    enabled: !!account && config.isSuccess,
    staleTime: 30_000
  })
}

// ---- The game balance: TLM and DEF deposited with core.pdef ----------------------------------------

/** What the player has deposited with core.pdef; joins without an entry transfer are paid from it. */
export function useGameBalance(account: string | null): UseQueryResult<GameBalance> {
  return useQuery({
    queryKey: ['game-balance', account],
    enabled: !!account,
    staleTime: 20_000,
    queryFn: async () => {
      const rows = await getRows<{ balance: string }>({ code: CONTRACTS.CORE, scope: account!, table: 'balances', limit: 20 })
      const amount = (symbol: string) => rows.map((r) => parseAsset(r.balance)).find((a) => a.symbol === symbol)?.amount ?? 0
      return { tlm: amount('TLM'), def: amount('DEF') }
    }
  })
}

// ---- NFTs still in the wallet (stakeable) ---------------------------------------------------------

export function useWalletNfts(account: string | null): UseQueryResult<AssetRef[]> {
  const stats = useAssetStats()
  const templates = useTemplates()
  return useQuery({
    queryKey: ['wallet-nfts', account],
    queryFn: async () => {
      const batches = await Promise.all(COLLECTIONS.map((c) => atomic.getOwnedAssets(account!, c)))
      const out: AssetRef[] = []
      for (const a of batches.flat()) {
        const c = cachedOf(a)
        // Only templates the game knows can be staked.
        if (!c || !stats.data!.has(c.t)) continue
        out.push(makeAssetRef(a.asset_id, c, stats.data!, templates.data!))
      }
      return out
    },
    enabled: !!account && stats.isSuccess && templates.isSuccess,
    staleTime: 60_000
  })
}

// ---- Deployments: the player's divisions out on missions --------------------------------------------

export interface Deployment {
  missionId: number
  divisionId: number
  /** The mission's entry row (the division's stats at join time); missing when a lagging node left it out. */
  entry?: MissionEntryRow
  joinedAt: number
  unlockAt: number
}

/**
 * Every division out on a mission, from the account's own lock table: one row per deployment,
 * kept until the reward is claimed, with when it locked and until when. That table is small and
 * read in one go, so a deployment can never go missing between refreshes. The mission's entry
 * table (every player's entries, read page by page) only adds the division's stats at join time.
 */
async function fetchDeployments(account: string): Promise<Deployment[]> {
  const locks = await getRows<DivLockRow>({ code: CONTRACTS.CORE, table: 'divlocks', scope: account }, { confirmEmpty: true })
  const missionIds = [...new Set(locks.map((l) => Number(l.mission_id)))]
  const entries = await Promise.all(
    missionIds.map((id) =>
      getRows<MissionEntryRow>({ code: CONTRACTS.MISSIONS, table: 'missentries', scope: String(id) }).catch(
        () => [] as MissionEntryRow[]
      )
    )
  )
  const byDivision = new Map<string, MissionEntryRow>()
  missionIds.forEach((missionId, i) => {
    for (const e of entries[i]) if (String(e.owner) === account) byDivision.set(`${missionId}:${e.division_id}`, e)
  })
  return locks
    .map((l) => ({
      missionId: Number(l.mission_id),
      divisionId: Number(l.division_id),
      entry: byDivision.get(`${Number(l.mission_id)}:${Number(l.division_id)}`),
      joinedAt: +chainDate(l.locked_at),
      unlockAt: +chainDate(l.locked_until)
    }))
    .sort((a, b) => a.unlockAt - b.unlockAt)
}

/**
 * Every player's entries on the given missions (one table per mission, read page by page): each
 * division out, with when it joined and when it unlocks.
 */
export function useMissionEntries(missionIds: number[]): UseQueryResult<Map<number, MissionEntryRow[]>> {
  const ids = [...missionIds].sort((a, b) => a - b)
  return useQuery({
    queryKey: ['missentries', ids.join(',')],
    queryFn: async () => {
      const lists = await Promise.all(
        ids.map((id) => getRows<MissionEntryRow>({ code: CONTRACTS.MISSIONS, table: 'missentries', scope: String(id) }))
      )
      return new Map(ids.map((id, i) => [id, lists[i]]))
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000
  })
}

export function useDeployments(account: string | null): UseQueryResult<Deployment[]> {
  return useQuery({
    queryKey: ['deployments', account],
    queryFn: () => fetchDeployments(account!),
    enabled: !!account,
    staleTime: 30_000,
    refetchInterval: 60_000
  })
}

/** Reads everything about the player again, after a transaction. */
export async function refreshPlayer(account: string | null) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['player', account] }),
    queryClient.invalidateQueries({ queryKey: ['game-balance', account] }),
    queryClient.invalidateQueries({ queryKey: ['today-earnings', account] }),
    queryClient.invalidateQueries({ queryKey: ['tlm-balance', account] }),
    queryClient.invalidateQueries({ queryKey: ['army', account] }),
    queryClient.invalidateQueries({ queryKey: ['deployments', account] }),
    queryClient.invalidateQueries({ queryKey: ['wallet-nfts', account] }),
    queryClient.invalidateQueries({ queryKey: ['owned-blend-inputs', account] }),
    queryClient.invalidateQueries({ queryKey: ['market-listings'] }),
    queryClient.invalidateQueries({ queryKey: ['missions'] })
  ])
}

/**
 * What the game has left to pay out: the TLM the missions contract (miss.pdef, which holds and
 * pays the player rewards) has on alien.worlds right now.
 */
export function useRewardPool(): UseQueryResult<number> {
  return useQuery({
    queryKey: ['reward-pool'],
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      const rows = await getRows<{ balance: string }>({ code: CONTRACTS.TLM, table: 'accounts', scope: CONTRACTS.MISSIONS })
      const hit = rows.map((r) => parseAsset(r.balance)).find((a) => a.symbol === 'TLM')
      return hit?.amount ?? 0
    }
  })
}
