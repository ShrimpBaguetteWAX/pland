import { describe, expect, it } from 'vitest'
import type { AnyAction } from '@wharfkit/session'

import { CATEGORY } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import type { Division } from '@/data/game'

import { diffArmy } from './armyDiff'
import { planRestore, snapshot, type Preset } from './armyPresets'
import type { PlannedDivision } from './armySearch'

let next = 1
const nft = (category: number, name: string): AssetRef => {
  const id = String(next++)
  return {
    assetId: id,
    templateId: `t${id}`,
    schema: 'x',
    name,
    rarity: 'common',
    img: '',
    info: null,
    stats: {
      template_id: next,
      category,
      attack: 10,
      defense: 10,
      movecost: 5,
      movecost_reduction: 0,
      slots_max: 5,
      attack_mult_bp: 10000,
      defense_mult_bp: 10000,
      movecost_mult_bp: 10000,
      min_forge_level: 0,
      image: ''
    }
  }
}
const division = (id: number, leader: AssetRef, units: { asset: AssetRef; gear?: Partial<Record<'weapon' | 'supply' | 'creature' | 'lavalux', AssetRef>> }[]): Division =>
  ({ id, leader, units: units.map((u) => ({ asset: u.asset, gear: u.gear ?? {} })), slotsMax: 5, atk: 0, def: 0, move: 0 }) as unknown as Division
const target = (warlord: AssetRef, units: { merc: AssetRef; gear?: PlannedDivision['units'][number]['gear'] }[], unchanged = false): PlannedDivision => ({
  warlord,
  units: units.map((u) => ({ merc: u.merc, gear: u.gear ?? {}, atk: 0, def: 0, move: 0 })),
  mission: null as never,
  atk: 0,
  def: 0,
  move: 0,
  pace: 0,
  perHour: 0,
  unchanged
})
const names = (actions: AnyAction[]) => actions.map((a) => String(a.name))

describe('diffArmy', () => {
  const w1 = nft(CATEGORY.WARLORD, 'W1')
  const w2 = nft(CATEGORY.WARLORD, 'W2')
  const m1 = nft(CATEGORY.MERCENARY, 'M1')
  const m2 = nft(CATEGORY.MERCENARY, 'M2')
  const m3 = nft(CATEGORY.MERCENARY, 'M3')
  const g1 = nft(CATEGORY.WEAPON, 'G1')
  const g2 = nft(CATEGORY.WEAPON, 'G2')

  it('signs nothing for a division that already stands as planned', () => {
    const now = [division(1, w1, [{ asset: m1, gear: { weapon: g1 } }, { asset: m2 }])]
    const d = diffArmy(now, [target(w1, [{ merc: m1, gear: { weapon: g1 } }, { merc: m2 }])])
    expect(d.disband).toEqual([])
    expect(d.create).toEqual([])
    expect(d.counts).toEqual({ free: 0, fill: 0 })
  })

  it('adjusts a kept division: a gear swap and a mercenary moving out, in order', () => {
    const now = [division(1, w1, [{ asset: m1, gear: { weapon: g1 } }, { asset: m2 }])]
    const d = diffArmy(now, [target(w1, [{ merc: m1, gear: { weapon: g2 } }])])
    expect(d.disband).toEqual([])
    expect(d.create).toEqual([])
    expect(names(d.free('a', 'p'))).toEqual(['unassign', 'removeunit'])
    expect(names(d.fill('a', 'p', () => 1))).toEqual(['assign'])
  })

  it('takes a division apart and raises another when the warlord changes, mercenaries following', () => {
    const now = [division(1, w1, [{ asset: m1 }, { asset: m2 }])]
    const d = diffArmy(now, [target(w2, [{ merc: m1 }, { merc: m3 }])])
    expect(d.disband.map((x) => x.id)).toEqual([1])
    expect(d.create).toEqual([w2.assetId])
    // Both mercenaries leave the old division (it is deleted), then the new one takes its two.
    expect(names(d.free('a', 'p'))).toEqual(['removeunit', 'removeunit', 'deldvasset'])
    const fill = d.fill('a', 'p', (l) => (l === w2.assetId ? 7 : undefined))
    expect(names(fill)).toEqual(['addunit', 'addunit'])
    expect(fill.every((a) => (a.data as { division_id: number }).division_id === 7)).toBe(true)
  })

  it('moves gear between divisions with every mercenary in place before any gear goes on', () => {
    const now = [division(1, w1, [{ asset: m1, gear: { weapon: g1 } }]), division(2, w2, [{ asset: m2 }])]
    const d = diffArmy(now, [target(w1, [{ merc: m1 }]), target(w2, [{ merc: m2, gear: { weapon: g1 } }, { merc: m3 }])])
    expect(names(d.free('a', 'p'))).toEqual(['unassign'])
    expect(names(d.fill('a', 'p', (l) => (l === w1.assetId ? 1 : 2)))).toEqual(['addunit', 'assign'])
  })
})

describe('restoring a preset through the diff', () => {
  const w1 = nft(CATEGORY.WARLORD, 'W1')
  const w2 = nft(CATEGORY.WARLORD, 'W2')
  const m1 = nft(CATEGORY.MERCENARY, 'M1')
  const m2 = nft(CATEGORY.MERCENARY, 'M2')
  const m3 = nft(CATEGORY.MERCENARY, 'M3')
  const g1 = nft(CATEGORY.WEAPON, 'G1')
  const free = { warlord: [w2], mercenary: [m3], weapon: [], supply: [], creature: [], lavalux: [] }

  it('keeps what matches, leaves out what a division that is out holds, and says so', () => {
    const saved: Preset = {
      id: 'p',
      name: 'p',
      savedAt: 0,
      divisions: snapshot([division(1, w1, [{ asset: m1, gear: { weapon: g1 } }]), division(2, w2, [{ asset: m2 }, { asset: m3 }])])
    }
    // Now: #1 as saved; m2 sits in #9, which is out; w2 leads nothing.
    const now = [division(1, w1, [{ asset: m1, gear: { weapon: g1 } }]), division(9, nft(CATEGORY.WARLORD, 'W9'), [{ asset: m2 }])]
    const plan = planRestore(saved, now, free, (d) => d.id !== 9)
    expect(plan.keep.map((d) => d.id)).toEqual([1])
    expect(plan.locked.map((d) => d.id)).toEqual([9])
    expect(plan.build).toEqual([{ leader: w2.assetId, units: [{ merc: m3.assetId, gear: {} }] }])
    expect(plan.held).toEqual([m2.assetId])
  })
})
