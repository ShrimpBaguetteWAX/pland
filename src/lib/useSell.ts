import { useQuery } from '@tanstack/react-query'
import type { AnyAction } from '@wharfkit/session'
import { useEffect, useMemo, useRef, useState } from 'react'

import { BUY_MARKETPLACE, listSalesActions, repriceSalesActions } from '@/chain/actions/market'
import { atomic, type AtomicAsset, type AtomicSale } from '@/chain/atomic'
import { offeredAssetIds } from '@/chain/offers'
import { formatNumber } from '@/lib/format'
import { imageSources } from '@/lib/ipfs'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * Selling what you hold of the Planetary Defense or the Alien Worlds collection at the lowest
 * listing of each template: the logic behind Market → Sell and couch mode's Sell tab, which only
 * differ in how they look. Every template you hold in the categories you pick, with how many you
 * have, how many are free (not listed yet) and the lowest listing; keep one of each if you like,
 * and change how many of each go up. Listing is cut into transactions of a dozen NFTs, signed one
 * after another (stop and resume at any point). Your listings above the lowest of their template
 * can be moved down to it the same way (a listing's price cannot change: it is taken off and
 * listed again).
 */

export type Collection = 'planetdefnft' | 'alien.worlds'
export type SellMode = 'all' | 'everything' | 'one'

export const COLLECTIONS: { key: Collection; label: string }[] = [
  { key: 'planetdefnft', label: 'Planetary Defense' },
  { key: 'alien.worlds', label: 'Alien Worlds' }
]
/** Friendly names of the categories (schemas). */
export const SCHEMA_LABEL: Record<string, string> = {
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
export const schemaLabel = (s: string) => SCHEMA_LABEL[s] ?? s

/** What starts ticked: every category but tools and land (the ones you mine with). */
const DEFAULT_OFF = new Set(['tool.worlds', 'land.worlds'])
/** NFTs listed per transaction (two actions each: announce the sale, offer the NFT). */
export const LIST_PER_TX = 12
/** Listings moved per transaction (three actions each: cancel, announce, offer). */
export const REPRICE_PER_TX = 8
/** AtomicMarket's cut besides the collection's: 1 % each to the listing and the buying marketplace. */
export const MARKET_FEES = 0.02
/** A listing counts as above the lowest only by at least this much: a move for less costs a transaction for nothing. */
export const MIN_MOVE_WAX = 0.01

/** Your own listings: up to 10,000 (pages of 100), read in parallel after one count. */
const OWN_SALE_PAGES = 100
export const waxOf = (s: AtomicSale) => Number(s.price.amount) / 10 ** s.price.token_precision
export const nameOf = (a: AtomicAsset) => String(a.data?.name ?? `#${a.template?.template_id ?? a.asset_id}`)
const chunk = <T,>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

/** A card's picture sources: for Alien Worlds the small copies first (the IPFS originals are often too large for the resizer), then IPFS. */
export const cardSources = (collection: string, templateId: string | undefined, img: string | undefined) => [
  ...(collection === 'alien.worlds' && templateId ? [`./img/aw-cards/${templateId}.webp`] : []),
  ...(img ? imageSources(img) : [])
]

/** "3× Scout, 2× Gunslinger, …" for a step's label. */
export function summary(names: string[]) {
  const c = new Map<string, number>()
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1)
  const parts = [...c].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n))
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more` : parts.join(', ')
}

export interface SellStep {
  label: string
  build: (account: string, permission: string) => AnyAction[]
  state: 'todo' | 'done' | 'failed'
  /** A listing step's NFTs: checked against the chain right before signing, so none is listed twice. */
  list?: { assetId: string; priceWax: number; name: string }[]
  /** Set when some of the step's NFTs turned out to be listed already. */
  note?: string
}

export interface SellPlan {
  kind: 'list' | 'reprice'
  steps: SellStep[]
  /** For a move to the lowest: every NFT with its price now and its new price, shown before signing. */
  review?: { name: string; mint?: string; from: number; to: number }[]
}

// ---- The ticked categories, remembered in this browser per collection ------------------------------

const CATS_KEY = 'pd-army.sell.categories'
function readCats(): Partial<Record<Collection, string[]>> {
  try {
    const v = JSON.parse(localStorage.getItem(CATS_KEY) ?? '{}') as Partial<Record<Collection, string[]>>
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
function saveCats(v: Partial<Record<Collection, string[]>>) {
  try {
    localStorage.setItem(CATS_KEY, JSON.stringify(v))
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
}

export function useSell(account: string) {
  const { run, pending, spectating } = useTransaction()
  const [collection, setCollection] = useState<Collection>('planetdefnft')
  /**
   * How much of each template to list: all but one (one of each kept), everything (nothing kept), or
   * one of each that you hold at least two of and are not selling yet (so one always stays).
   */
  const [mode, setModeRaw] = useState<SellMode>('all')
  /** Categories ticked, per collection (a collection's defaults apply until you change one). */
  const [picked, setPicked] = useState<Partial<Record<Collection, string[]>>>(readCats)
  /** How many of a template to list, when changed from the default (free minus the one kept). */
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map())

  const owned = useQuery({
    queryKey: ['sell-owned', account, collection],
    queryFn: () => atomic.getOwnedAssets(account, collection),
    staleTime: 60_000
  })
  const mine = useQuery({
    queryKey: ['sell-mine', account, collection],
    queryFn: () => atomic.getSales({ seller: account, collection_name: collection, symbol: 'WAX' }, OWN_SALE_PAGES),
    staleTime: 30_000
  })
  // The chain's word on what is listed: the API above lags behind fresh listings.
  const offered = useQuery({
    queryKey: ['sell-offered', account],
    queryFn: () => offeredAssetIds(account),
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
  const listedIds = useMemo(
    () => new Set([...(mine.data ?? []).flatMap((s) => s.assets.map((a) => a.asset_id)), ...(offered.data ?? [])]),
    [mine.data, offered.data]
  )
  const assets = useMemo(() => (owned.data ?? []).filter((a) => a.template && a.is_transferable !== false), [owned.data])

  /** Categories you hold, with how many. */
  const schemas = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of assets) m.set(a.schema.schema_name, (m.get(a.schema.schema_name) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [assets])
  const onList = picked[collection] ?? schemas.map(([s]) => s).filter((s) => !DEFAULT_OFF.has(s))
  const onKey = [...onList].sort().join()
  const on = useMemo(() => new Set(onList), [onKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const setCats = (next: string[]) =>
    setPicked((p) => {
      const v = { ...p, [collection]: next }
      saveCats(v)
      return v
    })
  const toggleSchema = (s: string) => setCats(on.has(s) ? [...on].filter((x) => x !== s) : [...on, s])
  const allSchemas = () => setCats(schemas.map(([s]) => s))
  const noSchemas = () => setCats([])

  const setMode = (m: SellMode) => {
    setModeRaw(m)
    setCounts(new Map())
  }
  const setCount = (templateId: string, n: number) => setCounts((c) => new Map(c).set(templateId, n))

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
  }, [assets, listedIds, on])

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
          const keep = mode === 'everything' ? 0 : Math.min(1, g.free.length)
          const max = Math.max(0, g.free.length - keep)
          const auto = mode === 'one' ? (g.free.length >= 2 && listedCount === 0 ? 1 : 0) : max
          const count = Math.min(max, Math.max(0, counts.get(g.templateId) ?? auto))
          return { ...g, lowest, keep, max, count, listedCount }
        })
        .sort((a, b) => (b.lowest ?? 0) * b.count - (a.lowest ?? 0) * a.count || (b.lowest ?? 0) - (a.lowest ?? 0) || a.name.localeCompare(b.name)),
    [groups, floors.data, counts, mode]
  )
  const sellable = rows.filter((r) => r.lowest !== null && r.count > 0)
  const toList = sellable.reduce((n, r) => n + r.count, 0)
  const listWax = sellable.reduce((n, r) => n + r.count * r.lowest!, 0)
  const cut = MARKET_FEES + (fee.data ?? 0)

  /** The lowest listing of every template you have a listing of. */
  const myFloors = useQuery({
    queryKey: ['sell-my-floors', collection, [...new Set((mine.data ?? []).map((s) => s.assets[0]?.template?.template_id ?? ''))].sort().join(',')],
    enabled: (mine.data?.length ?? 0) > 0,
    queryFn: () => atomic.getCheapestListings([...new Set((mine.data ?? []).flatMap((s) => (s.assets[0]?.template ? [s.assets[0].template.template_id] : [])))]),
    staleTime: 30_000
  })
  /** How far a listing is above the lowest of its template; null without a lowest to compare. */
  const overOf = (s: AtomicSale): number | null => {
    const t = s.assets.length === 1 ? s.assets[0].template?.template_id : undefined
    const low = t ? myFloors.data?.get(t) : undefined
    return low === undefined ? null : waxOf(s) - low
  }
  /** Your listings above the lowest of their template by at least MIN_MOVE_WAX. */
  const above = useMemo(
    () => (mine.data ?? []).filter((s) => (overOf(s) ?? 0) >= MIN_MOVE_WAX - 1e-9),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine.data, myFloors.data]
  )
  /** Your listings, the dearest first. */
  const mineByPrice = useMemo(() => [...(mine.data ?? [])].sort((a, b) => waxOf(b) - waxOf(a)), [mine.data])

  // ---- The step list: listing, or moving listings to the lowest ----------------------------------
  const [plan, setPlan] = useState<SellPlan | null>(null)
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
        state: 'todo',
        list: part
      }))
    })
  }
  function planReprice() {
    const items = above.map((s) => {
      const t = s.assets[0].template!.template_id
      return {
        saleId: s.sale_id,
        assetId: s.assets[0].asset_id,
        priceWax: myFloors.data!.get(t)!,
        name: nameOf(s.assets[0]),
        mint: s.assets[0].template_mint,
        from: waxOf(s)
      }
    })
    setPlan({
      kind: 'reprice',
      review: items.map((x) => ({ name: x.name, mint: x.mint, from: x.from, to: x.priceWax })).sort((a, b) => b.from - b.to - (a.from - a.to) || a.name.localeCompare(b.name)),
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
      let build = steps[i].build
      let note: string | undefined
      const list = steps[i].list
      if (list && account) {
        // Read what is offered right now; anything listed since the plan was made is left out.
        const taken = await offeredAssetIds(account).catch(() => null)
        const left = taken ? list.filter((x) => !taken.has(x.assetId)) : list
        if (left.length < list.length) note = `${list.length - left.length} already listed, left out`
        if (!left.length) {
          steps = steps.map((s, k) => (k === i ? { ...s, state: 'done', note: 'all already listed' } : s))
          setPlan((p) => (p ? { ...p, steps } : p))
          continue
        }
        build = (a, p) => listSalesActions(a, p, left, BUY_MARKETPLACE)
      }
      const ok = await run(build, `Step ${i + 1} of ${steps.length} signed`, 'sell-step')
      steps = steps.map((s, k) => (k === i ? { ...s, state: ok ? 'done' : 'failed', note } : s))
      setPlan((p) => (p ? { ...p, steps } : p))
      if (!ok) break
    }
    stopRef.current = false
    setStopAsked(false)
    setRunning(false)
    void Promise.all([owned.refetch(), mine.refetch(), offered.refetch(), floors.refetch(), myFloors.refetch()])
  }
  const stop = () => {
    stopRef.current = true
    setStopAsked(true)
  }

  const done = plan?.steps.filter((s) => s.state === 'done').length ?? 0

  return {
    spectating,
    pending,
    collection,
    setCollection,
    mode,
    setMode,
    schemas,
    on,
    toggleSchema,
    allSchemas,
    noSchemas,
    owned,
    mine,
    mineByPrice,
    sold,
    rows,
    setCount,
    toList,
    listWax,
    cut,
    above,
    overOf,
    myFloors,
    plan,
    setPlan,
    planList,
    planReprice,
    go,
    stop,
    running,
    stopAsked,
    done
  }
}
