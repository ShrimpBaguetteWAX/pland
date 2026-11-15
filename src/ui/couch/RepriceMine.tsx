import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { BUY_MARKETPLACE, repriceSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicSale } from '@/chain/atomic'
import { useTransaction } from '@/wallet/useTransaction'

import { waxOf } from './Chests'

/*
 * One button for every listing made on this site (Market → Sell and the couch pages, all listed
 * through shop.ale), Planetary Defense and Alien Worlds alike: each one above the lowest listing of
 * its template is taken off and listed again at that price. Signed in a few transactions, one
 * after another.
 */

const COLLECTIONS = ['planetdefnft', 'alien.worlds']
/** Listings moved per transaction (two actions each: cancel, list again). */
const PER_TX = 8

export function RepriceMine({ account }: { account: string }) {
  const { runSequence, pending, spectating } = useTransaction()
  const mine = useQuery({
    queryKey: ['shop-listings', account],
    queryFn: async () =>
      (await Promise.all(COLLECTIONS.map((c) => atomic.getSales({ seller: account, collection_name: c, symbol: 'WAX' }, 10)))).flat()
        .filter((s) => s.maker_marketplace === BUY_MARKETPLACE && s.assets.length === 1 && s.assets[0].template),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const templates = useMemo(() => [...new Set((mine.data ?? []).map((s) => s.assets[0].template!.template_id))].sort(), [mine.data])
  const floors = useQuery({
    queryKey: ['shop-listing-floors', templates.join(',')],
    enabled: templates.length > 0,
    queryFn: () => atomic.getCheapestListings(templates),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  const above = useMemo(
    () =>
      (mine.data ?? []).flatMap((s) => {
        const low = floors.data?.get(s.assets[0].template!.template_id)
        return low !== undefined && waxOf(s) > low + 1e-8 ? [{ sale: s, low }] : []
      }),
    [mine.data, floors.data]
  )
  const [confirm, setConfirm] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const busy = pending === 'shop-reprice'

  async function go() {
    const items = above.map(({ sale, low }) => ({ saleId: sale.sale_id, assetId: sale.assets[0].asset_id, priceWax: low, name: nameOf(sale) }))
    const parts = []
    for (let i = 0; i < items.length; i += PER_TX) {
      const part = items.slice(i, i + PER_TX)
      parts.push({ build: (a: string, p: string) => repriceSalesActions(a, p, part, BUY_MARKETPLACE), success: `${part.length} moved to the lowest` })
    }
    const done = await runSequence(parts, 'shop-reprice', `${items.length} listing${items.length === 1 ? '' : 's'} to the lowest`)
    setConfirm(false)
    if (!done) return
    // The market shows a moved listing a few seconds after it is signed: ask again until it does.
    setSyncing(true)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const fresh = (await mine.refetch()).data ?? []
      const moved = new Set(items.map((x) => x.assetId))
      if (!fresh.some((s) => moved.has(s.assets[0].asset_id) && items.some((x) => x.assetId === s.assets[0].asset_id && waxOf(s) > x.priceWax + 1e-8))) break
    }
    await floors.refetch()
    setSyncing(false)
  }

  const total = mine.data?.length ?? 0
  if (confirm)
    return (
      <div className="cb__plaque cm__confirm">
        <span>
          Move {above.length} listing{above.length === 1 ? '' : 's'} to the lowest?
          <small>
            each one is taken off and listed again at the lowest listing of its kind, through shop.ale · {Math.ceil(above.length / PER_TX)} signature
            {above.length > PER_TX ? 's' : ''}
          </small>
        </span>
        <span className="cm__acts">
          <button type="button" disabled={spectating || !!pending} onClick={() => void go()}>
            {busy ? 'Signing…' : 'Yes, move'}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </span>
      </div>
    )
  return (
    <>
      <button type="button" className="cc__second" disabled={spectating || !!pending || !above.length} onClick={() => setConfirm(true)}>
        {!mine.data || (templates.length > 0 && !floors.data)
          ? 'Reading your listings…'
          : !total
            ? 'Nothing listed from Market → Sell'
            : above.length
              ? `Everything I listed to the lowest · ${above.length} of ${total} (PD and AW)`
              : `All ${total} of your Market → Sell listings are at the lowest`}
      </button>
      {syncing && <p className="cb__note">Updating: the market shows a change a few seconds after it is signed…</p>}
    </>
  )
}

const nameOf = (s: AtomicSale) => String(s.assets[0].data?.name ?? s.assets[0].template?.template_id ?? 'NFT')
