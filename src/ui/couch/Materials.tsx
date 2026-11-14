import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { BUY_MARKETPLACE, listSalesActions, repriceSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicSale } from '@/chain/atomic'
import { useCollectionTemplates, useOwnedBlendInputs } from '@/data/blends'
import { formatNumber } from '@/lib/format'
import { imageSources } from '@/lib/ipfs'
import { shortDuration } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { MARKET_FEES, RARITY_COLOR, waxOf } from './Chests'

/*
 * Couch mode's fourth screen: your materials, the chest page's twin. Every material you hold with
 * how many are free and the lowest listing of its kind, listed one at a time or all at once on
 * AtomicMarket through shop.ale at that price; your own listings set to the lowest in one go; and
 * your recent material sales. Like the chest page it shows what was just signed at once and asks
 * the market again until its API shows the change.
 */

const COLLECTION = 'planetdefnft'

export function Materials({ account }: { account: string }) {
  const owned = useOwnedBlendInputs(account)
  const templates = useCollectionTemplates()
  const { run, pending, spectating } = useTransaction()

  // Which templates are materials (chests, keys and coins are loot).
  const materialIds = useMemo(
    () => [...(templates.data?.values() ?? [])].filter((t) => t.schema === 'material').map((t) => t.templateId),
    [templates.data]
  )
  // The cheapest listing of every material, and your own material listings.
  const floors = useQuery({
    queryKey: ['material-floors', materialIds.join(',')],
    enabled: materialIds.length > 0,
    queryFn: () => atomic.getCheapestListings(materialIds),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const mineQ = useQuery({
    queryKey: ['my-material-sales', account],
    queryFn: () => atomic.getSales({ seller: account, collection_name: COLLECTION, schema_name: 'material', symbol: 'WAX' }, 5),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const sold = useQuery({
    queryKey: ['my-recent-material-sales', account],
    queryFn: () =>
      atomic.getSales({ state: 3, seller: account, collection_name: COLLECTION, schema_name: 'material', symbol: 'WAX', sort: 'updated', order: 'desc', limit: 10 }, 1),
    staleTime: 60_000
  })

  // What was just signed, laid over the market's answer until it shows it: asset → price.
  const [held, setHeld] = useState<Map<string, { template: string; price: number }>>(() => new Map())
  const [syncing, setSyncing] = useState(false)
  async function settle(done: (sales: AtomicSale[]) => boolean) {
    setSyncing(true)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const sales = (await mineQ.refetch()).data ?? []
      if (done(sales)) break
    }
    void Promise.all([owned.refetch(), floors.refetch(), sold.refetch()])
    setSyncing(false)
  }

  /** Your listings per template, with what was just signed: asset → price. */
  const listed = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    const put = (template: string, asset: string, price: number) => {
      if (!m.has(template)) m.set(template, new Map())
      m.get(template)!.set(asset, price)
    }
    for (const s of mineQ.data ?? []) for (const a of s.assets) if (a.template) put(a.template.template_id, a.asset_id, waxOf(s))
    for (const [asset, h] of held) put(h.template, asset, h.price)
    return m
  }, [mineQ.data, held])
  const listedAssets = useMemo(() => new Set([...listed.values()].flatMap((m) => [...m.keys()])), [listed])

  /** One row per material you hold or have listed, the most valuable first. */
  const rows = useMemo(() => {
    const ids = new Set([...materialIds.filter((t) => (owned.data?.get(t)?.length ?? 0) > 0), ...listed.keys()])
    return [...ids]
      .map((t) => {
        const tpl = templates.data?.get(t)
        const free = (owned.data?.get(t) ?? []).filter((id) => !listedAssets.has(id))
        const lowest = floors.data?.get(t) ?? null
        const mine = [...(listed.get(t)?.values() ?? [])].sort((a, b) => a - b)
        return { t, tpl, free, lowest, mine }
      })
      .filter((r) => r.tpl?.schema === 'material')
      .sort((a, b) => (b.lowest ?? 0) * Math.max(1, b.free.length) - (a.lowest ?? 0) * Math.max(1, a.free.length) || (a.tpl?.name ?? '').localeCompare(b.tpl?.name ?? ''))
  }, [materialIds, owned.data, listed, listedAssets, templates.data, floors.data])

  const totalFree = rows.reduce((n, r) => n + r.free.length, 0)
  // The collection's cut, from your own sales (the API gives it per sale); none known yet: none taken off.
  const collectionFee = Number(sold.data?.[0]?.current_collection_fee ?? mineQ.data?.[0]?.current_collection_fee ?? 0) || 0
  const worth = rows.reduce((n, r) => n + (r.lowest ?? 0) * r.free.length, 0) * (1 - MARKET_FEES - collectionFee)
  const totalListed = rows.reduce((n, r) => n + r.mine.length, 0)
  // Your sales above the lowest listing of their kind.
  const above = useMemo(
    () =>
      (mineQ.data ?? []).filter((s) => {
        const a = s.assets[0]
        if (!a?.template || held.has(a.asset_id)) return false
        const low = floors.data?.get(a.template.template_id)
        return low !== undefined && waxOf(s) > low + 1e-8
      }),
    [mineQ.data, floors.data, held]
  )

  async function list(template: string, ids: string[], price: number) {
    if (!ids.length) return
    const name = templates.data?.get(template)?.name ?? 'material'
    const ok = await run(
      (a, p) => listSalesActions(a, p, ids.map((assetId) => ({ assetId, priceWax: price })), BUY_MARKETPLACE),
      `Listed ${ids.length} × ${name} at ${formatNumber(price, 2)} WAX`,
      `mat-list-${template}`,
      { split: true }
    )
    if (!ok) return
    setHeld((h) => new Map([...h, ...ids.map((id): [string, { template: string; price: number }] => [id, { template, price }])]))
    await settle((sales) => ids.every((id) => sales.some((s) => s.assets.some((x) => x.asset_id === id))))
    setHeld((h) => new Map([...h].filter(([id]) => !ids.includes(id))))
  }

  async function reprice() {
    if (!above.length) return
    const sales = above.map((s) => ({ saleId: s.sale_id, assetId: s.assets[0].asset_id, priceWax: floors.data!.get(s.assets[0].template!.template_id)! }))
    const ok = await run(
      (a, p) => repriceSalesActions(a, p, sales, BUY_MARKETPLACE),
      `${sales.length} listing${sales.length === 1 ? '' : 's'} set to the lowest`,
      'mat-reprice',
      { split: true }
    )
    if (!ok) return
    const ids = sales.map((s) => s.assetId)
    setHeld((h) => new Map([...h, ...above.map((s): [string, { template: string; price: number }] => [s.assets[0].asset_id, { template: s.assets[0].template!.template_id, price: floors.data!.get(s.assets[0].template!.template_id)! }])]))
    await settle((list) => sales.every((x) => list.some((s) => s.assets.some((a) => a.asset_id === x.assetId) && Math.abs(waxOf(s) - x.priceWax) < 1e-6)))
    setHeld((h) => new Map([...h].filter(([id]) => !ids.includes(id))))
  }

  const busy = !!pending && pending.startsWith('mat-')
  const off = spectating || busy

  return (
    <section className="couch__bankpage couch__chests" aria-label="Your materials">
      <div className="cb__plaque cb__rate">
        <small>Materials in your wallet</small>
        <span>
          <b className="num">{owned.data ? totalFree : '…'}</b>
          <i>≈ {formatNumber(worth, 0)} WAX</i>
        </span>
      </div>
      <p className="cb__note">
        Worth at each one&apos;s lowest listing after the market&apos;s fees{totalListed ? ` · ${totalListed} listed by you` : ''}. List at the lowest listing on
        AtomicMarket through shop.ale.
      </p>

      <button type="button" className="cc__second" disabled={off || !above.length} onClick={() => void reprice()}>
        {pending === 'mat-reprice'
          ? 'Signing…'
          : !totalListed
            ? 'No materials of yours listed'
            : above.length
              ? `Set my ${above.length} listing${above.length === 1 ? '' : 's'} to the lowest`
              : 'Your listings are at the lowest'}
      </button>
      {syncing && <p className="cb__note">Updating: the market shows a change a few seconds after it is signed…</p>}

      <ul className="cm__rows">
        {rows.map((r) => {
          const rarity = (r.tpl?.rarity ?? '').toLowerCase()
          const img = r.tpl?.img ? imageSources(r.tpl.img)[0] : undefined
          const can = !off && r.lowest !== null && r.free.length > 0
          return (
            <li key={r.t} className="cb__plaque cm__row" style={{ '--rc': RARITY_COLOR[rarity] ?? '#98a2b3' } as React.CSSProperties}>
              {img ? <img src={img} alt="" loading="lazy" /> : <i />}
              <span className="cm__name">
                <b>{r.tpl?.name ?? `#${r.t}`}</b>
                <small>
                  <span className="cm__rar">{rarity || '—'}</span> · {r.free.length} free
                  {r.mine.length ? ` · ${r.mine.length} listed at ${formatNumber(r.mine[0], 2)}${r.mine.length > 1 && r.mine[r.mine.length - 1] > r.mine[0] ? '+' : ''}` : ''}
                </small>
              </span>
              <span className="cm__low num">
                <b>{r.lowest !== null ? formatNumber(r.lowest, 2) : '–'}</b>
                <small>lowest</small>
              </span>
              <span className="cm__acts">
                <button type="button" disabled={!can} onClick={() => void list(r.t, r.free.slice(0, 1), r.lowest!)}>
                  {pending === `mat-list-${r.t}` ? '…' : 'List 1'}
                </button>
                {r.free.length > 1 && (
                  <button type="button" disabled={!can} onClick={() => void list(r.t, r.free, r.lowest!)}>
                    All {r.free.length}
                  </button>
                )}
              </span>
            </li>
          )
        })}
        {owned.data && !rows.length && <p className="cb__note">No materials in this wallet.</p>}
      </ul>

      <details className="cb__plaque cc__sold">
        <summary>
          Your recent sales
          <small>{sold.data ? (sold.data.length ? `last ${Math.min(10, sold.data.length)}` : 'none yet') : '…'}</small>
        </summary>
        {sold.data && sold.data.length > 0 && (
          <ul>
            {sold.data.slice(0, 10).map((s) => {
              const price = waxOf(s)
              const fee = Number(s.current_collection_fee ?? 0) || 0
              const when = Number(s.updated_at_time ?? 0)
              const tid = s.assets[0]?.template?.template_id
              const name = s.assets.length === 1 ? (tid ? (templates.data?.get(tid)?.name ?? `#${tid}`) : 'NFT') : `${s.assets.length} NFTs`
              return (
                <li key={s.sale_id}>
                  <span>
                    <b>{name}</b>
                    <small>{when ? `${shortDuration(Date.now() - when)} ago` : ''}</small>
                  </span>
                  <span className="num">
                    <b>{formatNumber(price, 2)} WAX</b>
                    <small>≈ {formatNumber(price * (1 - MARKET_FEES - fee), 2)} to you</small>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </details>
      {spectating && <p className="cb__note">Read-only: not your account.</p>}
    </section>
  )
}
