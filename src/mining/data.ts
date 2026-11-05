import { useQuery } from '@tanstack/react-query'

import { atomic } from '@/chain/atomic'
import { CONTRACTS, PLANETS, type Planet } from '@/chain/config'
import { getRow, getRows } from '@/chain/rpc'
import { queryClient, refetchOnReturn } from '@/data/queryClient'
import { parseAsset } from '@/lib/format'

import { effectiveCommission, estimateShards, estimateTlm, miningPowerByRarity } from './estimates'
import type {
  AwTool,
  Bag,
  EquippedTool,
  FavoriteLand,
  LandData,
  LandType,
  McMember,
  Miner,
  PoolBucket,
  ToolData,
  ToolUse
} from './types'

/*
 * What the Mine button reads, as WAX Mission Control reads it: the miner and their bag on
 * m.federation, tool and land stats on hq.mu, planet pools and minimum commissions, and the
 * favourite lands kept with the player's Mission Control membership (members.mc).
 */

const MIN = 60_000
const HOUR = 60 * MIN
const MEMBERS = 'members.mc'
const HQ = 'hq.mu'
const RATINGS = 'awlndratings'
const scopeOf = (planet: Planet) => `${planet}.world`
const exact = (key: string) => ({ lower_bound: key, upper_bound: key })

export const readMiner = (account: string) =>
  getRow<Miner>({ code: CONTRACTS.MINING, table: 'miners', ...exact(account) }, { confirmEmpty: true })
const readBag = (account: string) =>
  getRow<Bag>({ code: CONTRACTS.MINING, table: 'bags', ...exact(account) }, { confirmEmpty: true })
const readToolUse = (assetId: string) => getRow<ToolUse>({ code: CONTRACTS.MINING, table: 'tooluse', ...exact(assetId) })
const readPools = async (planet: Planet) => {
  const row = await getRow<{ pool_buckets: PoolBucket[] }>({ code: CONTRACTS.MINING, table: 'pools', scope: scopeOf(planet) })
  return Object.fromEntries((row?.pool_buckets ?? []).map((b) => [b.key, parseAsset(b.value).amount]))
}

const keys = {
  member: (a: string | null) => ['mining', 'member', a] as const,
  miner: (a: string | null) => ['mining', 'miner', a] as const,
  tools: (a: string | null) => ['mining', 'tools', a] as const,
  favorites: (a: string | null) => ['mining', 'favorites', a] as const,
  pools: ['mining', 'pools'] as const
}

/** The player's Mission Control membership; mining through Mission Control needs one. */
export const useMcMember = (account: string | null) =>
  useQuery({
    queryKey: keys.member(account),
    enabled: !!account,
    staleTime: 10 * MIN,
    queryFn: () => getRow<McMember>({ code: MEMBERS, table: 'mcmembers', ...exact(account!) }, { confirmEmpty: true })
  })

export const useMiner = (account: string | null) =>
  useQuery({
    queryKey: keys.miner(account),
    enabled: !!account,
    staleTime: 20 * MIN,
    refetchOnWindowFocus: refetchOnReturn,
    queryFn: () => readMiner(account!)
  })

const useAwTools = () =>
  useQuery({ queryKey: ['mining', 'awtools'], staleTime: HOUR, queryFn: () => getRows<AwTool>({ code: HQ, table: 'awtools' }) })
const useLandTypes = () =>
  useQuery({
    queryKey: ['mining', 'landtypes'],
    staleTime: HOUR,
    queryFn: () => getRows<LandType>({ code: HQ, table: 'awlandtypes' })
  })

/** min_commission per planet, as a fraction. */
const usePlanetMin = () =>
  useQuery({
    queryKey: ['mining', 'planetmin'],
    staleTime: HOUR,
    queryFn: async () => {
      const entries = await Promise.all(
        PLANETS.map(async (planet) => {
          const row = await getRow<{ data: { key: string; value: [string, number] }[] }>({
            code: RATINGS,
            table: 'plntconfigs',
            scope: scopeOf(planet)
          })
          return [planet, (row?.data.find((c) => c.key === 'min_commission')?.value?.[1] ?? 0) / 10000] as const
        })
      )
      return Object.fromEntries(entries) as Record<Planet, number>
    }
  })

/**
 * Every planet's pool. They move with every mine anyone makes, so they are read again often while a
 * mine is ready (it decides which land pays most) and rarely while it is cooling down.
 */
export const usePools = (cooling: boolean) =>
  useQuery({
    queryKey: keys.pools,
    staleTime: 10_000,
    refetchInterval: cooling ? 90_000 : 20_000,
    queryFn: async () =>
      Object.fromEntries(await Promise.all(PLANETS.map(async (p) => [p, await readPools(p)] as const))) as Record<
        Planet,
        Record<string, number>
      >
  })

/** The tools in the player's bag with their stats and when each was last used. */
export function useEquippedTools(account: string | null) {
  const awTools = useAwTools()
  return useQuery({
    queryKey: keys.tools(account),
    enabled: !!account && !!awTools.data,
    staleTime: 20 * MIN,
    refetchOnWindowFocus: refetchOnReturn,
    queryFn: async (): Promise<EquippedTool[]> => {
      const bag = await readBag(account!)
      if (!bag?.items.length) return []
      const [assets, uses] = await Promise.all([
        atomic.getAssetsByIds(bag.items),
        Promise.all(bag.items.map((id) => readToolUse(id)))
      ])
      return bag.items.flatMap((id, i) => {
        const asset = assets.find((a) => a.asset_id === id)
        if (!asset) return []
        const data = asset.data as unknown as ToolData
        const templateId = asset.template?.template_id ?? ''
        const stats = awTools.data!.find((t) => String(t.template_id) === templateId && t.shine === data.shine)
        return [
          {
            ...data,
            asset_id: id,
            last_use: Number(uses[i]?.last_use ?? 0),
            mining_power: stats?.mining_power ?? 0,
            nft_power: stats?.nft_power ?? 0,
            pow: stats?.pow ?? 0
          }
        ]
      })
    }
  })
}

/** The favourite lands from the Mission Control member row, each with what a mine there pays. */
export function useFavoriteLands(account: string | null, cooling: boolean) {
  const member = useMcMember(account)
  const tools = useEquippedTools(account)
  const landTypes = useLandTypes()
  const planetMin = usePlanetMin()
  const pools = usePools(cooling)
  const ids = (member.data?.usrsettings ?? [])
    .filter((s) => s.key.includes('land'))
    .flatMap((s) => s.value.split(','))
    .filter(Boolean)
  const assets = useQuery({
    queryKey: [...keys.favorites(account), ids.join(',')],
    enabled: !!account && ids.length > 0,
    staleTime: HOUR,
    queryFn: () => atomic.getAssetsByIds(ids)
  })

  // The lands on the pools as given: the loaded ones for the button, freshly read ones on a click.
  const estimate = (poolData: Record<Planet, Record<string, number>> | undefined): FavoriteLand[] => {
    const power = miningPowerByRarity(tools.data)
    return ids.flatMap((id) => {
      const asset = assets.data?.find((a) => a.asset_id === id)
      if (!asset) return []
      const data = asset.data as unknown as LandData
      const [landName, planetName = ''] = String(data.name).split(' on ')
      const planet = planetName.toLowerCase() as Planet
      const landType = landTypes.data?.find((l) => l.landtype_id === data.cardid)
      const commission = effectiveCommission(Number(data.commission) / 10000, planetMin.data?.[planet] ?? 0)
      const gross = estimateTlm(power, landType?.mining_power_mod ?? 0, poolData?.[planet])
      return [
        {
          asset_id: id,
          landName,
          planet,
          delay: Number(data.delay) || 0,
          estimatedTlm: gross - gross * commission,
          shards: estimateShards(tools.data, landType)
        }
      ]
    })
  }
  // A handful of lands: worked out again on every render, which is cheaper than keeping a memo honest.
  const lands = estimate(pools.data)

  return {
    member,
    tools,
    lands,
    loaded: member.isFetched && tools.isFetched && (!ids.length || assets.isFetched),
    /** The lands on every pool read again, so a click mines where the return is best at that moment. */
    estimateNow: async () => estimate((await pools.refetch()).data)
  }
}

/** After a mine: the miner row, the tool cooldowns and the pools. */
export function refreshMining(account: string | null) {
  return Promise.all(
    [keys.miner(account), keys.tools(account), keys.pools, ['today-earnings', account]].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })
    )
  )
}
