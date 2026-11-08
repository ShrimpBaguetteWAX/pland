import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { CONTRACTS } from '@/chain/config'
import { getActions, getTransactionActions, timesRun } from '@/chain/history'
import { parseAsset } from '@/lib/format'

import { queryClient } from './queryClient'

/*
 * What the player earned today, since 0:00 in their own timezone: TLM paid by missions to their
 * divisions, and TLM mined. Mission rewards are transfers from miss.pdef (counted once per claim,
 * see timesRun). Mining pays nothing out per mine: each mine logs its bounty (logmine) in its own
 * transaction and the TLM collects at m.federation, so today's mines are listed from the account's
 * history and each one's bounty read from its transaction, once: a bounty never changes, so they
 * are remembered in this browser and only new mines are looked up.
 */

export interface TodayEarnings {
  divisions: number
  mining: number
  /** Mines whose bounty could not be read yet (history lag); counted on the next refresh. */
  pending: number
}

const BOUNTY_KEY = 'pd.mine-bounty.v1'
const BOUNTY_LIMIT = 3000
/** Transactions read at once: quick, and gentle on the history nodes. */
const AT_ONCE = 4

let bounties: Map<string, number> | null = null
function bountyCache(): Map<string, number> {
  if (bounties) return bounties
  bounties = new Map()
  try {
    const raw = localStorage.getItem(BOUNTY_KEY)
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, number>)) bounties.set(k, v)
  } catch {
    /* storage unavailable: read them again */
  }
  return bounties
}
function saveBounties() {
  try {
    localStorage.setItem(BOUNTY_KEY, JSON.stringify(Object.fromEntries([...bountyCache()].slice(-BOUNTY_LIMIT))))
  } catch {
    /* storage full or unavailable */
  }
}

/** Local midnight, as Hyperion wants it (UTC ISO). */
export const startOfToday = () => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
}

async function bountyOf(trxId: string, account: string): Promise<number | null> {
  const actions = await getTransactionActions(trxId)
  const log = actions.find((a) => a.act.name === 'logmine' && a.act.data.miner === account)
  if (!log) return null
  return parseAsset(String(log.act.data.bounty ?? '0 TLM')).amount
}

async function fetchToday(account: string): Promise<TodayEarnings> {
  const after = startOfToday()
  const [rewards, mines] = await Promise.all([
    getActions(account, {
      filter: 'alien.worlds:transfer',
      'transfer.from': CONTRACTS.MISSIONS,
      'transfer.to': account,
      after
    }),
    getActions(account, { filter: `${CONTRACTS.MINING}:mine`, after })
  ])
  const divisions = rewards.reduce((n, a) => n + parseAsset(String(a.act.data.quantity ?? '0 TLM')).amount * timesRun(a), 0)

  const cache = bountyCache()
  const trxIds = [...new Set(mines.filter((a) => a.act.data.miner === account).map((a) => a.trx_id))]
  const missing = trxIds.filter((t) => !cache.has(t))
  let pending = 0
  for (let i = 0; i < missing.length; i += AT_ONCE) {
    const found = await Promise.all(missing.slice(i, i + AT_ONCE).map((t) => bountyOf(t, account).catch(() => null)))
    found.forEach((b, k) => {
      if (b === null) pending++
      else cache.set(missing[i + k], b)
    })
  }
  if (missing.length) saveBounties()
  const mining = trxIds.reduce((n, t) => n + (cache.get(t) ?? 0), 0)
  return { divisions, mining, pending }
}

export function useTodayEarnings(account: string | null): UseQueryResult<TodayEarnings> {
  return useQuery({
    queryKey: ['today-earnings', account],
    queryFn: () => fetchToday(account!),
    enabled: !!account,
    staleTime: 30_000,
    refetchInterval: 90_000
  })
}

/** After a claim or a mine: read again now, and once more when the history nodes have caught up. */
export function refreshToday(account: string | null) {
  const go = () => queryClient.invalidateQueries({ queryKey: ['today-earnings', account] })
  void go()
  setTimeout(() => void go(), 5000)
}
