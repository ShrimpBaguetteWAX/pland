import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'

/*
 * The ascension contract's settings (ascend.pdef): what each rarity yields when sacrificed, what
 * each star costs in Fragments, and which template ascends into which.
 */

export interface BurnYield {
  rarity: string
  guaranteed: number
  bonus: number
  /** 0–1 */
  bonusChance: number
}

export interface AscensionConfig {
  paused: boolean
  /** By rarity, lower case. */
  yields: Map<string, BurnYield>
  /** Fragments to go from `from` stars to the next, by "rarity:from" (rarity lower case). */
  costs: Map<string, number>
  /** Template → the template one star up. */
  next: Map<string, string>
}

interface BurnConfigRow {
  rarity: string
  fragments_guaranteed: number | string
  bonus_fragments: number | string
  bonus_chance: number | string
}
interface StarUpCostRow {
  rarity: string
  from_stars: number | string
  fragments_cost: number | string
}
interface StarUpMapRow {
  template_from: number | string
  template_to: number | string
}
interface StateRow {
  paused: number | boolean
}
interface PendingBurnRow {
  request_id: number | string
  player: string
  asset_ids: (number | string)[]
  guaranteed: (number | string)[]
  bonus_fragments: (number | string)[]
  bonus_chance: (number | string)[]
  commit_time: number
}

export const costKey = (rarity: string, fromStars: number) => `${rarity.toLowerCase()}:${fromStars}`

/** Expected Fragments from sacrificing one card of this rarity. */
export const expectedYield = (y: BurnYield) => y.guaranteed + y.bonus * y.bonusChance

export function useAscensionConfig(): UseQueryResult<AscensionConfig> {
  return useQuery({
    queryKey: ['ascension-config'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const code = CONTRACTS.ASCEND
      const [burns, costs, maps, state] = await Promise.all([
        getRows<BurnConfigRow>({ code, scope: code, table: 'burnconfigs' }),
        getRows<StarUpCostRow>({ code, scope: code, table: 'starupcosts' }),
        getRows<StarUpMapRow>({ code, scope: code, table: 'starupmaps' }),
        getRows<StateRow>({ code, scope: code, table: 'state', limit: 1 })
      ])
      return {
        paused: Boolean(Number(state[0]?.paused ?? 0)),
        yields: new Map(
          burns.map((b) => [
            b.rarity.toLowerCase(),
            {
              rarity: b.rarity,
              guaranteed: Number(b.fragments_guaranteed),
              bonus: Number(b.bonus_fragments),
              bonusChance: Number(b.bonus_chance) / 10_000
            }
          ])
        ),
        costs: new Map(costs.map((c) => [costKey(c.rarity, Number(c.from_stars)), Number(c.fragments_cost)])),
        next: new Map(maps.map((m) => [String(m.template_from), String(m.template_to)]))
      }
    }
  })
}

export interface PendingBurn {
  requestId: number
  cards: number
  /** Fragments at least, and at most, this request will mint. */
  min: number
  max: number
  committedAt: number
}

/** The player's sacrifices waiting for the oracle's reveal; polled quickly while there are any. */
export function usePendingBurns(account: string | null): UseQueryResult<PendingBurn[]> {
  return useQuery({
    queryKey: ['pending-burns', account],
    enabled: !!account,
    refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? 4_000 : 30_000),
    queryFn: async () => {
      const code = CONTRACTS.ASCEND
      const rows = await getRows<PendingBurnRow>({ code, scope: code, table: 'pendingburns' })
      return rows
        .filter((r) => r.player === account)
        .map((r) => ({
          requestId: Number(r.request_id),
          cards: r.asset_ids.length,
          min: r.guaranteed.reduce((n: number, g) => n + Number(g), 0),
          max: r.guaranteed.reduce((n: number, g, i) => n + Number(g) + Number(r.bonus_fragments[i] ?? 0), 0),
          committedAt: Number(r.commit_time) * 1000
        }))
    }
  })
}
