import type { AnyAction } from '@wharfkit/session'

import { claimMission } from '@/chain/actions/pd'
import { CONTRACTS } from '@/chain/config'
import { getRows } from '@/chain/rpc'
import type { Deployment } from '@/data/game'
import type { DivLockRow } from '@/data/types'

/*
 * A loop claims every division that is back in its first transaction and sends the others back
 * out one transaction each (the contract takes one join per transaction). A join sent while the
 * division's lock is still there is refused ("division already engaged in this mission. Claim it
 * first"). That happens when the claim went through the wallet's node and the join, a moment later,
 * reaches a node that has not applied it yet, or when the claim was dropped before it reached a
 * block. So every later join first waits for the chain to show the claim; if it never does, the
 * claim did not land, and that transaction claims the division itself before sending it out.
 */

/** How long a join waits for the claim before it to show on the chain, and how often it looks. */
const CLAIM_WAIT_MS = 10_000
const CLAIM_POLL_MS = 1_000

/** Whether this division is still locked on this mission after waiting for its claim (the claim removes the lock). */
export async function stillLocked(account: string, d: Pick<Deployment, 'missionId' | 'divisionId'>): Promise<boolean> {
  const until = Date.now() + CLAIM_WAIT_MS
  for (;;) {
    const rows = await getRows<DivLockRow>({ code: CONTRACTS.CORE, table: 'divlocks', scope: account }).catch(() => null)
    const locked = !rows || rows.some((l) => Number(l.division_id) === d.divisionId && Number(l.mission_id) === d.missionId)
    if (!locked) return false
    // A read that failed is no proof the claim is missing: then the join goes as planned.
    if (Date.now() >= until) return !!rows
    await new Promise((res) => setTimeout(res, CLAIM_POLL_MS))
  }
}

/** The claim to put in front of a later join, when the chain still shows the division locked. */
export async function claimIfStillLocked(a: string, p: string, d: Pick<Deployment, 'missionId' | 'divisionId'>): Promise<AnyAction[]> {
  return (await stillLocked(a, d)) ? [claimMission(a, p, d.missionId, d.divisionId)] : []
}
