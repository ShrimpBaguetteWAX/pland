import { useMemo } from 'react'

import type { AnyAction } from '@wharfkit/session'

import { claimMission, deployActions } from '@/chain/actions/pd'
import {
  freshMarket,
  useArmy,
  useDeployments,
  useGameBalance,
  useMarket,
  useMissionConfig,
  usePlayer,
  type Deployment
} from '@/data/game'
import { coveredBy, walletCosts, walletPart } from '@/lib/deposit'
import { missionEconomics, planLoops, type MissionEconomics, type PlanLine } from '@/lib/loop'
import { fundEntries, quoteFunding, sellDefAction, tlmForDef } from '@/lib/market'
import { chainDate, useClockFor } from '@/lib/time'

/*
 * The claim-and-redeploy loop, shared by the Deployments page and the top bar's loop button:
 * which divisions are back, which can go straight out again, when the next one returns, and the
 * transactions that claim the rewards and send them back out.
 */

/** Remembers whether claimed DEF is sold for TLM right away. */
export const CASH_OUT_KEY = 'pd.cash-out-def'

export function readCashOut(): boolean {
  try {
    return localStorage.getItem(CASH_OUT_KEY) === '1'
  } catch {
    return false
  }
}

export interface LoopPart {
  build: (a: string, p: string) => AnyAction[] | Promise<AnyAction[]>
  success: string
  /** The next transaction depends on this one (it frees the divisions): wait for it to go through. */
  settle?: boolean
}

export function useLoopPlan(account: string | null, cashOut: boolean) {
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const army = useArmy(account)
  const player = usePlayer(account)
  const market = useMarket()
  const game = useGameBalance(account)

  // Re-render as each division's cooldown ends.
  const unlocks = useMemo(() => deployments.data?.map((d) => d.unlockAt) ?? [], [deployments.data])
  const now = useClockFor(unlocks)

  const econ = useMemo(() => {
    const m = new Map<number, MissionEconomics>()
    if (config.data)
      for (const row of config.data.missions) m.set(Number(row.mission_id), missionEconomics(row, config.data, now))
    return m
  }, [config.data, now])

  const divisionById = useMemo(() => new Map(army.data?.divisions.map((d) => [d.id, d]) ?? []), [army.data])

  const list = deployments.data ?? []
  const ready = list.filter((d) => d.unlockAt <= now)
  const running = list.filter((d) => d.unlockAt > now)
  /** Ready deployments whose mission is still open, so the division can go straight back out. */
  const loopable = ready.filter((d) => econ.get(d.missionId)?.state === 'active')
  const nextReturnAt = running.length ? Math.min(...running.map((d) => d.unlockAt)) : null
  const wallet = player.data ? { tlm: player.data.tlm, def: player.data.def } : null

  /**
   * Divisions with units that are neither on a mission nor locked, each with the TLM loop that pays
   * the most per hour (`line`); a division no open mission pays TLM for has none.
   */
  const idle = useMemo(() => {
    // Until the deployments are in, no division counts as idle (they might all be out).
    if (!deployments.data) return []
    const out = new Set(deployments.data.map((d) => d.divisionId))
    const free = (army.data?.divisions ?? [])
      .filter((d) => d.units.length > 0 && !out.has(d.id) && !(d.lock && +chainDate(d.lock.locked_until) > now))
      // A lock that has run out no longer holds the division back.
      .map((d) => (d.lock ? { ...d, lock: null } : d))
    const lines = new Map(planLoops(free, [...econ.values()], market).map((l) => [l.division.id, l]))
    return free.map((division) => ({ division, line: lines.get(division.id) ?? null }))
  }, [army.data, deployments.data, now, econ, market])

  /**
   * Claims `claims` and sends `redeploy` back out. The claims, the DEF purchase and the cash-out
   * go in the first transaction; the claimed TLM and DEF land before the next action runs, so they
   * pay the new entries. The contract takes one join per transaction, so the first division sent
   * back out goes with the claims and every further one is a transaction of its own. The swaps
   * are built from a pool quote read at signing time, so their minimum output is current.
   */
  function cycle(claims: Deployment[], redeploy: Deployment[]) {
    const sum = (items: Deployment[], f: (e: MissionEconomics) => number) =>
      items.reduce((n, d) => n + (econ.get(d.missionId) ? f(econ.get(d.missionId)!) : 0), 0)
    const earnedTlm = sum(claims, (e) => e.rewardTlm)
    const earnedDef = sum(claims, (e) => e.rewardDef)
    const entries = { tlm: sum(redeploy, (e) => e.costTlm), def: sum(redeploy, (e) => e.costDef) }
    // Entry fees the game balance covers are left to the contract to take from it: no transfer, no swap.
    const fromDeposit = coveredBy(entries, game.data)
    const cost = walletPart(entries, fromDeposit)
    const after = wallet ? { tlm: wallet.tlm + earnedTlm, def: wallet.def + earnedDef } : null
    const funding = quoteFunding(market, cost, after)
    const surplusDef = cashOut ? Math.max(0, earnedDef - cost.def) : 0
    const sold = surplusDef > 0 ? tlmForDef(market, surplusDef) : 0
    const head = async (a: string, p: string) => {
      const m = await freshMarket(market)
      return [
        ...claims.map((d) => claimMission(a, p, d.missionId, d.divisionId)),
        ...fundEntries(a, p, m, cost, after).actions,
        ...(surplusDef > 0 ? [sellDefAction(a, p, m, surplusDef).action] : [])
      ]
    }
    const out = (a: string, p: string, x: Deployment) =>
      deployActions(
        a,
        p,
        x.missionId,
        x.divisionId,
        !!divisionById.get(x.divisionId) && !divisionById.get(x.divisionId)!.fresh,
        walletCosts(econ.get(x.missionId)!.costs, fromDeposit)
      )
    const [first, ...rest] = redeploy
    const parts: LoopPart[] = [
      {
        build: async (a, p) => [...(await head(a, p)), ...(first ? out(a, p, first) : [])],
        // The claims free the divisions the joins after it send out.
        settle: true,
        success: !first
          ? `${claims.length} claimed`
          : rest.length
            ? `${claims.length} claimed, #${first.divisionId} sent back out`
            : `#${first.divisionId} claimed and redeployed`
      },
      ...rest.map((x) => ({
        build: (a: string, p: string) => out(a, p, x),
        success: `#${x.divisionId} sent back to ${econ.get(x.missionId)?.title ?? 'its mission'}`
      }))
    ]
    return { parts, build: parts[0].build, funding, fromDeposit, surplusDef, sold, earnedTlm, earnedDef }
  }

  /**
   * Sends idle divisions out, each to its own mission: one transaction per division (the contract
   * takes one join each), the first also buying the DEF all the entries need.
   */
  function deploy(lines: PlanLine[]) {
    const entries = {
      tlm: lines.reduce((n, l) => n + l.mission.costTlm, 0),
      def: lines.reduce((n, l) => n + l.mission.costDef, 0)
    }
    const fromDeposit = coveredBy(entries, game.data)
    const cost = walletPart(entries, fromDeposit)
    const funding = quoteFunding(market, cost, wallet)
    const parts: LoopPart[] = lines.map((l, i) => ({
      build: async (a: string, p: string) => [
        ...(i === 0 ? fundEntries(a, p, await freshMarket(market), cost, wallet).actions : []),
        ...deployActions(a, p, l.mission.id, l.division.id, !l.division.fresh, walletCosts(l.mission.costs, fromDeposit))
      ],
      success: `#${l.division.id} sent to ${l.mission.title}`,
      settle: i === 0
    }))
    return { parts, funding }
  }

  return {
    loaded: !!deployments.data && !!config.data,
    loading: deployments.isLoading || config.isLoading,
    deployments: list,
    ready,
    running,
    loopable,
    nextReturnAt,
    now,
    econ,
    divisionById,
    market,
    idle,
    cycle,
    deploy
  }
}
