import { useQuery } from '@tanstack/react-query'
import type { AnyAction } from '@wharfkit/session'
import { useEffect, useMemo, useRef, useState } from 'react'

import { BUY_MARKETPLACE, listSalesActions, repriceSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicAsset, type AtomicSale } from '@/chain/atomic'
import { formatNumber } from '@/lib/format'
import { imageSources } from '@/lib/ipfs'
import { shortDuration } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { Icon } from './icons'

/*
 * Market → Sell: sell what you hold of the Planetary Defense or the Alien Worlds collection at the
 * lowest listing of each template. Every template you hold in the categories you pick, with how many
 * you have, how many are free (not listed yet) and the lowest listing; keep one of each if you like,
 * and change how many of each go up. Listing everything is cut into transactions of a dozen NFTs,
 * shown as a list that is ticked off as each is signed (stop and resume at any point). Your listings
 * above the lowest of their template can be moved down to it the same way (a listing's price cannot
 * change: it is taken off and listed again). Your recent sales of the collection close the page.
 */

type Collection = 'planetdefnft' | 'alien.worlds'

const COLLECTIONS: { key: Collection; label: string }[] = [
  { key: 'planetdefnft', label: 'Planetary Defense' },
  { key: 'alien.worlds', label: 'Alien Worlds' }
]
/** Friendly names of the categories (schemas). */
const SCHEMA_LABEL: Record<string, string> = {
  'crew.worlds': 'Mercenaries',
  'arms.worlds': 'Arms',
  'tool.worlds': 'Tools',
  'land.worlds': 'Land',
  'faces.worlds': 'Faces',
  'face.worlds': 'Faces (old)',
  'level.worlds': 'Levels',
  'items.worlds': 'Items',
  'award.worlds': 'Awards',
  mercenary: 'Mercenaries',
  warlord: 'Warlords',
  equipment: 'Equipment',
  supplies: 'Supplies',
  creature: 'Creatures',
  services: 'Lava Lux',
  badge: 'Badges',
  material: 'Materials',
  loot: 'Chests, keys & coins',
  promo: 'Promo'
}
/** What starts ticked: everything in Planetary Defense, mercenaries and arms in Alien Worlds. */
const DEFAULT_ON: Record<Collection, (schema: string) => boolean> = {
  planetdefnft: () => true,
  'alien.worlds': (s) => s === 'crew.worlds' || s === 'arms.worlds'
}
/** NFTs listed per transaction (two actions each: announce the sale, offer the NFT). */
const LIST_PER_TX = 12
/** Listings moved per transaction (three actions each: cancel, announce, offer). */
const REPRICE_PER_TX = 8
/** AtomicMarket's cut besides the collection's: 1 % each to the listing and the buying marketplace. */
const MARKET_FEES = 0.02

const waxOf = (s: AtomicSale) => Number(s.price.amount) / 10 ** s.price.token_precision
const nameOf = (a: AtomicAsset) => String(a.data?.name ?? `#${a.template?.template_id ?? a.asset_id}`)
const chunk = <T,>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

interface Step {
  label: string
  build: (account: string, permission: string) => AnyAction[]
  state: 'todo' | 'done' | 'failed'
}

/** "3× Scout, 2× Gunslinger, …" for a step's label. */
function summary(names: string[]) {
  const c = new Map<string, number>()
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1)
  const parts = [...c].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n))
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more` : parts.join(', ')
}

export function MarketSell({ account, spectating }: { account: string; spectating: boolean }) {
  const { run, pending } = useTransaction()
  const [collection, setCollection] = useState<Collection>('planetdefnft')
  const [keepOne, setKeepOne] = useState(true)
  /**
   * How much of each template to list: all but the one kept, or one of each that you hold at least
   * two of and are not selling yet (so one always stays).
   */
  const [mode, setMode] = useState<'all' | 'one'>('all')
  /** Show only the templates you hold but have no listing of. */
  const [notSellingOnly, setNotSellingOnly] = useState(false)
  /** Categories ticked, per collection (a collection's defaults apply until you change one). */
  const [picked, setPicked] = useState<Partial<Record<Collection, Set<string>>>>({})
  /** How many of a template to list, when changed from the default (free minus the one kept). */
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map())

  const owned = useQuery({
    queryKey: ['sell-owned', account, collection],
    queryFn: () => atomic.getOwnedAssets(account, collection),
    staleTime: 60_000
  })
  const mine = useQuery({
    queryKey: ['sell-mine', account, collection],
    queryFn: () => atomic.getSales({ seller: account, collection_name: collection, symbol: 'WAX' }, 10),
    staleTime: 30_000
  })
  const sold = useQuery({
    queryKey: ['sell-sold', account, collection],
    queryFn: () => atomic.getSales({ state: 3, seller: account, collection_name: collection, symbol: 'WAX', sort: 'updated', order: 'desc', limit: 20 }, 1),
    staleTime: 60_000
  })
  const fee = useQuery({
    queryKey: ['collection-fee', collection],
    queryFn: async () => {
      const r = await fetch(`https://wax.api.atomicassets.io/atomicassets/v1/collections/${collection}`)
      const j = (await r.json()) as { data?: { market_fee?: number } }
      return Number(j.data?.market_fee ?? 0) || 0
    },
    staleTime: 60 * 60_000
  })

  // Listed NFTs stay in the wallet (offered to the market): they are not free to list again.
  const listedIds = useMemo(() => new Set((mine.data ?? []).flatMap((s) => s.assets.map((a) => a.asset_id))), [mine.data])
  const assets = useMemo(() => (owned.data ?? []).filter((a) => a.template && a.is_transferable !== false), [owned.data])

  /** Categories you hold, with how many. */
  const schemas = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of assets) m.set(a.schema.schema_name, (m.get(a.schema.schema_name) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [assets])
  const on = picked[collection] ?? new Set(schemas.map(([s]) => s).filter(DEFAULT_ON[collection]))
  const toggleSchema = (s: string) =>
    setPicked((p) => {
      const next = new Set(on)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return { ...p, [collection]: next }
    })

  /** Every template you hold in the ticked categories. */
  const groups = useMemo(() => {
    const m = new Map<string, { templateId: string; name: string; img: string; schema: string; all: string[]; free: string[] }>()
    for (const a of assets) {
      if (!on.has(a.schema.schema_name)) continue
      const t = a.template!.template_id
      if (!m.has(t)) m.set(t, { templateId: t, name: nameOf(a), img: String(a.data?.img ?? ''), schema: a.schema.schema_name, all: [], free: [] })
      const g = m.get(t)!
      g.all.push(a.asset_id)
      if (!listedIds.has(a.asset_id)) g.free.push(a.asset_id)
    }
    return [...m.values()]
    // `on` is rebuilt each render from its parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, listedIds, [...on].sort().join()])

  const templateIds = useMemo(() => groups.map((g) => g.templateId).sort(), [groups])
  const floors = useQuery({
    queryKey: ['sell-floors', collection, templateIds.join(',')],
    enabled: templateIds.length > 0,
    queryFn: () => atomic.getCheapestListings(templateIds),
    staleTime: 30_000
  })

  const rows = useMemo(
    () =>
      groups
        .map((g) => {
          const lowest = floors.data?.get(g.templateId) ?? null
          // Keeping one of each: one held back from what is free, unless one is already listed (then you still own it until it sells).
          const listedCount = g.all.length - g.free.length
          const keep = mode === 'one' || keepOne ? Math.min(1, g.free.length) : 0
          const max = Math.max(0, g.free.length - keep)
          const auto = mode === 'one' ? (g.free.length >= 2 && listedCount === 0 ? 1 : 0) : max
          const count = Math.min(max, Math.max(0, counts.get(g.templateId) ?? auto))
          return { ...g, lowest, keep, max, count, listedCount }
        })
        .sort((a, b) => (b.lowest ?? 0) * b.count - (a.lowest ?? 0) * a.count || (b.lowest ?? 0) - (a.lowest ?? 0) || a.name.localeCompare(b.name)),
    [groups, floors.data, keepOne, counts, mode]
  )
  const sellable = rows.filter((r) => r.lowest !== null && r.count > 0)
  const toList = sellable.reduce((n, r) => n + r.count, 0)
  const listWax = sellable.reduce((n, r) => n + r.count * r.lowest!, 0)
  const cut = MARKET_FEES + (fee.data ?? 0)

  /** Your listings above the lowest of their template. */
  const myFloors = useQuery({
    queryKey: ['sell-my-floors', collection, [...new Set((mine.data ?? []).map((s) => s.assets[0]?.template?.template_id ?? ''))].sort().join(',')],
    enabled: (mine.data?.length ?? 0) > 0,
    queryFn: () => atomic.getCheapestListings([...new Set((mine.data ?? []).flatMap((s) => (s.assets[0]?.template ? [s.assets[0].template.template_id] : [])))]),
    staleTime: 30_000
  })
  const above = useMemo(
    () =>
      (mine.data ?? []).filter((s) => {
        const t = s.assets.length === 1 ? s.assets[0].template?.template_id : undefined
        const low = t ? myFloors.data?.get(t) : undefined
        return low !== undefined && waxOf(s) > low + 1e-8
      }),
    [mine.data, myFloors.data]
  )

  // ---- The step list: listing, or moving listings to the lowest ----------------------------------
  const [plan, setPlan] = useState<{ kind: 'list' | 'reprice'; steps: Step[] } | null>(null)
  const [running, setRunning] = useState(false)
  const [stopAsked, setStopAsked] = useState(false)
  /** Read inside the signing loop, which a state change does not reach. */
  const stopRef = useRef(false)
  useEffect(() => setPlan(null), [collection])

  function planList() {
    const items = sellable.flatMap((r) => r.free.slice(0, r.count).map((assetId) => ({ assetId, priceWax: r.lowest!, name: r.name })))
    setPlan({
      kind: 'list',
      steps: chunk(items, LIST_PER_TX).map((part) => ({
        label: `List ${part.length}: ${summary(part.map((p) => p.name))} · ${formatNumber(part.reduce((n, p) => n + p.priceWax, 0), 2)} WAX`,
        build: (a, p) => listSalesActions(a, p, part, BUY_MARKETPLACE),
        state: 'todo'
      }))
    })
  }
  function planReprice() {
    const items = above.map((s) => {
      const t = s.assets[0].template!.template_id
      return { saleId: s.sale_id, assetId: s.assets[0].asset_id, priceWax: myFloors.data!.get(t)!, name: nameOf(s.assets[0]), from: waxOf(s) }
    })
    setPlan({
      kind: 'reprice',
      steps: chunk(items, REPRICE_PER_TX).map((part) => ({
        label: `Move ${part.length}: ${summary(part.map((p) => p.name))} to the lowest`,
        build: (a, p) => repriceSalesActions(a, p, part, BUY_MARKETPLACE),
        state: 'todo'
      }))
    })
  }
  /** Signs the steps not done yet, one by one; stops at the first refused or failed one. */
  async function go() {
    if (!plan) return
    setRunning(true)
    setStopAsked(false)
    stopRef.current = false
    let steps = plan.steps
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].state === 'done') continue
      if (stopRef.current) break
      const ok = await run(steps[i].build, `Step ${i + 1} of ${steps.length} signed`, 'sell-step')
      steps = steps.map((s, k) => (k === i ? { ...s, state: ok ? 'done' : 'failed' } : s))
      setPlan((p) => (p ? { ...p, steps } : p))
      if (!ok) break
    }
    stopRef.current = false
    setStopAsked(false)
    setRunning(false)
    void Promise.all([owned.refetch(), mine.refetch(), floors.refetch(), myFloors.refetch()])
  }

  const done = plan?.steps.filter((s) => s.state === 'done').length ?? 0
  const off = spectating || running || !!pending

  return (
    <div className="ms">
      <header className="ms__hd">
        <div>
          <h2 className="h">Sell</h2>
          <p className="muted">Everything you hold, at the lowest listing of each template, on AtomicMarket through shop.ale.</p>
        </div>
        <div className="seg" role="tablist" aria-label="Collection">
          {COLLECTIONS.map((c) => (
            <button key={c.key} type="button" role="tab" aria-selected={collection === c.key} className={collection === c.key ? 'is-on' : ''} onClick={() => setCollection(c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      </header>

      <section className="box ms__opts">
        <div className="ms__chips" role="group" aria-label="Categories">
          {owned.isLoading ? (
            <span className="muted">Reading your wallet…</span>
          ) : (
            schemas.map(([s, n]) => (
              <button key={s} type="button" className={`ms__chip${on.has(s) ? ' is-on' : ''}`} aria-pressed={on.has(s)} onClick={() => toggleSchema(s)}>
                {SCHEMA_LABEL[s] ?? s} <small className="num">{formatNumber(n, 0)}</small>
              </button>
            ))
          )}
          {owned.data && !schemas.length && <span className="muted">Nothing of this collection in your wallet.</span>}
        </div>
        <span className="ms__opt-row">
          <span className="seg ms__mode" role="group" aria-label="How much of each to list">
            <button
              type="button"
              className={mode === 'all' ? 'is-on' : ''}
              aria-pressed={mode === 'all'}
              title="Every free one of each template, but the one kept when that is on"
              onClick={() => {
                setMode('all')
                setCounts(new Map())
              }}
            >
              All but one
            </button>
            <button
              type="button"
              className={mode === 'one' ? 'is-on' : ''}
              aria-pressed={mode === 'one'}
              title="One of each template you hold at least two of and are not selling yet: one always stays"
              onClick={() => {
                setMode('one')
                setCounts(new Map())
              }}
            >
              One of each
            </button>
          </span>
          {mode === 'all' && (
            <label className={`opt__toggle ${keepOne ? 'is-on' : ''}`}>
              <input type="checkbox" checked={keepOne} onChange={(e) => setKeepOne(e.target.checked)} />
              Keep one of each template
            </label>
          )}
        </span>
      </section>

      <section className="box ms__sum">
        <div className="ms__fig">
          <small>To list</small>
          <b className="num">{formatNumber(toList, 0)}</b>
        </div>
        <div className="ms__fig">
          <small>At the lowest listings</small>
          <b className="num">{formatNumber(listWax, 2)} WAX</b>
        </div>
        <div className="ms__fig">
          <small>To you after fees</small>
          <b className="num c-good">≈ {formatNumber(listWax * (1 - cut), 2)} WAX</b>
        </div>
        <div className="ms__fig">
          <small>Transactions</small>
          <b className="num">{Math.ceil(toList / LIST_PER_TX)}</b>
        </div>
        <button type="button" className="btn btn--go" disabled={running || !!pending || !toList} onClick={planList}>
          List everything at the lowest
        </button>
      </section>

      <section className="box ms__sum">
        <div className="ms__fig">
          <small>Your listings</small>
          <b className="num">{mine.data ? formatNumber(mine.data.length, 0) : '…'}</b>
        </div>
        <div className="ms__fig">
          <small>Above the lowest</small>
          <b className={`num ${above.length ? 'c-bad' : 'c-good'}`}>{mine.data ? formatNumber(above.length, 0) : '…'}</b>
        </div>
        <div className="ms__fig">
          <small>Transactions</small>
          <b className="num">{Math.ceil(above.length / REPRICE_PER_TX)}</b>
        </div>
        <button type="button" className="btn" disabled={running || !!pending || !above.length} onClick={planReprice}>
          {above.length ? `Move ${above.length} to the lowest` : 'Nothing to change'}
        </button>
      </section>

      {plan && (
        <section className="box ms__plan" aria-label="Transactions">
          <div className="ms__plan-hd">
            <b>
              {plan.kind === 'list' ? 'Listing' : 'Moving your listings to the lowest'}: {done} of {plan.steps.length} signed
            </b>
            <span className="ms__plan-acts">
              {running ? (
                <button type="button" className="btn btn--sm" disabled={stopAsked} onClick={() => {
                    stopRef.current = true
                    setStopAsked(true)
                  }}>
                  {stopAsked ? 'Stopping after this one…' : 'Stop'}
                </button>
              ) : (
                <>
                  {done < plan.steps.length && (
                    <button type="button" className="btn btn--go btn--sm" disabled={spectating} onClick={() => void go()}>
                      {done ? 'Go on' : 'Start signing'}
                    </button>
                  )}
                  <button type="button" className="btn btn--sm" onClick={() => setPlan(null)}>
                    {done === plan.steps.length ? 'Done' : 'Cancel'}
                  </button>
                </>
              )}
            </span>
          </div>
          <ol className="ms__steps">
            {plan.steps.map((s, i) => (
              <li key={i} className={`is-${s.state}`}>
                <span className="ms__tick" aria-hidden="true">
                  {s.state === 'done' ? <Icon name="check" size={13} /> : s.state === 'failed' ? '!' : i + 1}
                </span>
                {s.label}
              </li>
            ))}
          </ol>
          <p className="help">Each step is one transaction for your wallet to sign. A refused or failed one stops the list; Go on picks it up again.</p>
        </section>
      )}

      <div className="ms__filter">
        <button type="button" className={`ms__chip${notSellingOnly ? ' is-on' : ''}`} aria-pressed={notSellingOnly} onClick={() => setNotSellingOnly((v) => !v)}>
          Not selling <small className="num">{rows.filter((x) => x.listedCount === 0).length}</small>
        </button>
        <span className="muted">
          {rows.filter((x) => x.listedCount === 0).length} of {rows.length} templates you hold have no listing of yours
        </span>
      </div>

      <section className="box ms__table" aria-label="Templates">
        <div className="ms__scroll">
          <table className="num">
            <thead>
              <tr>
                <th>Template</th>
                <th>Held</th>
                <th>Free</th>
                <th>Lowest</th>
                <th>To list</th>
                <th>Worth</th>
              </tr>
            </thead>
            <tbody>
              {rows.filter((x) => !notSellingOnly || x.listedCount === 0).map((r) => {
                const img = r.img ? imageSources(r.img)[0] : undefined
                return (
                  <tr key={r.templateId}>
                    <td className="ms__name">
                      {img ? <img src={img} alt="" loading="lazy" /> : <i />}
                      <span>
                        <b>{r.name}</b>
                        <small>
                          {SCHEMA_LABEL[r.schema] ?? r.schema} · #{r.templateId}
                        </small>
                      </span>
                    </td>
                    <td>{r.all.length}</td>
                    <td>
                      {r.free.length}
                      {r.keep ? <small className="muted"> · keep 1</small> : null}
                      {r.listedCount ? <small className="c-good"> · {r.listedCount} listed</small> : null}
                    </td>
                    <td>{r.lowest !== null ? `${formatNumber(r.lowest, 2)}` : <span className="muted">none</span>}</td>
                    <td>
                      <input
                        type="number"
                        className="input ms__count"
                        min={0}
                        max={r.max}
                        value={r.count}
                        disabled={off || !r.max || r.lowest === null}
                        aria-label={`How many ${r.name} to list`}
                        onChange={(e) => setCounts((c) => new Map(c).set(r.templateId, Math.max(0, Math.min(r.max, Math.round(Number(e.target.value) || 0)))))}
                      />
                      <small className="muted"> / {r.max}</small>
                    </td>
                    <td>{r.lowest !== null && r.count ? `${formatNumber(r.lowest * r.count, 2)}` : '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {owned.data && !rows.length && <p className="none">Nothing in the ticked categories.</p>}
        </div>
      </section>

      <section className="box ms__sold" aria-label="Your recent sales">
        <h3 className="h">
          Your recent sales <small>{COLLECTIONS.find((c) => c.key === collection)!.label}</small>
        </h3>
        {sold.data?.length ? (
          <ul>
            {sold.data.map((s) => {
              const price = waxOf(s)
              const when = Number(s.updated_at_time ?? 0)
              const f = Number(s.current_collection_fee ?? 0) || 0
              return (
                <li key={s.sale_id}>
                  <span>
                    <b>{s.assets.length === 1 ? nameOf(s.assets[0]) : `${s.assets.length} NFTs`}</b>
                    <small className="muted">{when ? `${shortDuration(Date.now() - when)} ago` : ''}</small>
                  </span>
                  <span className="num">
                    <b>{formatNumber(price, 2)} WAX</b>
                    <small className="muted">≈ {formatNumber(price * (1 - MARKET_FEES - f), 2)} to you</small>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="none">{sold.isLoading ? 'Reading…' : 'No sales yet.'}</p>
        )}
      </section>
      {spectating && <p className="help">Read-only: {account}. Connect your own wallet to sell.</p>}
    </div>
  )
}

