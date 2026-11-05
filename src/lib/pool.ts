import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/*
 * Any Alcor concentrated-liquidity pool, quoted with its active liquidity and fee. Token A and B
 * are as the pool stores them; sqrt is sqrt(raw B per raw A). Within one tick range these
 * constant-liquidity formulas are exact; a real swap gets a slippage buffer on top.
 */

export interface PoolToken {
  symbol: string
  contract: string
  decimals: number
}

export interface Pool {
  id: number
  a: PoolToken
  b: PoolToken
  sqrt: number
  liquidity: number
  fee: number
  live: boolean
}

export function poolFromRow(
  id: number,
  row: {
    currSlot: { sqrtPriceX64: string }
    liquidity: string
    fee: number
    tokenA: { quantity: string; contract: string }
    tokenB: { quantity: string; contract: string }
  }
): Pool {
  const token = (t: { quantity: string; contract: string }): PoolToken => {
    const [num, symbol] = t.quantity.split(' ')
    return { symbol, contract: t.contract, decimals: num.includes('.') ? num.split('.')[1].length : 0 }
  }
  const sqrt = Number((BigInt(row.currSlot.sqrtPriceX64) * 1_000_000_000n) / 2n ** 64n) / 1e9
  return {
    id,
    a: token(row.tokenA),
    b: token(row.tokenB),
    sqrt,
    liquidity: Number(row.liquidity),
    fee: Number(row.fee) / 1e6,
    live: true
  }
}

/** Mid price: how many B for one A. */
export const midPrice = (p: Pool) => (p.sqrt * p.sqrt * 10 ** p.a.decimals) / 10 ** p.b.decimals

/** How much of `payWith` must go in to receive exactly `amount` of the other token. Infinity if the pool cannot supply it. */
export function costToReceive(p: Pool, receive: 'a' | 'b', amount: number): number {
  if (amount <= 0) return 0
  const L = p.liquidity
  const s = p.sqrt
  if (receive === 'a') {
    // B in, A out: 1/s' = 1/s − out/L, B in = L(s' − s)
    const out = amount * 10 ** p.a.decimals
    const inv = 1 / s - out / L
    if (inv <= 0) return Infinity
    const next = 1 / inv
    return (L * (next - s)) / (1 - p.fee) / 10 ** p.b.decimals
  }
  // A in, B out: s' = s − out/L, A in = L(s − s')/(s·s')
  const out = amount * 10 ** p.b.decimals
  const next = s - out / L
  if (next <= 0) return Infinity
  return (L * (s - next)) / (s * next) / (1 - p.fee) / 10 ** p.a.decimals
}

/** The pool's side holding `symbol`. */
export const sideOf = (p: Pool, symbol: string): 'a' | 'b' => (p.a.symbol === symbol ? 'a' : 'b')

/** Slippage room on real swaps: the pool may move between reading it and signing. */
export const SWAP_SLIPPAGE = 0.02

const fixed = (n: number, decimals: number, up: boolean) => {
  const f = 10 ** decimals
  return ((up ? Math.ceil(n * f) : Math.floor(n * f)) / f).toFixed(decimals)
}

/**
 * Buys at least `amount` of `symbol` from pool `p`, paying with the pool's other token. A little
 * more goes in than the quote to cover slippage; any surplus stays in the wallet.
 */
export function buyExactAction(
  account: string,
  permission: string,
  p: Pool,
  symbol: string,
  amount: number
): { action: AnyAction; paid: number } {
  const receive = sideOf(p, symbol)
  const out = receive === 'a' ? p.a : p.b
  const pay = receive === 'a' ? p.b : p.a
  const paid = costToReceive(p, receive, amount) * (1 + SWAP_SLIPPAGE)
  return {
    paid,
    action: {
      account: pay.contract,
      name: 'transfer',
      authorization: [{ actor: account, permission }],
      data: {
        from: account,
        to: CONTRACTS.ALCOR_SWAP,
        quantity: `${fixed(paid, pay.decimals, true)} ${pay.symbol}`,
        memo: `swapexactin#${p.id}#${account}#${fixed(amount, out.decimals, true)} ${out.symbol}@${out.contract}#0`
      }
    }
  }
}

/** What paying exactly `amount` of `paySymbol` into pool `p` returns of the other token (fee included). */
export function receiveFor(p: Pool, paySymbol: string, amount: number): number {
  if (amount <= 0) return 0
  const L = p.liquidity
  const s = p.sqrt
  if (sideOf(p, paySymbol) === 'a') {
    // A in, B out: s' = L·s / (L + x·s), B out = L(s − s')
    const x = amount * 10 ** p.a.decimals * (1 - p.fee)
    const next = (L * s) / (L + x * s)
    return (L * (s - next)) / 10 ** p.b.decimals
  }
  // B in, A out: s' = s + y/L, A out = L(1/s − 1/s')
  const y = amount * 10 ** p.b.decimals * (1 - p.fee)
  const next = s + y / L
  return (L * (1 / s - 1 / next)) / 10 ** p.a.decimals
}

/** The token a pool gives back for `symbol`. */
export const otherSide = (p: Pool, symbol: string) => (p.a.symbol === symbol ? p.b : p.a)

export interface Route {
  pools: Pool[]
  /** Tokens along the way, first = paid, last = received. */
  path: string[]
  out: number
  /** Out per unit in, for display. */
  rate: number
}

/** Walks `amount` of `from` through `pools` in order. */
export function quoteRoute(pools: Pool[], from: string, amount: number): Route {
  let symbol = from
  let value = amount
  const path = [from]
  for (const p of pools) {
    value = receiveFor(p, symbol, value)
    symbol = otherSide(p, symbol).symbol
    path.push(symbol)
  }
  return { pools, path, out: value, rate: amount > 0 ? value / amount : 0 }
}

/**
 * Swaps exactly `amount` of the route's first token for at least `minOut` of its last, through
 * every pool of the route in one Alcor call (memo: swapexactin#pool,pool#receiver#min@contract#deadline).
 */
export function swapExactInAction(account: string, permission: string, route: Route, amount: number, minOut: number): AnyAction {
  const first = route.pools[0]
  const last = route.pools[route.pools.length - 1]
  const pay = first.a.symbol === route.path[0] ? first.a : first.b
  const receive = last.a.symbol === route.path[route.path.length - 1] ? last.a : last.b
  return {
    account: pay.contract,
    name: 'transfer',
    authorization: [{ actor: account, permission }],
    data: {
      from: account,
      to: CONTRACTS.ALCOR_SWAP,
      quantity: `${fixed(amount, pay.decimals, false)} ${pay.symbol}`,
      memo: `swapexactin#${route.pools.map((p) => p.id).join(',')}#${account}#${fixed(minOut, receive.decimals, false)} ${receive.symbol}@${receive.contract}#0`
    }
  }
}
