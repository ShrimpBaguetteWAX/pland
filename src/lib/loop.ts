import { CONTRACTS, SHARD_POINTS_PER_UNIT } from '@/chain/config'
import type { EntryCost } from '@/chain/actions/pd'
import type { Division, MissionConfig } from '@/data/game'
import type { MissionRow } from '@/data/types'

import { parseAsset, parseMissionMeta, type MissionMeta } from './format'
import { tlmForDef, tlmForDefOut, type Market } from './market'
import { missionLockSeconds } from './stats'
import { chainDate } from './time'

/*
 * The economics of a mission for one division and one cycle (join, wait out the cooldown, claim):
 * what it costs to enter, what it pays, and what that is worth per hour of the division's time.
 * DEF is valued at what the Alcor pool really pays or charges for it (fee and price impact included),
 * so a TLM → DEF → mission → DEF → TLM loop is compared on the TLM that actually comes back.
 */

export type MissionState = 'active' | 'upcoming' | 'closed' | 'full' | 'capped'

export interface MissionEconomics {
  mission: MissionRow
  id: number
  meta: MissionMeta
  title: string
  planet: string
  image: string
  lore: string
  state: MissionState
  startAt: number
  endAt: number
  minAtk: number
  minDef: number
  cooldownBase: number
  /** Per division per cycle. */
  rewardTlm: number
  rewardDef: number
  rewardShards: number
  rewardNft: { templateId: number; count: number } | null
  costTlm: number
  costDef: number
  costs: EntryCost[]
  /** Lifetime join budget of a shard mission, when capped. */
  shardCap: { max: number; used: number } | null
  joined: number
  maxDivisions: number
}

export function missionState(m: MissionRow, config: MissionConfig, now: number): MissionState {
  const status = Number(m.status)
  const start = +chainDate(m.start)
  const end = +chainDate(m.end_base)
  if (status === 2 || (Number.isFinite(end) && end <= now && !(Number.isFinite(start) && start > now))) return 'closed'
  if (status === 0 || (Number.isFinite(start) && start > now)) return 'upcoming'
  const max = Number(m.max_divisions_total || 0)
  if (max > 0 && Number(m.divisions_joined) >= max) return 'full'
  const cap = config.shardCaps.get(Number(m.mission_id))
  if (cap && Number(cap.joins_consumed) >= Number(cap.max_joins)) return 'capped'
  return 'active'
}

export function missionEconomics(m: MissionRow, config: MissionConfig, now = Date.now()): MissionEconomics {
  const meta = parseMissionMeta(m.meta)
  const cfg = config.rewardConfigs.get(Number(m.reward_config_id))
  let rewardTlm = 0
  let rewardDef = 0
  for (const tier of cfg?.tiers ?? []) {
    const { amount, symbol } = parseAsset(tier.reward_asset)
    // Every live config has one tier at min_atk 1; a higher tier would pay the same or more, so take the max.
    if (symbol === 'TLM') rewardTlm = Math.max(rewardTlm, amount)
    if (symbol === 'DEF') rewardDef = Math.max(rewardDef, amount)
  }
  const shardRow = config.shardRewards.get(Number(m.reward_config_id))
  const rewardShards = Number(shardRow?.shard_reward || 0) / SHARD_POINTS_PER_UNIT
  const nftCount = Number(cfg?.nft_reward_count || 0)
  const rewardNft = cfg && nftCount > 0 ? { templateId: Number(cfg.nft_reward_template_id), count: nftCount } : null

  let costTlm = 0
  let costDef = 0
  const costs: EntryCost[] = []
  for (const row of config.entryCosts.get(Number(m.mission_id)) ?? []) {
    const { amount, symbol } = parseAsset(row.cost)
    if (amount <= 0) continue
    if (symbol === 'TLM') costTlm += amount
    if (symbol === 'DEF') costDef += amount
    costs.push({ contract: symbol === 'DEF' ? CONTRACTS.DEF : CONTRACTS.TLM, quantity: row.cost })
  }
  const cap = config.shardCaps.get(Number(m.mission_id))

  return {
    mission: m,
    id: Number(m.mission_id),
    meta,
    title: meta.title || meta.name || `Mission #${m.mission_id}`,
    planet: String(meta.planet || '').toLowerCase(),
    image: meta.image || '',
    lore: meta.lore || meta.description || '',
    state: missionState(m, config, now),
    startAt: +chainDate(m.start),
    endAt: +chainDate(m.end_base),
    minAtk: Number(m.min_div_attack || 0),
    minDef: Number(m.min_div_defense || 0),
    cooldownBase: Number(m.cooldown_base_sec || 0),
    rewardTlm,
    rewardDef,
    rewardShards,
    rewardNft,
    costTlm,
    costDef,
    costs,
    shardCap: cap ? { max: Number(cap.max_joins), used: Number(cap.joins_consumed) } : null,
    joined: Number(m.divisions_joined || 0),
    maxDivisions: Number(m.max_divisions_total || 0)
  }
}

/**
 * One cycle as a TLM-in, TLM-out route through the Alcor pool: the DEF the entry needs beyond what
 * the reward pays back is bought with TLM, the DEF the reward pays beyond the entry is sold for TLM.
 * DEF that comes in and goes out again is never swapped, so no fee is paid twice.
 */
export interface CycleRoute {
  /** DEF to buy with TLM per cycle (0 if the loop pays its own DEF). */
  buyDef: number
  buyTlm: number
  /** DEF left over to sell for TLM per cycle. */
  sellDef: number
  sellTlm: number
  /** TLM out of pocket per cycle: entry in TLM plus the DEF purchase. */
  tlmIn: number
  /** TLM back per cycle: TLM reward plus the DEF sale. */
  tlmOut: number
  net: number
}

export function cycleRoute(e: MissionEconomics, m: Market): CycleRoute {
  const netDef = e.rewardDef - e.costDef
  const buyDef = netDef < 0 ? -netDef : 0
  const sellDef = netDef > 0 ? netDef : 0
  const buyTlm = tlmForDefOut(m, buyDef)
  const sellTlm = tlmForDef(m, sellDef)
  const tlmIn = e.costTlm + buyTlm
  const tlmOut = e.rewardTlm + sellTlm
  return { buyDef, buyTlm, sellDef, sellTlm, tlmIn, tlmOut, net: tlmOut - tlmIn }
}

export const cycleCost = (e: MissionEconomics, m: Market) => cycleRoute(e, m).tlmIn
export const cycleNet = (e: MissionEconomics, m: Market) => cycleRoute(e, m).net

/** Seconds a division with this move cost is locked per cycle. */
export const cycleSeconds = (e: MissionEconomics, move: number) => missionLockSeconds(e.cooldownBase, move)

/** Net TLM per hour of a division's time, after swaps. */
export function tlmPerHour(e: MissionEconomics, move: number, m: Market): number {
  const seconds = cycleSeconds(e, move)
  return seconds > 0 ? (cycleNet(e, m) / seconds) * 3600 : 0
}

/** Return on the TLM put in per cycle; Infinity when nothing goes in and something comes out. */
export function cycleRoi(e: MissionEconomics, m: Market): number {
  const r = cycleRoute(e, m)
  if (r.tlmIn <= 0) return r.tlmOut > 0 ? Infinity : 0
  return r.tlmOut / r.tlmIn - 1
}

/** Whether the mission pays anything that converts to TLM (as opposed to shards or NFTs only). */
export const isTokenLoop = (e: MissionEconomics) => e.rewardTlm + e.rewardDef > 0

export const meetsRequirements = (e: MissionEconomics, atk: number, def: number) => atk >= e.minAtk && def >= e.minDef

/** Whether a division can be sent right now: idle and up to the mission's requirements. */
export const canDeploy = (e: MissionEconomics, d: Division) =>
  e.state === 'active' && meetsRequirements(e, d.atk, d.def) && !d.lock

export interface PlanLine {
  division: Division
  mission: MissionEconomics
  perHour: number
  net: number
  seconds: number
}

/**
 * The best TLM loop for each idle division: the mission that pays the most per hour of its time.
 * Divisions that would lose TLM everywhere are left out (a shard or NFT mission may still be
 * worth it to the player, but it is not a TLM loop).
 */
export function planLoops(divisions: Division[], missions: MissionEconomics[], m: Market): PlanLine[] {
  const lines: PlanLine[] = []
  for (const division of divisions) {
    if (division.lock) continue
    let best: PlanLine | null = null
    for (const mission of missions) {
      if (!canDeploy(mission, division) || !isTokenLoop(mission)) continue
      const perHour = tlmPerHour(mission, division.move, m)
      if (perHour <= 0) continue
      if (!best || perHour > best.perHour) {
        best = { division, mission, perHour, net: cycleNet(mission, m), seconds: cycleSeconds(mission, division.move) }
      }
    }
    if (best) lines.push(best)
  }
  return lines.sort((a, b) => b.perHour - a.perHour)
}

/** Reward text, e.g. "300 TLM", "100 DEF", "2× Quantum Chest", "300 shards". */
export function rewardParts(e: MissionEconomics, nftName?: string): string[] {
  const parts: string[] = []
  if (e.rewardTlm > 0) parts.push(`${trim(e.rewardTlm)} TLM`)
  if (e.rewardDef > 0) parts.push(`${trim(e.rewardDef)} DEF`)
  if (e.rewardNft) parts.push(`${e.rewardNft.count}× ${nftName ?? 'NFT'}`)
  if (e.rewardShards > 0) parts.push(`${trim(e.rewardShards)} shards`)
  return parts
}

export function costParts(e: MissionEconomics): string[] {
  const parts: string[] = []
  if (e.costTlm > 0) parts.push(`${trim(e.costTlm)} TLM`)
  if (e.costDef > 0) parts.push(`${trim(e.costDef)} DEF`)
  return parts
}

const trim = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))))
