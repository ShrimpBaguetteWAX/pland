import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { blendActions, type BlendRun } from '@/chain/actions/blend'
import { ascendAction, sacrificeAction } from '@/chain/actions/ascend'
import { buySalesActions } from '@/chain/actions/market'
import { atomic, type AtomicAsset } from '@/chain/atomic'
import { FRAGMENT_TEMPLATE } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import { costKey, expectedYield, useAscensionConfig, usePendingBurns } from '@/data/ascension'
import {
  QUANTUM_CHEST,
  QUANTUM_KEY,
  useBlends,
  useCollectionTemplates,
  useOwnedBlendInputs,
  useTemplatePrices,
  type Blend as Recipe,
  type Ingredient
} from '@/data/blends'
import { refreshPlayer, useArmy, useAssetStats, useWalletNfts } from '@/data/game'
import { useListings } from '@/data/market'
import { queryClient } from '@/data/queryClient'
import type { AssetStats } from '@/data/types'
import {
  floorOf,
  ingredientValue,
  marketFrom,
  materialValues,
  mintable,
  openingValue,
  planBlend,
  resultOf,
  SALE_KEEP,
  valueOf,
  type Market,
  type MaterialValue,
  type Opening
} from '@/lib/blendEconomy'
import { formatNumber, percent, titleCase } from '@/lib/format'
import { KIND_LABEL, kindOf } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { ChestValue } from './ChestValue'
import { Icon } from './icons'
import { StarRail } from './Stars'

import '@/styles/blend.css'

/*
 * The Blend page as aisles, like the Market: a rail on the left (recipes, materials, chests and
 * keys, ascension) and one view on the right. Recipes are NeftyBlocks blends of the collection;
 * prices are AtomicMarket floors in WAX, and what you own is used first and counted as free.
 */

type View = 'recipes' | 'materials' | 'chests' | 'ascension'

const VIEWS: { key: View; label: string }[] = [
  { key: 'recipes', label: 'Recipes' },
  { key: 'materials', label: 'Materials' },
  { key: 'chests', label: 'Chests & keys' },
  { key: 'ascension', label: 'Ascension' }
]

const CATEGORY_ORDER = ['warlord', 'mercenary', 'equipment', 'supplies', 'creature', 'services', 'material']
const CATEGORY_LABEL: Record<string, string> = {
  warlord: 'Warlords',
  mercenary: 'Mercenaries',
  equipment: 'Equipment',
  supplies: 'Supplies',
  creature: 'Creatures',
  services: 'Lava Lux',
  material: 'Materials'
}

const SINGULAR: Record<string, string> = {
  warlord: 'warlord',
  mercenary: 'mercenary',
  equipment: 'equipment',
  supplies: 'supply',
  creature: 'creature',
  services: 'Lava Lux',
  material: 'material'
}

const wax = (n: number | null | undefined, digits = 2) => (n == null || !Number.isFinite(n) ? '–' : formatNumber(n, digits))
const READ_ONLY = 'Read-only: not your account'

type Tx = ReturnType<typeof useTransaction>
type Run = Tx['run']

export function Blend({ account, spectating }: { account: string; spectating: boolean }) {
  const { run, pending } = useTransaction()
  const blends = useBlends()
  const templates = useCollectionTemplates()
  const listings = useListings()
  const owned = useOwnedBlendInputs(account)
  const prices = useTemplatePrices()
  const stats = useAssetStats()
  const [view, setView] = useState<View>('recipes')
  // Kept here, not in the chests view, so a reveal keeps going while you look at another view.
  const reveal = useReveal(account, run)

  const market = useMemo(
    () =>
      listings.data && templates.data && prices.data
        ? marketFrom(listings.data, owned.data ?? new Map(), templates.data, account, prices.data)
        : null,
    [listings.data, templates.data, owned.data, account, prices.data]
  )
  const values = useMemo(() => (market && blends.data ? materialValues(market, blends.data) : null), [market, blends.data])
  const byTemplate = useMemo(() => new Map((values?.materials ?? []).map((m) => [m.templateId, m])), [values])

  const ready = market && blends.data && values
  const count = (v: View): string | null => {
    if (!ready) return null
    if (v === 'recipes') return formatNumber(blends.data!.filter((b) => b.active && resultOf(b)).length, 0)
    if (v === 'materials') return formatNumber(values!.materials.length, 0)
    if (v === 'chests') return formatNumber(market!.owned.get(QUANTUM_CHEST)?.length ?? 0, 0)
    return formatNumber(market!.owned.get(FRAGMENT_TEMPLATE)?.length ?? 0, 0)
  }
  const countTitle: Record<View, string> = {
    recipes: 'Recipes on NeftyBlocks',
    materials: 'Materials',
    chests: 'Quantum Chests you hold',
    ascension: 'Fragments you hold'
  }

  return (
    <main className="bl wrap">
      <nav className="mkt__rail" aria-label="Blend views">
        {VIEWS.map((v) => (
          <button key={v.key} type="button" className={v.key === view ? 'is-on' : ''} onClick={() => setView(v.key)}>
            <span>{v.label}</span>
            <small className="num" title={countTitle[v.key]}>
              {count(v.key) ?? '…'}
            </small>
          </button>
        ))}
        {reveal.state && view !== 'chests' && (
          <>
            <span className="mkt__sep" />
            <button type="button" onClick={() => setView('chests')}>
              <span>{reveal.state.done ? 'Opening done' : 'Opening…'}</span>
              <small className="num">
                {reveal.state.found.length}/{reveal.state.expected}
              </small>
            </button>
          </>
        )}
      </nav>
      <section className="bl__page">
        {!ready ? (
          <div className="box">
            <p className="muted bl-loading">
              <span className="bl-spin" /> Reading the recipes…
            </p>
          </div>
        ) : view === 'recipes' ? (
          <Recipes
            blends={blends.data!}
            market={market!}
            byTemplate={byTemplate}
            stats={stats.data}
            run={run}
            pending={pending}
            spectating={spectating}
          />
        ) : view === 'materials' ? (
          <Materials materials={values!.materials} />
        ) : view === 'chests' ? (
          <Chests
            account={account}
            openings={values!.openings}
            market={market!}
            byTemplate={byTemplate}
            reveal={reveal}
            run={run}
            pending={pending}
            spectating={spectating}
          />
        ) : (
          <Ascension account={account} market={market!} run={run} pending={pending} spectating={spectating} />
        )}
      </section>
    </main>
  )
}

// ---- Small pieces -----------------------------------------------------------------------------------

/** Attack / defense / move, in their colours. */
function Trio({ atk, def, move }: { atk: number; def: number; move: number }) {
  return (
    <span className="trio num" title="Attack / defense / move">
      <span className="c-atk">{formatNumber(atk, 0)}</span>
      <span className="c-def">{formatNumber(def, 0)}</span>
      <span className="c-move">{formatNumber(move, 0)}</span>
    </span>
  )
}

/** A label and a figure; `title` explains it on hover. */
function Fig({ label, value, tone = '', title }: { label: string; value: ReactNode; tone?: string; title?: string }) {
  return (
    <span className="bl-fig" title={title}>
      <small>{label}</small>
      <b className={`num ${tone}`}>{value}</b>
    </span>
  )
}

function Stepper({
  value,
  min = 1,
  max,
  onChange,
  label = 'How many'
}: {
  value: number
  min?: number
  max: number
  onChange: (n: number) => void
  label?: string
}) {
  return (
    <span className="stepper bl-stepper" role="group" aria-label={label}>
      <button type="button" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <b className="num">{value}</b>
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </span>
  )
}

// ---- Recipes ----------------------------------------------------------------------------------------

/** Result rarities, cheapest first, as the filter chips list them. */
const RARITY_LIST = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']
/** Runs of one recipe per press at most. */
const MAX_TIMES = 20

function Recipes({
  blends,
  market,
  byTemplate,
  stats,
  run,
  pending,
  spectating
}: {
  blends: Recipe[]
  market: Market
  byTemplate: Map<string, MaterialValue>
  stats: Map<string, AssetStats> | undefined
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const [category, setCategory] = useState<string>('all')
  const [order, setOrder] = useState<'profit' | 'ready'>('profit')
  /** Result rarities left out of the list. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [counts, setCounts] = useState<Record<number, number>>({})

  const rows = useMemo(() => {
    return blends
      .filter((b) => b.active && resultOf(b))
      .map((b) => {
        const result = resultOf(b)!
        const t = market.templates.get(result)
        const plan = planBlend(market, b)
        // What the ingredients are worth even if you own them (you could sell them instead).
        const value = b.ingredients.reduce((n, ing) => n + (ingredientValue(market, ing) ?? NaN), 0)
        // Expected cost if the materials came from opening chests at today's prices.
        const viaChests = b.ingredients.reduce((n, ing) => {
          if (ing.type !== 'template') return NaN
          return n + ing.amount * (byTemplate.get(ing.templateId)?.fair ?? NaN)
        }, 0)
        const floor = valueOf(market, result)
        const left = mintable(market, b)
        return {
          blend: b,
          result,
          template: t,
          schema: t?.schema ?? 'other',
          plan,
          value,
          viaChests,
          floor,
          // Selling the result keeps 93% of its value (collection and marketplace fees).
          margin: floor !== null && Number.isFinite(value) ? floor * SALE_KEEP - value : null,
          left,
          // Every ingredient is in the wallet: nothing to buy.
          ready: left > 0 && plan.buy.length === 0 && Number.isFinite(plan.cost)
        }
      })
      .sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity))
  }, [blends, market, byTemplate])

  const rarityOf = (r: (typeof rows)[number]) => (r.template?.rarity ?? '').toLowerCase()
  const rarities = RARITY_LIST.filter((x) => rows.some((r) => rarityOf(r) === x))
  const inCategory = rows.filter((r) => (category === 'all' || r.schema === category) && !hidden.has(rarityOf(r)))
  // Rows are by profit already; "ready" lifts the ones blendable from the wallet, order kept within.
  const shown = order === 'ready' ? [...inCategory].sort((a, b) => Number(b.ready) - Number(a.ready)) : inCategory
  const readyCount = inCategory.filter((r) => r.ready).length
  const categories = CATEGORY_ORDER.filter((c) => rows.some((r) => r.schema === c))

  async function blendNow(r: (typeof rows)[number], times: number) {
    const reserved = new Map<string, number>()
    const plans = Array.from({ length: times }, () => planBlend(market, r.blend, reserved))
    if (plans.some((p) => !Number.isFinite(p.cost))) return
    const buy = plans.flatMap((p) => p.buy)
    // One transaction: the purchases first (their NFTs land in the wallet), then the blends that burn them.
    await run(
      (a, p) => [
        ...(buy.length
          ? buySalesActions(
              a,
              p,
              buy.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
            )
          : []),
        ...blendActions(
          a,
          p,
          plans.map((pl) => ({ blendId: r.blend.id, assetIds: pl.assets }))
        )
      ],
      `${times}× ${r.template?.name ?? 'blend'} on its way: it is minted in a few seconds`,
      `blend-${r.blend.id}`
    )
  }

  return (
    <div className="box">
      <h3 className="h">
        Recipes
        <small>
          {formatNumber(rows.length, 0)} on NeftyBlocks · {formatNumber(shown.length, 0)} shown
        </small>
      </h3>
      <p className="bl-blurb">Prices are AtomicMarket floors in WAX. What you own is used first and counts as free.</p>
      <div className="bl-tools">
        <span className="seg seg--pick">
          <button type="button" className={category === 'all' ? 'is-on' : ''} onClick={() => setCategory('all')}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} type="button" className={category === c ? 'is-on' : ''} onClick={() => setCategory(c)}>
              {CATEGORY_LABEL[c] ?? titleCase(c)}
            </button>
          ))}
        </span>
        <span className="seg seg--pick">
          <button type="button" className={order === 'profit' ? 'is-on' : ''} onClick={() => setOrder('profit')}>
            Most profit
          </button>
          <button type="button" className={order === 'ready' ? 'is-on' : ''} onClick={() => setOrder('ready')}>
            Ready now{readyCount ? <small>{readyCount}</small> : null}
          </button>
        </span>
        <span className="bl-rarities" role="group" aria-label="Rarities">
          {rarities.map((x) => {
            const off = hidden.has(x)
            return (
              <button
                key={x}
                type="button"
                className={`bl-rarity ${off ? 'is-off' : ''}`}
                style={{ '--rc': rarityColor(x) } as CSSProperties}
                aria-pressed={!off}
                title={off ? `Show ${x} recipes again` : `Hide ${x} recipes`}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev)
                    if (next.has(x)) next.delete(x)
                    else next.add(x)
                    return next
                  })
                }
              >
                {titleCase(x)}
              </button>
            )
          })}
        </span>
      </div>
      <p className="help bl-help">
        {order === 'ready'
          ? readyCount
            ? `${readyCount} recipe${readyCount === 1 ? '' : 's'} you can blend from your wallet, nothing to buy, come first. The rest follow by profit.`
            : 'Nothing can be blended from your wallet alone right now. The list stays by profit.'
          : 'Most profit first: the result at market value less the 7% sale fees, minus the ingredients at market value (yours count too: you could sell them). Market value is the lower of the floor and the recent sale median.'}
      </p>
      {!shown.length ? (
        <p className="none">No recipe matches these filters.</p>
      ) : (
        <div className="bl-recs">
          {shown.map((r) => {
            const st = stats?.get(r.result)
            const times = Math.max(1, Math.min(counts[r.blend.id] ?? 1, MAX_TIMES, Math.max(1, r.left)))
            const missing = r.plan.buy.length
            const canBlend = r.left > 0 && Number.isFinite(r.plan.cost)
            const busy = pending === `blend-${r.blend.id}`
            const rarity = r.template?.rarity ?? ''
            return (
              <article key={r.blend.id} className={`bl-rec ${r.left <= 0 ? 'is-capped' : ''} ${r.ready ? 'is-ready' : ''}`}>
                <div className="bl-card">
                  <Portrait img={r.template?.img} rarity={rarity} className="bl-pic bl-pic--lg" />
                  <span className="bl-card__text">
                    <b>{r.template?.name ?? `#${r.result}`}</b>
                    <small>
                      <i className="dot" style={{ background: rarityColor(rarity) }} /> <span className="cap">{rarity}</span> {SINGULAR[r.schema] ?? r.schema}
                    </small>
                    <StarRail asset={{ templateId: String(r.result), rarity }} size="sm" />
                    {st && Number(st.attack) + Number(st.defense) + Number(st.movecost) > 0 && <Trio atk={Number(st.attack)} def={Number(st.defense)} move={Number(st.movecost)} />}
                    <small className="muted">
                      {r.left === Infinity ? 'unlimited' : r.left <= 0 ? 'minted out' : `${formatNumber(r.left, 0)} left to mint`}
                    </small>
                  </span>
                </div>
                <div className="bl-ings">
                  {r.blend.ingredients.map((ing, i) => (
                    <IngredientChip key={i} ing={ing} market={market} line={r.plan.lines[i]} />
                  ))}
                </div>
                <dl className="bl-figs">
                  <dt title="What the result sells for: the lower of its floor and its recent sale median.">Result value</dt>
                  <dd className="num">{wax(r.floor)}</dd>
                  <dt title="Every ingredient at its market value, including the ones you own.">Ingredients</dt>
                  <dd className="num">{wax(r.value)}</dd>
                  <dt title="WAX you actually pay: only the ingredients you are missing, at today's floors.">You pay</dt>
                  <dd className={`num ${r.plan.cost === 0 ? 'is-good' : ''}`}>{wax(r.plan.cost)}</dd>
                  <dt title="Expected cost if every ingredient came from opening Quantum Chests (and Keys) at today's prices.">Via chests</dt>
                  <dd className="num">{wax(r.viaChests)}</dd>
                  <dt>Profit</dt>
                  <dd className={`num ${r.margin === null ? '' : r.margin > 0 ? 'is-good' : 'is-bad'}`}>
                    <b>{r.margin === null ? '–' : `${r.margin > 0 ? '+' : ''}${wax(r.margin)}`}</b>
                  </dd>
                </dl>
                <div className="bl-act">
                  <Stepper
                    value={times}
                    max={Math.max(1, Math.min(MAX_TIMES, r.left))}
                    onChange={(n) => setCounts((c) => ({ ...c, [r.blend.id]: n }))}
                    label="How many times"
                  />
                  <button
                    type="button"
                    className={`btn btn--sm ${missing ? '' : 'btn--go'}`}
                    disabled={!canBlend || spectating || !!pending}
                    title={
                      spectating
                        ? READ_ONLY
                        : r.left <= 0
                          ? 'Minted out'
                          : !Number.isFinite(r.plan.cost)
                            ? 'Not enough of an ingredient is listed right now'
                            : missing
                              ? `Buys the ${missing} missing ingredient${missing === 1 ? '' : 's'} and blends, in one transaction`
                              : 'Blends from your wallet'
                    }
                    onClick={() => void blendNow(r, times)}
                  >
                    <Icon name={missing ? 'cart' : 'spark'} size={14} /> {busy ? 'Signing…' : missing ? 'Buy & blend' : 'Blend'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function IngredientChip({ ing, market, line }: { ing: Ingredient; market: Market; line?: { cost: number; owned: number } }) {
  const t = ing.type === 'template' ? market.templates.get(ing.templateId) : null
  const label =
    ing.type === 'template'
      ? (t?.name ?? `#${ing.templateId}`)
      : ing.type === 'attribute'
        ? `any ${ing.attributes.map((a) => a.values.join('/')).join(' ')} ${ing.schema || 'NFT'}`
        : ing.label
  const have = line?.owned ?? 0
  const complete = have >= ing.amount
  const priced = Number.isFinite(line?.cost ?? NaN)
  const title = `${ing.amount}× ${label}. You own ${have}. ${
    complete ? 'Covered by your wallet.' : priced ? `The rest costs ${wax(line!.cost)} WAX.` : 'Not enough listed right now.'
  }`
  return (
    <span
      className={`bl-ing ${complete ? 'is-owned' : priced ? '' : 'is-missing'}`}
      style={{ '--rc': rarityColor(t?.rarity) } as CSSProperties}
      title={title}
    >
      {t?.img ? <Portrait img={t.img} rarity={t.rarity} className="bl-pic bl-pic--xs" /> : <span className="bl-pic bl-pic--xs" />}
      <span className="bl-ing__name">{label}</span>
      <b className="num">
        {have}/{ing.amount}
      </b>
    </span>
  )
}

// ---- Materials --------------------------------------------------------------------------------------

function Materials({ materials }: { materials: MaterialValue[] }) {
  const sorted = [...materials].sort(
    (a, b) => (a.source ?? 'z').localeCompare(b.source ?? 'z') || b.chance - a.chance || a.name.localeCompare(b.name)
  )
  return (
    <div className="box">
      <h3 className="h">
        Materials
        <small>{formatNumber(sorted.length, 0)} · what each one is worth</small>
      </h3>
      <ul className="bl-defs">
        <li>
          <b>Market</b>: the lower of the floor and the recent sale median. Most Epic and rarer materials are never listed but sell often.
        </li>
        <li>
          <b>Fair value</b>: its share of an opening. The chest (plus key) price is split across the drops by the market&apos;s price
          level per rarity, so opening breaks even at fair values.
        </li>
        <li>
          <b>Pull cost</b>: what getting this exact one from chests costs on average.
        </li>
        <li>
          <b>Blend value</b>: one unit&apos;s share of the best recipe&apos;s result, split by the ingredients&apos; market values.
        </li>
      </ul>
      <table className="t bl-stack">
        <thead>
          <tr>
            <th>Material</th>
            <th>Drops from</th>
            <th className="num">Market</th>
            <th className="num">Fair value</th>
            <th className="num">Pull cost</th>
            <th className="num">Blend value</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const ratio = m.value !== null && m.fair ? m.value / m.fair : null
            const verdict = ratio === null ? null : ratio < 0.85 ? 'cheap' : ratio > 1.15 ? 'dear' : 'fair'
            return (
              <tr key={m.templateId}>
                <td className="bl-stack__lead">
                  <span className="bl-card bl-card--sm">
                    <Portrait img={m.img} rarity={m.rarity} className="bl-pic" />
                    <span className="bl-card__text">
                      <b>{m.name}</b>
                      <small>
                        <i className="dot" style={{ background: rarityColor(m.rarity) }} /> <span className="cap">{m.rarity}</span>
                        {m.owned ? ` · you own ${m.owned}` : ''}
                      </small>
                      <StarRail asset={{ templateId: m.templateId, rarity: m.rarity }} size="sm" />
                    </span>
                  </span>
                </td>
                <td data-label="Drops from" className="num">
                  {m.source ? `${m.source === 'chest' ? 'Chest' : 'Chest + Key'} · ${percent(m.chance, 0)}` : '–'}
                </td>
                <td
                  data-label="Market"
                  className="num"
                  title={`Floor ${wax(m.floor)} (${m.listed} listed) · recent sales ${m.recent !== null ? `around ${wax(m.recent)}` : 'too few'}`}
                >
                  {wax(m.value)} <small className="muted">{m.floor === null ? 'sold' : `${m.listed} listed`}</small>
                </td>
                <td data-label="Fair value" className="num">
                  {wax(m.fair)}
                </td>
                <td data-label="Pull cost" className="num">
                  {wax(m.pullCost, 0)}
                </td>
                <td
                  data-label="Blend value"
                  className="num"
                  title={
                    m.blendValue !== null
                      ? `Best use: blend ${m.blendVia ? `recipe #${m.blendVia.id}` : ''} and sell the result at market value.`
                      : undefined
                  }
                >
                  {m.blendValue !== null ? <b className="is-good">{wax(m.blendValue)}</b> : '–'}
                </td>
                <td data-label="Verdict">
                  {verdict === 'cheap' && <span className="pill is-met">below fair</span>}
                  {verdict === 'fair' && <span className="pill">fair</span>}
                  {verdict === 'dear' && <span className="pill is-live">above fair</span>}
                  {verdict === null && <span className="muted">–</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---- Chests & keys ----------------------------------------------------------------------------------

function Chests({
  account,
  openings,
  market,
  byTemplate,
  reveal,
  run,
  pending,
  spectating
}: {
  account: string
  openings: { chest: Opening | null; chestKey: Opening | null }
  market: Market
  byTemplate: Map<string, MaterialValue>
  reveal: ReturnType<typeof useReveal>
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const chestFloor = floorOf(market, QUANTUM_CHEST)
  const keyFloor = floorOf(market, QUANTUM_KEY)
  const chestValue = openings.chest ? openingValue(openings.chest, byTemplate) : null
  const ckValue = openings.chestKey ? openingValue(openings.chestKey, byTemplate) : null
  // A key is only useful with a chest: its worth is what adding it to an opening gains.
  const keyValue =
    ckValue && chestValue
      ? {
          best: ckValue.best - chestValue.best,
          unpricedBest: Math.max(ckValue.unpricedBest, chestValue.unpricedBest)
        }
      : null
  const ownedChests = market.owned.get(QUANTUM_CHEST) ?? []
  const ownedKeys = market.owned.get(QUANTUM_KEY) ?? []

  return (
    <>
      {reveal.state && <RevealPanel reveal={reveal.state} market={market} byTemplate={byTemplate} onClose={reveal.close} />}
      <div className="bl-loots">
        <LootCard
          title="Quantum Chest"
          templateId={QUANTUM_CHEST}
          market={market}
          price={chestFloor}
          value={chestValue ? { best: chestValue.best, unpricedBest: chestValue.unpricedBest } : null}
          explain="Opens into one Common, Uncommon or Rare material (50 / 35 / 15%)."
          run={run}
          pending={pending}
          spectating={spectating}
          open={
            openings.chest
              ? {
                  max: Math.min(MAX_OPEN, ownedChests.length),
                  owned: ownedChests.length,
                  need: 'You hold no Quantum Chest.',
                  label: (n) => `Open ${n}`,
                  busy: pending === 'open-chest',
                  start: (n) =>
                    void reveal.open(
                      ownedChests.slice(0, n).map((c) => ({ blendId: openings.chest!.blend.id, assetIds: [c] })),
                      false,
                      chestFloor,
                      'open-chest'
                    )
                }
              : null
          }
        />
        <LootCard
          title="Quantum Key"
          templateId={QUANTUM_KEY}
          market={market}
          price={keyFloor}
          value={keyValue}
          explain="Opened together with a chest: one Epic, Legendary or Mythic material (70 / 25 / 5%) instead. Its worth is what it adds to that chest."
          run={run}
          pending={pending}
          spectating={spectating}
          open={
            openings.chestKey
              ? {
                  max: Math.min(MAX_OPEN, ownedChests.length, ownedKeys.length),
                  owned: Math.min(ownedChests.length, ownedKeys.length),
                  need: !ownedKeys.length ? 'You hold no Quantum Key.' : 'A key needs a chest to open with.',
                  label: (n) => `Open ${n} with key${n === 1 ? '' : 's'}`,
                  busy: pending === 'open-key',
                  start: (n) =>
                    void reveal.open(
                      Array.from({ length: n }, (_, i) => ({
                        blendId: openings.chestKey!.blend.id,
                        assetIds: [ownedChests[i], ownedKeys[i]]
                      })),
                      true,
                      chestFloor !== null && keyFloor !== null ? chestFloor + keyFloor : null,
                      'open-key'
                    )
                }
              : null
          }
        />
      </div>
      {/* What opening gives and what it is worth if sold: the Market's own card, not worked out twice. */}
      <ChestValue account={account} />
    </>
  )
}

function LootCard({
  title,
  templateId,
  market,
  price,
  value,
  explain,
  run,
  pending,
  spectating,
  open
}: {
  title: string
  templateId: string
  market: Market
  price: number | null
  /** After-fee value of one, using its materials the best way; and the share with no price. */
  value: { best: number; unpricedBest: number } | null
  explain: string
  run: Run
  pending: string | null
  spectating: boolean
  /** Opening the ones you own: how many at most in one transaction, and how to start it. */
  open: { max: number; owned: number; need: string; label: (n: number) => string; busy: boolean; start: (n: number) => void } | null
}) {
  const [qty, setQty] = useState(1)
  const [openQty, setOpenQty] = useState(1)
  const opening = open && open.max > 0 ? Math.max(1, Math.min(openQty, open.max)) : 0
  const t = market.templates.get(templateId)
  const listings = market.listings.get(templateId) ?? []
  const buyQty = Math.max(1, Math.min(qty, listings.length || 1))
  const buying = listings.slice(0, buyQty)
  const total = buying.reduce((n, l) => n + l.price, 0)
  const held = market.owned.get(templateId)?.length ?? 0
  // A verdict needs most of the outcomes priced; below that it is only a lower bound.
  const judge = (v: number, unpriced: number) => {
    if (price === null) return { text: 'No listing to compare with.', tone: '' }
    const edge = v / price - 1
    if (unpriced > 0.5 && v <= 0)
      return { text: `${percent(unpriced, 0)} of the outcomes have no price, so this cannot be valued yet.`, tone: '' }
    if (unpriced > 0.5)
      return {
        text: `${percent(unpriced, 0)} of the outcomes have no price yet: at least ${wax(v)} WAX back (${edge >= 0 ? '+' : ''}${percent(edge, 0)}).`,
        tone: edge >= 0 ? 'is-met' : ''
      }
    return {
      text: `${wax(v)} WAX back on average: ${edge >= 0 ? `${percent(edge, 0)} more than` : `${percent(-edge, 0)} less than`} its floor.`,
      tone: edge >= 0 ? 'is-met' : 'is-live'
    }
  }
  const bestVerdict = value ? judge(value.best, value.unpricedBest) : null
  // Only as many as are listed below what one is worth used the best way.
  const worthIt = value ? listings.filter((l) => l.price <= value.best).length : 0
  const buyBusy = pending === `buy-${templateId}`

  return (
    <article className="box bl-loot">
      <div className="bl-loot__head">
        <Portrait img={t?.img} rarity={t?.rarity} className="bl-pic bl-pic--lg" />
        <div>
          <h3 className="bl-loot__title">{title}</h3>
          <p className="bl-blurb">{explain}</p>
        </div>
      </div>
      <div className="bl-figrow">
        <Fig label="Floor" value={wax(price)} />
        <Fig
          label="Best use"
          value={wax(value?.best)}
          title="Expected WAX back using every material the best way: sold, or blended into a result that is sold (its share, after fees), whichever pays more."
        />
        <Fig label="You hold" value={held} />
      </div>
      {bestVerdict && (
        <p className="bl-verdict">
          <span className={`pill ${bestVerdict.tone}`}>Blending where it pays</span> {bestVerdict.text}
          {bestVerdict.tone === 'is-met' && worthIt > 0 ? ` ${worthIt} listed at or below that.` : ''}
        </p>
      )}
      <div className="bl-line">
        <span className="bl-line__label">Buy</span>
        <Stepper value={buyQty} max={Math.max(1, listings.length)} onChange={setQty} label="How many to buy" />
        <button
          type="button"
          className="btn btn--sm bl-line__btn"
          disabled={!buying.length || spectating || !!pending}
          title={spectating ? READ_ONLY : !buying.length ? 'None listed right now' : `The cheapest ${buying.length}, each asserted at its price`}
          onClick={() =>
            void run(
              (a, p) =>
                buySalesActions(
                  a,
                  p,
                  buying.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
                ),
              `Bought ${buying.length} ${title}${buying.length === 1 ? '' : 's'}`,
              `buy-${templateId}`,
              { split: true }
            )
          }
        >
          <Icon name="cart" size={14} /> {buyBusy ? 'Signing…' : `${wax(total)} WAX`}
        </button>
      </div>
      {open && (
        <div className="bl-line">
          <span className="bl-line__label">Open</span>
          {open.max > 0 ? (
            <>
              <span className="stepper bl-stepper" role="group" aria-label="How many to open">
                <button type="button" aria-label="Fewer" disabled={opening <= 1} onClick={() => setOpenQty(Math.max(1, opening - 1))}>
                  −
                </button>
                <input
                  className="num bl-count"
                  inputMode="numeric"
                  aria-label="How many to open"
                  value={opening}
                  onChange={(e) => setOpenQty(Number(e.target.value.replace(/\D/g, '')) || 1)}
                />
                <button
                  type="button"
                  aria-label="More"
                  disabled={opening >= open.max}
                  onClick={() => setOpenQty(Math.min(open.max, opening + 1))}
                >
                  +
                </button>
              </span>
              <button
                type="button"
                className="btn btn--sm btn--go bl-line__btn"
                disabled={spectating || !!pending}
                title={spectating ? READ_ONLY : 'Opens them in one transaction, then shows what comes out'}
                onClick={() => open.start(opening)}
              >
                <Icon name="gift" size={14} /> {open.busy ? 'Signing…' : open.label(opening)}
              </button>
              <span className="bl-line__note">
                <button type="button" className="link" onClick={() => setOpenQty(open.max)}>
                  max {open.max}
                </button>
                {open.owned > open.max && <small className="muted"> · {MAX_OPEN} per transaction</small>}
              </span>
            </>
          ) : (
            <span className="muted bl-line__none">{open.need}</span>
          )}
        </div>
      )}
    </article>
  )
}

// ---- Opening reveal ---------------------------------------------------------------------------------

/** Openings per transaction: each is its own blend action, and a wallet's CPU has limits. */
const MAX_OPEN = 50
const REVEAL_POLL_MS = 3_000
/** After this the reveal stops waiting; late materials still arrive in the wallet. */
const REVEAL_TIMEOUT_MS = 120_000

interface Reveal {
  expected: number
  withKey: boolean
  /** WAX one opening cost at today's floors, for the comparison. */
  costEach: number | null
  before: Set<string>
  found: AtomicAsset[]
  started: number
  done: boolean
}

/**
 * Opens chests and then watches the wallet for what the random oracle mints: every material that
 * was not there before the transaction is a result.
 */
function useReveal(account: string | null, run: Run) {
  const [state, setState] = useState<Reveal | null>(null)

  async function open(runs: BlendRun[], withKey: boolean, costEach: number | null, key: string) {
    if (!account) return
    // What the wallet held before, so the new materials can be told apart.
    const before = await atomic
      .getOwnedAssets(account, 'planetdefnft')
      .then((list) => new Set(list.map((a) => a.asset_id)))
      .catch(() => null)
    if (!before) return
    const ok = await run((a, p) => blendActions(a, p, runs), `${runs.length} opened: watching for what comes out`, key)
    if (ok) setState({ expected: runs.length, withKey, costEach, before, found: [], started: Date.now(), done: false })
  }

  useEffect(() => {
    if (!state || state.done || !account) return
    const poll = async () => {
      const assets = await atomic.getOwnedAssets(account, 'planetdefnft').catch(() => null)
      setState((r) => {
        if (r !== state) return r
        const found = assets ? assets.filter((a) => a.schema.schema_name === 'material' && !r.before.has(a.asset_id)) : r.found
        return { ...r, found, done: found.length >= r.expected || Date.now() - r.started > REVEAL_TIMEOUT_MS }
      })
    }
    const timer = setTimeout(() => void poll(), REVEAL_POLL_MS)
    return () => clearTimeout(timer)
  }, [state, account])

  // The wallet changed: refresh what the recipes and cards count as owned.
  const done = state?.done ?? false
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['owned-blend-inputs'] })
  }, [done])

  return { state, open, close: () => setState(null) }
}

function RevealPanel({
  reveal,
  market,
  byTemplate,
  onClose
}: {
  reveal: Reveal
  market: Market
  byTemplate: Map<string, MaterialValue>
  onClose: () => void
}) {
  const counts = new Map<string, number>()
  for (const a of reveal.found) {
    const t = a.template?.template_id ?? '?'
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const items = [...counts]
    .map(([t, n]) => ({ t, n, tpl: market.templates.get(t), mv: byTemplate.get(t) }))
    .sort((a, b) => (b.mv?.value ?? 0) - (a.mv?.value ?? 0))
  const worth = items.reduce((sum, i) => sum + i.n * (i.mv?.value ?? 0) * SALE_KEEP, 0)
  const cost = reveal.costEach !== null ? reveal.costEach * reveal.found.length : null
  const arrived = reveal.found.length
  const what = reveal.withKey ? 'chest + key' : 'chest'

  return (
    <section className="box bl-reveal" aria-live="polite">
      <header className="bl-reveal__head">
        <div className="bl-reveal__title">
          <span className="eyebrow">
            Opened {reveal.expected} × {what}
          </span>
          <h3>
            {!reveal.done && <span className="bl-spin" />}{' '}
            {!reveal.done
              ? `Revealing… ${arrived} of ${reveal.expected}`
              : arrived >= reveal.expected
                ? 'Here is what came out'
                : `${arrived} of ${reveal.expected} arrived so far`}
          </h3>
        </div>
        <button type="button" className="bl-x" aria-label="Close" title="Close" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </header>
      <span className="bar2">
        <i style={{ width: `${Math.min(100, (arrived / Math.max(1, reveal.expected)) * 100)}%` }} />
      </span>
      {arrived > 0 && (
        <div
          className="bl-figrow"
          title="What these materials sell for at market value after the 7% sale fees, against what the openings cost at today's floors."
        >
          <Fig label="Worth" value={wax(worth)} />
          {cost !== null && (
            <>
              <Fig label="Cost" value={wax(cost)} />
              <Fig
                label={worth >= cost ? 'Gain' : 'Loss'}
                value={`${worth >= cost ? '+' : ''}${wax(worth - cost)}`}
                tone={worth >= cost ? 'is-good' : 'is-bad'}
              />
            </>
          )}
        </div>
      )}
      {arrived === 0 && !reveal.done && (
        <p className="muted bl-note">The random oracle mints the materials a few seconds after the transaction.</p>
      )}
      {reveal.done && arrived < reveal.expected && (
        <p className="muted bl-note">The rest is not minted yet. It shows up in your wallet once the oracle gets to it.</p>
      )}
      {items.length > 0 && (
        <div className="bl-reveal__grid">
          {items.map((i) => (
            <div key={i.t} className="bl-reveal__item" style={{ '--rc': rarityColor(i.tpl?.rarity) } as CSSProperties}>
              <Portrait img={i.tpl?.img} rarity={i.tpl?.rarity} className="bl-pic bl-pic--lg" />
              <b className="bl-reveal__count num">×{i.n}</b>
              <span className="bl-reveal__name">{i.tpl?.name ?? `#${i.t}`}</span>
              <small className="muted">
                <span className="cap">{i.tpl?.rarity}</span>
                {i.mv?.value != null ? ` · ${wax(i.mv.value)} each` : ''}
              </small>
              <StarRail asset={{ templateId: String(i.t), rarity: i.tpl?.rarity ?? '' }} size="sm" />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ---- Ascension --------------------------------------------------------------------------------------

/*
 * The Ascension view: the Ascend Nexus (raise a card a star with Fragments) and the Sacrificial
 * Altar (burn cards for Fragments). Both work on cards in the wallet: a staked card has to be
 * unstaked first. Everything that goes in is burned.
 */

/** Cards per sacrifice transaction at most. */
const SACRIFICE_PER_TX = 20
const stars = (a: AssetRef) => Number(a.stats?.min_forge_level ?? 0)
const starText = (n: number) => (n > 0 ? '★'.repeat(n) : 'no stars')

function Ascension({
  account,
  market,
  run,
  pending: busy,
  spectating
}: {
  account: string
  market: Market
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const config = useAscensionConfig()
  const wallet = useWalletNfts(account || null)
  const army = useArmy(account || null)
  const stats = useAssetStats()
  const pending = usePendingBurns(account || null)

  // Fragments in the wallet: the market's owned map holds material by template.
  const fragmentIds = market.owned.get(FRAGMENT_TEMPLATE) ?? []
  const fragmentValue = valueOf(market, FRAGMENT_TEMPLATE)

  // When a pending sacrifice is revealed, the wallet has new Fragments: read it again.
  const pendingCount = pending.data?.length ?? 0
  const lastPending = useRef(0)
  useEffect(() => {
    if (lastPending.current > 0 && pendingCount < lastPending.current) void refreshPlayer(account)
    lastPending.current = pendingCount
  }, [pendingCount, account])

  // Wallet cards by template.
  const groups = useMemo(() => {
    const m = new Map<string, AssetRef[]>()
    for (const a of wallet.data ?? []) m.set(a.templateId, [...(m.get(a.templateId) ?? []), a])
    return m
  }, [wallet.data])

  if (!account)
    return (
      <div className="box">
        <p className="none">Sign in, or add ?as=account to the address, to see your cards.</p>
      </div>
    )
  if (!config.data || !stats.data || !wallet.data)
    return (
      <div className="box">
        <p className="muted bl-loading">
          <span className="bl-spin" /> Reading the Ascension tables…
        </p>
      </div>
    )
  const cfg = config.data

  // ---- Ascend ----
  const ascendable = [...groups.entries()]
    .map(([templateId, cards]) => {
      const to = cfg.next.get(templateId)
      const sample = cards[0]
      const from = stars(sample)
      const cost = cfg.costs.get(costKey(sample.rarity, from)) ?? null
      const nextStats = to ? stats.data!.get(to) : undefined
      return { templateId, cards, sample, from, to, cost, nextStats }
    })
    .filter((r) => r.to && r.cost !== null)
    .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))
  const stakedAscendable = [...(army.data?.assets.values() ?? [])].filter((a) => cfg.next.has(a.templateId)).length

  // ---- Sacrifice ----
  const sacrificeable = [...groups.entries()]
    .map(([templateId, cards]) => {
      const sample = cards[0]
      const y = cfg.yields.get(sample.rarity.toLowerCase()) ?? null
      return { templateId, cards, sample, y, floor: valueOf(market, templateId) }
    })
    .filter((r) => r.y)
    .sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0))

  const burnMin = pending.data?.reduce((n, p) => n + p.min, 0) ?? 0
  const burnMax = pending.data?.reduce((n, p) => n + p.max, 0) ?? 0

  return (
    <>
      <div className="box">
        <h3 className="h">
          Fragments
          <small>burned cards become Fragments; Fragments raise a card a star</small>
        </h3>
        {cfg.paused && <p className="bl-warn">Ascension is paused by the game right now.</p>}
        <div className="bl-figrow">
          <Fig label="You hold" value={formatNumber(fragmentIds.length, 0)} title="Fragments in your wallet." />
          <Fig label="One is worth" value={`${wax(fragmentValue)} WAX`} title="Market value: the lower of the floor and the recent sale median." />
          {pendingCount > 0 && (
            <Fig
              label="Awaiting reveal"
              value={`${burnMin}–${burnMax}`}
              tone="c-move"
              title="Sacrifices the oracle has not revealed yet; it usually takes a few seconds. The Fragments appear in your wallet when it does."
            />
          )}
        </div>
        {pendingCount > 0 && (
          <p className="bl-note">
            <span className="bl-spin" /> {pendingCount} sacrifice{pendingCount === 1 ? '' : 's'} waiting for the oracle: {burnMin}–{burnMax}{' '}
            Fragments on the way.
          </p>
        )}
        {stakedAscendable > 0 && (
          <p className="help">
            {stakedAscendable} staked card{stakedAscendable === 1 ? '' : 's'} could ascend too, after unstaking them on the Divisions page.
          </p>
        )}
      </div>

      <AscendList rows={ascendable} fragmentIds={fragmentIds} paused={cfg.paused} busy={busy} spectating={spectating} run={run} />
      <SacrificeList
        rows={sacrificeable}
        fragmentValue={fragmentValue}
        paused={cfg.paused}
        busy={busy}
        spectating={spectating}
        run={run}
      />
    </>
  )
}

interface AscendRow {
  templateId: string
  cards: AssetRef[]
  sample: AssetRef
  from: number
  to: string | undefined
  cost: number | null
  nextStats: AssetStats | undefined
}

function AscendList({
  rows,
  fragmentIds,
  paused,
  busy,
  spectating,
  run
}: {
  rows: AscendRow[]
  fragmentIds: string[]
  paused: boolean
  busy: string | null
  spectating: boolean
  run: Run
}) {
  return (
    <div className="box">
      <h3 className="h">
        Ascend
        <small>{rows.length ? `${rows.length} card${rows.length === 1 ? '' : 's'} can go up a star` : 'nothing to ascend'}</small>
      </h3>
      <p className="bl-blurb">
        A card goes up one star at a time, for Fragments. The card and the Fragments are burned and the next star of the same card is
        minted to you at once. A card with N stars needs Forge level N to be equipped. Common to Rare go to 3 stars, Epic and above to
        5. Warlords, creatures, supplies and Lava Lux can ascend; mercenaries and weapons cannot yet.
      </p>
      {rows.length === 0 ? (
        <p className="none">No card in your wallet can ascend. Staked cards have to be unstaked first.</p>
      ) : (
        <div className="bl-recs">
          {rows.map((r) => {
            const st = r.sample.stats!
            const isSupply = kindOf(st) === 'supply'
            const enough = fragmentIds.length >= (r.cost ?? Infinity)
            const kind = kindOf(st)
            return (
              <article key={r.templateId} className="bl-rec bl-rec--asc">
                <div className="bl-card">
                  <Portrait img={r.sample.img} rarity={r.sample.rarity} className="bl-pic bl-pic--lg" />
                  <span className="bl-card__text">
                    <b>{r.sample.name}</b>
                    <small>
                      <i className="dot" style={{ background: rarityColor(r.sample.rarity) }} /> <span className="cap">{r.sample.rarity}</span>{' '}
                      {kind ? KIND_LABEL[kind] : ''} · you have {r.cards.length}
                    </small>
                    <StarRail asset={r.sample} size="sm" />
                  </span>
                </div>
                <div className="bl-change num">
                  <span>
                    <small>now</small>
                    <b>
                      {st.attack}/{st.defense}
                      {isSupply ? ` −${st.movecost_reduction} move` : ` · ${st.movecost} move`}
                    </b>
                  </span>
                  <span className="bl-change__arrow" aria-hidden="true">
                    →
                  </span>
                  <span>
                    <small>{starText(r.from + 1)}</small>
                    <b className="is-good">
                      {r.nextStats ? `${r.nextStats.attack}/${r.nextStats.defense}` : '?'}
                      {r.nextStats ? (isSupply ? ` −${r.nextStats.movecost_reduction} move` : ` · ${r.nextStats.movecost} move`) : ''}
                    </b>
                  </span>
                </div>
                <div className="bl-cost">
                  <Fig label="Costs" value={`${r.cost} Fragments`} tone={enough ? '' : 'is-bad'} />
                  <small className="muted">needs Forge level {r.from + 1} to equip</small>
                </div>
                <div className="bl-act bl-act--one">
                  <button
                    type="button"
                    className="btn btn--sm btn--go"
                    disabled={!enough || paused || spectating || !!busy}
                    title={
                      spectating
                        ? READ_ONLY
                        : enough
                          ? `One transaction: ${r.sample.name} and ${r.cost} Fragments go to ascend.pdef and are burned; the ${starText(r.from + 1)} version is minted to you.`
                          : `You have ${fragmentIds.length} Fragments; this star costs ${r.cost}.`
                    }
                    onClick={() =>
                      void run(
                        (a, p) => ascendAction(a, p, r.cards[0].assetId, fragmentIds.slice(0, r.cost!)),
                        `${r.sample.name} ascended to ${starText(r.from + 1)}`,
                        `ascend-${r.templateId}`
                      )
                    }
                  >
                    <Icon name="spark" size={14} /> {busy === `ascend-${r.templateId}` ? 'Signing…' : 'Ascend one'}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface SacrificeRow {
  templateId: string
  cards: AssetRef[]
  sample: AssetRef
  y: { guaranteed: number; bonus: number; bonusChance: number; rarity: string } | null
  floor: number | null
}

function SacrificeList({
  rows,
  fragmentValue,
  paused,
  busy,
  spectating,
  run
}: {
  rows: SacrificeRow[]
  fragmentValue: number | null
  paused: boolean
  busy: string | null
  spectating: boolean
  run: Run
}) {
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<'all' | 'worth'>('all')
  const count = (t: string) => picked[t] ?? 0
  const total = rows.reduce((n, r) => n + count(r.templateId), 0)
  const setCount = (t: string, n: number, max: number) => setPicked((p) => ({ ...p, [t]: Math.max(0, Math.min(max, n)) }))
  const sum = (f: (r: SacrificeRow) => number) => rows.reduce((n, r) => n + count(r.templateId) * f(r), 0)
  const min = sum((r) => r.y!.guaranteed)
  const max = sum((r) => r.y!.guaranteed + r.y!.bonus)
  const expected = sum((r) => expectedYield(r.y!))
  const cardsValue = sum((r) => (r.floor ?? 0) * SALE_KEEP)
  const fragmentsValue = fragmentValue === null ? null : expected * fragmentValue * SALE_KEEP
  const shown = rows.filter((r) => filter === 'all' || worthIt(r, fragmentValue))
  const going = Math.min(total, SACRIFICE_PER_TX)

  async function sacrifice() {
    const ids = rows.flatMap((r) => r.cards.slice(0, count(r.templateId)).map((a) => a.assetId)).slice(0, SACRIFICE_PER_TX)
    if (!ids.length) return
    const ok = await run(
      (a, p) => sacrificeAction(a, p, ids),
      `${ids.length} card${ids.length === 1 ? '' : 's'} sacrificed: the Fragments arrive after the reveal, in a few seconds`,
      'sacrifice'
    )
    if (ok) setPicked({})
  }

  return (
    <div className="box">
      <h3 className="h">
        Sacrifice
        <small>burn cards for Fragments</small>
      </h3>
      <p className="bl-blurb">
        Each card gives a set number of Fragments for its rarity, plus a bonus by chance. Its market value sits next to what its
        Fragments are worth, so you can see when selling pays more.
      </p>
      <div className="bl-tools">
        <span className="seg seg--pick">
          <button type="button" className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>
            All cards
          </button>
          <button type="button" className={filter === 'worth' ? 'is-on' : ''} onClick={() => setFilter('worth')}>
            Worth burning
          </button>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="none">No card in your wallet. Only wallet cards can be sacrificed: unstake the ones you want to burn first.</p>
      ) : !shown.length ? (
        <p className="none">No card is worth more as Fragments right now.</p>
      ) : (
        <table className="t bl-stack">
          <thead>
            <tr>
              <th>Card</th>
              <th className="num">Fragments each</th>
              <th className="num">Card value</th>
              <th className="num">Fragments value</th>
              <th className="bl-stepcol">Sacrifice</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const y = r.y!
              const each = expectedYield(y)
              const fragWorth = fragmentValue === null ? null : each * fragmentValue * SALE_KEEP
              const cardWorth = r.floor === null ? null : r.floor * SALE_KEEP
              const n = count(r.templateId)
              return (
                <tr key={r.templateId} className={n > 0 ? 'is-me' : ''}>
                  <td className="bl-stack__lead">
                    <span className="bl-card bl-card--sm">
                      <Portrait img={r.sample.img} rarity={r.sample.rarity} className="bl-pic" />
                      <span className="bl-card__text">
                        <b>{r.sample.name}</b>
                        <small>
                          <i className="dot" style={{ background: rarityColor(r.sample.rarity) }} /> <span className="cap">{r.sample.rarity}</span> · you have{' '}
                          {r.cards.length}
                        </small>
                        <StarRail asset={r.sample} size="sm" />
                      </span>
                    </span>
                  </td>
                  <td
                    data-label="Fragments each"
                    className="num"
                    title={`${y.guaranteed} guaranteed, plus ${y.bonus} more with a ${formatNumber(y.bonusChance * 100, 0)}% chance.`}
                  >
                    {y.guaranteed}
                    <small className="muted">
                      {' '}
                      +{y.bonus} at {formatNumber(y.bonusChance * 100, 0)}%
                    </small>
                  </td>
                  <td data-label="Card value" className="num" title="At market value, after the 7% sale fees.">
                    {cardWorth === null ? '–' : `${wax(cardWorth)} WAX`}
                  </td>
                  <td data-label="Fragments value" className={`num ${worthIt(r, fragmentValue) ? 'is-good' : ''}`}>
                    {fragWorth === null ? '–' : `≈ ${wax(fragWorth)} WAX`}
                  </td>
                  <td data-label="Sacrifice" className="bl-stepcol">
                    <Stepper
                      value={n}
                      min={0}
                      max={r.cards.length}
                      onChange={(v) => setCount(r.templateId, v, r.cards.length)}
                      label={`How many ${r.sample.name} to sacrifice`}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {total > 0 && (
        <div className="bl-summary">
          <div className="bl-figrow">
            <Fig label="Cards" value={total} />
            <Fig label="Fragments" value={`${min}–${max}`} title={`About ${formatNumber(expected, 1)} on average.`} />
            <Fig label="Cards are worth" value={`${wax(cardsValue)} WAX`} title="At market value, after the 7% sale fees." />
            <Fig
              label="Fragments are worth"
              value={fragmentsValue === null ? '–' : `≈ ${wax(fragmentsValue)} WAX`}
              tone={fragmentsValue !== null && fragmentsValue >= cardsValue ? 'is-good' : 'is-bad'}
            />
          </div>
          <div className="bl-summary__go">
            {total > SACRIFICE_PER_TX && (
              <small className="muted">
                {SACRIFICE_PER_TX} cards per transaction: the first {SACRIFICE_PER_TX} go now.
              </small>
            )}
            <button type="button" className="btn btn--sm" onClick={() => setPicked({})} disabled={busy === 'sacrifice'}>
              Clear
            </button>
            <button
              type="button"
              className="btn btn--sm btn--bad"
              disabled={paused || spectating || !!busy}
              title={spectating ? READ_ONLY : 'The cards go to ascend.pdef and are burned. This cannot be undone.'}
              onClick={() => void sacrifice()}
            >
              <Icon name="flame" size={14} /> {busy === 'sacrifice' ? 'Signing…' : `Sacrifice ${going} card${going === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Whether a card's Fragments are worth more than the card itself on the market. */
function worthIt(r: SacrificeRow, fragmentValue: number | null) {
  if (!r.y || fragmentValue === null) return false
  const frag = expectedYield(r.y) * fragmentValue
  return r.floor === null || frag > r.floor
}
