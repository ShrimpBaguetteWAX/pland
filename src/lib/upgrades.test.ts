import { describe, expect, it } from 'vitest'

import { rankUpgrades, type Upgrade } from './upgrades'

const up = (id: string, wax: number, tlm: number, uses: string[]) =>
  ({ id, wax, uses, gain: { tlm, atk: 0, def: 0, move: 0 } }) as unknown as Upgrade

describe('rankUpgrades', () => {
  it('puts free upgrades first, then the most gain per WAX', () => {
    const ranked = rankUpgrades([up('a', 10, 2, ['x']), up('b', 0, 1, ['y']), up('c', 2, 1, ['z'])], 'tlm', new Map())
    expect(ranked.map((r) => r.upgrade.id)).toEqual(['b', 'c', 'a'])
    expect(ranked.at(-1)).toMatchObject({ runWax: 12, runGain: 4 })
  })

  it('marks an upgrade that needs what a better one took, and leaves it out of the totals', () => {
    const ranked = rankUpgrades([up('a', 0, 2, ['wallet:1']), up('b', 0, 1, ['wallet:1'])], 'tlm', new Map())
    expect(ranked[1].instead?.id).toBe('a')
    expect(ranked[1].runGain).toBe(2)
  })

  it('lets as many upgrades share a resource as there are of it', () => {
    const cap = new Map([['slot:weapon', 2]])
    const ranked = rankUpgrades(
      [up('a', 0, 3, ['slot:weapon']), up('b', 0, 2, ['slot:weapon']), up('c', 0, 1, ['slot:weapon'])],
      'tlm',
      cap
    )
    expect(ranked.map((r) => !!r.instead)).toEqual([false, false, true])
  })
})
