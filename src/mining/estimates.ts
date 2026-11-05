import { chainDate } from '@/lib/time'

import type { EquippedTool, FavoriteLand, LandType, MiningMode } from './types'

/*
 * Alien Worlds mining arithmetic, as WAX Mission Control does it: when the bag can mine again,
 * what a mine should pay on a land, and which favourite land the Mine button picks.
 */

/**
 * When the equipped bag can mine again: the land's delay attribute (10 = 1x) scales the tool delays,
 * where only the slowest tool counts fully, the second counts half with two tools and fully with three.
 */
export function mineReadyAt(landDelay: number | undefined, tools: EquippedTool[] | undefined, lastMine?: string): number {
  const multiplier = (landDelay ?? 0) / 10
  const delays = (tools ?? []).map((tool) => tool.delay ?? 0).sort((a, b) => b - a)

  let seconds = 0
  if (delays.length === 1) seconds = multiplier * delays[0]
  else if (delays.length === 2) seconds = multiplier * (delays[0] + delays[1] / 2)
  else if (delays.length >= 3) seconds = multiplier * (delays[0] + delays[1])

  const lastToolUse = Math.max(0, ...(tools ?? []).map((tool) => (tool.last_use ?? 0) * 1000))
  const lastMineAt = lastMine ? +chainDate(lastMine) : 0
  const last = Math.max(lastToolUse, Number.isFinite(lastMineAt) ? lastMineAt : 0)

  return last + seconds * 1000
}

/** Mining power per rarity across the equipped tools. */
export function miningPowerByRarity(tools: EquippedTool[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const tool of tools ?? []) out[tool.rarity] = (out[tool.rarity] ?? 0) + Number(tool.mining_power ?? 0)
  return out
}

/** Expected TLM per mine before commission: each rarity share is capped at 80% of that planet's pool bucket. */
export function estimateTlm(
  powerByRarity: Record<string, number>,
  landMiningPowerMod: number,
  pools: Record<string, number> | undefined
) {
  if (!pools) return 0
  return Object.entries(powerByRarity).reduce((sum, [rarity, power]) => {
    const share = Math.min(0.8, (power * landMiningPowerMod) / 10000)
    return sum + share * (pools[rarity] ?? 0)
  }, 0)
}

/** Commission is never below the planet minimum. Both are fractions. */
export const effectiveCommission = (landCommission: number, planetMin: number) => Math.max(landCommission, planetMin)

export function estimateShards(tools: EquippedTool[] | undefined, landType: LandType | undefined) {
  const nftPower = (tools ?? []).reduce((sum, tool) => sum + Number(tool.nft_power ?? 0), 0)
  return (nftPower * (landType?.nft_power_mod ?? 0)) / 100
}

/** What the mode ranks lands by. */
const valueOf = (land: FavoriteLand, mode: MiningMode) => (mode === 'tlm' ? land.estimatedTlm : land.shards)
const otherOf = (land: FavoriteLand, mode: MiningMode) => (mode === 'tlm' ? land.shards : land.estimatedTlm)

/** The favourite land to mine next: ready lands first, then by TLM or by shards, the other as tie-break. */
export function pickFavoriteLand(lands: FavoriteLand[], readyAt: (land: FavoriteLand) => number, mode: MiningMode, now: number) {
  if (lands.length === 0) return null
  let pool = lands.filter((land) => readyAt(land) <= now)
  if (pool.length === 0) {
    const soonest = Math.min(...lands.map(readyAt))
    pool = lands.filter((land) => readyAt(land) === soonest)
  }
  return [...pool].sort((a, b) => valueOf(b, mode) - valueOf(a, mode) || otherOf(b, mode) - otherOf(a, mode))[0]
}

/** Below this, a land pays the same for all the player can see, so it is no upgrade. */
const UPGRADE_EPSILON = 1e-4

/**
 * The favourite land the Mine button moves up to once it comes off cooldown: one that pays more than
 * the land it would pick now, the soonest such. Null when nothing cooling beats the current pick, and
 * while mining is still on cooldown, where the button's own countdown is all that matters.
 */
export function nextFavoriteUpgrade(
  lands: FavoriteLand[],
  readyAt: (land: FavoriteLand) => number,
  mode: MiningMode,
  now: number
): { land: FavoriteLand; at: number } | null {
  const current = pickFavoriteLand(lands, readyAt, mode, now)
  if (!current || readyAt(current) > now) return null
  const currentValue = valueOf(current, mode)
  const better = lands
    .filter((land) => readyAt(land) > now && valueOf(land, mode) - currentValue >= UPGRADE_EPSILON)
    .map((land) => ({ land, at: readyAt(land) }))
    .sort((a, b) => a.at - b.at || valueOf(b.land, mode) - valueOf(a.land, mode))
  return better[0] ?? null
}
