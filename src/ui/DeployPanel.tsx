import { useMemo, useState } from 'react'

import { deployActions } from '@/chain/actions/pd'
import { useGameBalance, useMarket, useMissionConfig, usePlayer, type Division } from '@/data/game'
import { coveredBy, walletCosts, walletPart } from '@/lib/deposit'
import { formatDuration, formatNumber } from '@/lib/format'
import { cycleRoute, cycleSeconds, meetsRequirements, missionEconomics, rewardParts, tlmPerHour, type MissionEconomics } from '@/lib/loop'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait } from './Art'
import { Icon } from './icons'

/*
 * Sending a division that is at home out on a mission, from the army screen. Of the missions it
 * meets right now, the one that earns the most TLM per hour comes first: what a cycle pays minus
 * what it costs, with DEF valued at what the Alcor pool really pays or charges for it (fee and price
 * impact included), over how long this division is locked there (base time plus 10 s per move
 * point). The other missions it can take are one click away.
 *
 * The entry fee is taken from the game balance where that covers it; the rest is sent from the
 * wallet with the join. A stale stats cache is recalculated in the same transaction.
 */

interface Option {
  m: MissionEconomics
  perHour: number
  net: number
  seconds: number
}

export function DeployPanel({ account, division, disabled }: { account: string; division: Division; disabled: string | null }) {
  const config = useMissionConfig()
  const market = useMarket()
  const player = usePlayer(account)
  const deposit = useGameBalance(account)
  const { run, pending } = useTransaction()
  const [more, setMore] = useState(false)

  const { options, closest } = useMemo(() => {
    if (!config.data) return { options: [] as Option[], closest: null as MissionEconomics | null }
    const open = config.data.missions.map((row) => missionEconomics(row, config.data!)).filter((e) => e.state === 'active')
    const options = open
      .filter((e) => meetsRequirements(e, division.atk, division.def))
      .map((m) => ({ m, perHour: tlmPerHour(m, division.move, market), net: cycleRoute(m, market).net, seconds: cycleSeconds(m, division.move) }))
      .sort((a, b) => b.perHour - a.perHour)
    // The easiest mission it cannot do yet, to say what it is short of.
    const short = (e: MissionEconomics) => Math.max(0, e.minAtk - division.atk) + Math.max(0, e.minDef - division.def)
    const closest = open.filter((e) => !meetsRequirements(e, division.atk, division.def)).sort((a, b) => short(a) - short(b))[0] ?? null
    return { options, closest }
  }, [config.data, market, division.atk, division.def, division.move])

  if (!config.data) return <div className="box deploy muted">Reading the missions…</div>

  /** What this one deployment pays, from where, and whether it can be paid at all. */
  const funding = (m: MissionEconomics) => {
    const fromDeposit = coveredBy({ tlm: m.costTlm, def: m.costDef }, deposit.data)
    const wallet = walletPart({ tlm: m.costTlm, def: m.costDef }, fromDeposit)
    const tlm = player.data?.tlm ?? 0
    const def = player.data?.def ?? 0
    const short =
      (wallet.tlm > 0 && tlm < wallet.tlm ? `${formatNumber(wallet.tlm - tlm, 2)} TLM` : '') ||
      (wallet.def > 0 && def < wallet.def ? `${formatNumber(wallet.def - def, 2)} DEF` : '')
    return { fromDeposit, short }
  }

  const deploy = (m: MissionEconomics) => {
    const { fromDeposit } = funding(m)
    void run(
      (a, p) => deployActions(a, p, m.id, division.id, !division.fresh, walletCosts(m.costs, fromDeposit)),
      `Division #${division.id} sent to ${m.title}`,
      `deploy-${m.id}`
    )
  }

  const row = ({ m, perHour, net, seconds }: Option, best: boolean) => {
    const f = funding(m)
    const cost = [m.costTlm > 0 && `${formatNumber(m.costTlm, 2)} TLM`, m.costDef > 0 && `${formatNumber(m.costDef, 2)} DEF`].filter(Boolean)
    const paidBy = f.fromDeposit.tlm || f.fromDeposit.def ? ' from your game balance' : ''
    return (
      <div key={m.id} className={`dm${best ? ' is-best' : ''}`}>
        <Portrait img={m.image} className="dm__pic" whole />
        <span className="dm__text">
          {best && <em className="dm__tag">Best income</em>}
          <b>{m.title || `Mission ${m.id}`}</b>
          <small>
            pays {rewardParts(m).join(' + ') || 'nothing'} · entry {cost.length ? `${cost.join(' + ')}${paidBy}` : 'free'} · back in{' '}
            {formatDuration(seconds)}
          </small>
        </span>
        <span className="dm__pay">
          <b className={perHour > 0 ? 'is-good' : perHour < 0 ? 'is-bad' : ''}>
            {perHour > 0 ? '+' : ''}
            {formatNumber(perHour, perHour !== 0 && Math.abs(perHour) < 10 ? 2 : 0)} TLM/h
          </b>
          <small className="muted">
            {net >= 0 ? '+' : ''}
            {formatNumber(net, 2)} TLM a run
          </small>
        </span>
        <button
          type="button"
          className="btn btn--go btn--sm"
          disabled={!!disabled || !!f.short || !!pending}
          title={f.short ? `You are ${f.short} short for the entry` : (disabled ?? undefined)}
          onClick={() => deploy(m)}
        >
          {pending === `deploy-${m.id}` ? 'Signing…' : f.short ? `${f.short} short` : 'Deploy'}
        </button>
      </div>
    )
  }

  const [best, ...rest] = options

  return (
    <div className="box deploy">
      <div className="deploy__h">
        <h2>
          <Icon name="rocket" /> Send it on a mission
        </h2>
        <span className="muted">
          1 DEF = {formatNumber(market.rate, 2)} TLM on Alcor{market.live ? '' : ' (estimate, the pool did not answer)'}
        </span>
      </div>
      {disabled && <p className="help deploy__why">{disabled}</p>}
      {best ? (
        <div className="deploy__list">
          {row(best, true)}
          {more && rest.map((o) => row(o, false))}
        </div>
      ) : (
        <p className="none">No open mission fits this division yet.</p>
      )}
      {rest.length > 0 && (
        <button type="button" className="link deploy__more" onClick={() => setMore((x) => !x)}>
          {more ? 'View less' : `View more · ${rest.length} other mission${rest.length === 1 ? '' : 's'} it can take`}
        </button>
      )}
      {closest && (
        <p className="help">
          Next up: {closest.title} needs{' '}
          {[
            closest.minAtk > division.atk && `${formatNumber(closest.minAtk - division.atk, 0)} more attack`,
            closest.minDef > division.def && `${formatNumber(closest.minDef - division.def, 0)} more defense`
          ]
            .filter(Boolean)
            .join(' and ')}
          .
        </p>
      )}
    </div>
  )
}
