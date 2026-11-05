import type { EntryCost } from '@/chain/actions/pd'
import { CONTRACTS } from '@/chain/config'

/*
 * The game balance: TLM and DEF the player has deposited with core.pdef (a transfer with the memo
 * "deposit"). A join that comes without its entry transfer is paid from it by the contract (credit
 * already sent for the mission first, then this balance), so a loop can run without sending new
 * tokens every cycle. `withdrawbal` sends it back to the wallet.
 */

export interface GameBalance {
  tlm: number
  def: number
}

/** Which tokens the deposit pays in full for these entries; a token it cannot cover is sent from the wallet as before. */
export function coveredBy(cost: GameBalance, deposit: GameBalance | null | undefined): { tlm: boolean; def: boolean } {
  const covers = (need: number, have: number | undefined) => need > 0 && have !== undefined && have + 1e-9 >= need
  return { tlm: covers(cost.tlm, deposit?.tlm), def: covers(cost.def, deposit?.def) }
}

/** The part of the cost still paid from the wallet. */
export const walletPart = (cost: GameBalance, covered: { tlm: boolean; def: boolean }): GameBalance => ({
  tlm: covered.tlm ? 0 : cost.tlm,
  def: covered.def ? 0 : cost.def
})

/** The entry transfers still sent with a join: the ones the deposit does not pay. */
export const walletCosts = (costs: EntryCost[], covered: { tlm: boolean; def: boolean }) =>
  costs.filter((c) => !(c.contract === CONTRACTS.DEF ? covered.def : covered.tlm))

/** Decimals of each token, as the token contracts want them. */
export const DECIMALS = { TLM: 4, DEF: 8 } as const
export type BalanceSymbol = keyof typeof DECIMALS
export const quantityOf = (amount: number, symbol: BalanceSymbol) => `${amount.toFixed(DECIMALS[symbol])} ${symbol}`
