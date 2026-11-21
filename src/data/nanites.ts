import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'
import { useNftFloors } from '@/data/market'
import { savedActions } from '@/wallet/autoSign'

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
  /** A division's wear gauge holds gauge_mult × (its attack + defense) points. */
  gaugeMult: number
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
        gaugeMult: Number(c?.gauge_mult ?? 0),
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
    // Read again after every transaction (refreshPlayer), and now and then for ones made elsewhere.
    refetchInterval: 60_000,
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

/** Each division's wear points (the integrity table, scoped by owner); a division never worn has none. */
export function useIntegrity(account: string | null): UseQueryResult<Map<number, number>> {
  return useQuery({
    queryKey: ['nanite-integrity', account],
    enabled: !!account,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const rows = await getRows<{ division_id: number | string; worn: number | string }>({ code: CONTRACTS.NANITES, scope: account!, table: 'integrity' })
      return new Map(rows.map((r) => [Number(r.division_id), Number(r.worn)]))
    }
  })
}

/** How intact a division is, 0 to 1: its gauge (gauge_mult × attack + defense) less its wear. Null when the gauge is unknown. */
export function condition(worn: number, atk: number, def: number, gaugeMult: number | undefined): number | null {
  const gauge = (gaugeMult ?? 0) * (atk + def)
  return gauge > 0 ? Math.max(0, Math.min(1, 1 - worn / gauge)) : null
}

/** Restores a division's wear: `amount` is in chain units (thousandths of a nanite), so less than one nanite works. */
export const restoreAction = (account: string, permission: string, divisionId: number, amount: number): AnyAction => ({
  account: CONTRACTS.NANITES,
  name: 'restore',
  authorization: [{ actor: account, permission }],
  data: { owner: account, division_id: divisionId, amount }
})

/** A division to repair: `adds` is the wear a join right after the claim puts on it (the mission's attack plus defense requirement), when it goes straight back out. */
export interface RepairItem {
  divisionId: number
  adds?: number
}

/** Nanite units per division: `now` restores the wear it has (after its claim, before anything else), `after` the wear its next join adds (right after that join). */
export interface RepairPlan {
  now: Map<number, number>
  after: Map<number, number>
}

/** Wear points to chain units, rounded down: never more than the wear needs (at 5 units a point it is exact). */
const unitsFor = (points: number, config: NaniteConfig) => Math.floor((points * config.perNanite) / config.pointsPerNanite)

/**
 * The repairs to make right now, read fresh from the chain: each division's wear (the integrity
 * table, scoped by owner) and the nanite balance, in chain units. First every listed division with
 * wear is fully repaired, in order, while the balance covers the whole repair (a division always comes
 * home at 100 %); then, for each one going straight back out that is clean before its join, the wear
 * that join adds (always the mission's attack plus defense requirement), so it is at 100 % while out
 * too. A repair the balance cannot fully cover is left out, never made in part.
 */
export async function planRepairs(account: string, items: RepairItem[], config: NaniteConfig): Promise<RepairPlan> {
  const plan: RepairPlan = { now: new Map(), after: new Map() }
  if (!items.length || config.pointsPerNanite <= 0) return plan
  const code = CONTRACTS.NANITES
  const [integrity, accounts] = await Promise.all([
    getRows<{ division_id: number | string; worn: number | string }>({ code, scope: account, table: 'integrity' }),
    getRows<{ owner: string; nanites: number | string }>({ code, scope: code, table: 'accounts', lower_bound: account, upper_bound: account, limit: 1 })
  ])
  const worn = new Map(integrity.map((r) => [Number(r.division_id), Number(r.worn)]))
  let budget = Number(accounts.find((r) => r.owner === account)?.nanites ?? 0)
  const clean = new Set<number>()
  for (const { divisionId } of items) {
    const need = unitsFor(worn.get(divisionId) ?? 0, config)
    if (need <= 0) clean.add(divisionId)
    else if (need <= budget) {
      plan.now.set(divisionId, need)
      budget -= need
      clean.add(divisionId)
    }
  }
  for (const { divisionId, adds } of items) {
    if (!adds || !clean.has(divisionId)) continue
    const need = unitsFor(adds, config)
    if (need <= 0 || need > budget) continue
    plan.after.set(divisionId, need)
    budget -= need
  }
  return plan
}

/**
 * Whether repairs may go into a transaction: always, unless joins are picked for auto-signing and the
 * repair is not, so a transaction that would be auto-signed stays auto-signed instead of going to the
 * wallet every time.
 */
export function repairsAllowed(): boolean {
  const picked = savedActions()
  return !picked.includes('miss.pdef::join') || picked.includes('nanites.pdef::restore')
}

/** The plan for these divisions, or an empty one while repairs are off or the config is unread (a failed read leaves them out too). */
export async function repairPlanFor(account: string, items: RepairItem[], config: NaniteConfig | undefined): Promise<RepairPlan> {
  const empty: RepairPlan = { now: new Map(), after: new Map() }
  if (!config || !repairsAllowed() || !items.length) return empty
  return planRepairs(account, items, config).catch(() => empty)
}

/** The restore action for one division from one side of a plan (none when it is not in it). */
export const restoreFrom = (account: string, permission: string, side: Map<number, number>, divisionId: number): AnyAction[] => {
  const amount = side.get(divisionId)
  return amount ? [restoreAction(account, permission, divisionId, amount)] : []
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
