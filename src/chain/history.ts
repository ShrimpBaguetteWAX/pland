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

/** The node that answered last: tried first, so a dead node's timeout is not paid on every request. */
let lastGood: string | null = null

function nodesInOrder(): string[] {
  const now = Date.now()
  const healthy = HISTORY_NODES.filter((u) => (penalties.get(u) ?? 0) < now)
  const pool = healthy.length ? healthy : HISTORY_NODES
  const start = cursor++ % pool.length
  const order = [...pool.slice(start), ...pool.slice(0, start)]
  return lastGood && order.includes(lastGood) ? [lastGood, ...order.filter((u) => u !== lastGood)] : order
}

/**
 * Some nodes answer at most 100 actions a request (HTTP 500 "limit too big, maximum: 100"). That
 * is remembered per node and the request asked again with their size, instead of benching a
 * healthy node.
 */
const nodeMax = new Map<string, number>()
class LimitError extends Error {
  constructor(readonly max: number) {
    super(`page too big for this node, maximum ${max}`)
  }
}
/** The page size to ask `base` for, at most `want`. */
const sizeFor = (base: string, want: number) => Math.min(want, nodeMax.get(base) ?? want)

async function getJson<T>(base: string, path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(base + path, { signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const max = /limit too big, maximum: (\d+)/.exec(body)
      if (max) {
        nodeMax.set(base, Number(max[1]))
        throw new LimitError(Number(max[1]))
      }
      throw new Error(`HTTP ${res.status}`)
    }
    const json = (await res.json()) as T
    lastGood = base
    return json
  } catch (err) {
    if (!(err instanceof LimitError)) penalties.set(base, Date.now() + PENALTY_MS)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** One request, asked again at once with the node's own page size if it says the page is too big. */
async function getPage(base: string, query: Record<string, string>, want: number): Promise<{ actions: HistoryAction[]; size: number }> {
  for (let i = 0; i < 2; i++) {
    const size = sizeFor(base, want)
    try {
      const j = await getJson<{ actions?: HistoryAction[] }>(base, `/v2/history/get_actions?${new URLSearchParams({ ...query, limit: String(size) })}`)
      return { actions: j.actions ?? [], size }
    } catch (err) {
      if (!(err instanceof LimitError) || i > 0) throw err
    }
  }
  throw new Error('unreachable')
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
export async function getActions(account: string, params: Record<string, string>, maxPages = MAX_PAGES): Promise<HistoryAction[]> {
  const errors: string[] = []
  for (const base of nodesInOrder()) {
    try {
      const out: HistoryAction[] = []
      // Up to maxPages × 1,000 actions; a node with smaller pages just takes more of them.
      while (out.length < maxPages * PAGE) {
        const { actions, size } = await getPage(base, { account, skip: String(out.length), sort: 'asc', ...params }, PAGE)
        out.push(...actions)
        if (actions.length < size) break
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
 * One page of actions, for callers that pace their own requests and walk a long history
 * themselves; `size` is the page size the node used (a shorter page than that is the end). Asks
 * for `params.limit` (default 1,000), less where a node allows less. Fails over to the next node.
 */
export async function getActionsChunk(account: string, params: Record<string, string>): Promise<{ actions: HistoryAction[]; size: number }> {
  const errors: string[] = []
  const { limit, ...rest } = params
  const want = Number(limit) || PAGE
  for (const base of nodesInOrder()) {
    try {
      return await getPage(base, { account, sort: 'asc', ...rest }, want)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`History request failed: ${errors.join('; ')}`)
}

