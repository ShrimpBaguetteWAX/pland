import { useMemo, useState } from 'react'

import { withdrawBalanceAction } from '@/chain/actions/pd'
import { useGameBalance } from '@/data/game'
import { useNftFloors, useSwapPools, type SwapPools } from '@/data/market'
import { quantityOf } from '@/lib/deposit'
import { formatNumber } from '@/lib/format'
import { cycleSeconds } from '@/lib/loop'
import { quoteRoute, receiveFor, swapExactInAction, type Pool, type Route } from '@/lib/pool'
import { useField } from '@/lib/useField'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * Couch mode's second screen (swipe left from the orb): the bank. The day of your divisions as a
 * little receipt (in, out and net per token, each net's TLM value, and the surplus in TLM as its
 * total, as if every division went out again as soon as it is back), the DEF → TLM rate on Alcor,
 * what is deposited in the game, and one tap to withdraw some of the DEF and swap it to TLM, in one
 * signature.
 */

type Token = 'WAX' | 'TLM' | 'DEF'

/** The pool between two tokens. */
function poolFor(pools: SwapPools, a: Token, b: Token): Pool {
  const pair = [a, b].sort().join('/')
  return pair === 'DEF/WAX' ? pools.def : pair === 'TLM/WAX' ? pools.tlm : pools.tlmdef
}

/** DEF to TLM, direct or through WAX: whichever returns more. */
function defToTlm(pools: SwapPools, amount: number): Route {
  return [quoteRoute([pools.tlmdef], 'DEF', amount), quoteRoute([poolFor(pools, 'DEF', 'WAX'), poolFor(pools, 'WAX', 'TLM')], 'DEF', amount)].sort(
    (x, y) => y.out - x.out
  )[0]
}

const SHARES = [1 / 3, 2 / 3, 1] as const
const SHARE_LABEL = ['33 %', '66 %', '100 %']
const SLIPPAGE = 0.01
/** DEF has 8 decimals: round down so the withdrawal never asks for more than is there. */
const floorDef = (n: number) => Math.floor(n * 1e8) / 1e8

const n0 = (n: number) => formatNumber(n, 0)
const signed = (n: number, d = 0) => `${n >= 0 ? '+' : '−'}${formatNumber(Math.abs(n), d)}`

export function Bank({ account }: { account: string }) {
  const bank = useGameBalance(account)
  const pools = useSwapPools()
  const f = useField(account)
  const { run, pending, spectating } = useTransaction()
  const [share, setShare] = useState(1)

  // The rate shown: what 1 DEF brings in TLM on the better route right now.
  const rate = pools.data ? defToTlm(pools.data, 1).rate : null

  // NFT rewards at their floor, as on the Missions page and in the optimizer.
  const nftIds = useMemo(() => [...f.econ.values()].flatMap((e) => (e.rewardNft ? [String(e.rewardNft.templateId)] : [])), [f.econ])
  const floors = useNftFloors(nftIds)

  /** The day of every division on its mission, sent again as soon as it is back. */
  const day = useMemo(() => {
    const d = { tlmIn: 0, tlmOut: 0, defIn: 0, defOut: 0, nfts: 0, nftTlm: 0, divisions: 0 }
    for (const dep of f.field) {
      const e = f.econ.get(dep.missionId)
      const div = f.byId.get(dep.divisionId)
      if (!e || !div) continue
      const s = cycleSeconds(e, div.move)
      if (!(s > 0)) continue
      const cycles = 86_400 / s
      d.divisions++
      d.tlmIn += e.costTlm * cycles
      d.tlmOut += e.rewardTlm * cycles
      d.defIn += e.costDef * cycles
      d.defOut += e.rewardDef * cycles
      if (e.rewardNft) {
        const n = e.rewardNft.count * cycles
        d.nfts += n
        const wax = floors.data?.get(String(e.rewardNft.templateId))
        if (wax !== undefined && pools.data) d.nftTlm += receiveFor(pools.data.tlm, 'WAX', wax) * n
      }
    }
    return d
  }, [f.field, f.econ, f.byId, floors.data, pools.data])
  const tlmNet = day.tlmOut - day.tlmIn
  const defNet = day.defOut - day.defIn
  const defTlm = rate !== null ? defNet * rate : 0
  const surplus = tlmNet + defTlm + day.nftTlm

  // The swap: a share of the DEF in the game, withdrawn and swapped to TLM in one transaction.
  const held = bank.data?.def ?? 0
  const amount = floorDef(held * SHARES[share])
  const route = pools.data && amount > 0 ? defToTlm(pools.data, amount) : null
  const busy = pending === 'bank-swap'
  async function swap() {
    if (!route || amount <= 0) return
    const minOut = route.out * (1 - SLIPPAGE)
    const ok = await run(
      (a, p) => [withdrawBalanceAction(a, p, quantityOf(amount, 'DEF')), swapExactInAction(a, p, route, amount, minOut)],
      `Withdrew ${formatNumber(amount, 2)} DEF and swapped it for about ${n0(route.out)} TLM`,
      'bank-swap'
    )
    if (ok) void bank.refetch()
  }

  return (
    <section className="couch__bankpage" aria-label="Bank: your day, the rate and your deposit">
      <div className="cb__hero">
        <small>You earn a day</small>
        <b className={`num ${surplus >= 0 ? 'is-good' : 'is-bad'}`}>
          {f.loaded ? signed(surplus) : '…'}
          <i>TLM</i>
        </b>
      </div>

      <div className="cb__plaque cb__receipt">
        <table className="num">
          <thead>
            <tr>
              <th />
              <th>in</th>
              <th>out</th>
              <th>net</th>
              <th>≈ TLM</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="is-tlm">TLM</td>
              <td>{n0(day.tlmIn)}</td>
              <td>{n0(day.tlmOut)}</td>
              <td className={tlmNet >= 0 ? 'is-good' : 'is-bad'}>{signed(tlmNet)}</td>
              <td>{signed(tlmNet)}</td>
            </tr>
            <tr>
              <td className="is-def">DEF</td>
              <td>{n0(day.defIn)}</td>
              <td>{n0(day.defOut)}</td>
              <td className={defNet >= 0 ? 'is-good' : 'is-bad'}>{signed(defNet)}</td>
              <td>{rate !== null ? signed(defTlm) : '…'}</td>
            </tr>
            <tr>
              <td className="is-nft">NFTs</td>
              <td>–</td>
              <td>{formatNumber(day.nfts, day.nfts >= 10 ? 0 : 1)}</td>
              <td className={day.nfts > 0 ? 'is-good' : ''}>{day.nfts > 0 ? signed(day.nfts, day.nfts >= 10 ? 0 : 1) : '0'}</td>
              <td>{day.nftTlm > 0 ? signed(day.nftTlm) : '0'}</td>
            </tr>
            <tr className="cb__sum">
              <td>Surplus</td>
              <td />
              <td />
              <td />
              <td className={surplus >= 0 ? 'is-good' : 'is-bad'}>{signed(surplus)}</td>
            </tr>
          </tbody>
        </table>
        <p className="cb__note">
          {day.divisions} division{day.divisions === 1 ? '' : 's'} on their missions, each sent again as soon as it is back. DEF at the rate below,
          NFTs at their floor.
        </p>
      </div>

      <div className="cb__plaque cb__rate">
        <small>DEF → TLM on Alcor</small>
        <span>
          <b className="num">{rate !== null ? formatNumber(rate, 2) : '…'}</b>
          <i>TLM per DEF</i>
        </span>
      </div>

      <p className="cb__held num">
        <span>
          In the game: <b className="is-tlm">{bank.data ? n0(bank.data.tlm) : '…'} TLM</b>
        </span>
        <b className="is-def">{bank.data ? formatNumber(held, held >= 100 ? 0 : 2) : '…'} DEF</b>
      </p>

      <div className="cb__pct" role="group" aria-label="How much of the DEF to swap">
        {SHARE_LABEL.map((label, i) => (
          <button key={label} type="button" className={share === i ? 'is-on' : ''} aria-pressed={share === i} onClick={() => setShare(i)}>
            {label}
          </button>
        ))}
      </div>
      <button type="button" className="cb__go" disabled={spectating || busy || !route || amount <= 0} onClick={() => void swap()}>
        {busy ? (
          'Signing…'
        ) : amount > 0 && route ? (
          <>
            Swap {share === 2 ? 'all ' : ''}
            {formatNumber(amount, amount >= 100 ? 0 : 2)} DEF → {n0(route.out)} TLM
          </>
        ) : (
          'No DEF in the game'
        )}
        <small>{spectating ? 'Read-only: not your account' : 'withdraw + Alcor, one signature · 1 % slippage'}</small>
      </button>
    </section>
  )
}
