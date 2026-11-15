import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { BUY_MARKETPLACE, listSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicAsset, type AtomicSale } from '@/chain/atomic'
import { offeredAssetIds } from '@/chain/offers'
import { formatNumber } from '@/lib/format'
import { imageSources } from '@/lib/ipfs'
import { shortDuration } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { MARKET_FEES, waxOf } from './Chests'

/*
 * Couch mode's screen left of the orb: your recent AtomicMarket sales, every collection. Where you
 * still hold more of what sold (in the wallet, not listed yet), one tap lists the next one: the
 * highest mint number first (low mints are the ones worth keeping), at the lowest listing of its
 * kind, or at the price it just sold for when nobody lists it. Through shop.ale, like every listing
 * of this site.
 */

const SHOWN = 30

const nameOf = (a: AtomicAsset | undefined) => String(a?.data?.name ?? (a?.template ? `#${a.template.template_id}` : 'NFT'))
const mintOf = (a: AtomicAsset) => Number(a.template_mint ?? 0) || 0

export function Sales({ account }: { account: string }) {
  const { run, pending, spectating } = useTransaction()
  const sold = useQuery({
    queryKey: ['couch-sales', account],
    queryFn: () => atomic.getSales({ state: 3, seller: account, symbol: 'WAX', sort: 'updated', order: 'desc', limit: SHOWN }, 1),
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
    () => [...new Set((sold.data ?? []).flatMap((s) => (s.assets.length === 1 && s.assets[0].template ? [s.assets[0].template.template_id] : [])))].filter((t) => free.has(t)),
    [sold.data, free]
  )
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

  const busy = !!pending && pending.startsWith('sales-')
  const total = (sold.data ?? []).reduce((n, s) => n + waxOf(s) * (1 - MARKET_FEES - (Number(s.current_collection_fee ?? 0) || 0)), 0)

  return (
    <section className="couch__bankpage couch__chests" aria-label="Your recent sales">
      <div className="cb__plaque cb__rate">
        <small>Your recent sales</small>
        <span>
          <b className="num">{sold.data ? sold.data.length : '…'}</b>
          <i>≈ {formatNumber(total, 0)} WAX to you</i>
        </span>
      </div>
      <p className="cb__note">
        The last {SHOWN} on AtomicMarket, every collection. Where you hold more, list the next one: the highest mint first, at the lowest listing of
        its kind (or the price it sold for when nobody lists it), through shop.ale.
      </p>

      <ul className="cm__rows">
        {(sold.data ?? []).map((s) => {
          const a = s.assets[0]
          const single = s.assets.length === 1
          const t = single ? a?.template?.template_id : undefined
          const price = waxOf(s)
          const when = Number(s.updated_at_time ?? 0)
          const more = t ? (free.get(t) ?? []) : []
          const next = more[0]
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
                  {t && owned.data ? ` · ${more.length ? `${more.length} more free` : 'none left'}` : ''}
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
        {sold.data && !sold.data.length && <p className="cb__note">No sales yet.</p>}
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
