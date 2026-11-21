import { useCallback, useMemo } from 'react'

import type { Division } from '@/data/game'
import { useMarket } from '@/data/game'
import { useNftFloors, useSwapPools } from '@/data/market'
import { useNanitePrice } from '@/data/nanites'

import { formatNumber } from './format'
import { cycleSeconds, isTokenLoop, tlmPerHour, type MissionEconomics } from './loop'
import { receiveFor } from './pool'

/*
 * The efficiency score of a mission, shared by the Missions page and couch mode's Missions page:
 * net TLM per hour for every 100 points of the strength the mission asks for (attack, or defense
 * when it asks for more of that), for a division carrying the move this army carries per 100
 * strength. NFT rewards count at their floor, swapped to TLM; the repair a cycle wears is taken off
 * at the cheapest nanite. Shard-only missions get their own score, in shards.
 */

const MOVE_DEFAULT = 40
const MOVE_MAX = 100

/**
 * What a cycle's repair costs, in TLM: every join wears the division down by the mission's attack
 * plus defense requirement, a nanite restores points_per_nanite of it, and the nanite is priced at
 * the cheapest one on the market (the refinery material with the lowest listing per nanite), as TLM
 * through the WAX → TLM pool. 0 before the price is known. Shared by the efficiency score, the TLM / h
 * figures and the optimizer.
 */
export function useRepairTlm() {
  const pools = useSwapPools()
  const nanite = useNanitePrice()
  const repairTlm = useMemo(() => {
    const tlmPool = pools.data?.tlm
    const ppn = nanite.config?.pointsPerNanite ?? 0
    const wpn = nanite.price?.waxPerNanite
    return (e: MissionEconomics): number => (tlmPool && ppn > 0 && wpn ? receiveFor(tlmPool, 'WAX', ((e.minAtk + e.minDef) / ppn) * wpn) : 0)
  }, [pools.data, nanite.config, nanite.price])
  return { repairTlm, nanite }
}

/** TLM an hour a division earns on a mission at its move, the repair taken off. */
export const netPerHour = (perHour: number, repair: number, seconds: number) => (seconds > 0 ? perHour - (repair / seconds) * 3600 : perHour)

export function useMissionScores(divisions: Division[], missions: MissionEconomics[]) {
  const market = useMarket()
  // How much move the army carries for its strength: what the efficiency score assumes.
  const movePer100 = useMemo(() => {
    const strength = divisions.reduce((n, d) => n + Math.max(d.atk, d.def), 0)
    return strength > 0 ? Math.min(MOVE_MAX, Math.round((divisions.reduce((n, d) => n + d.move, 0) / strength) * 100)) : MOVE_DEFAULT
  }, [divisions])

  // NFT rewards are valued at the floor (the cheapest WAX listing of the template), then as TLM
  // through the WAX → TLM pool, so NFT missions get an efficiency too.
  const pools = useSwapPools()
  const nftIds = useMemo(() => missions.flatMap((e) => (e.rewardNft ? [String(e.rewardNft.templateId)] : [])), [missions])
  const floors = useNftFloors(nftIds)
  /** The TLM a mission's NFT reward is worth per cycle; 0 without one, null while its floor is unknown. */
  const nftTlm = useMemo(() => {
    const tlmPool = pools.data?.tlm
    return (e: MissionEconomics): number | null => {
      if (!e.rewardNft) return 0
      const wax = floors.data?.get(String(e.rewardNft.templateId))
      if (wax === undefined || !tlmPool) return null
      return receiveFor(tlmPool, 'WAX', wax * e.rewardNft.count)
    }
  }, [floors.data, pools.data])

  // The repair a cycle wears, in TLM (see useRepairTlm).
  const { repairTlm, nanite } = useRepairTlm()
  /** The repair, for the efficiency tooltip. */
  const repairNote = (e: MissionEconomics): string | undefined => {
    const ppn = nanite.config?.pointsPerNanite
    if (!ppn || !nanite.price) return nanite.config ? undefined : 'Reading the nanite refinery…'
    const n = (e.minAtk + e.minDef) / ppn
    return `Repair counted: ${formatNumber(e.minAtk + e.minDef, 0)} wear a cycle = ${formatNumber(n, 2)} nanites at ${formatNumber(nanite.price.waxPerNanite, 2)} WAX each (the cheapest refinery material) ≈ ${formatNumber(repairTlm(e), 1)} TLM`
  }

  /** How an NFT reward was valued, for the efficiency tooltip. */
  const nftNote = (e: MissionEconomics): string | undefined => {
    if (!e.rewardNft) return undefined
    const wax = floors.data?.get(String(e.rewardNft.templateId))
    const tlm = nftTlm(e)
    if (wax === undefined || tlm === null) return floors.isLoading ? 'Reading the NFT floor…' : 'The NFT has no listing, so it is not counted'
    return `The NFT counts at its floor: ${formatNumber(wax, 2)} WAX${e.rewardNft.count > 1 ? ` each, ×${e.rewardNft.count}` : ''} ≈ ${formatNumber(tlm, 1)} TLM a cycle (the cheapest listing, before market fees)`
  }

  /** The mission's score: TLM / h per 100 strength asked (null when it pays no TLM, DEF or priced NFT), or shards / h per 100 for shard-only ones. */
  const score = useCallback(
    (e: MissionEconomics): { efficiency: number | null; shardEff: number | null } => {
        const need = Math.max(e.minAtk, e.minDef)
        const assumed = Math.round((need * movePer100) / 100)
        // Tokens after swaps, plus the NFT at its floor when it has one; an NFT-only mission waits for its floor.
        const nft = nftTlm(e)
        const nftPerHour = nft && cycleSeconds(e, assumed) > 0 ? (nft / cycleSeconds(e, assumed)) * 3600 : 0
        const repairPerHour = cycleSeconds(e, assumed) > 0 ? (repairTlm(e) / cycleSeconds(e, assumed)) * 3600 : 0
        const efficiency = need > 0 && (isTokenLoop(e) || nft !== null && nft > 0) ? ((tlmPerHour(e, assumed, market) + nftPerHour - repairPerHour) / need) * 100 : null
        // Shards have no price: a shard-only mission gets its own score, in shards.
        const cycle = cycleSeconds(e, assumed)
        const shardEff = efficiency === null && need > 0 && e.rewardShards > 0 && cycle > 0 ? ((e.rewardShards / cycle) * 3600 * 100) / need : null
      return { efficiency, shardEff }
    },
    [market, movePer100, nftTlm, repairTlm]
  )
  return { movePer100, score, nftNote, repairNote, repairTlm }
}
