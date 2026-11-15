import type { AnyAction } from '@wharfkit/session'

import { ascendAction } from '@/chain/actions/ascend'
import { addUnit, assignGear, createDivision, deleteDivision, removeUnit, stakeAssets, unassignGear, unstakeAsset } from '@/chain/actions/pd'
import { atomic } from '@/chain/atomic'
import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'
import type { AssetRef } from '@/data/assets'
import type { Army, Division, Unit } from '@/data/game'
import type { DivisionRow } from '@/data/types'
import { sleep } from '@/lib/format'
import { GEAR_KINDS, type GearKind } from '@/lib/stats'

/*
 * Ascending a card wherever it is, and putting the new star back in the same place. ascend.pdef
 * takes cards from the wallet only, and it mints the new card when it runs, so the new asset id is
 * known only after the ascension landed. So it is a short sequence, signed one after another:
 *
 *   1. out of the game: gear off, mercenaries out, the division deleted (for a warlord), unstaked
 *   2. the ascension itself: the card and its Fragments to ascend.pdef
 *   3. the new card found in the wallet, staked and put back: on the same mercenary, as the same
 *      mercenary with its gear, in the reserve, or leading a new division
 *   4. a warlord only: the division's mercenaries and their gear back in, once its number is known
 *
 * A card in the wallet is step 2 alone.
 */

export type Place =
  | { at: 'leader'; division: Division }
  | { at: 'unit'; division: Division; unit: Unit }
  | { at: 'gear'; division: Division; unit: Unit; kind: GearKind }
  | { at: 'reserve' }
  | { at: 'wallet' }

export function locateAsset(army: Army | undefined, assetId: string): Place {
  for (const d of army?.divisions ?? []) {
    if (d.leader?.assetId === assetId) return { at: 'leader', division: d }
    for (const u of d.units) {
      if (u.asset.assetId === assetId) return { at: 'unit', division: d, unit: u }
      const kind = GEAR_KINDS.find((k) => u.gear[k]?.assetId === assetId)
      if (kind) return { at: 'gear', division: d, unit: u, kind }
    }
  }
  return army?.assets.has(assetId) ? { at: 'reserve' } : { at: 'wallet' }
}

/** The division a place is in, if any. */
export const divisionOf = (place: Place): Division | null => ('division' in place ? place.division : null)

/** "leads #12", "in #12", "on Gunslinger in #12", "in the reserve", "in the wallet". */
export function placeText(place: Place): string {
  switch (place.at) {
    case 'leader':
      return `leads #${place.division.id}`
    case 'unit':
      return `in #${place.division.id}`
    case 'gear':
      return `on ${place.unit.asset.name} in #${place.division.id}`
    case 'reserve':
      return 'staked, in the reserve'
    default:
      return 'in the wallet'
  }
}

const unitOut = (a: string, p: string, d: Division, u: Unit): AnyAction[] => [
  ...GEAR_KINDS.filter((k) => u.gear[k]).map((k) => unassignGear(a, p, d.id, u.asset.assetId, u.gear[k]!.assetId)),
  removeUnit(a, p, u.asset.assetId)
]

/** A mercenary back into a division with the gear it had (the gear waited in the reserve). */
const unitIn = (a: string, p: string, divisionId: number, mercId: string, gear: Unit['gear']): AnyAction[] => [
  addUnit(a, p, divisionId, mercId),
  ...GEAR_KINDS.filter((k) => gear[k]).map((k) => assignGear(a, p, divisionId, mercId, k, gear[k]!.assetId))
]

function takeOut(a: string, p: string, place: Place, card: AssetRef): AnyAction[] {
  switch (place.at) {
    case 'gear':
      return [unassignGear(a, p, place.division.id, place.unit.asset.assetId, card.assetId), unstakeAsset(a, p, card.assetId)]
    case 'unit':
      return [...unitOut(a, p, place.division, place.unit), unstakeAsset(a, p, card.assetId)]
    case 'leader':
      return [
        ...place.division.units.flatMap((u) => unitOut(a, p, place.division, u)),
        deleteDivision(a, p, card.assetId),
        unstakeAsset(a, p, card.assetId)
      ]
    case 'reserve':
      return [unstakeAsset(a, p, card.assetId)]
    default:
      return []
  }
}

/** Ids of the cards of a template in the wallet right now. */
async function walletIdsOf(owner: string, templateId: string): Promise<Set<string>> {
  const assets = await atomic.getOwnedAssets(owner, 'planetdefnft').catch(() => [])
  return new Set(assets.filter((x) => String(x.template?.template_id) === templateId).map((x) => x.asset_id))
}

/** The card ascend.pdef just minted: a card of the new template that was not in the wallet before. */
async function findMinted(owner: string, templateId: string, before: Set<string>): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const now = await walletIdsOf(owner, templateId)
    const fresh = [...now].filter((id) => !before.has(id)).sort((x, y) => (BigInt(y) > BigInt(x) ? 1 : -1))
    if (fresh.length) return fresh[0]
    await sleep(3000)
  }
  throw new Error('The new card did not show up in the wallet yet. It is there, in your wallet: stake it and put it back on the Divisions page')
}

async function findDivision(owner: string, leaderId: string): Promise<number> {
  for (let i = 0; i < 12; i++) {
    const rows = await getRows<DivisionRow>({ code: CONTRACTS.CORE, table: 'divisions', scope: owner }).catch(() => [] as DivisionRow[])
    const row = rows.find((r) => String(r.leader_asset_id) === leaderId)
    if (row) return Number(row.division_id)
    await sleep(1500)
  }
  throw new Error('The new division did not show up yet. Put its mercenaries back on the Divisions page')
}

export interface Part {
  build: (a: string, p: string) => AnyAction[] | AnyAction | Promise<AnyAction[] | AnyAction>
  success: string
  settle?: boolean
}

/** The whole sequence for one card: see the top of this file. */
export function ascendInPlaceParts(card: AssetRef, place: Place, toTemplate: string, fragmentIds: string[], starLabel: string): Part[] {
  const parts: Part[] = []
  const staked = place.at !== 'wallet'
  if (staked) parts.push({ build: (a, p) => takeOut(a, p, place, card), success: `${card.name} is out of the game`, settle: true })

  // Read just before the ascension, so the card it mints is the one id that is new afterwards.
  let before = new Set<string>()
  parts.push({
    build: async (a, p) => {
      if (staked) before = await walletIdsOf(a, toTemplate)
      return ascendAction(a, p, card.assetId, fragmentIds)
    },
    success: `${card.name} ascended to ${starLabel}`,
    settle: staked
  })
  if (!staked) return parts

  let minted = ''
  parts.push({
    build: async (a, p) => {
      minted = await findMinted(a, toTemplate, before)
      const stake = stakeAssets(a, p, [minted])
      switch (place.at) {
        case 'gear':
          return [stake, assignGear(a, p, place.division.id, place.unit.asset.assetId, place.kind, minted)]
        case 'unit':
          return [stake, ...unitIn(a, p, place.division.id, minted, place.unit.gear)]
        case 'leader':
          return [stake, createDivision(a, p, minted)]
        default:
          return [stake]
      }
    },
    success: place.at === 'leader' ? `${card.name} leads a division again` : `${card.name} is back ${placeText(place)}`,
    settle: place.at === 'leader'
  })
  if (place.at === 'leader' && place.division.units.length) {
    const units = place.division.units
    parts.push({
      build: async (a, p) => {
        const id = await findDivision(a, minted)
        return units.flatMap((u) => unitIn(a, p, id, u.asset.assetId, u.gear))
      },
      success: `The division is back together: ${units.length} mercenar${units.length === 1 ? 'y' : 'ies'} and their gear`
    })
  }
  return parts
}
