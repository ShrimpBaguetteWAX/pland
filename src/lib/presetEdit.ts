import type { AssetRef } from '@/data/assets'
import { liveStats, type Army, type Division } from '@/data/game'
import type { DivisionRow } from '@/data/types'

import type { PresetDivision } from './armyPresets'
import { GEAR_KINDS, kindOf, type GearKind, type Kind } from './stats'

/*
 * Editing a preset as if it were the army: the preset's divisions become a virtual army built from
 * the account's staked cards, so the Army page can show and change it exactly as it shows and
 * changes the real one, only nothing is signed. Every change here is a pure function from one list
 * of preset divisions to the next; the page keeps the list in its state and saves it when asked.
 *
 * A card is never in two places: putting it somewhere takes it out of wherever it was first.
 */

/** The preset's divisions as an Army, from the staked cards the real army knows. */
export function virtualArmy(base: Army, divisions: PresetDivision[]): Army {
  const ref = (id?: string) => (id ? base.assets.get(id) : undefined)
  const used = new Set<string>()
  const gearUsed = { weapon: 0, supply: 0, creature: 0, lavalux: 0 }
  const built: Division[] = divisions.flatMap((p, i) => {
    const leader = ref(p.leader)
    if (!leader) return []
    used.add(leader.assetId)
    const units = p.units.flatMap((u) => {
      const asset = ref(u.merc)
      if (!asset) return []
      used.add(asset.assetId)
      const gear: Division['units'][number]['gear'] = {}
      for (const k of GEAR_KINDS) {
        const g = ref(u.gear[k])
        if (!g) continue
        gear[k] = g
        used.add(g.assetId)
        gearUsed[k]++
      }
      return [{ asset, gear }]
    })
    const live = liveStats(units, units.length, leader) ?? { atk: 0, def: 0, move: 0 }
    return [
      {
        row: { division_id: i + 1, leader_asset_id: leader.assetId } as unknown as DivisionRow,
        id: i + 1,
        leader,
        units,
        slotsMax: Number(leader.stats?.slots_max ?? 0),
        ...live,
        fresh: true,
        cached: live,
        live,
        lock: null
      }
    ]
  })
  const free: Record<Kind, AssetRef[]> = { warlord: [], mercenary: [], weapon: [], supply: [], creature: [], lavalux: [] }
  for (const a of base.assets.values()) {
    if (used.has(a.assetId)) continue
    const k = kindOf(a.stats)
    if (k) free[k].push(a)
  }
  return { divisions: built, free, assets: base.assets, stakes: base.stakes, locks: [], gearUsed }
}

const clone = (divs: PresetDivision[]): PresetDivision[] => divs.map((d) => ({ leader: d.leader, units: d.units.map((u) => ({ merc: u.merc, gear: { ...u.gear } })) }))

/** Takes a card out of wherever it is: a mercenary with its gear, a piece of gear off its mercenary. */
function withoutCard(divs: PresetDivision[], id: string): PresetDivision[] {
  for (const d of divs) {
    d.units = d.units.filter((u) => u.merc !== id)
    for (const u of d.units) for (const k of GEAR_KINDS) if (u.gear[k] === id) delete u.gear[k]
  }
  return divs
}

/** Gear onto a mercenary; what it wore of that kind comes off, and the piece leaves wherever it was. */
export function presetEquip(divs: PresetDivision[], merc: string, kind: GearKind, gear: string): PresetDivision[] {
  const next = withoutCard(clone(divs), gear)
  for (const d of next) for (const u of d.units) if (u.merc === merc) u.gear[kind] = gear
  return next
}

export function presetTakeOff(divs: PresetDivision[], merc: string, kind: GearKind): PresetDivision[] {
  const next = clone(divs)
  for (const d of next) for (const u of d.units) if (u.merc === merc) delete u.gear[kind]
  return next
}

/** Gear from one mercenary to another; if the other wears that kind already, the two swap. */
export function presetMoveGear(divs: PresetDivision[], src: string, dst: string, kind: GearKind): PresetDivision[] {
  const next = clone(divs)
  let a: string | undefined
  let b: string | undefined
  for (const d of next)
    for (const u of d.units) {
      if (u.merc === src) a = u.gear[kind]
      if (u.merc === dst) b = u.gear[kind]
    }
  if (!a) return divs
  for (const d of next)
    for (const u of d.units) {
      if (u.merc === src) {
        if (b) u.gear[kind] = b
        else delete u.gear[kind]
      }
      if (u.merc === dst) u.gear[kind] = a
    }
  return next
}

/** A mercenary into a division (out of any other first), gear and all when it comes from a division. */
export function presetRecruit(divs: PresetDivision[], leader: string, merc: string): PresetDivision[] {
  const next = clone(divs)
  const carried = next.flatMap((d) => d.units).find((u) => u.merc === merc)
  withoutCard(next, merc)
  const target = next.find((d) => d.leader === leader)
  if (target) target.units.push({ merc, gear: carried ? { ...carried.gear } : {} })
  return next
}

/** A mercenary out of its division; its gear comes off and stays free. */
export function presetDismiss(divs: PresetDivision[], merc: string): PresetDivision[] {
  return withoutCard(clone(divs), merc)
}

export function presetCreate(divs: PresetDivision[], leader: string): PresetDivision[] {
  const next = withoutCard(clone(divs), leader).filter((d) => d.leader !== leader)
  next.push({ leader, units: [] })
  return next
}

export function presetDisband(divs: PresetDivision[], leader: string): PresetDivision[] {
  return clone(divs).filter((d) => d.leader !== leader)
}
