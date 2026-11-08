import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { getActions, timesRun } from '@/chain/history'
import { parseAsset } from '@/lib/format'
import { FLOW_TOKENS, PD_CONTRACTS, type FlowToken } from '@/lib/flow'

/*
 * What the project's own wallets do with TLM and DEF outside gameplay: every transfer of the
 * treasury (planetarydef, which received the DEF minted on 15 Oct 2026), sorted into kinds by who
 * is on the other side. Its history is small (hundreds of transfers), so it is read whole.
 */

/** The project's wallets followed here. */
export const TREASURY = 'planetarydef'

export type MoveKind = 'mint' | 'fund' | 'dex' | 'pool' | 'fromgame' | 'wallets'

export const MOVE_LABEL: Record<MoveKind, string> = {
  mint: 'Newly minted',
  fund: 'Funding received',
  dex: 'Alcor',
  pool: 'Reward pool top-up',
  fromgame: 'From the game contracts',
  wallets: 'Paid to wallets'
}

export interface TreasuryMove {
  t: number
  gs: number
  dir: 'in' | 'out'
  kind: MoveKind
  /** The other side of the transfer. */
  who: string
  amount: number
  memo: string
  trx: string
}

const PD = new Set<string>(PD_CONTRACTS)
/** Alcor's swap, DEX and wrapping contracts. */
const isAlcor = (a: string) => a.startsWith('alcor') || a.endsWith('.alcor')

function kindOf(dir: 'in' | 'out', who: string, token: FlowToken): MoveKind {
  if (dir === 'in' && who === FLOW_TOKENS[token].contract) return 'mint'
  if (isAlcor(who)) return 'dex'
  if (PD.has(who)) return dir === 'in' ? 'fromgame' : 'pool'
  return dir === 'in' ? 'fund' : 'wallets'
}

async function fetchTreasury(token: FlowToken): Promise<TreasuryMove[]> {
  const t = FLOW_TOKENS[token]
  const actions = await getActions(TREASURY, { filter: `${t.contract}:transfer` }, 20)
  const seen = new Set<number>()
  const out: TreasuryMove[] = []
  for (const a of actions) {
    const d = a.act.data
    const q = parseAsset(String(d.quantity ?? ''))
    if (q.symbol !== t.symbol || !(q.amount > 0)) continue
    const from = String(d.from ?? '')
    const to = String(d.to ?? '')
    if (from !== TREASURY && to !== TREASURY) continue
    const gs = Number(a.global_sequence ?? 0)
    if (seen.has(gs)) continue
    seen.add(gs)
    const dir = to === TREASURY ? 'in' : 'out'
    const who = dir === 'in' ? from : to
    out.push({
      t: Date.parse(a['@timestamp'].endsWith('Z') ? a['@timestamp'] : `${a['@timestamp']}Z`),
      gs,
      dir,
      kind: kindOf(dir, who, token),
      who,
      amount: q.amount * timesRun(a),
      memo: String(d.memo ?? ''),
      trx: a.trx_id
    })
  }
  return out.sort((a, b) => a.t - b.t)
}

export function useTreasury(token: FlowToken): UseQueryResult<TreasuryMove[]> {
  return useQuery({ queryKey: ['treasury', token], staleTime: 10 * 60_000, queryFn: () => fetchTreasury(token) })
}
