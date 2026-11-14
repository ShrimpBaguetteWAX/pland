import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { atomic } from '@/chain/atomic'
import { CONTRACTS } from '@/chain/config'
import { getActions, getTransactionActions, timesRun, type HistoryAction } from '@/chain/history'
import { getRows } from '@/chain/rpc'

/*
 * Everything an account spent on Planetary Defense and everything it got back, from the chain:
 *
 *  spent   NFTs bought on AtomicMarket (collection planetdefnft), Forge levels (TLM) and slots
 *          (DEF), mission entry fees (TLM or DEF)
 *  earned  mission rewards (TLM, DEF), the old game's rewards (magordefense, narondefense), NFTs
 *          sold on AtomicMarket or to a template buy offer (after fees)
 *
 * Token swaps are not counted: they only change what the money is held in.
 *
 * Since the contracts' update of 7 Nov 2026 the game balance on core.pdef sits in between: rewards
 * are credited to it (miss.pdef → core.pdef, memo "credit:<player>") and entry fees taken from it
 * (core.pdef → miss.pdef, which does not name the player). Credits are read and the player's kept;
 * an entry fee taken from the balance is the player's own join valued at the mission's entry cost.
 * Deposits to and withdrawals from the balance only move the player's own money, so they are not
 * counted either.
 */

export type Category = 'nft' | 'forge-level' | 'forge-slot' | 'forge-other' | 'entry' | 'mission' | 'v2' | 'sale' | 'def-buy' | 'def-sell'
export type Token = 'WAX' | 'TLM' | 'DEF'

export interface LedgerEntry {
  id: string
  /** ms since epoch */
  time: number
  category: Category
  direction: 'in' | 'out'
  token: Token
  amount: number
  note: string
}

export const CATEGORY_LABEL: Record<Category, string> = {
  nft: 'NFTs bought',
  'forge-level': 'Forge levels',
  'forge-slot': 'Forge slots',
  'forge-other': 'Forge, other',
  entry: 'Mission entry fees',
  mission: 'Mission rewards',
  v2: 'Old game rewards (V2)',
  sale: 'NFTs sold',
  'def-buy': 'DEF bought on Alcor',
  'def-sell': 'DEF sold on Alcor'
}

const COLLECTION = 'planetdefnft'
/** The old game's contracts that paid rewards. */
const V2_CONTRACTS = ['magordefense', 'narondefense']
/** AtomicMarket's cut on a sale besides the collection fee: 1% each to the listing and the buying marketplace. */
const MARKETPLACE_FEES = 0.02
/** Pages of 1,000 actions the ledger reads per query: a whole history, not the usual 10,000 (read oldest first, the newest would drop off). */
const LEDGER_HISTORY_PAGES = 50
/** Pages of 100 sales the ledger reads each way. */
const LEDGER_SALE_PAGES = 100
const TOKEN_FILTER = 'alien.worlds:transfer,defensetoken:transfer'
/** When the game balance began paying entries and taking rewards (the contracts' update). */
const BALANCE_SINCE = '2026-11-07T19:15:00Z'

const chainTime = (iso: string) => Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`)

function tokenOf(quantity: unknown): { amount: number; token: Token } | null {
  const [num, sym] = String(quantity ?? '').split(' ')
  if (sym !== 'TLM' && sym !== 'DEF' && sym !== 'WAX') return null
  return { amount: Number(num), token: sym }
}

function transferEntry(a: HistoryAction, category: Category, direction: 'in' | 'out', note: string): LedgerEntry | null {
  const q = tokenOf(a.act.data.quantity)
  if (!q || !(q.amount > 0)) return null
  // Identical transfers in one transaction (a claim of several divisions) come back as one action.
  const times = timesRun(a)
  return {
    // One entry per action: a transaction claiming several divisions pays several equal transfers.
    id: `${a.trx_id}:${a.global_sequence ?? a.action_ordinal ?? ''}:${a.act.account}:${category}:${q.amount}`,
    time: chainTime(a['@timestamp']),
    category,
    direction,
    token: q.token,
    amount: q.amount * times,
    note: times > 1 ? `${note} (${times} × ${q.amount} ${q.token})` : note
  }
}

interface EntryCostRow {
  mission_id: number | string
  cost: string
}

/**
 * The game balance's part: rewards credited to it (everyone's credits are read, the history nodes
 * cannot filter by memo, and the player's kept) and entry fees taken from it, one per join of the
 * player's that did not pay from the wallet in the same transaction, at the mission's entry cost
 * per division (the entry cost table as it is now: costs rarely change).
 */
async function balanceEntries(account: string, walletEntryTrx: Set<string>): Promise<LedgerEntry[]> {
  const [credits, joins, costs] = await Promise.all([
    getActions(CONTRACTS.CORE, { filter: TOKEN_FILTER, 'transfer.from': CONTRACTS.MISSIONS, 'transfer.to': CONTRACTS.CORE, after: BALANCE_SINCE }, LEDGER_HISTORY_PAGES),
    getActions(account, { filter: `${CONTRACTS.MISSIONS}:join`, after: BALANCE_SINCE }, LEDGER_HISTORY_PAGES),
    getRows<EntryCostRow>({ code: CONTRACTS.MISSIONS, table: 'entrycosts', limit: 1000 }).catch(() => [] as EntryCostRow[])
  ])
  const out: LedgerEntry[] = []
  const memo = `credit:${account}`
  for (const a of credits) {
    if (String(a.act.data.memo ?? '') !== memo) continue
    const e = transferEntry(a, 'mission', 'in', 'Mission reward, to the game balance')
    if (e) out.push(e)
  }
  const costOf = new Map<number, { amount: number; token: Token }[]>()
  for (const row of costs) {
    const q = tokenOf(row.cost)
    if (!q || !(q.amount > 0)) continue
    const id = Number(row.mission_id)
    costOf.set(id, [...(costOf.get(id) ?? []), q])
  }
  for (const a of joins) {
    if (a.act.account !== CONTRACTS.MISSIONS || a.act.name !== 'join' || String(a.act.data.owner ?? '') !== account) continue
    if (walletEntryTrx.has(a.trx_id)) continue
    const mission = Number(a.act.data.mission_id)
    const n = Array.isArray(a.act.data.division_ids) ? a.act.data.division_ids.length : 1
    for (const c of costOf.get(mission) ?? [])
      out.push({
        id: `join:${a.trx_id}:${a.global_sequence ?? ''}:${c.token}`,
        time: chainTime(a['@timestamp']),
        category: 'entry',
        direction: 'out',
        token: c.token,
        amount: c.amount * n,
        note: `Entry, mission ${mission}, from the game balance${n > 1 ? ` (${n} divisions)` : ''}`
      })
  }
  return out
}

async function tokenEntries(account: string): Promise<LedgerEntry[]> {
  const [fromMissions, toMissions, toForge, ...fromV2] = await Promise.all([
    getActions(account, { filter: TOKEN_FILTER, 'transfer.from': CONTRACTS.MISSIONS, 'transfer.to': account }, LEDGER_HISTORY_PAGES),
    getActions(account, { filter: TOKEN_FILTER, 'transfer.from': account, 'transfer.to': CONTRACTS.MISSIONS }, LEDGER_HISTORY_PAGES),
    getActions(account, { filter: TOKEN_FILTER, 'transfer.from': account, 'transfer.to': CONTRACTS.FORGE }, LEDGER_HISTORY_PAGES),
    ...V2_CONTRACTS.map((c) =>
      getActions(account, { filter: 'alien.worlds:transfer', 'transfer.from': c, 'transfer.to': account }, LEDGER_HISTORY_PAGES)
    )
  ])
  const out: LedgerEntry[] = []
  for (const a of fromMissions) {
    const e = transferEntry(a, 'mission', 'in', String(a.act.data.memo ?? 'Mission reward'))
    if (e) out.push(e)
  }
  for (const a of toMissions) {
    const memo = String(a.act.data.memo ?? '')
    const e = transferEntry(a, 'entry', 'out', memo.startsWith('entry:') ? `Entry, mission ${memo.slice(6)}` : memo)
    if (e) out.push(e)
  }
  for (const a of toForge) {
    const memo = String(a.act.data.memo ?? '')
    const e = memo.startsWith('forge:')
      ? transferEntry(a, 'forge-level', 'out', `Forge level ${memo.slice(6)}`)
      : memo.startsWith('shop:')
        ? transferEntry(a, 'forge-slot', 'out', `Shop item ${memo.slice(5)}`)
        : transferEntry(a, 'forge-other', 'out', memo || 'Forge')
    if (e) out.push(e)
  }
  for (const list of fromV2)
    for (const a of list) {
      const e = transferEntry(a, 'v2', 'in', String(a.act.data.memo ?? 'Planetary Defense V2'))
      if (e) out.push(e)
    }
  // The game balance: rewards credited to it and entry fees taken from it.
  const walletEntryTrx = new Set(toMissions.map((a) => a.trx_id))
  out.push(...(await balanceEntries(account, walletEntryTrx)))
  return out
}

async function marketEntries(account: string): Promise<LedgerEntry[]> {
  const [bought, sold] = await Promise.all([
    // A whole history: up to 10,000 sales each way, not the market's usual 2,000 (which, sorted by
    // price, would drop the most expensive ones).
    atomic.getSales({ state: 3, buyer: account, collection_name: COLLECTION }, LEDGER_SALE_PAGES),
    atomic.getSales({ state: 3, seller: account, collection_name: COLLECTION }, LEDGER_SALE_PAGES)
  ])
  const amountOf = (s: (typeof bought)[number]) => Number(s.price.amount) / 10 ** s.price.token_precision
  const nameOf = (s: (typeof bought)[number]) =>
    s.assets.map((a) => String(a.data?.name ?? a.template?.template_id ?? a.asset_id)).join(', ')
  const out: LedgerEntry[] = []
  for (const s of bought) {
    if (s.price.token_symbol !== 'WAX') continue
    out.push({
      id: `buy:${s.sale_id}`,
      time: Number(s.updated_at_time),
      category: 'nft',
      direction: 'out',
      token: 'WAX',
      amount: amountOf(s),
      note: nameOf(s)
    })
  }
  for (const s of sold) {
    if (s.price.token_symbol !== 'WAX') continue
    const fee = Number(s.current_collection_fee ?? 0) + MARKETPLACE_FEES
    out.push({
      id: `sell:${s.sale_id}`,
      time: Number(s.updated_at_time),
      category: 'sale',
      direction: 'in',
      token: 'WAX',
      amount: amountOf(s) * (1 - fee),
      note: nameOf(s)
    })
  }
  return out
}

/**
 * NFTs sold to buy offers. AtomicMarket's buy-offer API does not answer, so these come from the
 * chain: every WAX payment from AtomicMarket marked as a buy offer (already after fees), kept when
 * the NFT that left the wallet in the same transaction belongs to this collection.
 */
async function buyofferEntries(account: string): Promise<LedgerEntry[]> {
  const payments = (
    await getActions(account, { filter: 'eosio.token:transfer', 'transfer.from': 'atomicmarket', 'transfer.to': account }, LEDGER_HISTORY_PAGES)
  ).filter((a) => /buyoff/i.test(String(a.act.data.memo ?? '')))
  // Five transactions at a time: quick, and gentle on the history nodes.
  const recent = payments.slice(-100)
  const found: (LedgerEntry | null)[] = []
  for (let i = 0; i < recent.length; i += 5)
    found.push(...(await Promise.all(recent.slice(i, i + 5).map((pay) => buyofferEntry(account, pay)))))
  return found.filter((e): e is LedgerEntry => !!e)
}

/** One buy-offer payment as a sale, when the NFT it paid for is from this collection. */
async function buyofferEntry(account: string, pay: HistoryAction): Promise<LedgerEntry | null> {
  const actions = await getTransactionActions(pay.trx_id).catch(() => [] as HistoryAction[])
  // The NFT leaves through an offer AtomicMarket accepts, not a plain transfer; the chain logs
  // that move (logtransfer) with the collection, which is what decides whether it counts.
  const moved = actions.filter(
    (a) => a.act.account === 'atomicassets' && a.act.name === 'logtransfer' && a.act.data.from === account
  )
  if (!moved.some((a) => a.act.data.collection_name === COLLECTION)) return null
  const ids = moved.flatMap((a) => (a.act.data.asset_ids as string[] | undefined) ?? [])
  const assets = await atomic.getAssetsByIds(ids).catch(() => [])
  const names = assets.map((x) => String(x.data?.name ?? x.asset_id)).join(', ') || ids.join(', ')
  return transferEntry(pay, 'sale', 'in', `Buy offer: ${names}`)
}

/**
 * DEF bought and sold on Alcor. DEF itself is not money the ledger counts: what counts is the WAX
 * or TLM paid for it when it is bought, and the WAX or TLM it brings when it is sold. Every token
 * moving between the account and Alcor's swap contract is summed per transaction (an exact-out buy
 * gets its change back in the same transaction); a transaction that gains DEF for WAX or TLM is a
 * buy, one that gives DEF for WAX or TLM a sale. Anything else (adding liquidity) is left out.
 */
async function swapEntries(account: string): Promise<LedgerEntry[]> {
  const filter = 'eosio.token:transfer,alien.worlds:transfer,defensetoken:transfer'
  const [sent, got] = await Promise.all([
    getActions(account, { filter, 'transfer.from': account, 'transfer.to': CONTRACTS.ALCOR_SWAP }, LEDGER_HISTORY_PAGES),
    getActions(account, { filter, 'transfer.from': CONTRACTS.ALCOR_SWAP, 'transfer.to': account }, LEDGER_HISTORY_PAGES)
  ])
  const byTrx = new Map<string, { time: number; net: Record<Token, number> }>()
  const add = (a: HistoryAction, sign: 1 | -1) => {
    const q = tokenOf(a.act.data.quantity)
    // Only the real tokens: a fake "TLM" or "DEF" from another contract does not count.
    const real = { WAX: 'eosio.token', TLM: 'alien.worlds', DEF: 'defensetoken' } as const
    if (!q || a.act.account !== real[q.token]) return
    const t = byTrx.get(a.trx_id) ?? { time: chainTime(a['@timestamp']), net: { WAX: 0, TLM: 0, DEF: 0 } }
    t.net[q.token] += sign * q.amount * timesRun(a)
    byTrx.set(a.trx_id, t)
  }
  for (const a of sent) add(a, -1)
  for (const a of got) add(a, 1)
  const out: LedgerEntry[] = []
  const eps = 1e-9
  for (const [trx, { time, net }] of byTrx) {
    const def = net.DEF
    const paid = (['WAX', 'TLM'] as const).filter((k) => net[k] < -eps)
    const received = (['WAX', 'TLM'] as const).filter((k) => net[k] > eps)
    if (def > eps && paid.length && !received.length)
      for (const k of paid)
        out.push({ id: `${trx}:def-buy:${k}`, time, category: 'def-buy', direction: 'out', token: k, amount: -net[k], note: `Bought ${formatDef(def)} DEF` })
    else if (def < -eps && received.length && !paid.length)
      for (const k of received)
        out.push({ id: `${trx}:def-sell:${k}`, time, category: 'def-sell', direction: 'in', token: k, amount: net[k], note: `Sold ${formatDef(-def)} DEF` })
  }
  return out
}

const formatDef = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** Every entry for an account, oldest first. */
export async function fetchLedger(account: string): Promise<LedgerEntry[]> {
  const [tokens, market, buyoffers, swaps] = await Promise.all([
    tokenEntries(account),
    marketEntries(account),
    buyofferEntries(account).catch(() => [] as LedgerEntry[]),
    swapEntries(account)
  ])
  const seen = new Set<string>()
  return [...tokens, ...market, ...buyoffers, ...swaps].filter((e) => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => a.time - b.time)
}

export function useLedger(account: string | null): UseQueryResult<LedgerEntry[]> {
  return useQuery({
    queryKey: ['ledger', account],
    enabled: !!account,
    staleTime: 10 * 60_000,
    queryFn: () => fetchLedger(account!)
  })
}

// ---- Prices over time ---------------------------------------------------------------------------------

/** Daily USD prices, oldest first, as [ms, usd]. */
export interface PriceHistory {
  wax: [number, number][]
  tlm: [number, number][]
}

const PRICE_STORE = 'pd.price-history.v1'
const PRICE_MAX_AGE_MS = 6 * 3600_000

async function coingecko(id: string): Promise<[number, number][]> {
  const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`)
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`)
  const j = (await res.json()) as { prices?: [number, number][] }
  if (!j.prices?.length) throw new Error('CoinGecko: no prices')
  return j.prices
}

/**
 * WAX and TLM in USD, day by day for the last year (CoinGecko), kept for six hours so the page
 * does not ask again on every visit. DEF is not listed there; it is converted through Alcor.
 */
export function usePriceHistory(): UseQueryResult<PriceHistory> {
  return useQuery({
    queryKey: ['price-history'],
    staleTime: PRICE_MAX_AGE_MS,
    retry: 1,
    queryFn: async () => {
      try {
        const saved = JSON.parse(localStorage.getItem(PRICE_STORE) ?? 'null') as (PriceHistory & { at: number }) | null
        if (saved && Date.now() - saved.at < PRICE_MAX_AGE_MS) return { wax: saved.wax, tlm: saved.tlm }
      } catch {
        // No storage: ask again.
      }
      const [wax, tlm] = await Promise.all([coingecko('wax'), coingecko('alien-worlds')])
      try {
        localStorage.setItem(PRICE_STORE, JSON.stringify({ at: Date.now(), wax, tlm }))
      } catch {
        // Not stored: the next visit asks again.
      }
      return { wax, tlm }
    }
  })
}

/** The price on the day of \`time\` (the last point at or before it; the oldest one for earlier days). */
export function priceAt(series: [number, number][], time: number): number | null {
  if (!series.length) return null
  let lo = 0
  let hi = series.length - 1
  if (time <= series[0][0]) return series[0][1]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid][0] <= time) lo = mid
    else hi = mid - 1
  }
  return series[lo][1]
}
