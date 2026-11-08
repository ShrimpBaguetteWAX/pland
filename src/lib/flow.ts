/*
 * The token flow of the Planetary Defense contracts (TLM or DEF): every transfer touching one of them, sorted
 * into money coming in from outside, money going out, and transfers between PD's own contracts
 * (internal, kept out of the in and out lines so nothing counts twice).
 */

/** The tokens the page follows, and the contract each lives on (defensetoken also mints DEF). */
export const FLOW_TOKENS = {
  TLM: { symbol: 'TLM', contract: 'alien.worlds', digits: 0 },
  DEF: { symbol: 'DEF', contract: 'defensetoken', digits: 2 }
} as const
export type FlowToken = keyof typeof FLOW_TOKENS

/** One transfer, as stored: amounts already multiplied by how often it really ran. */
export interface FlowTransfer {
  /** ms */
  t: number
  /** global sequence, unique per action: the same transfer seen from two contracts is one. */
  gs: number
  from: string
  to: string
  amount: number
  /** How many identical transfers Hyperion folded into this one (claims batched in a transaction). */
  times: number
  memo: string
  trx: string
}

export const PD_CONTRACTS = ['core.pdef', 'miss.pdef', 'forge.pdef', 'siege.pdef', 'planet.pdef', 'ascend.pdef'] as const
/** Where campaign entries end up; whether it counts as PD is the player's choice on the page. */
export const ALIENS = 'aliens.pdef'
/** Every account whose history is read. */
export const FLOW_ACCOUNTS = [...PD_CONTRACTS, ALIENS]
/** The contract that holds and pays the player rewards. */
export const REWARD_POOL = 'miss.pdef'

export type FlowDir = 'in' | 'out' | 'internal'

export interface FlowCategory {
  id: string
  name: string
  dir: FlowDir
  /** Colour token on the page. */
  color: string
}

export const CATEGORIES: FlowCategory[] = [
  { id: 'deposit', name: 'Game balance deposits', dir: 'in', color: 'var(--fl-in)' },
  { id: 'entry', name: 'Entry fees paid directly', dir: 'in', color: 'var(--fl-s3)' },
  { id: 'forge', name: 'Forge levels', dir: 'in', color: 'var(--fl-s4)' },
  { id: 'slot', name: 'Forge slots', dir: 'in', color: 'var(--fl-s4)' },
  { id: 'siege-fund', name: 'Campaign funding', dir: 'in', color: 'var(--fl-s6)' },
  { id: 'mint', name: 'Newly minted', dir: 'in', color: 'var(--fl-in)' },
  { id: 'fund', name: 'Reward pool top-ups', dir: 'in', color: 'var(--fl-s5)' },
  { id: 'siege-in', name: 'Campaign entries', dir: 'in', color: 'var(--fl-s6)' },
  { id: 'other-in', name: 'Other', dir: 'in', color: 'var(--fl-s7)' },
  { id: 'reward', name: 'Mission rewards', dir: 'out', color: 'var(--fl-out)' },
  { id: 'withdraw', name: 'Balance withdrawals', dir: 'out', color: 'var(--fl-s4)' },
  { id: 'siege-out', name: 'Campaign payouts', dir: 'out', color: 'var(--fl-s6)' },
  { id: 'aliens', name: 'To aliens.pdef', dir: 'out', color: 'var(--fl-s5)' },
  { id: 'other-out', name: 'Other', dir: 'out', color: 'var(--fl-s7)' },
  { id: 'internal', name: 'Between PD contracts', dir: 'internal', color: 'var(--text-faint)' }
]
export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]))

export interface FlowOptions {
  /** Contracts counted (the rest are treated like outside accounts). */
  contracts: Set<string>
  /** aliens.pdef counts as part of PD. */
  aliensInside: boolean
}

export interface Classified {
  dir: FlowDir
  category: string
  /** The PD contract it went into or came out of (for internal: the sender). */
  contract: string
  /** The outside account (for internal: the receiving contract). */
  account: string
}

/** Which side of the line a transfer falls on, and why; null when it doesn't touch a counted contract. */
export function classify(x: FlowTransfer, o: FlowOptions): Classified | null {
  const inside = (a: string) => o.contracts.has(a) || (o.aliensInside && a === ALIENS)
  const fromIn = inside(x.from)
  const toIn = inside(x.to)
  if (fromIn && toIn) return { dir: 'internal', category: 'internal', contract: x.from, account: x.to }
  const memo = x.memo.toLowerCase()
  if (toIn) {
    const c = x.to
    const category =
      x.from === FLOW_TOKENS.DEF.contract
        ? 'mint'
        : c === 'core.pdef' && memo === 'deposit'
          ? 'deposit'
          : c === 'miss.pdef' && memo.startsWith('entry:')
            ? 'entry'
            : c === 'miss.pdef' && memo.includes('reward')
              ? 'fund'
              : c === 'forge.pdef' && memo.startsWith('forge:')
                ? 'forge'
                : c === 'forge.pdef' && memo.startsWith('shop:')
                  ? 'slot'
                  : c === 'siege.pdef' && memo.startsWith('join:')
                    ? 'siege-in'
                    : c === 'siege.pdef' && memo.startsWith('unlock:')
                      ? 'siege-fund'
                      : 'other-in'
    return { dir: 'in', category, contract: c, account: x.from }
  }
  if (fromIn) {
    const c = x.from
    const category =
      x.to === ALIENS
        ? 'aliens'
        : c === 'miss.pdef' && memo.includes('reward')
          ? 'reward'
          : c === 'core.pdef' && memo.includes('withdraw')
            ? 'withdraw'
            : c === 'siege.pdef'
              ? 'siege-out'
              : 'other-out'
    return { dir: 'out', category, contract: c, account: x.to }
  }
  return null
}

/** Local day (midnight, ms) of a time. */
export const dayOf = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
/** Local day as YYYY-MM-DD, the cache key. */
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** The next local midnight (handles daylight-saving days). */
export const nextDay = (day: number) => {
  const d = new Date(day)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

export interface Bucket {
  t: number
  end: number
  inBy: Record<string, number>
  outBy: Record<string, number>
  internal: number
  inSum: number
  outSum: number
  /** What the reward pool held at the end of the bucket (null when unknown). */
  pool: number | null
}

/**
 * Totals per day (or week of seven days) between from and to, plus the reward pool at the end of
 * each, worked back from its balance now: every later transfer into it is taken off again and
 * every later one out of it added back.
 */
export function aggregate(
  transfers: FlowTransfer[],
  o: FlowOptions & { from: number; to: number; week: boolean; showInternal: boolean; account: string; poolNow: number | null }
): Bucket[] {
  const days: number[] = []
  for (let d = dayOf(o.from); d <= o.to; d = nextDay(d)) days.push(d)
  const starts = o.week ? days.filter((_, i) => i % 7 === 0) : days
  const buckets: Bucket[] = starts.map((t, i) => ({
    t,
    end: i + 1 < starts.length ? starts[i + 1] : nextDay(days.at(-1)!),
    inBy: {},
    outBy: {},
    internal: 0,
    inSum: 0,
    outSum: 0,
    pool: null
  }))
  const at = (t: number) => {
    let lo = 0
    let hi = buckets.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (buckets[mid].t <= t) lo = mid
      else hi = mid - 1
    }
    return buckets[lo]
  }
  const who = o.account.trim().toLowerCase()
  for (const x of transfers) {
    if (x.t < buckets[0]?.t || x.t >= buckets.at(-1)!.end) continue
    const c = classify(x, o)
    if (!c) continue
    if (who && !c.account.includes(who) && !x.from.includes(who) && !x.to.includes(who)) continue
    const b = at(x.t)
    if (c.dir === 'in') b.inBy[c.category] = (b.inBy[c.category] ?? 0) + x.amount
    else if (c.dir === 'out') b.outBy[c.category] = (b.outBy[c.category] ?? 0) + x.amount
    else b.internal += x.amount
  }
  for (const b of buckets) {
    const internal = o.showInternal ? b.internal : 0
    b.inSum = Object.values(b.inBy).reduce((n, v) => n + v, 0) + internal
    b.outSum = Object.values(b.outBy).reduce((n, v) => n + v, 0) + internal
  }
  // The reward pool, walked back from now.
  if (o.poolNow !== null) {
    const sorted = transfers.filter((x) => x.to === REWARD_POOL || x.from === REWARD_POOL).sort((a, b) => b.t - a.t)
    let bal = o.poolNow
    let k = 0
    for (let i = buckets.length - 1; i >= 0; i--) {
      const end = buckets[i].end
      while (k < sorted.length && sorted[k].t >= end) {
        const x = sorted[k++]
        if (x.to === REWARD_POOL) bal -= x.amount
        if (x.from === REWARD_POOL) bal += x.amount
      }
      buckets[i].pool = bal
    }
  }
  return buckets
}

export interface FlowRow extends FlowTransfer, Classified {}

/** The transfers of a time span that count under the options, for the breakdown and the raw table. */
export function rowsIn(
  transfers: FlowTransfer[],
  o: FlowOptions & { showInternal: boolean; account: string },
  from: number,
  to: number
): FlowRow[] {
  const who = o.account.trim().toLowerCase()
  const out: FlowRow[] = []
  for (const x of transfers) {
    if (x.t < from || x.t >= to) continue
    const c = classify(x, o)
    if (!c || (c.dir === 'internal' && !o.showInternal)) continue
    if (who && !c.account.includes(who) && !x.from.includes(who) && !x.to.includes(who)) continue
    out.push({ ...x, ...c })
  }
  return out
}
