import { CORS_SAFE_CONTENT_TYPE, RPC_NODES } from './config'

export interface EndpointHealth {
  url: string
  /** Round-trip time of the probe, in ms. */
  latency: number
  /** How far the node's head block lagged behind real time, in seconds. */
  lag: number
  ok: boolean
  error?: string
}

export interface PoolStatus {
  state: 'idle' | 'probing' | 'ready' | 'offline'
  healthy: EndpointHealth[]
  all: EndpointHealth[]
  probedAt: number
}

/** First pass: a node that can't answer get_info in a second isn't worth reading from. */
const PROBE_TIMEOUT_MS = 1_000
/** Patient second pass, only when the quick one found nothing (slow mobile connections). */
const SLOW_PROBE_TIMEOUT_MS = 4_000
/** A node this far behind head serves stale reads. */
const MAX_LAG_SECONDS = 120
const REPROBE_INTERVAL_MS = 10 * 60 * 1000
/** Reads rotate across the fastest N nodes. */
const ROTATION_SIZE = 6
/** How long a node stays benched after failing a real request. */
const PENALTY_MS = 60_000
/** When every node is benched, the soonest the whole list is probed again. */
const REPROBE_AFTER_FAILURE_MS = 30_000

type Listener = (status: PoolStatus) => void

/**
 * A live, ranked set of WAX nodes. Every candidate is probed at boot, survivors
 * are ranked by latency, and reads round-robin across the fastest few so one
 * slow or dead node can't stall the site.
 */
export class EndpointPool {
  private candidates: string[]
  private health = new Map<string, EndpointHealth>()
  private ranked: string[] = []
  /** Browser clock minus chain clock, in ms, from the last probe. */
  clockSkewMs = 0
  private cursor = 0
  private penalties = new Map<string, number>()
  private inflight: Promise<PoolStatus> | null = null
  private probedAt = 0
  private lastForcedProbe = 0
  private state: PoolStatus['state'] = 'idle'
  private listeners = new Set<Listener>()

  constructor(candidates: readonly string[] = RPC_NODES) {
    this.candidates = [...candidates]
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.status())
    return () => this.listeners.delete(fn)
  }

  status(): PoolStatus {
    return {
      state: this.state,
      healthy: this.ranked.map((url) => this.health.get(url)!),
      all: this.candidates.map((url) => this.health.get(url) ?? { url, latency: Infinity, lag: Infinity, ok: false }),
      probedAt: this.probedAt
    }
  }

  private emit() {
    const s = this.status()
    for (const fn of this.listeners) fn(s)
  }

  /** Probe every candidate in parallel; concurrent callers share one run. */
  probe(force = false): Promise<PoolStatus> {
    if (this.inflight) return this.inflight
    if (!force && this.probedAt && Date.now() - this.probedAt < REPROBE_INTERVAL_MS) {
      return Promise.resolve(this.status())
    }

    this.state = 'probing'
    this.emit()

    const usable = (results: EndpointHealth[]) =>
      results
        .filter((r) => r.ok && r.lag <= MAX_LAG_SECONDS)
        .sort((a, b) => a.latency - b.latency)
        .map((r) => r.url)

    this.inflight = this.sweep(PROBE_TIMEOUT_MS)
      .then((quick) => (usable(quick).length > 0 ? quick : this.sweep(SLOW_PROBE_TIMEOUT_MS)))
      .then((results) => {
        for (const r of results) this.health.set(r.url, r)
        this.ranked = usable(results)
        // How far this browser's clock runs ahead of the chain (negative: behind). The smallest lag
        // over the healthy nodes: the node that answered fastest is the one closest to the truth.
        const lags = results.filter((r) => r.ok && Number.isFinite(r.lag)).map((r) => r.lag)
        if (lags.length) this.clockSkewMs = Math.min(...lags) * 1000
        this.cursor = 0
        this.penalties.clear()
        this.probedAt = Date.now()
        this.state = this.ranked.length > 0 ? 'ready' : 'offline'
        this.emit()
        return this.status()
      })
      .finally(() => {
        this.inflight = null
      })

    return this.inflight
  }

  private sweep(timeoutMs: number): Promise<EndpointHealth[]> {
    return Promise.all(this.candidates.map((url) => this.probeOne(url, timeoutMs)))
  }

  private async probeOne(url: string, timeoutMs: number): Promise<EndpointHealth> {
    const started = performance.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${url}/v1/chain/get_info`, {
        method: 'POST',
        headers: { 'Content-Type': CORS_SAFE_CONTENT_TYPE },
        body: '{}',
        signal: controller.signal
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const info = await res.json()
      const latency = performance.now() - started
      const head = Date.parse(`${info.head_block_time}Z`)
      const lag = Number.isFinite(head) ? (Date.now() - head) / 1000 : Infinity
      return { url, latency, lag, ok: true }
    } catch (err) {
      return { url, latency: Infinity, lag: Infinity, ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  get isReady(): boolean {
    return this.ranked.length > 0
  }

  /** Next node, round-robining the fastest few and skipping benched ones. */
  next(exclude?: Set<string>): string {
    const pool = (this.ranked.length ? this.ranked : this.candidates).filter((u) => !exclude?.has(u))
    if (pool.length === 0) return this.candidates[this.cursor++ % this.candidates.length]

    if (this.ranked.length === 0) return pool[this.cursor++ % pool.length]

    const window = pool.slice(0, Math.min(ROTATION_SIZE, pool.length))
    const now = Date.now()
    for (let i = 0; i < window.length; i++) {
      const url = window[(this.cursor + i) % window.length]
      if ((this.penalties.get(url) ?? 0) < now) {
        this.cursor = (this.cursor + i + 1) % window.length
        return url
      }
    }
    return pool.find((u) => (this.penalties.get(u) ?? 0) < now) ?? window[0]
  }

  /** Preferred node first, then the rest by rank. */
  failoverOrder(limit = 3, exclude?: Set<string>): string[] {
    const first = this.next(exclude)
    const rest = (this.ranked.length ? this.ranked : this.candidates).filter((u) => u !== first && !exclude?.has(u))
    return [first, ...rest].slice(0, limit)
  }

  /**
   * Bench a node that just failed a real request. When none is left, probe the whole list again,
   * but at most every REPROBE_AFTER_FAILURE_MS: while offline, every failed read lands here, and
   * each forced probe asks all the nodes.
   */
  penalize(url: string) {
    const now = Date.now()
    this.penalties.set(url, now + PENALTY_MS)
    const alive = this.ranked.some((u) => (this.penalties.get(u) ?? 0) < now)
    if (!alive && now - this.lastForcedProbe >= REPROBE_AFTER_FAILURE_MS) {
      this.lastForcedProbe = now
      void this.probe(true)
    }
  }
}

export const endpointPool = new EndpointPool()

/** The current time as the chain sees it: what decides whether a lock has passed. */
export const chainNow = () => Date.now() - endpointPool.clockSkewMs
