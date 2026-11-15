import { useMemo, useState } from 'react'

import { FRAGMENT_TEMPLATE } from '@/chain/config'
import { useAscensionConfig, type AscensionConfig } from '@/data/ascension'
import type { Blend } from '@/data/blends'
import { useAssetStats } from '@/data/game'
import { queryClient } from '@/data/queryClient'
import type { AssetStats } from '@/data/types'
import { cheapestRoute, fragmentSupply, fragmentsBetween, linesOf, routeSources, routeTransactions, type Line, type Route, type Supply } from '@/lib/ascensionRoutes'
import type { Market } from '@/lib/blendEconomy'
import { formatNumber } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'

/*
 * Blend → Ascension info: every card that ascends, by category, through all of its stars. Pick a
 * card on the left; on the right a ledger of its stars: what each step gains and costs in
 * Fragments, how much each Fragment buys, and the cheapest way to own the card at that star from
 * today's market, with a button that runs it (lib/ascensionRoutes).
 */

const CATS: [string, string][] = [
  ['mercenary', 'Mercenaries'],
  ['warlord', 'Warlords'],
  ['creature', 'Creatures'],
  ['supplies', 'Supplies'],
  ['services', 'Lava Lux']
]
const RANK = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']
const wax = (n: number) => formatNumber(Math.round(n), 0)
const mult = (bp: number) => `×${(bp / 10000).toFixed(2)}`

// ---- What a card is at one star, and what a step adds: shared with the Ascension view ----------------

/** The card at one star, in the terms of its category. */
export function StatLine({ schema, s }: { schema: string; s: AssetStats | undefined }) {
  if (!s) return <span className="muted">?</span>
  if (schema === 'warlord')
    return (
      <span className="num">
        <span title="Mercenary places in its division">{s.slots_max} place{s.slots_max === 1 ? '' : 's'}</span>
        {' · '}
        {s.movecost_reduction ? <span className="c-move" title="Taken off the whole division's move cost">−{s.movecost_reduction} move</span> : <span className="muted">no move cut</span>}
      </span>
    )
  if (schema === 'services')
    return (
      <span className="num">
        <span className="c-atk">{mult(s.attack_mult_bp)}</span> <span className="c-def">{mult(s.defense_mult_bp)}</span>{' '}
        <span className="c-move" title="Move multiplier: lower is faster">{mult(s.movecost_mult_bp)} move</span>
      </span>
    )
  return (
    <span className="num">
      <span className="c-atk">{s.attack}</span>/<span className="c-def">{s.defense}</span>
      {schema === 'mercenary' && <span className="c-move"> · {s.movecost} move</span>}
      {schema === 'supplies' && <span className="c-move" title="Taken off its mercenary's move cost"> · −{s.movecost_reduction} move</span>}
    </span>
  )
}

/** What one step changes: better in green, worse in red. */
export function GainLine({ schema, from, to }: { schema: string; from: AssetStats | undefined; to: AssetStats | undefined }) {
  if (!from || !to) return <span className="muted">?</span>
  const parts: { text: string; good: boolean }[] = []
  const d = (x: number, label: string, upIsGood = true) => {
    if (!x) return
    parts.push({ text: `${x > 0 ? '+' : '−'}${Math.abs(x)} ${label}`, good: upIsGood ? x > 0 : x < 0 })
  }
  if (schema === 'services') {
    const a = (to.attack_mult_bp - from.attack_mult_bp) / 10000
    const m = (to.movecost_mult_bp - from.movecost_mult_bp) / 10000
    if (a) parts.push({ text: `${a > 0 ? '+' : '−'}${Math.abs(a).toFixed(2)}× atk/def`, good: a > 0 })
    if (m) parts.push({ text: `${m > 0 ? '+' : '−'}${Math.abs(m).toFixed(2)}× move`, good: m < 0 })
  } else if (schema === 'warlord') {
    d(to.slots_max - from.slots_max, to.slots_max - from.slots_max === 1 ? 'place' : 'places')
    d(to.movecost_reduction - from.movecost_reduction, 'move cut')
  } else {
    d(to.attack - from.attack, 'atk')
    d(to.defense - from.defense, 'def')
    if (schema === 'mercenary') d(to.movecost - from.movecost, 'move', false)
    if (schema === 'supplies') d(to.movecost_reduction - from.movecost_reduction, 'move cut')
  }
  if (!parts.length) return <span className="muted">no change</span>
  return (
    <span className="num ai-gain">
      {parts.map((p) => (
        <span key={p.text} className={p.good ? 'c-good' : 'c-bad'}>
          {p.text}
        </span>
      ))}
    </span>
  )
}

/** One number for how much a step buys, to compare steps per Fragment. */
function gainValue(schema: string, from: AssetStats, to: AssetStats): number {
  if (schema === 'warlord') return to.movecost_reduction - from.movecost_reduction + (to.slots_max - from.slots_max) * 10
  if (schema === 'services') return (to.attack_mult_bp - from.attack_mult_bp) / 100 + (from.movecost_mult_bp - to.movecost_mult_bp) / 100
  if (schema === 'supplies') return to.attack - from.attack + to.defense - from.defense + (to.movecost_reduction - from.movecost_reduction)
  return to.attack - from.attack + to.defense - from.defense
}

/** The cheapest Fragments for the whole page, computed once per market. */
export function useFragmentSupply(cfg: AscensionConfig | undefined, market: Market, blends: Blend[], lines: Line[]): Supply | null {
  return useMemo(() => {
    if (!cfg) return null
    const target = Math.max(0, ...lines.map((l) => fragmentsBetween(cfg, l.rarity, 0, l.templates.length - 1)))
    // The cards a route would buy to ascend are not sacrificed.
    const exclude = new Set(lines.flatMap((l) => l.templates.flatMap((t) => (market.listings.get(t)?.[0] ? [market.listings.get(t)![0].saleId] : []))))
    return fragmentSupply(cfg, market, blends, target, exclude)
  }, [cfg, market, blends, lines])
}

// ---- The page ---------------------------------------------------------------------------------------

export function AscensionInfo({ market, blends, spectating }: { market: Market; blends: Blend[]; spectating: boolean }) {
  const config = useAscensionConfig()
  const stats = useAssetStats()
  const { runSequence, pending } = useTransaction()
  const cfg = config.data
  const lines = useMemo(
    () =>
      cfg
        ? linesOf(cfg, market).sort(
            (a, b) => RANK.indexOf(a.rarity.toLowerCase()) - RANK.indexOf(b.rarity.toLowerCase()) || a.name.localeCompare(b.name)
          )
        : [],
    [cfg, market]
  )
  const supply = useFragmentSupply(cfg, market, blends, lines)
  const [pick, setPick] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Route | null>(null)

  if (!cfg || !stats.data || !supply)
    return (
      <div className="box">
        <p className="muted bl-loading">
          <span className="bl-spin" /> Reading the Ascension tables and the market…
        </p>
      </div>
    )

  const line = lines.find((l) => l.templates[0] === pick) ?? lines.find((l) => l.schema === 'mercenary') ?? lines[0]
  const statsAt = (s: number) => stats.data!.get(line.templates[s])
  const max = line.templates.length - 1
  const top = market.templates.get(line.templates[0])
  const routes = line.templates.map((_, s) => cheapestRoute(cfg, market, supply, line, s))
  const steps = line.templates.slice(1).map((_, i) => {
    const frags = fragmentsBetween(cfg, line.rarity, i, i + 1)
    const before = fragmentsBetween(cfg, line.rarity, 0, i)
    const stepWax = supply.cost[before + frags] !== undefined ? supply.cost[before + frags] - supply.cost[before] : null
    const f = statsAt(i)
    const t = statsAt(i + 1)
    return { frags, stepWax, per: f && t ? gainValue(line.schema, f, t) / frags : 0 }
  })
  const best = Math.max(...steps.map((s) => s.per), 1e-9)
  const climb = fragmentsBetween(cfg, line.rarity, 0, max)

  // Today's price of one Fragment by each source, for the strip under the ledger.
  const firstOf = (kind: string) => supply.units.find((u) => u.kind === kind)
  const fragFloor = market.listings.get(FRAGMENT_TEMPLATE)?.[0]?.price ?? null
  const sac = firstOf('sacrifice')
  const craft = firstOf('craft')

  async function go(r: Route) {
    const done = await runSequence(routeTransactions(r, market, cfg!), 'asc-get', `${r.line.name} to ★${r.star}`)
    setConfirm(null)
    if (done) void Promise.all(['market-listings', 'owned-blend-inputs'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })))
  }

  return (
    <div className="ai">
      <nav className="box ai__list" aria-label="Cards">
        {CATS.map(([k, label]) => (
          <div key={k} className="ai__grp">
            <small>{label}</small>
            {lines
              .filter((l) => l.schema === k)
              .map((l) => (
                <button
                  key={l.templates[0]}
                  type="button"
                  className={`ai__pick${l === line ? ' is-on' : ''}`}
                  style={{ '--rc': rarityColor(l.rarity) } as React.CSSProperties}
                  onClick={() => {
                    setPick(l.templates[0])
                    setConfirm(null)
                  }}
                >
                  <i className="dot" />
                  <b>{l.name}</b>
                  <span className="ai__stars">{'★'.repeat(l.templates.length - 1)}</span>
                </button>
              ))}
          </div>
        ))}
      </nav>

      <section className="box ai__main">
        <div className="ai__hero">
          <Portrait img={top?.img} rarity={line.rarity} className="bl-pic bl-pic--lg" />
          <div className="ai__title">
            <h3>{line.name}</h3>
            <small>
              <i className="dot" style={{ background: rarityColor(line.rarity) }} /> <span className="cap">{line.rarity}</span> ·{' '}
              {CATS.find((c) => c[0] === line.schema)?.[1]} · up to ★{max}
            </small>
          </div>
          <div className="ai__figs">
            <span className="fig">
              <small>Base</small>
              <b>
                <StatLine schema={line.schema} s={statsAt(0)} />
              </b>
            </span>
            <span className="fig">
              <small>At ★{max}</small>
              <b>
                <StatLine schema={line.schema} s={statsAt(max)} />
              </b>
            </span>
            <span className="fig">
              <small>Full climb</small>
              <b className="num c-frag">◆ {climb}</b>
              <span className="muted num">{supply.cost[climb] !== undefined ? `≈ ${wax(supply.cost[climb])} WAX` : 'more than the market has'}</span>
            </span>
          </div>
        </div>

        {confirm && (
          <div className="ai__confirm">
            <b>
              {confirm.line.name} ★{confirm.star} for ≈ {wax(confirm.wax)} WAX?
            </b>
            <ol>
              {confirm.from === confirm.star ? (
                <li>Buy the ★{confirm.star} listing ({wax(confirm.listing.price)} WAX)</li>
              ) : (
                <>
                  {confirm.units.some((u) => u.kind === 'craft') && <li>Buy the materials and craft the cards to sacrifice</li>}
                  {confirm.units.some((u) => u.kind === 'craft' || u.kind === 'sacrifice') && (
                    <li>Sacrifice them for Fragments, and wait for the game&apos;s oracle to reveal them</li>
                  )}
                  <li>
                    Buy {confirm.line.name} ★{confirm.from} ({wax(confirm.listing.price)} WAX)
                    {confirm.units.some((u) => u.kind === 'buy') ? ' and the Fragment listings' : ''}, and ascend it to ★{confirm.from + 1}
                  </li>
                  {confirm.star > confirm.from + 1 && <li>Ascend it on to ★{confirm.star}, one star per transaction</li>}
                </>
              )}
            </ol>
            <small className="muted">
              Fragments: {routeSources(confirm, market).join(', ') || 'none needed'}. {confirm.txs} transaction{confirm.txs === 1 ? '' : 's'}, one after
              another. Everything bought is burned, apart from the card you end up with.
            </small>
            <span className="ai__acts">
              <button type="button" className="btn btn--go btn--sm" disabled={spectating || !!pending} onClick={() => void go(confirm)}>
                {pending === 'asc-get' ? 'Signing…' : 'Yes, run it'}
              </button>
              <button type="button" className="btn btn--sm" disabled={pending === 'asc-get'} onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </span>
          </div>
        )}

        <div className="ai__tbl">
          <table>
            <thead>
              <tr>
                <th>Star</th>
                <th>Card</th>
                <th>Gain</th>
                <th className="r">Step cost</th>
                <th>Gain per ◆</th>
                <th className="r">Forge</th>
                <th>Cheapest way to own it</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {line.templates.map((t, s) => {
                const r = routes[s]
                const step = s > 0 ? steps[s - 1] : null
                return (
                  <tr key={t}>
                    <td className="ai__star">{s ? '★'.repeat(s) : '☆'}</td>
                    <td>
                      <StatLine schema={line.schema} s={statsAt(s)} />
                    </td>
                    <td>{s ? <GainLine schema={line.schema} from={statsAt(s - 1)} to={statsAt(s)} /> : <span className="muted">base card</span>}</td>
                    <td className="r num">
                      {step ? (
                        <>
                          <span className="c-frag">◆ {step.frags}</span>
                          <br />
                          <small className="muted">{step.stepWax !== null ? `≈ ${wax(step.stepWax)} WAX` : '–'}</small>
                        </>
                      ) : null}
                    </td>
                    <td>{step && <span className="ai__bar" title="What this step buys per Fragment, against the best step of this card"><i style={{ width: `${(step.per / best) * 100}%` }} /></span>}</td>
                    <td className="r muted">{s ? `F${s}` : ''}</td>
                    <td className="ai__route">
                      {!r ? (
                        <span className="muted">nobody lists it at this star or below</span>
                      ) : r.from === s ? (
                        <>buy the ★{s} listing</>
                      ) : (
                        <>
                          buy ★{r.from} ({wax(r.listing.price)}) + {routeSources(r, market).join(', ')}, ascend {s - r.from}×
                          <small className="muted">
                            {' '}
                            · {r.txs} transaction{r.txs === 1 ? '' : 's'}
                          </small>
                        </>
                      )}
                    </td>
                    <td className="r">
                      {r && (
                        <button
                          type="button"
                          className="btn btn--sm btn--go ai__get"
                          disabled={spectating || !!pending}
                          title={spectating ? 'Read-only: not your account' : `Shows the steps first`}
                          onClick={() => setConfirm(r)}
                        >
                          Get ★{s} <small className="num">{wax(r.wax)}</small>
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="ai__prices">
          <span className="fig">
            <small>Fragment listing</small>
            <b className="num">{fragFloor !== null ? `${wax(fragFloor)} WAX` : '–'}</b>
          </span>
          {craft && craft.kind === 'craft' && (
            <span className="fig">
              <small>Craft &amp; sacrifice</small>
              <b className="num">{wax(craft.wax / craft.frags)} WAX/◆</b>
              <span className="muted">{market.templates.get(craft.result)?.name}</span>
            </span>
          )}
          {sac && sac.kind === 'sacrifice' && (
            <span className="fig">
              <small>Buy &amp; sacrifice</small>
              <b className="num">{wax(sac.wax / sac.frags)} WAX/◆</b>
              <span className="muted">{sac.listing.asset.name}</span>
            </span>
          )}
          <span className="fig">
            <small>You hold</small>
            <b className="num c-frag">◆ {supply.owned}</b>
            <span className="muted">used first</span>
          </span>
        </div>
        <p className="help">
          Cheapest from today&apos;s listings, walked in price order: buying a card at a star, or a lower star and ascending it. Fragments come from your
          wallet first, then whatever is cheapest per Fragment: a Fragment listing, a card bought and sacrificed, or a card crafted from bought
          materials and sacrificed (sure Fragments only, never the bonus; your own materials are left alone). A star needs that Forge level to be
          equipped.
        </p>
      </section>
    </div>
  )
}
