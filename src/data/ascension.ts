import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'

/*
 * The ascension contract's settings (ascend.pdef), as far as the division builder needs them: what
 * each star costs (which says how far a rarity can go) and which template ascends into which (which
 * says whether a card can ascend at all). Ascending itself is not done here.
 */

export interface AscensionConfig {
  /** Fragments to go from `from` stars to the next, by "rarity:from" (rarity lower case). */
  costs: Map<string, number>
  /** Template → the template one star up. */
  next: Map<string, string>
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

export const costKey = (rarity: string, fromStars: number) => `${rarity.toLowerCase()}:${fromStars}`

export function useAscensionConfig(): UseQueryResult<AscensionConfig> {
  return useQuery({
    queryKey: ['ascension-config'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const code = CONTRACTS.ASCEND
      const [costs, maps] = await Promise.all([
        getRows<StarUpCostRow>({ code, scope: code, table: 'starupcosts' }),
        getRows<StarUpMapRow>({ code, scope: code, table: 'starupmaps' })
      ])
      return {
        costs: new Map(costs.map((c) => [costKey(c.rarity, Number(c.from_stars)), Number(c.fragments_cost)])),
        next: new Map(maps.map((m) => [String(m.template_from), String(m.template_to)]))
      }
    }
  })
}
