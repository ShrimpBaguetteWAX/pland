import type { AnyAction } from '@wharfkit/session'

import { addUnit, assignGear, deleteDivision, removeUnit, unassignGear } from '@/chain/actions/pd'
import type { Division } from '@/data/game'
import { GEAR_KINDS, type GearKind } from '@/lib/stats'

import type { PlannedDivision } from './armySearch'

/*
 * From the army as it is to the army the search proposes, in as few actions as possible. A
 * division is its warlord: where the planned division's warlord already leads one, that division
 * is kept and only its differences are signed; warlords that lead now but not in the plan have
 * their divisions taken apart; warlords that lead in the plan but not now get a new division.
 *
 * Three transactions, in order: first everything that frees cards (gear off, mercenaries out,
 * divisions deleted), then the new divisions, then (once their numbers are known) every mercenary
 * into place and every piece of gear onto its mercenary. Freeing first means no slot or allowance
 * is ever needed twice at the same time.
 */

export interface ArmyDiff {
  /** Divisions that go: no warlord in the plan leads them. */
  disband: Division[]
  /** Warlords that lead a new division. */
  create: string[]
  /** Actions that free cards: gear off, mercenaries out, divisions deleted. */
  free: (a: string, p: string) => AnyAction[]
  /**
   * Actions that fill the divisions; `idOf` gives each planned division's number (the kept one's,
   * or the new one's once it exists).
   */
  fill: (a: string, p: string, idOf: (leaderAssetId: string) => number | undefined) => AnyAction[]
  /** How many actions each step has, for the summary. */
  counts: { free: number; fill: number }
  /** Planned divisions touched at all (not unchanged). */
  changed: PlannedDivision[]
}

export function diffArmy(current: Division[], plan: PlannedDivision[]): ArmyDiff {
  const planByLeader = new Map(plan.map((d) => [d.warlord.assetId, d]))
  const nowByLeader = new Map(current.flatMap((d) => (d.leader ? [[d.leader.assetId, d] as const] : [])))
  const disband = current.filter((d) => !d.leader || !planByLeader.has(d.leader.assetId))
  const create = plan.filter((d) => !nowByLeader.has(d.warlord.assetId)).map((d) => d.warlord.assetId)
  const changed = plan.filter((d) => !d.unchanged)

  // Where every mercenary and piece of gear is now, and where it is going.
  const mercNow = new Map<string, { division: Division; gear: Record<GearKind, string | undefined> }>()
  for (const d of current)
    for (const u of d.units)
      mercNow.set(u.asset.assetId, {
        division: d,
        gear: Object.fromEntries(GEAR_KINDS.map((k) => [k, u.gear[k]?.assetId])) as Record<GearKind, string | undefined>
      })
  const mercPlan = new Map<string, { division: PlannedDivision; gear: Record<GearKind, string | undefined> }>()
  for (const d of plan)
    for (const u of d.units)
      mercPlan.set(u.merc.assetId, {
        division: d,
        gear: Object.fromEntries(GEAR_KINDS.map((k) => [k, u.gear[k]?.assetId])) as Record<GearKind, string | undefined>
      })

  const free = (a: string, p: string): AnyAction[] => {
    const out: AnyAction[] = []
    for (const [merc, now] of mercNow) {
      const next = mercPlan.get(merc)
      const stays = !!next && next.division.warlord.assetId === now.division.leader?.assetId
      for (const k of GEAR_KINDS) {
        const g = now.gear[k]
        // Gear comes off when the mercenary moves, or when it is to carry something else (or nothing).
        if (g && (!stays || next!.gear[k] !== g)) out.push(unassignGear(a, p, now.division.id, merc, g))
      }
      if (!stays) out.push(removeUnit(a, p, merc))
    }
    for (const d of disband) if (d.leader) out.push(deleteDivision(a, p, d.leader.assetId))
    return out
  }

  const fill = (a: string, p: string, idOf: (leader: string) => number | undefined): AnyAction[] => {
    const out: AnyAction[] = []
    const later: AnyAction[] = []
    for (const [merc, next] of mercPlan) {
      const id = idOf(next.division.warlord.assetId)
      if (id === undefined) continue
      const now = mercNow.get(merc)
      const stays = !!now && now.division.leader?.assetId === next.division.warlord.assetId
      if (!stays) out.push(addUnit(a, p, id, merc))
      for (const k of GEAR_KINDS) {
        const g = next.gear[k]
        if (g && (!stays || now!.gear[k] !== g)) later.push(assignGear(a, p, id, merc, k, g))
      }
    }
    // Every mercenary is in place before any gear goes on.
    return [...out, ...later]
  }

  const nowIds = (leader: string) => nowByLeader.get(leader)?.id
  return {
    disband,
    create,
    free,
    fill,
    counts: { free: free('a', 'p').length, fill: fill('a', 'p', (l) => nowIds(l) ?? 0).length },
    changed
  }
}
