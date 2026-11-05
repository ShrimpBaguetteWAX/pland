import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'
import { getTransactionActions } from '@/chain/history'
import { sleep } from '@/lib/format'

import { readMiner } from './data'
import { computeNonce } from './nonce'
import type { EquippedTool } from './types'

/*
 * One mine, as WAX Mission Control makes it: proof of work in a worker, then a single transaction
 * of cpu.mc::paycpu (Mission Control pays the CPU), m.federation::setland when the land changes,
 * and m.federation::mine. Afterwards the history says what it paid.
 */

const auth = (account: string, permission: string) => [{ actor: account, permission }]

/** paycpu type: 0 = mine, 1 = change land and mine. */
export function mineActions(account: string, permission: string, nonce: string, landId?: string): AnyAction[] {
  const mine: AnyAction = {
    account: CONTRACTS.MINING,
    name: 'mine',
    authorization: auth(account, permission),
    data: { miner: account, nonce, notify: 'notify.mc' }
  }
  const payCpu = (type: number): AnyAction => ({
    account: CONTRACTS.MC_CPU,
    name: 'paycpu',
    authorization: auth(account, permission),
    data: { wallet: account, type }
  })
  if (!landId) return [payCpu(0), mine]
  const setland: AnyAction = {
    account: CONTRACTS.MINING,
    name: 'setland',
    authorization: auth(account, permission),
    data: { account, land_id: landId }
  }
  return [payCpu(1), setland, mine]
}

/** The actions of a mine, ready to sign: the nonce is found first, and the land set only when it changes. */
export async function buildMine(account: string, permission: string, tools: EquippedTool[] | undefined, landId?: string) {
  const miner = await readMiner(account)
  const difficulty = (tools ?? []).reduce((sum, tool) => sum + Number(tool.pow ?? 0), 0)
  const nonce = await computeNonce({ account, lastMineTx: miner?.last_mine_tx, difficulty })
  const target = landId && landId !== miner?.current_land ? landId : undefined
  return mineActions(account, permission, nonce, target)
}

interface LogMine {
  bounty?: string
  params?: { luck?: number }
}

/** History nodes index a mine within about two seconds: ask soon, then back off. */
const POLL_DELAYS_MS = [1500, 1500, 2500, 4000]

/** What a mine paid, for the message ("You mined 0.4213 TLM & 2.4 Shards"), or null if history has nothing yet. */
export async function mineResult(txId: string): Promise<string | null> {
  if (!txId) return null
  for (const delay of POLL_DELAYS_MS) {
    await sleep(delay)
    try {
      const actions = await getTransactionActions(txId)
      const data = actions.find((a) => a.act.name === 'logmine' && (a.act.data as LogMine)?.bounty)?.act.data as
        LogMine | undefined
      if (data?.bounty) {
        const shards = data.params?.luck ?? 0
        return shards > 0 ? `You mined ${data.bounty} & ${shards / 10} Shards` : `You mined ${data.bounty}`
      }
    } catch {
      // A slow history node: try again on the next round.
    }
  }
  return null
}

/**
 * Did the mine land? The contract stamps its transaction on the miner row, so the row answers when
 * history is silent. Read twice, as nodes can be a block behind; an unreadable row counts as landed.
 */
export async function mineLanded(account: string, txId: string): Promise<boolean> {
  const wanted = txId.toLowerCase()
  for (const delay of [0, 2500]) {
    if (delay) await sleep(delay)
    try {
      const miner = await readMiner(account)
      if (miner?.last_mine_tx?.toLowerCase() === wanted) return true
    } catch {
      return true
    }
  }
  return false
}
