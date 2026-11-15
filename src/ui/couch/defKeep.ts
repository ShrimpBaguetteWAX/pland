import { create } from 'zustand'

import { withdrawBalanceAction } from '@/chain/actions/pd'
import { useGameBalance } from '@/data/game'
import { useSwapPools, type SwapPools } from '@/data/market'
import { quantityOf } from '@/lib/deposit'
import { formatNumber } from '@/lib/format'
import { quoteRoute, swapExactInAction, type Pool, type Route } from '@/lib/pool'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * How much DEF to keep in the game balance, and swapping the rest to TLM. Set on the bank page with
 * a slider (0 to 1,000 DEF, or unlimited: keep it all, the default); whatever the game balance holds
 * above it is withdrawn and swapped to TLM on Alcor in one signature, from the bank page or by
 * tapping the orb, which lights up while there is some.
 */

type Token = 'WAX' | 'TLM' | 'DEF'

/** The pool between two tokens. */
function poolFor(pools: SwapPools, a: Token, b: Token): Pool {
  const pair = [a, b].sort().join('/')
  return pair === 'DEF/WAX' ? pools.def : pair === 'TLM/WAX' ? pools.tlm : pools.tlmdef
}

/** DEF to TLM, direct or through WAX: whichever returns more. */
export function defToTlm(pools: SwapPools, amount: number): Route {
  return [quoteRoute([pools.tlmdef], 'DEF', amount), quoteRoute([poolFor(pools, 'DEF', 'WAX'), poolFor(pools, 'WAX', 'TLM')], 'DEF', amount)].sort(
    (x, y) => y.out - x.out
  )[0]
}

const SLIPPAGE = 0.01
/** DEF has 8 decimals: round down so the withdrawal never asks for more than is there. */
const floorDef = (n: number) => Math.floor(n * 1e8) / 1e8
/** Below this, a swap is not worth a signature. */
const MIN_SWAP = 1

/** The slider: 0 to 1,000 DEF in steps of 10, and one more step for unlimited. */
export const KEEP_MAX = 1000
export const KEEP_STEP = 10
export const KEEP_UNLIMITED = KEEP_MAX + KEEP_STEP

const KEY = 'pd:couch-keep-def'

function read(): number | null {
  try {
    const v = localStorage.getItem(KEY)
    if (v === null || v === 'unlimited') return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

/** DEF to keep in the game balance; null: unlimited (nothing is swapped). */
export const useKeepDef = create<{ keep: number | null; setKeep: (keep: number | null) => void }>((set) => ({
  keep: read(),
  setKeep: (keep) => {
    try {
      localStorage.setItem(KEY, keep === null ? 'unlimited' : String(keep))
    } catch {
      // Not kept for next time, but it works for now.
    }
    set({ keep })
  }
}))

/** The DEF over the keep amount, its swap, and how to run it. */
export function useDefSwap(account: string | null) {
  const keep = useKeepDef((s) => s.keep)
  const bank = useGameBalance(account)
  const pools = useSwapPools()
  const { run, pending, spectating } = useTransaction()
  const held = bank.data?.def ?? 0
  const over = keep === null ? 0 : floorDef(Math.max(0, held - keep))
  const ready = over >= MIN_SWAP
  const route = pools.data && ready ? defToTlm(pools.data, over) : null
  const busy = pending === 'bank-swap'

  /** Withdraws what is over the keep amount right now (read again first) and swaps it to TLM. */
  async function swap(): Promise<boolean> {
    if (keep === null || !pools.data) return false
    const fresh = (await bank.refetch()).data
    const amount = floorDef(Math.max(0, (fresh?.def ?? 0) - keep))
    if (amount < MIN_SWAP) return false
    const r = defToTlm(pools.data, amount)
    const minOut = r.out * (1 - SLIPPAGE)
    const ok = await run(
      (a, p) => [withdrawBalanceAction(a, p, quantityOf(amount, 'DEF')), swapExactInAction(a, p, r, amount, minOut)],
      `Withdrew ${formatNumber(amount, 2)} DEF and swapped it for about ${formatNumber(r.out, 0)} TLM, keeping ${formatNumber(keep, 0)} DEF`,
      'bank-swap'
    )
    if (ok) void bank.refetch()
    return ok
  }

  return { keep, held, over, ready, route, busy, spectating, swap, loaded: !!bank.data, rate: pools.data ? defToTlm(pools.data, 1).rate : null }
}
