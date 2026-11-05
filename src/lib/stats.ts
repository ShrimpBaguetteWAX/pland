import { CATEGORY, SECONDS_PER_MOVE_POINT } from '@/chain/config'
import type { AssetStats } from '@/data/types'

/** What one mercenary brings to its division, with its gear. Mirrors the contract's formula. */
export interface UnitTotals {
  baseAtk: number
  baseDef: number
  baseMove: number
  atkMult: number
  defMult: number
  moveMult: number
  atk: number
  def: number
  move: number
}

export interface UnitParts {
  unit?: AssetStats | null
  weapon?: AssetStats | null
  supply?: AssetStats | null
  creature?: AssetStats | null
  lavalux?: AssetStats | null
}

export function unitTotals({ unit, weapon, supply, creature, lavalux }: UnitParts): UnitTotals {
  const parts = [unit, weapon, supply, creature].filter((p): p is AssetStats => !!p)
  const sum = (key: 'attack' | 'defense' | 'movecost' | 'movecost_reduction') =>
    parts.reduce((n, p) => n + Number(p[key] || 0), 0)
  const baseAtk = sum('attack')
  const baseDef = sum('defense')
  const baseMove = Math.max(0, sum('movecost') - sum('movecost_reduction'))
  const bp = (v?: number) => (v && v > 0 ? v / 10000 : 1)
  const atkMult = bp(lavalux?.attack_mult_bp)
  const defMult = bp(lavalux?.defense_mult_bp)
  const moveMult = bp(lavalux?.movecost_mult_bp)
  return {
    baseAtk,
    baseDef,
    baseMove,
    atkMult,
    defMult,
    moveMult,
    // The contract rounds down after the multiplier (integer maths), per unit: 1 538 × 1.3 is 1 999, not 2 000.
    atk: Math.floor(baseAtk * atkMult + 1e-9),
    def: Math.floor(baseDef * defMult + 1e-9),
    move: Math.floor(baseMove * moveMult + 1e-9)
  }
}

/** How long a division is locked when it joins a mission: base cooldown plus 10 s per move point. */
export const missionLockSeconds = (cooldownBaseSec: number, movecost: number) =>
  Number(cooldownBaseSec || 0) + SECONDS_PER_MOVE_POINT * Number(movecost || 0)

export type Kind = 'warlord' | 'mercenary' | 'weapon' | 'supply' | 'creature' | 'lavalux'

export function kindOfCategory(category?: number | null): Kind | null {
  switch (Number(category)) {
    case CATEGORY.WARLORD:
      return 'warlord'
    case CATEGORY.MERCENARY:
      return 'mercenary'
    case CATEGORY.WEAPON:
      return 'weapon'
    case CATEGORY.SUPPLY:
      return 'supply'
    case CATEGORY.CREATURE:
      return 'creature'
    case CATEGORY.LAVALUX:
    case CATEGORY.LAVALUX_ALT:
      return 'lavalux'
    default:
      return null
  }
}

export const kindOf = (s?: AssetStats | null) => (s ? kindOfCategory(s.category) : null)

/** The four gear slots of a mercenary, in display order. */
export const GEAR_KINDS = ['weapon', 'supply', 'creature', 'lavalux'] as const
export type GearKind = (typeof GEAR_KINDS)[number]

export const KIND_LABEL: Record<Kind, string> = {
  warlord: 'Warlord',
  mercenary: 'Mercenary',
  weapon: 'Equipment',
  supply: 'Supply',
  creature: 'Creature',
  lavalux: 'Lavalux'
}

/** A power score used to rank units and gear: what they add to attack and defense together. */
export const power = (s?: AssetStats | null) => (s ? Number(s.attack || 0) + Number(s.defense || 0) : 0)
