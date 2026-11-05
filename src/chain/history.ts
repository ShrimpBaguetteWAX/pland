/*
 * Hyperion (action history) client: which transfers an account made or received, and the actions
 * of one transaction. Rotation and failover like the other clients: a failing node is benched for
 * a minute, and a query is paged from one node so pages never mix.
 */

const HISTORY_NODES = [
  'https://wax.eosusa.io',
  'https://wax.cryptolions.io',
  'https://api.waxsweden.org',
  'https://hyperion.wax.detroitledger.tech',
  'https://wax-history.eosdac.io'
]

const TIMEOUT_MS = 20_000
const PENALTY_MS = 60_000
/** Hyperion's page size limit. */
const PAGE = 1000
/** Pages per query at most (10 000 actions). */
const MAX_PAGES = 10

const penalties = new Map<string, number>()
let cursor = 0

function nodesInOrder(): string[] {
  const now = Date.now()
  const healthy = HISTORY_NODES.filter((u) => (penalties.get(u) ?? 0) < now)
  const pool = healthy.length ? healthy : HISTORY_NODES
  const start = cursor++ % pool.length
  return [...pool.slice(start), ...pool.slice(0, start)]
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(base + path, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    penalties.set(base, Date.now() + PENALTY_MS)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export interface HistoryAction {
  '@timestamp': string
  trx_id: string
  /** Unique per action on the chain (several claims in one transaction each have their own). */
  global_sequence?: number
  action_ordinal?: number
  /** One receipt per execution and notified account (see timesRun). */
  receipts?: { receiver: string; global_sequence?: number | string }[]
  act: { account: string; name: string; data: Record<string, unknown> }
}

/**
 * How many times an action really ran. Hyperion folds identical actions of one transaction into a
 * single entry (fourteen claims paying 5 TLM each come back as one transfer), keeping one receipt
 * per execution for the contract and each account it notified; the contract's own receipts count.
 */
export const timesRun = (a: HistoryAction) => a.receipts?.filter((r) => r.receiver === a.act.account).length || 1

/**
 * Every action matching the query, oldest first. `params` are Hyperion's own, for example
 * { filter: 'alien.worlds:transfer', 'transfer.to': 'forge.pdef' }.
 */
export async function getActions(account: string, params: Record<string, string>): Promise<HistoryAction[]> {
  const errors: string[] = []
  for (const base of nodesInOrder()) {
    try {
      const out: HistoryAction[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ account, limit: String(PAGE), skip: String(page * PAGE), sort: 'asc', ...params })
        const j = await getJson<{ actions?: HistoryAction[] }>(base, `/v2/history/get_actions?${query}`)
        const batch = j.actions ?? []
        out.push(...batch)
        if (batch.length < PAGE) break
      }
      return out
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`History request failed: ${errors.join('; ')}`)
}

/** Every action of one transaction. */
export async function getTransactionActions(trxId: string): Promise<HistoryAction[]> {
  const errors: string[] = []
  for (const base of nodesInOrder()) {
    try {
      const j = await getJson<{ actions?: HistoryAction[] }>(base, `/v2/history/get_transaction?id=${trxId}`)
      return j.actions ?? []
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`History request failed: ${errors.join('; ')}`)
}

/**
 * One page of actions (up to Hyperion's PAGE), for callers that pace their own requests and walk
 * a long history themselves. Fails over to the next node like getActions.
 */
export async function getActionsPage(account: string, params: Record<string, string>): Promise<HistoryAction[]> {
  const errors: string[] = []
  for (const base of nodesInOrder()) {
    try {
      const query = new URLSearchParams({ account, limit: String(PAGE), sort: 'asc', ...params })
      const j = await getJson<{ actions?: HistoryAction[] }>(base, `/v2/history/get_actions?${query}`)
      return j.actions ?? []
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`History request failed: ${errors.join('; ')}`)
}

/** Actions per page from getActionsPage. */
export const HISTORY_PAGE = PAGE
