import type { AnyAction } from '@wharfkit/session'

import { ALCOR_TLM_DEF_POOL_ID, CONTRACTS } from '@/chain/config'

import { asset } from './format'

/*
 * The Alcor TLM/DEF pool (concentrated liquidity, token A = TLM with 4 decimals, token B = DEF with 8).
 * Quotes use the pool's active liquidity and price, fee included, so a loop that pays its entry in
 * DEF bought with TLM, or earns DEF that is sold back for TLM, is valued at what the swap really gives.
 * Within one tick range the constant-L formulas are exact; big trades that cross ranges get a
 * small error, which the slippage buffer on the actual swap absorbs.
 */

export interface Market {
  /** sqrt(raw DEF per raw TLM) */
  sqrt: number
  /** Active liquidity. */
  liquidity: number
  /** Fee as a fraction, e.g. 0.01. */
  fee: number
  /** Mid price, TLM per DEF. */
  rate: number
  live: boolean
}

const TLM_UNIT = 1e4
const DEF_UNIT = 1e8

export function marketFromPool(sqrtPriceX64: string, liquidity: string, feePpm: number): Market {
  const sqrt = Number((BigInt(sqrtPriceX64) * 1_000_000_000n) / 2n ** 64n) / 1e9
  const defPerTlm = (sqrt * sqrt * TLM_UNIT) / DEF_UNIT
  return { sqrt, liquidity: Number(liquidity), fee: feePpm / 1e6, rate: 1 / defPerTlm, live: true }
}

/** Used until the pool has been read: a mid price with the usual 1% fee and deep liquidity. */
export const fallbackMarket = (rate = 23): Market => ({
  sqrt: Math.sqrt(DEF_UNIT / TLM_UNIT / rate),
  liquidity: 1e15,
  fee: 0.01,
  rate,
  live: false
})

/** DEF received for selling `tlm` TLM. */
export function defForTlm(m: Market, tlm: number): number {
  if (tlm <= 0) return 0
  const x = tlm * TLM_UNIT * (1 - m.fee)
  const next = (m.liquidity * m.sqrt) / (m.liquidity + x * m.sqrt)
  return (m.liquidity * (m.sqrt - next)) / DEF_UNIT
}

/** TLM that has to go in to receive `def` DEF. */
export function tlmForDefOut(m: Market, def: number): number {
  if (def <= 0) return 0
  const out = def * DEF_UNIT
  const next = m.sqrt - out / m.liquidity
  if (next <= 0) return Infinity
  const x = (m.liquidity * (m.sqrt - next)) / (m.sqrt * next)
  return x / (1 - m.fee) / TLM_UNIT
}

/** TLM received for selling `def` DEF. */
export function tlmForDef(m: Market, def: number): number {
  if (def <= 0) return 0
  const y = def * DEF_UNIT * (1 - m.fee)
  const next = m.sqrt + y / m.liquidity
  return (m.liquidity * (1 / m.sqrt - 1 / next)) / TLM_UNIT
}

/**
 * Slippage room on real swaps: the quote may move between reading the pool and signing. Wide on
 * purpose: these swaps are small (entry fees, claimed DEF), a refused fill costs a whole
 * transaction, and the room is only used if the price really moved (a purchase keeps its surplus
 * DEF; a sale's floor only binds when the pool moved against it).
 */
export const SLIPPAGE = 0.05

const ceil = (n: number, decimals: number) => Math.ceil(n * 10 ** decimals) / 10 ** decimals
const floor = (n: number, decimals: number) => Math.floor(n * 10 ** decimals) / 10 ** decimals

const swapMemo = (receiver: string, minOut: string, contract: string) =>
  `swapexactin#${ALCOR_TLM_DEF_POOL_ID}#${receiver}#${minOut}@${contract}#0`

/** Buys at least `def` DEF with TLM (a little extra TLM goes in to cover slippage; any surplus DEF stays in the wallet). */
export function buyDefAction(account: string, permission: string, m: Market, def: number): { action: AnyAction; tlm: number } {
  const need = ceil(def, 8)
  const tlm = ceil(tlmForDefOut(m, need) * (1 + SLIPPAGE), 4)
  return {
    tlm,
    action: {
      account: CONTRACTS.TLM,
      name: 'transfer',
      authorization: [{ actor: account, permission }],
      data: {
        from: account,
        to: CONTRACTS.ALCOR_SWAP,
        quantity: asset(tlm, 'TLM'),
        memo: swapMemo(account, asset(need, 'DEF'), CONTRACTS.DEF)
      }
    }
  }
}

/** Sells `def` DEF for TLM, refusing to fill below the quote minus slippage. */
export function sellDefAction(account: string, permission: string, m: Market, def: number): { action: AnyAction; tlm: number } {
  const amount = floor(def, 8)
  const tlm = tlmForDef(m, amount)
  return {
    tlm,
    action: {
      account: CONTRACTS.DEF,
      name: 'transfer',
      authorization: [{ actor: account, permission }],
      data: {
        from: account,
        to: CONTRACTS.ALCOR_SWAP,
        quantity: asset(amount, 'DEF'),
        memo: swapMemo(account, asset(floor(tlm * (1 - SLIPPAGE), 4), 'TLM'), CONTRACTS.TLM)
      }
    }
  }
}

export interface Funding {
  /** Swaps to put in front of the transaction (empty when the wallet already holds enough DEF). */
  actions: AnyAction[]
  /** DEF bought with TLM. */
  defBought: number
  /** TLM spent in total: direct entry fees plus the DEF purchase. */
  tlmTotal: number
  /** Whether the wallet's TLM covers it. */
  affordable: boolean
}

/**
 * How to pay entry fees totalling `tlm` TLM and `def` DEF from a wallet holding `balance`:
 * whatever DEF is missing is bought with TLM in the same transaction.
 */
export function fundEntries(
  account: string,
  permission: string,
  m: Market,
  cost: { tlm: number; def: number },
  balance: { tlm: number; def: number } | null
): Funding {
  const q = quoteFunding(m, cost, balance)
  const actions = q.defBought > 0 ? [buyDefAction(account, permission, m, q.defBought).action] : []
  return { actions, ...q }
}

/** The numbers of fundEntries without building actions, for labels and the affordability check. */
export function quoteFunding(m: Market, cost: { tlm: number; def: number }, balance: { tlm: number; def: number } | null) {
  const missing = Math.max(0, cost.def - (balance?.def ?? Infinity))
  const defBought = missing > 1e-8 ? Math.ceil(missing * 1e8) / 1e8 : 0
  const swapTlm = defBought > 0 ? Math.ceil(tlmForDefOut(m, defBought) * (1 + SLIPPAGE) * 1e4) / 1e4 : 0
  const tlmTotal = cost.tlm + swapTlm
  return { defBought, tlmTotal, affordable: !balance || balance.tlm >= tlmTotal }
}
