import { ATOMIC_NODES } from './config'

/*
 * AtomicAssets client: rotation and failover like the chain client, but plain GETs.
 * A node that fails is benched for a minute.
 */

type Params = Record<string, string | number | undefined>

const REQUEST_TIMEOUT_MS = 10_000
const PENALTY_MS = 60_000

const penalties = new Map<string, number>()
/** Smoothed response time per node (ms). Requests go to the fast ones; slow ones are the fallback. */
const latency = new Map<string, number>()
/** A node counts as fast when it answers within this factor of the fastest one (plus a little slack). */
const FAST_FACTOR = 2
const FAST_SLACK_MS = 150

function recordLatency(base: string, ms: number) {
  const prev = latency.get(base)
  latency.set(base, prev === undefined ? ms : prev * 0.7 + ms * 0.3)
}
let cursor = 0

/*
 * Some public nodes stop indexing yet keep answering, with sales that sold months ago. Every node's
 * /health says how far its reader is behind the chain; nodes more than a few minutes behind are left
 * out. Checked once at start and then every five minutes.
 *
 * A node can also index assets live while its market index is stuck (the Alien Worlds node's sales
 * stopped 20 days back while its /health read 0 lag). So each node's newest sale is compared with
 * the freshest node's; one far behind is left out of market reads only.
 */
const MAX_LAG_BLOCKS = 600 // five minutes of WAX blocks
const HEALTH_EVERY_MS = 5 * 60_000
/** How far a node's newest sale may trail the freshest node's before its market data is not trusted. */
const MAX_MARKET_LAG_MS = 15 * 60_000
/** A node that cannot answer its health questions this fast counts as behind until the next check. */
const HEALTH_TIMEOUT_MS = 3_000
const HEALTH_STORE = 'pd.atomic-health.v1'
let stale = new Set<string>()
let marketStale = new Set<string>()
let healthAt = 0
let healthCheck: Promise<void> | null = null

async function lagOf(base: string): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  const started = performance.now()
  try {
    const res = await fetch(base + '/health', { signal: controller.signal })
    recordLatency(base, performance.now() - started)
    const json = await res.json()
    const head = Number(json?.data?.chain?.head_block)
    const read = Math.max(...(json?.data?.postgres?.readers ?? []).map((r: { block_num: string }) => Number(r.block_num)))
    return Number.isFinite(head) && Number.isFinite(read) ? head - read : Infinity
  } catch {
    return Infinity
  } finally {
    clearTimeout(timer)
  }
}

/** When the newest open sale on a node was listed (ms), or -Infinity when it cannot say. */
async function newestSaleOf(base: string): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  const started = performance.now()
  try {
    const res = await fetch(base + '/atomicmarket/v2/sales?state=1&sort=created&order=desc&limit=1', {
      signal: controller.signal
    })
    recordLatency(base, performance.now() - started)
    const json = await res.json()
    const created = Number(json?.data?.[0]?.created_at_time)
    return Number.isFinite(created) ? created : -Infinity
  } catch {
    return -Infinity
  } finally {
    clearTimeout(timer)
  }
}

// A reload within five minutes reuses the last check instead of waiting for a new one.
try {
  const saved = JSON.parse(localStorage.getItem(HEALTH_STORE) ?? 'null') as {
    at: number
    stale: string[]
    marketStale: string[]
  } | null
  if (saved && Date.now() - saved.at < HEALTH_EVERY_MS) {
    stale = new Set(saved.stale)
    marketStale = new Set(saved.marketStale)
    healthAt = saved.at
  }
} catch {
  // No storage (private window, blocked site data): check again.
}

/** Once this many nodes have answered, the check waits at most HEALTH_GRACE_MS for the rest. */
const HEALTH_QUORUM = 2
const HEALTH_GRACE_MS = 1_000

type HealthRow = readonly [node: string, lag: number, newest: number]

/** Sets the stale lists from the answers so far; a node that has not answered yet counts as behind. */
function applyHealth(rows: HealthRow[], final: boolean) {
  const answered = new Set(rows.map(([u]) => u))
  const missing = ATOMIC_NODES.filter((u) => !answered.has(u))
  // Never leave out every node: if all look behind, trust them all rather than none.
  const keep = (set: Set<string>) => (set.size < ATOMIC_NODES.length ? set : new Set<string>())
  stale = keep(new Set([...rows.filter(([, lag]) => lag > MAX_LAG_BLOCKS).map(([u]) => u), ...missing]))
  const freshest = Math.max(...rows.map(([, , newest]) => newest))
  marketStale = keep(
    new Set([...rows.filter(([, , newest]) => newest < freshest - MAX_MARKET_LAG_MS).map(([u]) => u), ...missing])
  )
  healthAt = Date.now()
  if (!final) return
  try {
    localStorage.setItem(HEALTH_STORE, JSON.stringify({ at: healthAt, stale: [...stale], marketStale: [...marketStale] }))
  } catch {
    // Not stored: the next reload checks again.
  }
}

/**
 * Asks every node both questions at once. Reads go ahead as soon as a couple of nodes have answered
 * and a short grace period has passed (a dead node would otherwise hold everything up for the full
 * timeout); the lists are completed when the last node answers or times out.
 */
function checkHealth(): Promise<void> {
  if (Date.now() - healthAt < HEALTH_EVERY_MS) return Promise.resolve()
  healthCheck ??= new Promise<void>((ready) => {
    const rows: HealthRow[] = []
    let released = false
    const release = () => {
      if (released) return
      released = true
      applyHealth(rows, false)
      ready()
    }
    const all = ATOMIC_NODES.map(async (u) => {
      const [lag, newest] = await Promise.all([lagOf(u), newestSaleOf(u)])
      // A node that timed out on both questions has not really answered.
      if (Number.isFinite(lag) || Number.isFinite(newest)) rows.push([u, lag, newest])
      if (rows.length === HEALTH_QUORUM) setTimeout(release, HEALTH_GRACE_MS)
    })
    void Promise.all(all).then(() => {
      applyHealth(rows, true)
      released = true
      ready()
    })
  }).finally(() => (healthCheck = null))
  return healthCheck
}

function nodesInOrder(path: string): string[] {
  const now = Date.now()
  const market = path.startsWith('/atomicmarket/')
  const fresh = ATOMIC_NODES.filter((u) => !stale.has(u) && !(market && marketStale.has(u)))
  const healthy = fresh.filter((u) => (penalties.get(u) ?? 0) < now)
  const pool = healthy.length ? healthy : fresh.length ? fresh : [...ATOMIC_NODES]
  // Fastest first. Requests rotate among the nodes about as fast as the fastest, spreading the load
  // without handing a slow node an equal share; the rest follow as fallbacks.
  const ms = (u: string) => latency.get(u) ?? 1_000
  const bySpeed = [...pool].sort((a, b) => ms(a) - ms(b))
  const limit = ms(bySpeed[0]) * FAST_FACTOR + FAST_SLACK_MS
  const fast = bySpeed.filter((u) => ms(u) <= limit)
  const rest = bySpeed.filter((u) => ms(u) > limit)
  const start = cursor++ % fast.length
  return [...fast.slice(start), ...fast.slice(0, start), ...rest]
}

const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

function toQuery(params: Params): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const s = query.toString()
  return s ? `?${s}` : ''
}

async function getFrom<T>(base: string, path: string, outside?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  outside?.addEventListener('abort', () => controller.abort())
  const started = performance.now()
  try {
    const res = await fetch(base + path, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (json?.success === false) throw new Error(json?.message ?? 'Atomic API error')
    recordLatency(base, performance.now() - started)
    return json.data as T
  } catch (err) {
    if (outside?.aborted) throw err
    penalties.set(base, Date.now() + PENALTY_MS)
    recordLatency(base, REQUEST_TIMEOUT_MS)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Never hedge sooner than this: a normal answer from a good node can take a few hundred ms. */
const HEDGE_MIN_MS = 700

/**
 * Asks the fastest node; when it has not answered within about three times its usual time, asks
 * the next one as well and takes whichever answers first (the other request is cancelled). A node
 * that fails hands over to the next at once. This bounds how long one slow node can hold a page up.
 */
async function get<T>(path: string): Promise<T> {
  await checkHealth()
  const order = nodesInOrder(path)
  return new Promise<T>((resolve, reject) => {
    const cancel = new AbortController()
    const errors: string[] = []
    let next = 0
    let running = 0
    let settled = false
    const finish = () => {
      settled = true
      clearTimeout(hedge)
      cancel.abort()
    }
    const launch = (): boolean => {
      if (settled || next >= order.length) return false
      const base = order[next++]
      running++
      getFrom<T>(base, path, cancel.signal).then(
        (value) => {
          if (settled) return
          finish()
          resolve(value)
        },
        (err) => {
          running--
          if (settled) return
          errors.push(err instanceof Error ? err.message : String(err))
          if (!launch() && running === 0) {
            finish()
            reject(new Error(`AtomicAssets request failed: ${errors.join('; ')}`))
          }
        }
      )
      return true
    }
    launch()
    // Answers always arrive asynchronously, so finish() never runs before this is set.
    const hedge = setTimeout(() => launch(), Math.max(HEDGE_MIN_MS, 3 * (latency.get(order[0]) ?? 300)))
  })
}

/** A lagging node answers an empty list rather than failing, so ask the next node before believing it. */
async function getNonEmpty<T>(path: string): Promise<T[]> {
  await checkHealth()
  let last: T[] = []
  let answered = false
  let tried = 0
  const errors: string[] = []
  for (const base of nodesInOrder(path)) {
    try {
      last = await getFrom<T[]>(base, path)
      answered = true
      if (last.length > 0) return last
    } catch (err) {
      // A node that cannot answer is not a node saying no.
      errors.push(err instanceof Error ? err.message : String(err))
    }
    if (++tried >= 3) break
  }
  // Silence from every node is a failure to retry, not an empty wallet.
  if (!answered) throw new Error(`AtomicAssets request failed: ${errors.join('; ')}`)
  return last
}

export interface AtomicAsset {
  asset_id: string
  owner: string
  collection: { collection_name: string }
  schema: { schema_name: string }
  template: { template_id: string } | null
  data: Record<string, unknown>
  is_transferable?: boolean
}

export interface AtomicTemplate {
  template_id: string
  schema: { schema_name: string }
  immutable_data: Record<string, unknown>
  issued_supply: string
  /** "0" means uncapped. */
  max_supply: string
}

/** An AtomicMarket sale as the v2 API returns it (state 1 = listed). */
export interface AtomicSale {
  sale_id: string
  seller: string
  listing_price: string
  listing_symbol: string
  price: { token_contract: string; token_symbol: string; token_precision: number; amount: string }
  assets: AtomicAsset[]
  collection_name: string
  /** When it last changed state (ms, as a string): for a sold one, when it sold. */
  updated_at_time?: string
  /** The collection's cut at the time of the sale (0.05 = 5%). */
  current_collection_fee?: number | string
}

/** An open AtomicMarket buy offer, ready to be accepted. */
export interface BuyOffer {
  id: string
  /** On a template (anyone holding it can sell), or on one specific NFT. */
  kind: 'template' | 'asset'
  /** WAX offered. */
  wax: number
  /** Raw price in WAX's smallest unit, exactly as offered: the sale asserts it. */
  amount: string
  /** The collection's cut (0.05 = 5%). */
  collectionFee: number
  /** The NFT the offer is for (asset offers only). */
  assetId?: string
}

interface OfferRow {
  buyoffer_id: string
  buyer: string
  template?: { template_id: string } | null
  assets?: { asset_id: string }[]
  price: { token_symbol: string; token_precision: number; amount: string }
  collection?: { market_fee?: number | string }
}

const offerOf = (r: OfferRow, kind: BuyOffer['kind']): BuyOffer | null =>
  r.price.token_symbol !== 'WAX' || r.price.token_precision !== 8
    ? null
    : {
        id: String(r.buyoffer_id),
        kind,
        wax: Number(r.price.amount) / 1e8,
        amount: String(r.price.amount),
        collectionFee: Number(r.collection?.market_fee ?? 0)
      }

/** What a template actually sold for lately (AtomicMarket's own statistics), in WAX. */
export interface TemplatePrice {
  templateId: string
  /** AtomicMarket's suggested median: the median of recent sales, less swayed by old ones. */
  median: number
  sales: number
}

/**
 * Reads every page from one node, so pages from nodes at different points in time never mix.
 * Moves to the next node, from the first page again, when one fails.
 */
async function getPaged<T>(pathOf: (page: number) => string, maxPages: number, pageSize: number): Promise<T[]> {
  await checkHealth()
  const errors: string[] = []
  for (const base of nodesInOrder(pathOf(1))) {
    try {
      const out: T[] = []
      for (let page = 1; page <= maxPages; page++) {
        const batch = await getFrom<T[]>(base, pathOf(page))
        out.push(...batch)
        if (batch.length < pageSize) break
      }
      return out
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`AtomicAssets request failed: ${errors.join('; ')}`)
}

/** Sale pages per query at most (2 000 listings). */
const MAX_SALE_PAGES = 20
/** Requests in flight at once for sale pages, across every query: gentle on the public nodes. */
const MAX_IN_FLIGHT = 8
let inFlight = 0
const waiting: (() => void)[] = []

/** Runs `fn` when fewer than MAX_IN_FLIGHT limited requests are running. */
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  // A finished request hands its slot straight to the next waiting one, so the cap always holds.
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve))
  else inFlight++
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else inFlight--
  }
}

const inflight = new Map<string, Promise<AtomicAsset[]>>()

export const atomic = {
  /** Assets by id, batched into one request per 100 ids; identical concurrent batches share a request. */
  async getAssetsByIds(ids: string[]): Promise<AtomicAsset[]> {
    const unique = [...new Set(ids.filter((id) => id && id !== '0'))].sort()
    const out: AtomicAsset[] = []
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100)
      const key = chunk.join(',')
      let request = inflight.get(key)
      if (!request) {
        request = getNonEmpty<AtomicAsset>(`/atomicassets/v1/assets${toQuery({ ids: key, limit: chunk.length })}`).finally(() =>
          inflight.delete(key)
        )
        inflight.set(key, request)
      }
      out.push(...(await request))
    }
    return out
  },

  /** Every template of a collection, with its mint count and cap. */
  getTemplates(collection: string): Promise<AtomicTemplate[]> {
    return getPaged(
      (page) => `/atomicassets/v1/templates${toQuery({ collection_name: collection, limit: 1000, page })}`,
      10,
      1000
    )
  },

  /**
   * Every open sale matching `params` (collection, schema or template ids), cheapest first. Nodes
   * return at most 100 per page, so the count is asked first and the pages are fetched together,
   * spread over the healthy nodes (at most MAX_IN_FLIGHT requests at once across the whole app).
   * A last page that comes back full means listings were added meanwhile: reading continues.
   */
  async getSales(params: Params): Promise<AtomicSale[]> {
    const path = (page: number) =>
      `/atomicmarket/v2/sales${toQuery({ state: 1, limit: 100, page, sort: 'price', order: 'asc', ...params })}`
    const count = await limited(() => get<string | number>(`/atomicmarket/v2/sales/_count${toQuery({ state: 1, ...params })}`))
      .then(Number)
      .catch(() => NaN)
    // Without a count, fall back to reading page after page from one node.
    if (!Number.isFinite(count)) return getPaged(path, MAX_SALE_PAGES, 100)
    const pages = Math.min(MAX_SALE_PAGES, Math.ceil(count / 100))
    const batches = await Promise.all(Array.from({ length: pages }, (_, i) => limited(() => get<AtomicSale[]>(path(i + 1)))))
    for (let page = pages + 1; page <= MAX_SALE_PAGES && (batches[batches.length - 1]?.length ?? 0) === 100; page++)
      batches.push(await limited(() => get<AtomicSale[]>(path(page))))
    // Pages can come from different nodes, so a sale may show up twice at a page boundary.
    const seen = new Set<string>()
    return batches.flat().filter((sale) => !seen.has(sale.sale_id) && seen.add(sale.sale_id))
  },

  /** Recent sale prices of every template in a collection that has sold for WAX. */
  async getTemplatePrices(collection: string): Promise<TemplatePrice[]> {
    const rows = await getPaged<{ template_id: string; suggested_median: string; token_precision: number; sales: string }>(
      (page) => `/atomicmarket/v1/prices/templates${toQuery({ collection_name: collection, symbol: 'WAX', limit: 1000, page })}`,
      5,
      1000
    )
    return rows.map((r) => ({
      templateId: r.template_id,
      median: Number(r.suggested_median) / 10 ** r.token_precision,
      sales: Number(r.sales)
    }))
  },

  /** Every asset a wallet holds, in every collection, paged from one node. */
  getAllOwnedAssets(owner: string): Promise<AtomicAsset[]> {
    return getPaged(
      (page) => `/atomicassets/v1/assets${toQuery({ owner, limit: 1000, page, order: 'asc', sort: 'asset_id' })}`,
      30,
      1000
    )
  },

  /**
   * The highest open template buy offer per template: an offer anyone holding the template can
   * accept. Read 100 templates at a time, every offer highest first. The account's own offers are
   * left out (it cannot sell to itself).
   */
  async getTemplateBuyofferTops(templateIds: string[], exceptBuyer?: string): Promise<Map<string, BuyOffer>> {
    const out = new Map<string, BuyOffer>()
    await Promise.all(
      chunks(templateIds, 100).map(async (ids) => {
        const rows = await limited(() =>
          getPaged<OfferRow>(
            (page) =>
              `/atomicmarket/v1/template_buyoffers${toQuery({ state: 0, template_id: ids.join(','), symbol: 'WAX', limit: 100, page, sort: 'price', order: 'desc' })}`,
            20,
            100
          )
        )
        for (const r of rows) {
          const t = r.template?.template_id
          const offer = offerOf(r, 'template')
          if (!t || !offer || r.buyer === exceptBuyer) continue
          if (offer.wax > (out.get(t)?.wax ?? 0)) out.set(t, offer)
        }
      })
    )
    return out
  },

  /** Open buy offers made on the wallet's own NFTs, one NFT each: the best per asset. */
  async getAssetBuyofferTops(seller: string): Promise<Map<string, BuyOffer>> {
    const rows = await getPaged<OfferRow>(
      (page) =>
        `/atomicmarket/v1/buyoffers${toQuery({ state: 0, seller, symbol: 'WAX', limit: 100, page, sort: 'price', order: 'desc' })}`,
      10,
      100
    )
    const out = new Map<string, BuyOffer>()
    for (const r of rows) {
      const offer = offerOf(r, 'asset')
      if (!offer || r.assets?.length !== 1) continue
      const id = String(r.assets[0].asset_id)
      if (offer.wax > (out.get(id)?.wax ?? 0)) out.set(id, { ...offer, assetId: id })
    }
    return out
  },

  /** The cheapest WAX listing per template, 100 templates at a time. */
  async getCheapestListings(templateIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    await Promise.all(
      chunks(templateIds, 100).map(async (ids) => {
        const rows = await limited(() =>
          get<AtomicSale[]>(
            `/atomicmarket/v1/sales/templates${toQuery({ symbol: 'WAX', template_id: ids.join(','), limit: 100 })}`
          )
        )
        for (const s of rows) {
          const t = s.assets[0]?.template?.template_id
          if (!t || s.assets.length !== 1) continue
          const wax = Number(s.price.amount) / 10 ** s.price.token_precision
          if (!out.has(t) || wax < out.get(t)!) out.set(t, wax)
        }
      })
    )
    return out
  },

  /** Every asset a wallet holds in a collection, paged. */
  async getOwnedAssets(owner: string, collection: string): Promise<AtomicAsset[]> {
    const out: AtomicAsset[] = []
    for (let page = 1; page <= 10; page++) {
      const path = `/atomicassets/v1/assets${toQuery({ owner, collection_name: collection, limit: 1000, page, order: 'desc', sort: 'asset_id' })}`
      const batch = page === 1 ? await getNonEmpty<AtomicAsset>(path) : await get<AtomicAsset[]>(path)
      out.push(...batch)
      if (batch.length < 1000) break
    }
    return out
  }
}
