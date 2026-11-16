import { useEffect, useMemo, useState } from 'react'

import { useGameBalance } from '@/data/game'
import { useNftFloors, useSwapPools } from '@/data/market'
import { formatNumber } from '@/lib/format'
import { cycleSeconds } from '@/lib/loop'
import { receiveFor } from '@/lib/pool'
import { useField } from '@/lib/useField'

import { KEEP_MAX, KEEP_STEP, KEEP_UNLIMITED, useDefSwap, useKeepDef } from './defKeep'

/*
 * Couch mode's second screen (swipe left from the orb): the bank. The day of your divisions as a
 * little receipt (in, out and net per token, each net's TLM value, and the surplus in TLM as its
 * total, as if every division went out again as soon as it is back), the DEF → TLM rate on Alcor,
 * what is deposited in the game, and how much DEF to keep there (a slider, unlimited by default):
 * what is over it is withdrawn and swapped to TLM in one signature, here or by tapping the orb.
 */

/** How long the slider stays unlocked after the last change. */
const RELOCK_MS = 6000

const n0 = (n: number) => formatNumber(n, 0)
const signed = (n: number, d = 0) => `${n >= 0 ? '+' : '−'}${formatNumber(Math.abs(n), d)}`

export function Bank({ account }: { account: string }) {
  const bank = useGameBalance(account)
  const pools = useSwapPools()
  const f = useField(account)
  const keep = useKeepDef((st) => st.keep)
  const setKeep = useKeepDef((st) => st.setKeep)
  const dx = useDefSwap(account)

  // The rate shown: what 1 DEF brings in TLM on the better route right now.
  const rate = dx.rate

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

  const held = dx.held
  const slider = keep === null ? KEEP_UNLIMITED : Math.min(KEEP_MAX, keep)
  /** The slider is locked until unlocked, so a swipe across it cannot move it; it locks again a few seconds after the last change. */
  const [unlocked, setUnlocked] = useState(false)
  const [touched, setTouched] = useState(0)
  useEffect(() => {
    if (!unlocked) return
    const t = setTimeout(() => setUnlocked(false), RELOCK_MS)
    return () => clearTimeout(t)
  }, [unlocked, touched])

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

      <div className={`cb__plaque cb__keep${unlocked ? ' is-unlocked' : ''}`}>
        <span className="cb__keep-hd">
          <small>Keep in the game</small>
          <span className="cb__keep-val">
            <b className="num is-def">{keep === null ? 'Unlimited' : `${n0(keep)} DEF`}</b>
            <button
              type="button"
              className="cb__lock"
              aria-pressed={unlocked}
              aria-label={unlocked ? 'Lock the slider' : 'Unlock the slider to change it'}
              title={unlocked ? 'Locks again by itself a few seconds after your last change' : 'Unlock to change how much DEF is kept'}
              onClick={() => setUnlocked((u) => !u)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="5" y="11" width="14" height="10" rx="2.5" />
                <path d={unlocked ? 'M8 11V7.5a4 4 0 0 1 7.6-1.7' : 'M8 11V7.5a4 4 0 0 1 8 0V11'} />
              </svg>
            </button>
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={KEEP_UNLIMITED}
          step={KEEP_STEP}
          value={slider}
          aria-label={unlocked ? 'DEF to keep in the game' : 'DEF to keep in the game (locked: unlock it first)'}
          disabled={!unlocked}
          aria-valuetext={keep === null ? 'Unlimited' : `${keep} DEF`}
          onChange={(e) => {
            const v = Number(e.target.value)
            setKeep(v > KEEP_MAX ? null : v)
            setTouched((n) => n + 1)
          }}
        />
        <span className="cb__keep-scale" aria-hidden="true">
          <span>0</span>
          <span>500</span>
          <span>1,000</span>
          <span>∞</span>
        </span>
        <small className="cb__keep-note">
          {keep === null
            ? `All your DEF stays in the game. ${unlocked ? 'Slide left' : 'Unlock, then slide left'} to swap what is over an amount to TLM.`
            : dx.ready
              ? `${formatNumber(dx.over, dx.over >= 100 ? 0 : 2)} DEF over it: tap the orb (it is lit) or swap here.`
              : 'Nothing over it right now. When there is, the orb lights up and a tap swaps it.'}
        </small>
      </div>
      <button type="button" className="cb__go" disabled={dx.spectating || dx.busy || !dx.ready || !dx.route} onClick={() => void dx.swap()}>
        {dx.busy ? (
          'Signing…'
        ) : dx.ready && dx.route ? (
          <>
            Swap {formatNumber(dx.over, dx.over >= 100 ? 0 : 2)} DEF → {n0(dx.route.out)} TLM
          </>
        ) : keep === null ? (
          'Keeping all your DEF'
        ) : (
          'Nothing over your keep amount'
        )}
        <small>{dx.spectating ? 'Read-only: not your account' : 'withdraw + Alcor, one signature · 1 % slippage'}</small>
      </button>
    </section>
  )
}
