import { useMemo } from 'react'

import { claimMission, deployActions } from '@/chain/actions/pd'
import { useArmy, useDeployments, useGameBalance, useMarket, useMissionConfig, usePlayer, type Deployment, type Division } from '@/data/game'
import { useTransaction } from '@/wallet/useTransaction'

import { coveredBy, walletCosts, walletPart } from './deposit'
import { formatNumber } from './format'
import { missionEconomics, tlmPerHour, type MissionEconomics } from './loop'
import { useClockFor } from './time'

/*
 * The field: every division out on a mission, what is back, and the two things to do about it,
 * claim and claim-and-redeploy. Shared by the Missions page and the console strip under the menu,
 * so both act the same way and show the same numbers.
 *
 * Claim-and-redeploy: the claims and the first join go in one transaction (the rewards land in the
 * game balance before the join pays its entry), every further division is a transaction of its own,
 * because the contract takes one join per transaction. Entry fees the game balance covers are left
 * to the contract; the rest is sent from the wallet with the join.
 */

export interface Field {
  now: number
  loaded: boolean
  econ: Map<number, MissionEconomics>
  byId: Map<number, Division>
  /** Every deployment, soonest return first. */
  field: Deployment[]
  ready: Deployment[]
  /** Ready deployments whose mission is still open, so the division can go straight back. */
  loopable: Deployment[]
  running: Deployment[]
  nextReturnAt: number | null
  /** TLM an hour the divisions out are earning, each on its mission at its own move. */
  earning: number
  /** TLM waiting in the ready rewards (DEF not counted). */
  waitingTlm: number
  /** Why these entries cannot be paid, or '' when they can. */
  shortFor: (entries: { tlm: number; def: number }, extra?: { tlm: number; def: number }) => { fromDeposit: { tlm: boolean; def: boolean }; short: string }
  claim: (list: Deployment[]) => void
  redeploy: (list: Deployment[]) => void
  /** Why claim-and-redeploy cannot run for these, or '' when it can. */
  redeployShort: (list: Deployment[]) => string
  /** Sends divisions at home out, one transaction each (the contract takes one join per transaction). */
  send: (e: MissionEconomics, divisions: Division[]) => void
  sendShort: (e: MissionEconomics, divisions: Division[]) => string
  pending: string | null
  spectating: boolean
}

export function useField(account: string): Field {
  const army = useArmy(account)
  const deployments = useDeployments(account)
  const config = useMissionConfig()
  const market = useMarket()
  const player = usePlayer(account)
  const deposit = useGameBalance(account)
  const { run, runSequence, pending, spectating } = useTransaction()

  const unlocks = useMemo(() => deployments.data?.map((d) => d.unlockAt) ?? [], [deployments.data])
  const now = useClockFor(unlocks)

  const econ = useMemo(() => {
    const m = new Map<number, MissionEconomics>()
    if (config.data) for (const row of config.data.missions) m.set(Number(row.mission_id), missionEconomics(row, config.data, now))
    return m
  }, [config.data, now])
  const byId = useMemo(() => new Map((army.data?.divisions ?? []).map((d) => [d.id, d])), [army.data])
  const field = useMemo(() => [...(deployments.data ?? [])].sort((a, b) => a.unlockAt - b.unlockAt), [deployments.data])
  const ready = field.filter((d) => d.unlockAt <= now)
  const running = field.filter((d) => d.unlockAt > now)
  const loopable = ready.filter((d) => econ.get(d.missionId)?.state === 'active')
  const nextReturnAt = running.length ? running[0].unlockAt : null
  const earning = field.reduce((n, d) => {
    const e = econ.get(d.missionId)
    const div = byId.get(d.divisionId)
    return e && div ? n + tlmPerHour(e, div.move, market) : n
  }, 0)
  const waitingTlm = ready.reduce((n, d) => n + (econ.get(d.missionId)?.rewardTlm ?? 0), 0)

  const wallet = { tlm: player.data?.tlm ?? 0, def: player.data?.def ?? 0 }
  const shortFor: Field['shortFor'] = (entries, extra = { tlm: 0, def: 0 }) => {
    const have = { tlm: (deposit.data?.tlm ?? 0) + extra.tlm, def: (deposit.data?.def ?? 0) + extra.def }
    const fromDeposit = coveredBy(entries, have)
    const w = walletPart(entries, fromDeposit)
    const short =
      (w.tlm > 0 && wallet.tlm < w.tlm ? `${formatNumber(w.tlm - wallet.tlm, 2)} TLM short` : '') || (w.def > 0 && wallet.def < w.def ? `${formatNumber(w.def - wallet.def, 2)} DEF short` : '')
    return { fromDeposit, short }
  }

  const sums = (list: Deployment[]) => ({
    earned: list.reduce((n, d) => ({ tlm: n.tlm + (econ.get(d.missionId)?.rewardTlm ?? 0), def: n.def + (econ.get(d.missionId)?.rewardDef ?? 0) }), { tlm: 0, def: 0 }),
    entries: list.reduce((n, d) => ({ tlm: n.tlm + (econ.get(d.missionId)?.costTlm ?? 0), def: n.def + (econ.get(d.missionId)?.costDef ?? 0) }), { tlm: 0, def: 0 })
  })

  const claim = (list: Deployment[]) => {
    if (!list.length) return
    void run(
      (a, p) => list.map((d) => claimMission(a, p, d.missionId, d.divisionId)),
      list.length === 1 ? `Division #${list[0].divisionId} claimed` : `${list.length} rewards claimed`,
      list.length === 1 ? `claim-${list[0].divisionId}` : 'claim-all'
    )
  }

  const redeployShort = (list: Deployment[]) => {
    const back = list.filter((d) => econ.get(d.missionId)?.state === 'active')
    if (!back.length) return 'The mission is no longer open'
    const { earned, entries } = sums(back)
    return shortFor(entries, earned).short
  }

  const redeploy = (list: Deployment[]) => {
    const back = list.filter((d) => econ.get(d.missionId)?.state === 'active')
    if (!back.length) return
    const { earned, entries } = sums(back)
    const { fromDeposit, short } = shortFor(entries, earned)
    if (short) return
    const out = (a: string, p: string, x: Deployment) => {
      const d = byId.get(x.divisionId)
      return deployActions(a, p, x.missionId, x.divisionId, !!d && !d.fresh, walletCosts(econ.get(x.missionId)!.costs, fromDeposit))
    }
    const [first, ...rest] = back
    void runSequence(
      [
        {
          build: (a, p) => [...back.map((d) => claimMission(a, p, d.missionId, d.divisionId)), ...out(a, p, first)],
          settle: true,
          success: rest.length ? `${back.length} claimed, #${first.divisionId} sent back out` : `#${first.divisionId} claimed and sent back out`
        },
        ...rest.map((x) => ({ build: (a: string, p: string) => out(a, p, x), success: `#${x.divisionId} sent back to ${econ.get(x.missionId)?.title ?? 'its mission'}` }))
      ],
      back.length === 1 ? `loop-${first.divisionId}` : 'loop-all',
      'Claim & redeploy'
    )
  }

  const sendShort = (e: MissionEconomics, divisions: Division[]) => {
    if (e.state !== 'active') return 'The mission is not open'
    if (!divisions.length) return 'Nothing picked'
    return shortFor({ tlm: e.costTlm * divisions.length, def: e.costDef * divisions.length }).short
  }
  const send = (e: MissionEconomics, divisions: Division[]) => {
    if (sendShort(e, divisions)) return
    const { fromDeposit } = shortFor({ tlm: e.costTlm * divisions.length, def: e.costDef * divisions.length })
    const part = (d: Division) => ({
      build: (a: string, p: string) => deployActions(a, p, e.id, d.id, !d.fresh, walletCosts(e.costs, fromDeposit)),
      success: `Division #${d.id} sent to ${e.title}`
    })
    if (divisions.length === 1) {
      const d = divisions[0]
      void run(part(d).build, part(d).success, `deploy-${d.id}`)
    } else void runSequence(divisions.map(part), 'deploy-many', `Sending ${divisions.length} divisions to ${e.title}`)
  }

  return {
    now,
    loaded: !!army.data && !!config.data && !!deployments.data,
    econ,
    byId,
    field,
    ready,
    loopable,
    running,
    nextReturnAt,
    earning,
    waitingTlm,
    shortFor,
    claim,
    redeploy,
    redeployShort,
    send,
    sendShort,
    pending,
    spectating
  }
}
