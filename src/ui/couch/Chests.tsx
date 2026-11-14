import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { blendActions, type BlendRun } from '@/chain/actions/blend'
import { BUY_MARKETPLACE, listSalesActions, repriceSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicSale } from '@/chain/atomic'
import { QUANTUM_CHEST, QUANTUM_KEY, useBlends, useCollectionTemplates, useOwnedBlendInputs, type Blend } from '@/data/blends'
import { openingsOf } from '@/lib/blendEconomy'
import { formatNumber } from '@/lib/format'
import { shortDuration } from '@/lib/time'
import { imageSources } from '@/lib/ipfs'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * Couch mode's third screen (two swipes left from the orb): your Quantum Chests. A little
 * inventory (chests in the wallet, keys, your listings, what the chests are worth at the lowest
 * listing), the lowest listing large, and three actions: list chests on AtomicMarket through
 * shop.ale at the lowest listing, set your own listings to it (a sale's price cannot change: it is
 * taken off and listed again), and open chests (with keys or without) with what came out shown as
 * cards, once the blend's random oracle has minted them.
 */

/** AtomicMarket's cut besides the collection's: 1 % each to the listing and the buying marketplace. */
export const MARKET_FEES = 0.02
export const RARITY_COLOR: Record<string, string> = {
  common: '#98a2b3',
  uncommon: '#45b07a',
  rare: '#3d8fd8',
  epic: '#8f63e0',
  legendary: '#e9a227',
  mythic: '#ff2e7e',
  primordial: '#22d3ee'
}

export const waxOf = (s: AtomicSale) => Number(s.price.amount) / 10 ** s.price.token_precision

/** The NFTs for one run of a recipe, in its ingredients' order, taken from what is left. */
function runFor(blend: Blend, pools: Map<string, string[]>): BlendRun | null {
  const ids: string[] = []
  for (const ing of blend.ingredients) {
    if (ing.type !== 'template') return null
    const list = pools.get(ing.templateId)
    const id = list?.shift()
    if (!id) return null
    ids.push(id)
  }
  return { blendId: blend.id, assetIds: ids }
}

export function Chests({ account }: { account: string }) {
  const owned = useOwnedBlendInputs(account)
  const templates = useCollectionTemplates()
  const blends = useBlends()
  const { run, pending, spectating } = useTransaction()

  // Every Quantum Chest listed for WAX, cheapest first: the lowest is what everything is priced at.
  const market = useQuery({
    queryKey: ['chest-sales'],
    queryFn: () => atomic.getSales({ template_id: QUANTUM_CHEST, symbol: 'WAX' }, 2),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
  // Your last sales of the collection (chests, keys, materials), newest first.
  const sold = useQuery({
    queryKey: ['my-recent-sales', account],
    queryFn: () => atomic.getSales({ state: 3, seller: account, collection_name: 'planetdefnft', symbol: 'WAX', sort: 'updated', order: 'desc', limit: 10 }, 1),
    staleTime: 60_000
  })
  const mine = useMemo(() => (market.data ?? []).filter((s) => s.seller === account), [market.data, account])
  const others = useMemo(() => (market.data ?? []).filter((s) => s.seller !== account), [market.data, account])
  const lowest = others.length ? waxOf(others[0]) : mine.length ? waxOf(mine[0]) : null
  const collectionFee = Number(others[0]?.current_collection_fee ?? mine[0]?.current_collection_fee ?? 0) || 0
  const net = lowest !== null ? lowest * (1 - MARKET_FEES - collectionFee) : null

  /*
   * The market's API shows a new or changed listing only a few seconds after it is signed. Until it
   * does, what was just signed is shown as done (chest → its new price) and the market is asked again
   * every few seconds, for half a minute at most.
   */
  const [held, setHeld] = useState<Map<string, number>>(() => new Map())
  const [syncing, setSyncing] = useState(false)
  async function settle(done: (sales: AtomicSale[]) => boolean) {
    setSyncing(true)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const sales = (await market.refetch()).data ?? []
      if (done(sales)) break
    }
    void owned.refetch()
    setSyncing(false)
  }
  /** Your listings with what was just signed laid over them: asset → price. */
  const myListings = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of mine) for (const a of s.assets) m.set(a.asset_id, waxOf(s))
    for (const [id, price] of held) m.set(id, price)
    return m
  }, [mine, held])
  const myPrices = [...myListings.values()].sort((a, b) => a - b)

  // A listed chest stays in the wallet (offered to the market): it is not free to list or open.
  const chests = useMemo(() => (owned.data?.get(QUANTUM_CHEST) ?? []).filter((id) => !myListings.has(id)), [owned.data, myListings])
  const keys = owned.data?.get(QUANTUM_KEY) ?? []
  const above = lowest !== null ? mine.filter((s) => !held.has(s.assets[0]?.asset_id) && waxOf(s) > lowest + 1e-8) : []

  const openings = useMemo(() => (blends.data ? openingsOf(blends.data) : null), [blends.data])
  const [useKeys, setUseKeys] = useState(true)
  const withKey = useKeys && keys.length > 0 && !!openings?.chestKey
  const opening = withKey ? openings?.chestKey : openings?.chest
  const maxOpen = withKey ? Math.min(chests.length, keys.length) : chests.length

  const [listCount, setListCount] = useState(1)
  const toList = Math.min(Math.max(1, listCount), chests.length)
  const [found, setFound] = useState<{ templateId: string; assetId: string }[] | null>(null)
  const [waiting, setWaiting] = useState(false)

  async function list() {
    if (lowest === null || !toList) return
    const ids = chests.slice(0, toList)
    const ok = await run(
      (a, p) => listSalesActions(a, p, ids.map((assetId) => ({ assetId, priceWax: lowest })), BUY_MARKETPLACE),
      `Listed ${ids.length} chest${ids.length === 1 ? '' : 's'} at ${formatNumber(lowest, 2)} WAX`,
      'chest-list',
      { split: true }
    )
    if (!ok) return
    setHeld((h) => new Map([...h, ...ids.map((id): [string, number] => [id, lowest])]))
    const listedNow = (sales: AtomicSale[]) =>
      ids.every((id) => sales.some((s) => s.seller === account && s.assets.some((a) => a.asset_id === id)))
    await settle(listedNow)
    setHeld((h) => new Map([...h].filter(([id]) => !ids.includes(id))))
  }

  async function reprice() {
    if (lowest === null || !above.length) return
    const ok = await run(
      (a, p) =>
        repriceSalesActions(
          a,
          p,
          above.map((s) => ({ saleId: s.sale_id, assetId: s.assets[0].asset_id, priceWax: lowest })),
          BUY_MARKETPLACE
        ),
      `${above.length} listing${above.length === 1 ? '' : 's'} set to ${formatNumber(lowest, 2)} WAX`,
      'chest-reprice',
      { split: true }
    )
    if (!ok) return
    const ids = above.map((s) => s.assets[0].asset_id)
    const price = lowest
    setHeld((h) => new Map([...h, ...ids.map((id): [string, number] => [id, price])]))
    const repricedNow = (sales: AtomicSale[]) =>
      ids.every((id) => sales.some((s) => s.seller === account && s.assets.some((a) => a.asset_id === id) && Math.abs(waxOf(s) - price) < 1e-6))
    await settle(repricedNow)
    setHeld((h) => new Map([...h].filter(([id]) => !ids.includes(id))))
  }

  async function open(n: number) {
    if (!opening || n <= 0) return
    const pools = new Map<string, string[]>([
      [QUANTUM_CHEST, [...chests]],
      [QUANTUM_KEY, [...keys]]
    ])
    const runs: BlendRun[] = []
    for (let i = 0; i < n; i++) {
      const r = runFor(opening.blend, pools)
      if (!r) break
      runs.push(r)
    }
    if (!runs.length) return
    // What the wallet held before, so the new materials can be told apart once minted.
    const before = new Set([...(owned.data?.values() ?? [])].flat())
    setFound(null)
    const ok = await run((a, p) => blendActions(a, p, runs), `Opened ${runs.length} chest${runs.length === 1 ? '' : 's'}`, 'chest-open')
    if (!ok) return
    // The random oracle mints the results within seconds: look until they are all there (a minute at most).
    setWaiting(true)
    let fresh: { templateId: string; assetId: string }[] = []
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const now = (await owned.refetch()).data
      fresh = [...(now?.entries() ?? [])].flatMap(([templateId, ids]) => ids.filter((id) => !before.has(id)).map((assetId) => ({ templateId, assetId })))
      if (fresh.length >= runs.length) break
    }
    setWaiting(false)
    setFound(fresh)
  }

  const busy = !!pending && pending.startsWith('chest-')
  const off = spectating || busy
  const lowestText = lowest !== null ? formatNumber(lowest, 2) : '…'

  return (
    <section className="couch__bankpage couch__chests" aria-label="Your chests">
      <div className="cb__plaque cb__rate">
        <small>Lowest listing</small>
        <span>
          <b className="num">{lowestText}</b>
          <i>WAX</i>
        </span>
      </div>

      <div className="cb__plaque">
        <table className="cc__inv num">
          <tbody>
            <tr>
              <td>Quantum Chests in your wallet</td>
              <td className="cc__big">{owned.data ? chests.length : '…'}</td>
            </tr>
            <tr>
              <td>Quantum Keys</td>
              <td className="cc__big is-nft">{owned.data ? keys.length : '…'}</td>
            </tr>
            <tr>
              <td>Listed by you</td>
              <td>
                {myPrices.length
                  ? `${myPrices.length} · ${formatNumber(myPrices[0], 2)}${
                      myPrices[myPrices.length - 1] > myPrices[0] + 1e-8 ? `–${formatNumber(myPrices[myPrices.length - 1], 2)}` : ''
                    } WAX`
                  : 'none'}
              </td>
            </tr>
            <tr>
              <td>Worth at the lowest listing</td>
              <td className="is-good">{net !== null ? `≈ ${formatNumber(chests.length * net, 0)} WAX` : '…'}</td>
            </tr>
          </tbody>
        </table>
        {net !== null && <p className="cb__note">A chest sold at the lowest listing brings you ≈ {formatNumber(net, 2)} WAX after the market&apos;s fees.</p>}
      </div>

      <div className="cc__list">
        <span className="cc__step" role="group" aria-label="How many chests to list">
          <button type="button" aria-label="One fewer" disabled={off || toList <= 1} onClick={() => setListCount(Math.max(1, toList - 1))}>
            −
          </button>
          <b className="num">{toList}</b>
          <button type="button" aria-label="One more" disabled={off || toList >= chests.length} onClick={() => setListCount(Math.min(chests.length, toList + 1))}>
            +
          </button>
        </span>
        <button type="button" className="cb__go" disabled={off || !chests.length || lowest === null} onClick={() => void list()}>
          {pending === 'chest-list' ? 'Signing…' : chests.length ? `List ${toList} at ${lowestText} WAX` : 'No chests to list'}
          <small>on AtomicMarket through shop.ale</small>
        </button>
      </div>

      <button type="button" className="cc__second" disabled={off || !above.length} onClick={() => void reprice()}>
        {pending === 'chest-reprice'
          ? 'Signing…'
          : !myPrices.length
            ? 'No chests of yours listed'
            : above.length
              ? `Set my ${above.length} listing${above.length === 1 ? '' : 's'} to ${lowestText} WAX`
              : 'Your listings are at the lowest'}
      </button>
      {syncing && <p className="cb__note">Updating: the market shows a change a few seconds after it is signed…</p>}

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

      <div className="cc__open">
        <div className="cc__keys" role="group" aria-label="Open with keys or without">
          <button type="button" className={withKey ? 'is-on' : ''} aria-pressed={withKey} disabled={!keys.length} onClick={() => setUseKeys(true)}>
            With keys
          </button>
          <button type="button" className={!withKey ? 'is-on' : ''} aria-pressed={!withKey} onClick={() => setUseKeys(false)}>
            Without
          </button>
        </div>
        <div className="cc__opens">
          {[1, 3].map((n) => (
            <button key={n} type="button" className="cc__open-b is-go" disabled={off || !opening || maxOpen < n} onClick={() => void open(n)}>
              Open {n}
            </button>
          ))}
          <button type="button" className="cc__open-b" disabled={off || !opening || maxOpen < 1} onClick={() => void open(maxOpen)}>
            Open all {maxOpen}
          </button>
        </div>
      </div>

      {(waiting || pending === 'chest-open' || found) && (
        <div className="cc__found">
          <small>{pending === 'chest-open' ? 'Signing…' : waiting ? 'Opening… the results arrive in a few seconds' : 'Last opened'}</small>
          {found && (
            <div className="cc__loot">
              {found.length ? (
                found.map((x) => {
                  const t = templates.data?.get(x.templateId)
                  const rarity = (t?.rarity ?? '').toLowerCase()
                  return (
                    <div key={x.assetId} className="cc__item" style={{ '--rc': RARITY_COLOR[rarity] ?? '#98a2b3' } as React.CSSProperties}>
                      {t?.img && imageSources(t.img)[0] ? <img src={imageSources(t.img)[0]} alt="" loading="lazy" /> : <i />}
                      <b>{t?.name ?? `#${x.templateId}`}</b>
                      <small>{rarity || '—'}</small>
                    </div>
                  )
                })
              ) : (
                <p className="cb__note">Nothing new showed up yet. It can take a little longer: it will be in your wallet.</p>
              )}
            </div>
          )}
        </div>
      )}
      {spectating && <p className="cb__note">Read-only: not your account.</p>}
    </section>
  )
}
