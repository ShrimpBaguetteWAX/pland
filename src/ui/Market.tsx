import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import { atomic, type AtomicSale } from '@/chain/atomic'
import { buySalesActions, stakeBoughtAction } from '@/chain/actions/market'
import { cachedOf } from '@/data/assets'
import { QUANTUM_CHEST, QUANTUM_KEY, useCollectionTemplates, useOwnedBlendInputs, type CollectionTemplate } from '@/data/blends'
import { refreshPlayer, useArmy, usePlayer, useWalletNfts } from '@/data/game'
import { useListings, type Listing } from '@/data/market'
import { formatNumber } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'
import { ChestValue } from './ChestValue'
import { ChestForecast, MarketBuilder } from './MarketBuilder'
import { MarketUpgrade } from './MarketUpgrade'
import { StarRail } from './Stars'

/*
 * The Market as aisles: a rail of the division builder and every shelf down the left, one page each
 * on the right. Every shelf is the same table: one row per item (all its listings together), its
 * stats, the cheapest price, how many are listed, how many you hold, and a stepper to buy the
 * cheapest few in one press. A row opens to its single listings. Prices are AtomicMarket's open
 * WAX sales of single NFTs; each purchase asserts the sale first, so a seller changing the price
 * fails the purchase instead of costing more. Cards that go into divisions can be staked right
 * after buying.
 */

type Aisle = 'builder' | 'payback' | 'upgrade' | 'chests' | 'material' | 'mercenary' | 'warlord' | 'weapon' | 'supply' | 'creature' | 'lavalux' | 'badge' | 'coins'

const AISLES: { key: Aisle; label: string; blurb: string }[] = [
  { key: 'builder', label: 'Division builder', blurb: '' },
  { key: 'payback', label: 'Mission ROI', blurb: '' },
  { key: 'upgrade', label: 'Upgrade', blurb: '' },
  { key: 'chests', label: 'Chests & keys', blurb: 'A Quantum Chest opens into one material; opened with a Key the odds shift to the rarer ones. Open them on the Blend page.' },
  { key: 'material', label: 'Materials', blurb: 'What blends are made of. Chests open into them too.' },
  { key: 'mercenary', label: 'Mercenaries', blurb: 'The crew of a division. Sort by WAX per attack to find the cheapest strength.' },
  { key: 'warlord', label: 'Warlords', blurb: 'Every division needs one. Crew places and move reduction differ.' },
  { key: 'weapon', label: 'Equipment', blurb: 'Weapons and armour: flat attack and defense for one mercenary. Each needs an equipment slot.' },
  { key: 'supply', label: 'Supplies', blurb: 'Red Boar drinks: attack, defense and less move. Each needs a supply slot.' },
  { key: 'creature', label: 'Creatures', blurb: 'Pets: a little attack and defense, no slot needed.' },
  { key: 'lavalux', label: 'Lava Lux', blurb: 'Hotel passes: multiply a mercenary’s attack and defense, and its move. Each needs a Lava Lux slot.' },
  { key: 'badge', label: 'Badges', blurb: 'Badges from the Planetary Defense collection.' },
  { key: 'coins', label: 'Coins', blurb: 'Coin packs that redeem for in-game coins.' }
]
const PLAYABLE: Aisle[] = ['mercenary', 'warlord', 'weapon', 'supply', 'creature', 'lavalux']
/** Listings bought in one press at most. */
const MAX_PER_PRESS = 40
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary']

/** A listing reduced to what a shelf needs (badges and coins come from their own query). */
interface Offer {
  saleId: string
  assetId: string
  listingPrice: string
  price: number
  seller: string
  templateId: string
  schema: string
  name: string
  rarity: string
  img: string
  listing?: Listing
}

/** Badges and coin packs: listed on the same collection, but not part of the game's listings. */
function useExtraOffers() {
  return useQuery({
    queryKey: ['market-extra'],
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async (): Promise<Offer[]> => {
      const batches = await Promise.all(['badge', 'promo'].map((schema) => atomic.getSales({ collection_name: 'planetdefnft', schema_name: schema })))
      const out: Offer[] = []
      for (const sale of batches.flat() as AtomicSale[]) {
        if (sale.listing_symbol !== 'WAX' || sale.price?.token_symbol !== 'WAX' || sale.assets.length !== 1) continue
        const a = sale.assets[0]
        const c = cachedOf(a)
        if (!c) continue
        out.push({
          saleId: String(sale.sale_id),
          assetId: String(a.asset_id),
          listingPrice: String(sale.listing_price),
          price: Number(sale.price.amount) / 1e8,
          seller: sale.seller,
          templateId: c.t,
          schema: c.s,
          name: c.n ?? `#${c.t}`,
          rarity: '',
          img: ''
        })
      }
      return out.sort((x, y) => x.price - y.price)
    }
  })
}

const aisleOf = (l: { schema: string; templateId: string; kind?: string | null }): Aisle | null => {
  if (l.schema === 'loot') return l.templateId === QUANTUM_CHEST || l.templateId === QUANTUM_KEY ? 'chests' : 'coins'
  if (l.schema === 'promo') return 'coins'
  if (l.schema === 'badge') return 'badge'
  if (l.schema === 'material') return 'material'
  return (l.kind as Aisle) ?? null
}

export function Market({ account, spectating, onMissions }: { account: string; spectating: boolean; onMissions?: () => void }) {
  const listings = useListings()
  const extra = useExtraOffers()
  const collection = useCollectionTemplates()
  const [aisle, setAisle] = useState<Aisle>('builder')
  /** A target the Upgrade tab hands to the builder; the nonce makes the same target count twice. */
  const [request, setRequest] = useState<{ atk: number; def: number; maxMove?: number; missionId?: number; nonce: number } | null>(null)

  /** Every offer, sorted into its aisle (the player's own listings left out). */
  const byAisle = useMemo(() => {
    const m = new Map<Aisle, Offer[]>()
    const meta = (t: string): CollectionTemplate | undefined => collection.data?.get(t)
    const put = (a: Aisle | null, o: Offer) => {
      if (!a || o.seller === account) return
      m.set(a, [...(m.get(a) ?? []), o])
    }
    for (const l of listings.data ?? [])
      put(aisleOf(l), {
        saleId: l.saleId,
        assetId: l.assetId,
        listingPrice: l.listingPrice,
        price: l.price,
        seller: l.seller,
        templateId: l.templateId,
        schema: l.schema,
        name: l.asset.name || meta(l.templateId)?.name || `#${l.templateId}`,
        rarity: (l.asset.rarity || meta(l.templateId)?.rarity || '').toLowerCase(),
        img: l.asset.img || meta(l.templateId)?.img || '',
        listing: l
      })
    for (const o of extra.data ?? [])
      put(aisleOf(o), { ...o, name: meta(o.templateId)?.name ?? o.name, rarity: (meta(o.templateId)?.rarity ?? '').toLowerCase(), img: meta(o.templateId)?.img ?? '' })
    return m
  }, [listings.data, extra.data, collection.data, account])

  const current = AISLES.find((a) => a.key === aisle)!

  return (
    <main className="mkt wrap">
      <nav className="mkt__rail" aria-label="Market aisles">
        {AISLES.map((a, i) => (
          <Fragment key={a.key}>
            <button type="button" className={a.key === aisle ? 'is-on' : ''} onClick={() => setAisle(a.key)}>
              <span>{a.label}</span>
              {a.key !== 'builder' && a.key !== 'payback' && a.key !== 'upgrade' && <small className="num">{listings.data ? formatNumber(byAisle.get(a.key)?.length ?? 0, 0) : '…'}</small>}
            </button>
            {i === 2 && <span className="mkt__sep" />}
          </Fragment>
        ))}
      </nav>
      <section className="mkt__page">
        {/* The builder and the payback table share one component and stay mounted, so a search
            running in either keeps going (and keeps its answer) while you look at a shelf. */}
        <div className="mkt__builder" hidden={aisle !== 'builder' && aisle !== 'payback'}>
          <MarketBuilder
            account={account}
            spectating={spectating}
            onMissions={onMissions}
            view={aisle === 'payback' ? 'payback' : 'builder'}
            onLoaded={() => setAisle('builder')}
            request={request}
          />
        </div>
        {/* Stays mounted too: a scan keeps going while you look elsewhere. */}
        <div className="mkt__builder" hidden={aisle !== 'upgrade'}>
          <MarketUpgrade account={account} spectating={spectating} onBuild={(target) => setRequest({ ...target, nonce: Date.now() })} />
        </div>
        {aisle === 'builder' || aisle === 'payback' || aisle === 'upgrade' ? null : (
          <Shelf
            key={aisle}
            aisle={aisle}
            title={current.label}
            blurb={current.blurb}
            offers={byAisle.get(aisle) ?? []}
            loading={!listings.data && listings.isLoading}
            account={account}
            spectating={spectating}
            extra={
              aisle === 'chests' ? (
                <>
                  <ChestValue account={account} />
                  <ChestForecast account={account} />
                </>
              ) : null
            }
          />
        )}
      </section>
    </main>
  )
}

// ---- A shelf -----------------------------------------------------------------------------------------

interface Row {
  templateId: string
  name: string
  rarity: string
  img: string
  offers: Offer[]
  /** A listing of the item, for its game stats (playable aisles). */
  sample?: Listing
  atk: number
  def: number
  move: number
  held: number
}

type Sort = 'price' | 'perAtk' | 'listed' | 'name'

function Shelf({
  aisle,
  title,
  blurb,
  offers,
  loading,
  account,
  spectating,
  extra
}: {
  aisle: Aisle
  title: string
  blurb: string
  offers: Offer[]
  loading: boolean
  account: string
  spectating: boolean
  extra: ReactNode
}) {
  const playable = PLAYABLE.includes(aisle)
  const wallet = useWalletNfts(account)
  const army = useArmy(account)
  const owned = useOwnedBlendInputs(account)
  const player = usePlayer(account)
  const { run, pending } = useTransaction()
  const [sort, setSort] = useState<Sort>(playable && aisle !== 'warlord' && aisle !== 'lavalux' ? 'perAtk' : 'price')
  const [rarity, setRarity] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [stake, setStake] = useState(true)

  // How many of each template you hold: in the wallet and staked (for game cards), or as blend inputs.
  const held = useMemo(() => {
    const m = new Map<string, number>()
    const add = (t: string, n = 1) => m.set(t, (m.get(t) ?? 0) + n)
    for (const a of wallet.data ?? []) add(a.templateId)
    for (const a of army.data?.assets.values() ?? []) add(a.templateId)
    for (const [t, ids] of owned.data ?? []) if (!m.has(t)) add(t, ids.length)
    return m
  }, [wallet.data, army.data, owned.data])

  const rows = useMemo(() => {
    const m = new Map<string, Row>()
    for (const o of offers) {
      let r = m.get(o.templateId)
      if (!r) {
        const st = o.listing?.asset.stats
        r = {
          templateId: o.templateId,
          name: o.name,
          rarity: o.rarity,
          img: o.img,
          offers: [],
          sample: o.listing,
          atk: Number(st?.attack ?? 0),
          def: Number(st?.defense ?? 0),
          move: Number(st?.movecost ?? 0),
          held: held.get(o.templateId) ?? 0
        }
        m.set(o.templateId, r)
      }
      r.offers.push(o)
    }
    const list = [...m.values()].filter((r) => !rarity || r.rarity === rarity)
    const perAtk = (r: Row) => (r.atk > 0 ? r.offers[0].price / r.atk : Infinity)
    return list.sort((a, b) =>
      sort === 'perAtk' ? perAtk(a) - perAtk(b) : sort === 'listed' ? b.offers.length - a.offers.length : sort === 'name' ? a.name.localeCompare(b.name) : a.offers[0].price - b.offers[0].price
    )
  }, [offers, held, rarity, sort])

  const rarities = useMemo(() => RARITIES.filter((r) => offers.some((o) => o.rarity === r)), [offers])
  const wax = player.data?.wax ?? 0

  const buy = async (r: Row) => {
    const n = Math.min(counts[r.templateId] ?? 1, r.offers.length, MAX_PER_PRESS)
    const chosen = r.offers.slice(0, n)
    if (!chosen.length) return
    const total = chosen.reduce((s, o) => s + o.price, 0)
    const ok = await run(
      (a, p) => buySalesActions(a, p, chosen.map((o) => ({ saleId: o.saleId, assetId: o.assetId, listingPrice: o.listingPrice }))),
      `${chosen.length} × ${r.name} bought for ${formatNumber(total, 2)} WAX`,
      `buy-${r.templateId}`,
      { split: true }
    )
    // Game cards are staked straight after, when asked: they arrive in the wallet with the purchase.
    if (ok && playable && stake)
      await run((a, p) => stakeBoughtAction(a, p, chosen.map((o) => o.assetId)), `${chosen.length} × ${r.name} staked`, `stake-${r.templateId}`)
    if (ok) void refreshPlayer(account)
  }

  const statCell = (r: Row) => {
    const st = r.sample?.asset.stats
    if (!st) return <span className="muted">—</span>
    if (aisle === 'warlord')
      return (
        <span className="num">
          {st.slots_max} crew{Number(st.movecost_reduction) ? <span className="c-move"> · −{st.movecost_reduction} move</span> : ''}
        </span>
      )
    if (aisle === 'lavalux')
      return (
        <span className="num">
          <span className="c-atk">×{formatNumber(Number(st.attack_mult_bp) / 10000, 2)}</span> · <span className="c-move">×{formatNumber(Number(st.movecost_mult_bp) / 10000, 2)} move</span>
        </span>
      )
    return (
      <span className="trio num">
        <span className="c-atk">{formatNumber(r.atk, 0)}</span>
        <span className="c-def">{formatNumber(r.def, 0)}</span>
        {aisle === 'supply' ? <span className="c-move">−{formatNumber(Number(st.movecost_reduction ?? 0), 0)}</span> : <span className="c-move">{formatNumber(r.move, 0)}</span>}
      </span>
    )
  }
  const statHead = aisle === 'warlord' ? 'Leads' : aisle === 'lavalux' ? 'Multiplies' : aisle === 'supply' ? 'Atk / Def / Move cut' : 'Atk / Def / Move'

  return (
    <>
      <div className="box">
        <h3 className="h">
          {title}
          <small>
            {loading ? 'reading the market…' : `${formatNumber(rows.length, 0)} items · ${formatNumber(offers.length, 0)} listings · cheapest first`}
          </small>
        </h3>
        <p className="mkt__blurb">{blurb}</p>
        <div className="mkt__tools">
          {rarities.length > 1 && (
            <span className="seg seg--pick">
              <button type="button" className={!rarity ? 'is-on' : ''} onClick={() => setRarity(null)}>
                All
              </button>
              {rarities.map((r) => (
                <button key={r} type="button" className={rarity === r ? 'is-on' : ''} onClick={() => setRarity(r)}>
                  <i className="dot" style={{ background: rarityColor(r) }} /> {r}
                </button>
              ))}
            </span>
          )}
          <span className="seg seg--pick">
            <button type="button" className={sort === 'price' ? 'is-on' : ''} onClick={() => setSort('price')}>
              Price
            </button>
            {playable && aisle !== 'warlord' && aisle !== 'lavalux' && (
              <button type="button" className={sort === 'perAtk' ? 'is-on' : ''} onClick={() => setSort('perAtk')}>
                WAX per atk
              </button>
            )}
            <button type="button" className={sort === 'listed' ? 'is-on' : ''} onClick={() => setSort('listed')}>
              Most listed
            </button>
            <button type="button" className={sort === 'name' ? 'is-on' : ''} onClick={() => setSort('name')}>
              Name
            </button>
          </span>
          {playable && (
            <label className="mkt__stake">
              <input type="checkbox" checked={stake} onChange={(e) => setStake(e.target.checked)} /> Stake after buying
            </label>
          )}
          <span className="muted mkt__wax">You hold {formatNumber(wax, 2)} WAX</span>
        </div>
        {loading ? (
          <p className="muted">Reading the market…</p>
        ) : !rows.length ? (
          <p className="none">Nothing listed right now.</p>
        ) : (
          <div className="tablewrap">
            <table className="t mkt__table">
              <thead>
                <tr>
                  <th>Item</th>
                  {playable && <th>{statHead}</th>}
                  {playable && aisle !== 'warlord' && aisle !== 'lavalux' && <th className="num">WAX per atk</th>}
                  <th className="num">Cheapest</th>
                  <th className="num">Listed</th>
                  <th className="num">You hold</th>
                  <th className="mkt__buycol">Buy the cheapest</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const n = Math.min(counts[r.templateId] ?? 1, r.offers.length, MAX_PER_PRESS)
                  const total = r.offers.slice(0, n).reduce((s, o) => s + o.price, 0)
                  const max = Math.min(r.offers.length, MAX_PER_PRESS)
                  const isOpen = open === r.templateId
                  const busy = pending === `buy-${r.templateId}` || pending === `stake-${r.templateId}`
                  return (
                    <Fragment key={r.templateId}>
                      <tr className={isOpen ? 'is-open' : ''}>
                        <td>
                          <button type="button" className="mkt__item" onClick={() => setOpen(isOpen ? null : r.templateId)} title="Show every listing">
                            <Portrait img={r.img} rarity={r.rarity} className="mkt__pic" />
                            <span>
                              <b>{r.name}</b>
                              <small>
                                <i className="dot" style={{ background: rarityColor(r.rarity) }} /> {r.rarity || '—'}
                              </small>
                              {r.sample && <StarRail asset={r.sample.asset} size="sm" />}
                            </span>
                          </button>
                        </td>
                        {playable && <td>{statCell(r)}</td>}
                        {playable && aisle !== 'warlord' && aisle !== 'lavalux' && <td className="num">{r.atk > 0 ? formatNumber(r.offers[0].price / r.atk, 1) : '—'}</td>}
                        <td className="num">
                          <b>{formatNumber(r.offers[0].price, 2)}</b> WAX
                        </td>
                        <td className="num">{formatNumber(r.offers.length, 0)}</td>
                        <td className="num">{r.held ? formatNumber(r.held, 0) : <span className="muted">0</span>}</td>
                        <td className="mkt__buycol">
                          <span className="mkt__buy">
                            <span className="stepper">
                              <button type="button" disabled={n <= 1} onClick={() => setCounts((c) => ({ ...c, [r.templateId]: Math.max(1, n - 1) }))} aria-label="Fewer">
                                −
                              </button>
                              <b className="num">{n}</b>
                              <button type="button" disabled={n >= max} onClick={() => setCounts((c) => ({ ...c, [r.templateId]: Math.min(max, n + 1) }))} aria-label="More">
                                +
                              </button>
                            </span>
                            <button
                              type="button"
                              className="btn btn--sm btn--go"
                              disabled={!!pending || spectating || total > wax}
                              title={spectating ? 'Read-only: not your account' : total > wax ? `That is ${formatNumber(total - wax, 2)} WAX more than you hold` : `The cheapest ${n}, each asserted at its price`}
                              onClick={() => void buy(r)}
                            >
                              <Icon name="cart" size={14} /> {busy ? 'Signing…' : `${formatNumber(total, total < 100 ? 2 : 0)} WAX`}
                            </button>
                          </span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="mkt__offers">
                          <td colSpan={playable ? (aisle !== 'warlord' && aisle !== 'lavalux' ? 7 : 6) : 5}>
                            <ul>
                              {r.offers.slice(0, 24).map((o, i) => (
                                <li key={o.saleId} className={i < n ? 'is-chosen' : ''} style={{ '--rc': rarityColor(r.rarity) } as CSSProperties}>
                                  <span className="num">{formatNumber(o.price, 2)} WAX</span>
                                  <span className="muted">{o.seller}</span>
                                  <a href={`https://wax.atomichub.io/market/sale/wax-mainnet/${o.saleId}`} target="_blank" rel="noreferrer">
                                    AtomicHub
                                  </a>
                                </li>
                              ))}
                              {r.offers.length > 24 && <li className="muted">and {r.offers.length - 24} more</li>}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {extra}
    </>
  )
}
