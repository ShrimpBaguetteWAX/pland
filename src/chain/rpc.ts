import { CORS_SAFE_CONTENT_TYPE } from './config'
import { endpointPool } from './endpoints'

/*
 * Chain reads on top of the endpoint pool:
 * - the pool picks the node (fastest few, round-robin, failed ones benched);
 * - a per-node token bucket (3 calls per 3 s) keeps any one node from being hammered;
 * - identical concurrent reads share one request;
 * - WAX nodes under load answer with an empty `rows` array rather than an error,
 *   so per-user reads can ask a different node before trusting "nothing there".
 */

const BUCKET_SIZE = 3
const BUCKET_WINDOW_MS = 3000
const REQUEST_TIMEOUT_MS = 8000

const calls = new Map<string, number[]>()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function throttle(url: string) {
  for (;;) {
    const now = Date.now()
    const recent = (calls.get(url) ?? []).filter((t) => now - t < BUCKET_WINDOW_MS)
    if (recent.length < BUCKET_SIZE) {
      recent.push(now)
      calls.set(url, recent)
      return
    }
    calls.set(url, recent)
    await sleep(BUCKET_WINDOW_MS - (now - recent[0]) + 10)
  }
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly attempts: { url: string; error: string }[] = []
  ) {
    super(message)
    this.name = 'ChainError'
  }
}

interface Answer<T> {
  data: T
  url: string
}

async function post<T>(path: string, body: unknown, exclude?: Set<string>): Promise<Answer<T>> {
  const urls = endpointPool.failoverOrder(3, exclude)
  const attempts: { url: string; error: string }[] = []

  for (const url of urls) {
    await throttle(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await fetch(url + path, {
        method: 'POST',
        headers: { 'Content-Type': CORS_SAFE_CONTENT_TYPE },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        const message = json?.error?.details?.[0]?.message ?? json?.message ?? `HTTP ${res.status}`
        // A 4xx other than rate limiting means the request is wrong; another node won't help.
        if (res.status < 500 && res.status !== 429) throw new ChainError(message, attempts)
        throw new Error(message)
      }
      return { data: json as T, url }
    } catch (err) {
      if (err instanceof ChainError) throw err
      attempts.push({ url, error: err instanceof Error ? err.message : String(err) })
      endpointPool.penalize(url)
    } finally {
      clearTimeout(timer)
    }
  }

  throw new ChainError(`All ${urls.length} endpoints failed for ${path}`, attempts)
}

export interface TableQuery {
  code: string
  table: string
  scope?: string
  lower_bound?: string | number
  upper_bound?: string | number
  index_position?: number | string
  key_type?: string
  limit?: number
  reverse?: boolean
}

interface TableResult<T> {
  rows: T[]
  more: boolean
  next_key?: string
}

export interface ReadOptions {
  /** Re-check an empty result on a different node before trusting it. */
  confirmEmpty?: boolean
}

const inflight = new Map<string, Promise<unknown>>()

function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const request = run().finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

const PAGE_SIZE = 1000
/** Guards against a malformed next_key looping forever: 50,000 rows. */
const MAX_PAGES = 50

/**
 * Rows of a table.
 * - With an explicit `limit`: one page, at most that many rows.
 * - Without one: every row. Primary-key reads follow `next_key` page by page, forwards or in
 *   reverse. A node answers at most 1,000 rows per call and only says so with `more`, so a
 *   growing table would otherwise lose rows silently.
 * - Secondary-index reads can't be paged reliably (many rows share one index value), so they stay
 *   one page; in development a cut-off result is reported in the console.
 */
export function getRows<T>(query: TableQuery, options: ReadOptions = {}): Promise<T[]> {
  const body = { json: true, scope: query.code, limit: PAGE_SIZE, ...query }
  const key = JSON.stringify(body) + (options.confirmEmpty ? '!' : '')
  const paged = query.limit === undefined && query.index_position === undefined

  return shared(key, async () => {
    let answer = await post<TableResult<T>>('/v1/chain/get_table_rows', body)
    if (answer.data.rows.length === 0 && options.confirmEmpty) {
      answer = await post<TableResult<T>>('/v1/chain/get_table_rows', body, new Set([answer.url]))
    }

    const rows = [...answer.data.rows]
    let page = answer.data
    for (let n = 1; paged && page.more && page.next_key && n < MAX_PAGES; n++) {
      // Reverse reads walk down from the top, so the next page ends where this one stopped.
      const bound = query.reverse ? { upper_bound: page.next_key } : { lower_bound: page.next_key }
      page = (await post<TableResult<T>>('/v1/chain/get_table_rows', { ...body, ...bound })).data
      rows.push(...page.rows)
    }

    if (import.meta.env.DEV && query.limit === undefined && page.more) {
      console.warn(`${query.code}:${query.table} was cut off after ${rows.length} rows`, query)
    }
    return rows
  })
}

export async function getRow<T>(query: TableQuery, options: ReadOptions = {}): Promise<T | null> {
  const rows = await getRows<T>({ limit: 1, ...query }, options)
  return rows[0] ?? null
}

/** Any node call with the usual failover: JSON in, JSON out (used for dry runs of Alcor loops). */
export async function rpcCall(path: string, body: unknown): Promise<unknown> {
  return (await post<unknown>(path, body)).data
}
