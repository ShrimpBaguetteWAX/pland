import { useEffect, useState } from 'react'

import { getActionsChunk, timesRun, type HistoryAction } from '@/chain/history'
import { getRows } from '@/chain/rpc'
import { parseAsset } from '@/lib/format'
import { dayKey, dayOf, FLOW_ACCOUNTS, FLOW_TOKENS, nextDay, REWARD_POOL, type FlowToken, type FlowTransfer } from '@/lib/flow'

/*
 * The token flow's data: every transfer of one token (TLM or DEF) of the PD contracts over the days asked for. History is
 * read gently: one request at a time with a pause between them (the history nodes rate-limit),
 * a page of 1 000 transfers each, walking forward in time. Finished days are kept in this browser
 * (IndexedDB), so a second visit only reads today and whatever is missing.
 */

/** Pause between two history requests. */
const GAP_MS = 1000
/**
 * Transfers per request. Half of Hyperion's limit: a full page of 1,000 is about 1 MB, which some
 * nodes cut off mid-answer.
 */
const FLOW_PAGE = 500
/** Tries per page before the read gives up (a node can fail once and answer the next time). */
const TRIES = 3
/** Pauses when a day still fails after its tries: the nodes get time to let up before the read carries on. */
const PAUSES = [15_000, 30_000, 60_000, 90_000]
/** A day counts as finished (safe to keep) this long after it ended: history nodes lag a little. */
const SETTLE_MS = 15 * 60_000

// ---- IndexedDB: one record per finished day, its transfers ------------------------------------

const DB = 'pd-flow'
const STORE = 'days'
let dbp: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}
async function readDay(key: string): Promise<FlowTransfer[] | undefined> {
  const d = await db()
  if (!d) return undefined
  return new Promise((resolve) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as FlowTransfer[] | undefined)
    req.onerror = () => resolve(undefined)
  })
}
async function writeDays(days: Map<string, FlowTransfer[]>) {
  const d = await db()
  if (!d) return
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite')
    for (const [k, v] of days) tx.objectStore(STORE).put(v, k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

/** Days already read this session, so switching ranges back and forth costs nothing. */
const memory = new Map<string, FlowTransfer[]>()

// ---- Reading the history ----------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const iso = (t: number) => new Date(t).toISOString()

function toTransfer(a: HistoryAction, symbol: string): FlowTransfer | null {
  const d = a.act.data
  const q = parseAsset(String(d.quantity ?? ''))
  if (q.symbol !== symbol || !(q.amount > 0)) return null
  const times = timesRun(a)
  const t = Date.parse(a['@timestamp'].endsWith('Z') ? a['@timestamp'] : `${a['@timestamp']}Z`)
  return {
    t,
    gs: Number(a.global_sequence ?? 0),
    from: String(d.from ?? ''),
    to: String(d.to ?? ''),
    amount: q.amount * times,
    times,
    memo: String(d.memo ?? ''),
    trx: a.trx_id
  }
}

export interface FlowProgress {
  /** 0–1 */
  share: number
  label: string
}

/**
 * Reads [from, to) for every flow account, page after page, pausing between requests. `onPage`
 * reports how far it got; `alive` stops it when the page has moved on.
 */
async function readSpan(
  token: FlowToken,
  from: number,
  to: number,
  onProgress: (share: number, label: string) => void,
  alive: () => boolean
): Promise<FlowTransfer[]> {
  const seen = new Set<number>()
  const out: FlowTransfer[] = []
  for (let i = 0; i < FLOW_ACCOUNTS.length; i++) {
    const account = FLOW_ACCOUNTS[i]
    let cursor = from
    for (;;) {
      if (!alive()) return out
      let page: HistoryAction[] = []
      let size = FLOW_PAGE
      for (let attempt = 1; ; attempt++) {
        try {
          ;({ actions: page, size } = await getActionsChunk(account, {
            filter: `${FLOW_TOKENS[token].contract}:transfer`,
            after: iso(cursor),
            before: iso(to),
            limit: String(FLOW_PAGE)
          }))
          break
        } catch (err) {
          if (attempt >= TRIES || !alive()) throw err
          await sleep(GAP_MS * 3 * attempt)
        }
      }
      await sleep(GAP_MS)
      let last = cursor
      for (const a of page) {
        const x = toTransfer(a, FLOW_TOKENS[token].symbol)
        const t = Date.parse(a['@timestamp'].endsWith('Z') ? a['@timestamp'] : `${a['@timestamp']}Z`)
        if (t > last) last = t
        if (!x || seen.has(x.gs)) continue
        seen.add(x.gs)
        out.push(x)
      }
      const covered = Math.min(1, (last - from) / Math.max(1, to - from))
      onProgress(
        (i + (page.length < size ? 1 : covered)) / FLOW_ACCOUNTS.length,
        `${account} · ${new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      )
      // A short page is the end; a full one carries on from its last moment (the same moment
      // may hold more transfers, which the seen-set keeps from counting twice).
      if (page.length < size || last <= cursor) break
      cursor = last
    }
  }
  return out
}

/** The reward pool's balance of the token now. */
async function poolBalance(token: FlowToken): Promise<number | null> {
  try {
    const t = FLOW_TOKENS[token]
    const rows = await getRows<{ balance: string }>({ code: t.contract, table: 'accounts', scope: REWARD_POOL })
    const hit = rows.map((r) => parseAsset(r.balance)).find((a) => a.symbol === t.symbol)
    return hit?.amount ?? 0
  } catch {
    return null
  }
}

export interface FlowData {
  transfers: FlowTransfer[]
  poolNow: number | null
  loading: boolean
  progress: FlowProgress | null
  error: string | null
  /** The first day the data covers. */
  from: number
}

/**
 * Every transfer of the token by the PD contracts from `from` to now. Kept and finished days come from the
 * browser; the rest is read, gently, with progress reported as it goes.
 */
export function useFlowData(token: FlowToken, from: number, round: number): FlowData {
  const [state, setState] = useState<FlowData>({ transfers: [], poolNow: null, loading: true, progress: null, error: null, from })
  useEffect(() => {
    let live = true
    const alive = () => live
    void (async () => {
      setState((s) => ({ ...s, loading: true, error: null, progress: { share: 0, label: 'Opening what this browser kept' } }))
      const now = Date.now()
      const days: number[] = []
      for (let d = dayOf(from); d <= now; d = nextDay(d)) days.push(d)
      // What is kept, then the spans still to read (today is always read again).
      const have = new Map<string, FlowTransfer[]>()
      const keyOf = (t: number) => (token === 'TLM' ? dayKey(t) : `${token}:${dayKey(t)}`)
      for (const d of days) {
        const k = keyOf(d)
        const finished = nextDay(d) + SETTLE_MS < now
        // Refresh (round) keeps finished days too: they cannot change. Only today and missing days are read.
        if (!finished) continue
        const m = memory.get(k) ?? (await readDay(k))
        if (m) {
          have.set(k, m)
          memory.set(k, m)
        }
      }
      // Day by day, oldest first: each finished day is kept the moment it is read, so a pause or a
      // reload loses nothing. When the nodes refuse (they rate-limit), the read waits and carries on
      // by itself, a little longer each time, before it gives up.
      const missing = days.filter((d) => !have.has(keyOf(d)))
      const fresh: FlowTransfer[] = []
      let failures = 0
      for (let i = 0; i < missing.length; ) {
        if (!alive()) return
        const d = missing[i]
        const end = Math.min(nextDay(d), now)
        const dayName = new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        setState((s) => ({ ...s, progress: { share: i / missing.length, label: `Reading ${dayName} · day ${i + 1} of ${missing.length}` } }))
        try {
          const got = await readSpan(
            token,
            d,
            end,
            (share, label) =>
              alive() &&
              setState((s) => ({
                ...s,
                progress: { share: (i + share) / missing.length, label: `Reading ${label} · day ${i + 1} of ${missing.length}` }
              })),
            alive
          )
          if (!alive()) return
          fresh.push(...got)
          if (nextDay(d) + SETTLE_MS < now) {
            memory.set(keyOf(d), got)
            void writeDays(new Map([[keyOf(d), got]]))
          }
          failures = 0
          i++
        } catch (err) {
          if (!alive()) return
          failures++
          if (failures > PAUSES.length) {
            setState((s) => ({
              ...s,
              loading: false,
              progress: null,
              error: `the history nodes kept refusing at ${dayName} (${err instanceof Error ? err.message : String(err)}). The ${i} day${i === 1 ? '' : 's'} read so far are kept; Refresh carries on from there.`
            }))
            return
          }
          const wait = PAUSES[failures - 1]
          setState((s) => ({
            ...s,
            progress: { share: i / missing.length, label: `The history nodes are busy: waiting ${wait / 1000} s, then carrying on from ${dayName} · day ${i + 1} of ${missing.length}` }
          }))
          await sleep(wait)
        }
      }
      try {
        const poolNow = await poolBalance(token)
        if (!alive()) return
        const transfers = [...[...have.values()].flat(), ...fresh].sort((x, y) => x.t - y.t)
        setState({ transfers, poolNow, loading: false, progress: null, error: null, from })
      } catch (err) {
        if (!alive()) return
        setState((s) => ({ ...s, loading: false, progress: null, error: err instanceof Error ? err.message : String(err) }))
      }
    })()
    return () => {
      live = false
    }
  }, [token, from, round])

  return state
}
