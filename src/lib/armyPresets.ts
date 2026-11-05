import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import { GEAR_KINDS, type GearKind, type Kind } from './stats'

/*
 * Army presets: the army exactly as built (each division's warlord, its mercenaries and the gear on
 * each), saved in this browser under the account, to come back to with one click. Everything is
 * kept by asset id, so a preset points at the very NFTs, shine and all.
 *
 * Restoring keeps the divisions that already match, takes apart the ones that can be changed and do
 * not, and builds the preset's other divisions from what is staked. Divisions out on a mission (or
 * waiting for a claim) cannot be changed: they stay as they are, and a preset division that needs
 * one of their NFTs is left out. NFTs no longer staked are left out too, and said so.
 */

export interface PresetUnit {
  merc: string
  gear: Partial<Record<GearKind, string>>
}

export interface PresetDivision {
  leader: string
  units: PresetUnit[]
}

export interface Preset {
  id: string
  name: string
  savedAt: number
  divisions: PresetDivision[]
}

const key = (account: string) => `pd:army-presets:v1:${account}`

export function readPresets(account: string | null): Preset[] {
  if (!account) return []
  try {
    const raw = localStorage.getItem(key(account))
    const list = raw ? (JSON.parse(raw) as Preset[]) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function writePresets(account: string, presets: Preset[]): boolean {
  try {
    localStorage.setItem(key(account), JSON.stringify(presets))
    return true
  } catch {
    return false
  }
}

/** The army as it stands, as a preset's divisions (divisions without a warlord cannot be rebuilt and are left out). */
export function snapshot(divisions: Division[]): PresetDivision[] {
  return divisions
    .filter((d) => d.leader)
    .map((d) => ({
      leader: d.leader!.assetId,
      units: d.units.map((u) => ({
        merc: u.asset.assetId,
        gear: Object.fromEntries(GEAR_KINDS.flatMap((k) => (u.gear[k] ? [[k, u.gear[k]!.assetId]] : [])))
      }))
    }))
}

const unitSig = (u: PresetUnit) => u.merc + '[' + GEAR_KINDS.map((k) => u.gear[k] ?? '').join(',') + ']'
const divisionSig = (d: PresetDivision) => d.leader + ':' + d.units.map(unitSig).sort().join('|')

/** Whether a division stands exactly as the preset division: same warlord, mercenaries and gear on each. */
export const matches = (d: Division, p: PresetDivision) => !!d.leader && divisionSig(snapshot([d])[0]) === divisionSig(p)

/** Whether the army stands exactly as the preset (every division of each, nothing more). */
export function isCurrent(preset: Preset, divisions: Division[]): boolean {
  const now = snapshot(divisions).map(divisionSig).sort()
  const want = preset.divisions.map(divisionSig).sort()
  return now.length === want.length && now.every((s, i) => s === want[i])
}

export interface RestorePlan {
  /** Current divisions that already match a preset division: left as they are. */
  keep: Division[]
  /** Current divisions that can be changed and do not match: taken apart. */
  disband: Division[]
  /** Current divisions out on a mission or waiting for a claim: they cannot change and stay. */
  locked: Division[]
  /** The preset divisions to build, each with only the NFTs that can be had. */
  build: PresetDivision[]
  /** Preset divisions left out, and why. */
  skipped: { division: PresetDivision; reason: string }[]
  /** NFTs of the preset that are no longer staked. */
  missing: string[]
  /** NFTs of the preset held in a division that cannot change right now. */
  held: string[]
}

export function planRestore(
  preset: Preset,
  divisions: Division[],
  free: Record<Kind, AssetRef[]>,
  editable: (d: Division) => boolean
): RestorePlan {
  const keep: Division[] = []
  const todo: PresetDivision[] = []
  const unmatched = new Set(divisions)
  for (const p of preset.divisions) {
    const hit = [...unmatched].find((d) => matches(d, p))
    if (hit) {
      keep.push(hit)
      unmatched.delete(hit)
    } else todo.push(p)
  }
  const locked = [...unmatched].filter((d) => !editable(d))
  const disband = [...unmatched].filter((d) => editable(d))

  const contents = (d: Division) => [
    ...(d.leader ? [d.leader.assetId] : []),
    ...d.units.flatMap((u) => [u.asset.assetId, ...GEAR_KINDS.flatMap((k) => (u.gear[k] ? [u.gear[k]!.assetId] : []))])
  ]
  const lockedIds = new Set(locked.flatMap(contents))
  const owned = new Set([...divisions.flatMap(contents), ...Object.values(free).flatMap((list) => list.map((a) => a.assetId))])
  const missing = new Set<string>()
  const held = new Set<string>()
  const ok = (id: string) => {
    if (!owned.has(id)) missing.add(id)
    else if (lockedIds.has(id)) held.add(id)
    else return true
    return false
  }

  const build: PresetDivision[] = []
  const skipped: RestorePlan['skipped'] = []
  for (const p of todo) {
    if (!owned.has(p.leader)) {
      missing.add(p.leader)
      skipped.push({ division: p, reason: 'its warlord is no longer staked' })
      continue
    }
    if (lockedIds.has(p.leader)) {
      held.add(p.leader)
      skipped.push({ division: p, reason: 'its warlord leads a division out on a mission or waiting for a claim' })
      continue
    }
    const units = p.units.flatMap((u) => {
      if (!ok(u.merc)) return []
      const gear = Object.fromEntries(Object.entries(u.gear).filter(([, id]) => id && ok(id))) as PresetUnit['gear']
      return [{ merc: u.merc, gear }]
    })
    build.push({ leader: p.leader, units })
  }
  return { keep, disband, locked, build, skipped, missing: [...missing], held: [...held] }
}
