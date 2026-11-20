import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'
import { useNftFloors } from '@/data/market'

/*
 * The nanite system (nanites.pdef). Materials are refined into nanites by sending them to the
 * contract with the memo "refine" (at most max_refine per transfer); the contract burns them and
 * adds their nanites to the player's balance at once. The refinery table says which material
 * template gives how many nanites. Missions wear divisions down (the integrity table, per player),
 * and restoring spends nanites: points_per_nanite points each. Amounts on chain are in thousandths
 * of a nanite (units.per_nanite).
 *
 * Seen on chain on 18 Nov 2026: refining is open to everyone; wear and restoring are recorded only
 * for the contract's testers so far (config mode 1).
 */

export interface NaniteConfig {
  mode: number
  pointsPerNanite: number
  maxRefine: number
  /** Chain units per nanite. */
  perNanite: number
  /** Material template → nanites per item. */
  refinery: Map<string, number>
  /** Accounts that get wear and restoring while the system is in testing. */
  testers: Set<string>
}

interface ConfigRow {
  mode: number
  gauge_mult: number
  points_per_nanite: number
  max_refine: number
}

export function useNaniteConfig(): UseQueryResult<NaniteConfig> {
  return useQuery({
    queryKey: ['nanite-config'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const code = CONTRACTS.NANITES
      const [config, units, refinery, testers] = await Promise.all([
        getRows<ConfigRow>({ code, scope: code, table: 'config', limit: 1 }),
        getRows<{ per_nanite: number }>({ code, scope: code, table: 'units', limit: 1 }),
        getRows<{ template_id: number | string; nanites: number }>({ code, scope: code, table: 'refinery' }),
        getRows<{ account: string }>({ code, scope: code, table: 'testers' })
      ])
      const c = config[0]
      return {
        mode: Number(c?.mode ?? 0),
        pointsPerNanite: Number(c?.points_per_nanite ?? 0),
        maxRefine: Math.max(1, Number(c?.max_refine ?? 50)),
        perNanite: Math.max(1, Number(units[0]?.per_nanite ?? 1)),
        refinery: new Map(refinery.map((r) => [String(r.template_id), Number(r.nanites)])),
        testers: new Set(testers.map((t) => t.account))
      }
    }
  })
}

export interface NaniteAccount {
  /** Nanites held now, refined in all, spent, and wear points taken. */
  nanites: number
  refined: number
  spent: number
  worn: number
}

/** The player's nanites (in whole nanites); zero for a player who never refined. */
export function useNaniteAccount(account: string | null, perNanite: number | undefined): UseQueryResult<NaniteAccount> {
  return useQuery({
    queryKey: ['nanite-account', account, perNanite],
    enabled: !!account && !!perNanite,
    staleTime: 30_000,
    queryFn: async () => {
      const code = CONTRACTS.NANITES
      const rows = await getRows<{ owner: string; nanites: number; refined: number; spent: number; worn: number }>({
        code,
        scope: code,
        table: 'accounts',
        lower_bound: account!,
        upper_bound: account!,
        limit: 1
      })
      const r = rows.find((x) => x.owner === account)
      const u = perNanite!
      return { nanites: Number(r?.nanites ?? 0) / u, refined: Number(r?.refined ?? 0) / u, spent: Number(r?.spent ?? 0) / u, worn: Number(r?.worn ?? 0) }
    }
  })
}

/** Restores a division's wear: `amount` is in chain units (thousandths of a nanite), so less than one nanite works. */
export const restoreAction = (account: string, permission: string, divisionId: number, amount: number): AnyAction => ({
  account: CONTRACTS.NANITES,
  name: 'restore',
  authorization: [{ actor: account, permission }],
  data: { owner: account, division_id: divisionId, amount }
})

/**
 * The repairs to make right now, read fresh from the chain: each division's wear (the integrity
 * table, scoped by owner) and the nanite balance, in chain units. Every listed division that is
 * worn gets fully repaired, in order, while the balance covers the whole repair; one it cannot
 * cover is left as it is. Wear only shows for accounts the contract records it for (all of them once
 * it is live, the testers before).
 */
export async function planRepairs(account: string, divisionIds: number[], config: NaniteConfig): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!divisionIds.length || config.pointsPerNanite <= 0) return out
  const code = CONTRACTS.NANITES
  const [integrity, accounts] = await Promise.all([
    getRows<{ division_id: number | string; worn: number | string }>({ code, scope: account, table: 'integrity' }),
    getRows<{ owner: string; nanites: number | string }>({ code, scope: code, table: 'accounts', lower_bound: account, upper_bound: account, limit: 1 })
  ])
  const worn = new Map(integrity.map((r) => [Number(r.division_id), Number(r.worn)]))
  let budget = Number(accounts.find((r) => r.owner === account)?.nanites ?? 0)
  for (const id of divisionIds) {
    const points = worn.get(id) ?? 0
    if (points <= 0) continue
    // Rounded down: never more than the wear needs (a part of a point may stay; at 5 units a point it is exact).
    const need = Math.floor((points * config.perNanite) / config.pointsPerNanite)
    if (need <= 0 || need > budget) continue
    out.set(id, need)
    budget -= need
  }
  return out
}

/** Refines materials into nanites: they go to nanites.pdef with the memo "refine" and are burned. */
export const refineAction = (account: string, permission: string, assetIds: string[]): AnyAction => ({
  account: CONTRACTS.ATOMICASSETS,
  name: 'transfer',
  authorization: [{ actor: account, permission }],
  data: { from: account, to: CONTRACTS.NANITES, asset_ids: assetIds, memo: 'refine' }
})

export interface NanitePrice {
  /** WAX for one nanite the cheapest way: buying the refinery material with the lowest listing per nanite. */
  waxPerNanite: number
  templateId: string
  /** The listing that gives it, and the nanites one of those gives. */
  wax: number
  nanites: number
}

/** The cheapest nanite on AtomicMarket right now (null while reading, or with nothing listed). */
export function useNanitePrice(): { config: NaniteConfig | undefined; price: NanitePrice | null } {
  const config = useNaniteConfig().data
  const floors = useNftFloors(config ? [...config.refinery.keys()] : [])
  let price: NanitePrice | null = null
  if (config && floors.data)
    for (const [templateId, nanites] of config.refinery) {
      const wax = floors.data.get(templateId)
      if (wax === undefined || nanites <= 0) continue
      if (!price || wax / nanites < price.waxPerNanite) price = { waxPerNanite: wax / nanites, templateId, wax, nanites }
    }
  return { config, price }
}

/** The player's nanite balance in whole nanites (undefined while reading). */
export function useNaniteBalance(account: string | null): number | undefined {
  const config = useNaniteConfig().data
  return useNaniteAccount(account, config?.perNanite).data?.nanites
}

/** 1,250 · 12.5 */
export const formatNanites = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0 })
