import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'

import { BUY_MARKETPLACE, listSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicAsset, type AtomicSale } from '@/chain/atomic'
import { offeredAssetIds } from '@/chain/offers'
import { formatNumber } from '@/lib/format'
import { imageSources } from '@/lib/ipfs'
import { shortDuration } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { MARKET_FEES, waxOf } from './Chests'

/*
 * Couch mode's Sell tab, its Sold half: your AtomicMarket sales of the last 48 hours, every collection. Where you
 * have none of what sold listed right now and still hold at least two (so one always stays), one
 * tap lists the next one, or one button lists the next of each in one transaction: the
 * highest mint number first (low mints are the ones worth keeping), at the lowest listing of its
 * kind, or at the price it just sold for when nobody lists it. Through shop.ale, like every listing
 * of this site.
 */

/** How far back the list goes. */
const WINDOW_MS = 48 * 3600_000
/** Read 100 sales a page, newest first, until one is older than the window; at most this many pages. */
const MAX_PAGES = 30

/** Every sale of the account within the window, newest first. */
async function salesSince(account: string, since: number): Promise<AtomicSale[]> {
  const out: AtomicSale[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await atomic.getSales({ state: 3, seller: account, symbol: 'WAX', sort: 'updated', order: 'desc', limit: 100, page }, 1)
    const fresh = batch.filter((x) => Number(x.updated_at_time ?? 0) >= since)
    out.push(...fresh)
    if (batch.length < 100 || fresh.length < batch.length) break
  }
  const seen = new Set<string>()
  return out.filter((x) => !seen.has(x.sale_id) && seen.add(x.sale_id))
}

const nameOf = (a: AtomicAsset | undefined) => String(a?.data?.name ?? (a?.template ? `#${a.template.template_id}` : 'NFT'))
const mintOf = (a: AtomicAsset) => Number(a.template_mint ?? 0) || 0

export function Sales({ account, head }: { account: string; head?: ReactNode }) {
  const { run, pending, spectating } = useTransaction()
  const sold = useQuery({
    queryKey: ['couch-sales', account],
    queryFn: () => salesSince(account, Date.now() - WINDOW_MS),
    staleTime: 60_000,
    refetchInterval: 120_000
  })
  const collections = useMemo(() => [...new Set((sold.data ?? []).map((s) => s.collection_name))].sort(), [sold.data])
  // What you still hold of each collection that sold, and what of it is offered (listed) right now.
  const owned = useQuery({
    queryKey: ['couch-sales-owned', account, collections.join(',')],
    enabled: collections.length > 0,
    queryFn: async () => (await Promise.all(collections.map((c) => atomic.getOwnedAssets(account, c).catch(() => [] as AtomicAsset[])))).flat(),
    staleTime: 60_000
  })
  const offered = useQuery({ queryKey: ['sell-offered', account], queryFn: () => offeredAssetIds(account), staleTime: 30_000 })
  /** Listed from this page just now: left out at once, before the chain is read again. */
  const [justListed, setJustListed] = useState<Set<string>>(() => new Set())

  /** Free copies of each template, highest mint first. */
  /** Templates with a listing of yours right now (or one just listed here). */
  const listedTemplates = useMemo(() => {
    const m = new Set<string>()
    for (const a of owned.data ?? [])
      if (a.template && (offered.data?.has(a.asset_id) || justListed.has(a.asset_id))) m.add(a.template.template_id)
    return m
  }, [owned.data, offered.data, justListed])
  const free = useMemo(() => {
    const m = new Map<string, AtomicAsset[]>()
    for (const a of owned.data ?? []) {
      const t = a.template?.template_id
      if (!t || a.is_transferable === false || offered.data?.has(a.asset_id) || justListed.has(a.asset_id)) continue
      m.set(t, [...(m.get(t) ?? []), a])
    }
    for (const list of m.values()) list.sort((x, y) => mintOf(y) - mintOf(x))
    return m
  }, [owned.data, offered.data, justListed])

  const restock = useMemo(
    () => [...new Set((sold.data ?? []).flatMap((s) => (s.assets.length === 1 && s.assets[0].template ? [s.assets[0].template.template_id] : [])))].filter((t) => (free.get(t)?.length ?? 0) >= 2 && !listedTemplates.has(t)),
    [sold.data, free, listedTemplates]
  )
  /** Where the next one lists: the lowest listing of its kind, or what it last sold for. */
  const lastSold = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of sold.data ?? []) {
      const t = x.assets.length === 1 ? x.assets[0].template?.template_id : undefined
      if (t && !m.has(t)) m.set(t, waxOf(x))
    }
    return m
  }, [sold.data])
  const floors = useQuery({
    queryKey: ['couch-sales-floors', [...restock].sort().join(',')],
    enabled: restock.length > 0,
    queryFn: () => atomic.getCheapestListings(restock),
    staleTime: 30_000
  })

  async function listNext(s: AtomicSale, next: AtomicAsset, price: number) {
    const t = s.assets[0].template!.template_id
    const ok = await run(
      (a, p) => listSalesActions(a, p, [{ assetId: next.asset_id, priceWax: price }], BUY_MARKETPLACE),
      `Listed ${nameOf(next)} #${mintOf(next)} at ${formatNumber(price, 2)} WAX`,
      `sales-list-${t}`
    )
    if (!ok) return
    setJustListed((x) => new Set([...x, next.asset_id]))
    void offered.refetch()
  }

  /** The next of every template shown with a List button, all in one transaction. */
  async function listAll() {
    const items = restock.map((t) => ({ t, next: free.get(t)![0], price: floors.data?.get(t) ?? lastSold.get(t)! }))
    if (!items.length) return
    const ok = await run(
      (a, p) => listSalesActions(a, p, items.map((x) => ({ assetId: x.next.asset_id, priceWax: x.price })), BUY_MARKETPLACE),
      `Listed ${items.length}: the next of each, at the lowest listing`,
      'sales-list-all'
    )
    if (!ok) return
    setJustListed((x) => new Set([...x, ...items.map((i) => i.next.asset_id)]))
    void offered.refetch()
  }
  const allWax = restock.reduce((n, t) => n + (floors.data?.get(t) ?? lastSold.get(t) ?? 0), 0)

  const busy = !!pending && pending.startsWith('sales-')
  const total = (sold.data ?? []).reduce((n, s) => n + waxOf(s) * (1 - MARKET_FEES - (Number(s.current_collection_fee ?? 0) || 0)), 0)

  return (
    <section className="couch__bankpage couch__chests" aria-label="Sold in the last 48 hours">
      {head}
      <div className="cb__plaque cb__rate">
        <small>Sold in the last 48 hours</small>
        <span>
          <b className="num">{sold.data ? sold.data.length : '…'}</b>
          <i>≈ {formatNumber(total, 0)} WAX to you</i>
        </span>
      </div>
      <p className="cb__note">
        Everything you sold on AtomicMarket in the last 48 hours, every collection. Where you hold more, list the next one: the highest mint first, at the lowest listing of
        its kind (or the price it sold for when nobody lists it), through shop.ale. Shown where none of it is listed and you hold at least two.
      </p>

      <button type="button" className="cb__go" disabled={spectating || busy || !restock.length || !floors.data} onClick={() => void listAll()}>
        {pending === 'sales-list-all'
          ? 'Signing…'
          : restock.length
            ? `List the next of each · ${restock.length} for ${formatNumber(allWax, 2)} WAX`
            : 'Nothing to list again'}
        <small>{restock.length ? 'one transaction, the highest mint of each, through shop.ale' : 'everything that sold is listed already, or you hold fewer than two'}</small>
      </button>

      <ul className="cm__rows">
        {(sold.data ?? []).map((s) => {
          const a = s.assets[0]
          const single = s.assets.length === 1
          const t = single ? a?.template?.template_id : undefined
          const price = waxOf(s)
          const when = Number(s.updated_at_time ?? 0)
          const more = t ? (free.get(t) ?? []) : []
          const next = t && restock.includes(t) ? more[0] : undefined
          const listAt = t ? (floors.data?.get(t) ?? price) : price
          const fromFloor = !!t && floors.data?.has(t)
          const srcs = [
            ...(s.collection_name === 'alien.worlds' && t ? [`./img/aw-cards/${t}.webp`] : []),
            ...(a?.data?.img ? imageSources(String(a.data.img)) : [])
          ]
          return (
            <li key={s.sale_id} className="cb__plaque cm__row cs__row">
              <Pic srcs={srcs} />
              <span className="cm__name">
                <b>{single ? nameOf(a) : `${s.assets.length} NFTs`}</b>
                <small>
                  {when ? `${shortDuration(Date.now() - when)} ago` : ''}
                  {single && a?.template_mint ? ` · #${a.template_mint}` : ''}
                  {t && owned.data ? ` · ${listedTemplates.has(t) ? 'one listed' : more.length ? `${more.length} held` : 'none left'}` : ''}
                </small>
              </span>
              <span className="cm__low num">
                <b>{formatNumber(price, 2)}</b>
                <small>sold</small>
              </span>
              {next && (
                <span className="cm__acts">
                  <button
                    type="button"
                    disabled={spectating || busy || (t !== undefined && !floors.data && restock.includes(t))}
                    title={`Lists #${mintOf(next)} (the highest mint you hold free) at ${formatNumber(listAt, 2)} WAX, ${fromFloor ? 'the lowest listing now' : 'what it sold for: nobody lists it'}`}
                    onClick={() => void listNext(s, next, listAt)}
                  >
                    {pending === `sales-list-${t}` ? '…' : `List #${mintOf(next)}`}
                    <small className="num">{formatNumber(listAt, 2)}</small>
                  </button>
                </span>
              )}
            </li>
          )
        })}
        {sold.data && !sold.data.length && <p className="cb__note">Nothing sold in the last 48 hours.</p>}
        {!sold.data && <p className="cb__note">Reading your sales…</p>}
      </ul>
      {spectating && <p className="cb__note">Read-only: not your account.</p>}
    </section>
  )
}

/** A picture that tries its sources in turn and shows a plain square when none loads. */
function Pic({ srcs }: { srcs: string[] }) {
  const [i, setI] = useState(0)
  if (i >= srcs.length) return <i />
  return <img src={srcs[i]} alt="" loading="lazy" onError={() => setI((n) => n + 1)} />
}
