import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { formatNumber } from '@/lib/format'
import { cardSources, COLLECTIONS, LIST_PER_TX, MIN_MOVE_WAX, nameOf, REPRICE_PER_TX, schemaLabel, useSell, waxOf } from '@/lib/useSell'

import { Thumb } from '../MarketSell'

import './Sell.css'

/*
 * Couch mode's Sell tab: Market → Sell on the phone, every category of both collections (the logic
 * is lib/useSell.ts, shared with Market → Sell). The categories sit behind one line that opens a
 * list of switches; how much of each, four figures and one List everything key; your listings with
 * the key that moves them to the lowest, which first shows every price it changes; every template
 * you hold, the dearest first, with a stepper for how many go up; and your listings, dearest first.
 * While a run signs, its progress sits at the top.
 */

/** Your listings shown before "Show all": the page stays quick with thousands of them. */
const LISTINGS_SHOWN = 40

const wax = (n: number) => formatNumber(n, n >= 1000 ? 0 : 2)
const txs = (n: number) => `${formatNumber(n, 0)} transaction${n === 1 ? '' : 's'}`

/** A sheet over the whole couch screen: drawn into the couch's root, above the tab bar (the page itself sits below it). */
function Sheet({ host, children }: { host: Element | null; children: ReactNode }) {
  return host ? createPortal(children, host) : null
}

/** Sell or Sold: the two halves of the Sell tab, switched at its top. */
export type SellView = 'sell' | 'sold'

/** The switch at the top of the Sell tab: what to list, or what sold in the last 48 hours. */
export function SellSwitch({ view, onView }: { view: SellView; onView: (v: SellView) => void }) {
  return (
    <div className="cs cs__seg cs__view" role="tablist" aria-label="Sell or sold">
      {(
        [
          ['sell', 'Sell'],
          ['sold', 'Sold · 48 h']
        ] as const
      ).map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'is-on' : ''} onClick={() => onView(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function SellPage({ account, head }: { account: string; head?: ReactNode }) {
  const s = useSell(account)
  const { plan, done, running } = s
  const [cats, setCats] = useState(false)
  /** The price check before a move to the lowest: open from planning until Start or Cancel. */
  const [review, setReview] = useState(false)
  const [allListings, setAllListings] = useState(false)
  const off = s.spectating || running || !!s.pending
  const page = useRef<HTMLElement>(null)
  const [host, setHost] = useState<Element | null>(null)
  useEffect(() => setHost(page.current?.closest('.couch') ?? null), [])

  const picked = s.schemas.filter(([x]) => s.on.has(x))
  const showProgress = !!plan && !(plan.kind === 'reprice' && review)
  const firstTodo = plan ? plan.steps.findIndex((x) => x.state !== 'done') : -1
  const from = Math.max(0, (firstTodo < 0 ? (plan?.steps.length ?? 0) : firstTodo) - 2)
  const shownSteps = plan ? plan.steps.slice(from, from + 4) : []
  const moveDrop = s.above.reduce((n, x) => n + (s.overOf(x) ?? 0), 0)
  const listings = allListings ? s.mineByPrice : s.mineByPrice.slice(0, LISTINGS_SHOWN)

  return (
    <section className="couch__bankpage cs" aria-label="Sell" ref={page}>
      {head}
      {showProgress && plan && (
        <div className="cs__prog" aria-label="Transactions">
          <div className="cs__prog-hd">
            <b>
              {plan.kind === 'list' ? 'Listing' : 'Moving to the lowest'} · <span className="num">{done}</span> of <span className="num">{plan.steps.length}</span>
            </b>
            {running ? (
              <button type="button" className="cs__btn" disabled={s.stopAsked} onClick={s.stop}>
                {s.stopAsked ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <span className="cs__prog-acts">
                {done < plan.steps.length && (
                  <button type="button" className="cs__btn is-acc" disabled={s.spectating || !!s.pending} onClick={() => void s.go()}>
                    {done ? 'Go on' : 'Start'}
                  </button>
                )}
                <button type="button" className="cs__btn" onClick={() => s.setPlan(null)}>
                  {done === plan.steps.length ? 'Done' : 'Cancel'}
                </button>
              </span>
            )}
          </div>
          <div className="cs__bar" aria-hidden="true">
            <i style={{ width: `${(done / Math.max(1, plan.steps.length)) * 100}%` }} />
          </div>
          <ol className="cs__steps" start={from + 1}>
            {shownSteps.map((x, k) => {
              const i = from + k
              const now = i === firstTodo
              return (
                <li key={i} className={`is-${x.state}${now ? ' is-now' : ''}`}>
                  <span className="cs__tick num" aria-hidden="true">
                    {x.state === 'done' ? '✓' : x.state === 'failed' ? '!' : i + 1}
                  </span>
                  <span>
                    {x.label}
                    {x.note ? <small> · {x.note}</small> : null}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      <div className="cs__seg" role="tablist" aria-label="Collection">
        {COLLECTIONS.map((c) => (
          <button key={c.key} type="button" role="tab" aria-selected={s.collection === c.key} className={s.collection === c.key ? 'is-on' : ''} disabled={running} onClick={() => s.setCollection(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <button type="button" className="cs__pick" onClick={() => setCats(true)} disabled={!s.schemas.length}>
        <span>
          <b>
            Categories · {picked.length} of {s.schemas.length}
          </b>
          <small>{s.owned.isLoading ? 'Reading your wallet…' : picked.length ? picked.map(([x]) => schemaLabel(x)).join(', ') : 'None picked'}</small>
        </span>
        <i aria-hidden="true">›</i>
      </button>

      <div className="cs__seg is-small" role="group" aria-label="How much of each to list">
        {(
          [
            ['all', 'All but one'],
            ['everything', 'Everything'],
            ['one', 'One of each']
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" aria-pressed={s.mode === m} className={s.mode === m ? 'is-on' : ''} onClick={() => s.setMode(m)}>
            {label}
          </button>
        ))}
      </div>

      <div className="cs__sum">
        <div>
          <small>To list</small>
          <b className="num">{formatNumber(s.toList, 0)}</b>
        </div>
        <div>
          <small>Transactions</small>
          <b className="num">{Math.ceil(s.toList / LIST_PER_TX)}</b>
        </div>
        <div>
          <small>At the lowest</small>
          <b className="num">
            {wax(s.listWax)}
            <i>WAX</i>
          </b>
        </div>
        <div>
          <small>To you after fees</small>
          <b className="num is-good">
            ≈ {wax(s.listWax * (1 - s.cut))}
            <i>WAX</i>
          </b>
        </div>
      </div>

      <button type="button" className="cs__go" disabled={off || !s.toList || !!plan} onClick={s.planList}>
        <b>List everything at the lowest</b>
        <span>
          {s.toList ? `${formatNumber(s.toList, 0)} NFT${s.toList === 1 ? '' : 's'} · ${txs(Math.ceil(s.toList / LIST_PER_TX))}` : 'Nothing to list in what is picked'}
        </span>
      </button>

      <div className="cs__mine">
        <span>
          <b>
            Your listings · <span className="num">{s.mine.data ? formatNumber(s.mine.data.length, 0) : '…'}</span>
          </b>
          <small>
            {!s.mine.data ? (
              'Reading…'
            ) : s.above.length ? (
              <>
                <span className="is-bad num">{formatNumber(s.above.length, 0)}</span> above the lowest · <span className="num">−{wax(moveDrop)}</span> WAX
              </>
            ) : s.mine.data.length ? (
              'All at the lowest'
            ) : (
              'None yet'
            )}
          </small>
        </span>
        <button
          type="button"
          className={`cs__btn${s.above.length ? ' is-acc' : ''}`}
          disabled={off || !s.above.length || !!plan}
          onClick={() => {
            s.planReprice()
            setReview(true)
          }}
        >
          {s.above.length ? `Move ${formatNumber(s.above.length, 0)}` : 'Nothing to move'}
        </button>
      </div>

      <span className="cs__cap">What you hold · dearest first</span>
      {s.rows.map((r) => (
        <div key={r.templateId} className="cs__row">
          <span className="cs__pic">
            <Thumb srcs={cardSources(s.collection, r.templateId, r.img)} />
          </span>
          <span className="cs__info">
            <b>{r.name}</b>
            <small>
              {schemaLabel(r.schema)} · {r.all.length} held
              {r.listedCount ? ` · ${r.listedCount} listed` : ''}
              {r.keep ? ' · keep 1' : ''}
            </small>
          </span>
          <span className="cs__side">
            <span className="cs__price num">
              {r.lowest !== null ? wax(r.lowest) : '–'}
              {r.lowest !== null && <i>WAX</i>}
            </span>
            <span className="cs__step">
              <button type="button" aria-label={`One fewer ${r.name}`} disabled={off || r.count <= 0 || r.lowest === null} onClick={() => s.setCount(r.templateId, r.count - 1)}>
                −
              </button>
              <b className="num">
                {r.count}
                <small>/{r.max}</small>
              </b>
              <button type="button" aria-label={`One more ${r.name}`} disabled={off || r.count >= r.max || r.lowest === null} onClick={() => s.setCount(r.templateId, r.count + 1)}>
                +
              </button>
            </span>
          </span>
        </div>
      ))}
      {s.owned.data && !s.rows.length && <p className="cs__none">Nothing in the picked categories.</p>}

      {s.mineByPrice.length > 0 && (
        <div className="cs__list">
          <div className="cs__list-hd">
            <b>Your listings</b>
            <small className="num">
              {formatNumber(s.mineByPrice.length, 0)} · {wax(s.mineByPrice.reduce((n, x) => n + waxOf(x), 0))} WAX · dearest first
            </small>
          </div>
          {listings.map((x) => {
            const over = s.overOf(x)
            const a = x.assets[0]
            return (
              <div key={x.sale_id} className="cs__li">
                <span className="cs__n">
                  <b>{x.assets.length > 1 ? `${x.assets.length} NFTs` : a ? nameOf(a) : `Sale ${x.sale_id}`}</b>
                  <small className="num">{a?.template_mint ? `mint ${a.template_mint}` : `#${a?.asset_id ?? ''}`}</small>
                </span>
                <span className="cs__p num">{wax(waxOf(x))}</span>
                <span className={`cs__d num${over !== null && over < MIN_MOVE_WAX - 1e-9 ? ' is-ok' : ''}`}>
                  {over === null ? '–' : over >= MIN_MOVE_WAX - 1e-9 ? `+${wax(over)}` : 'lowest'}
                </span>
              </div>
            )
          })}
          {!allListings && s.mineByPrice.length > LISTINGS_SHOWN && (
            <button type="button" className="cs__more" onClick={() => setAllListings(true)}>
              Show all {formatNumber(s.mineByPrice.length, 0)}
            </button>
          )}
        </div>
      )}
      {s.spectating && <p className="cs__none">Read-only: {account}. Connect your own wallet to sell.</p>}

      {/* The categories: one line on the page, a list of switches here. */}
      {cats && (
        <Sheet host={host}>
        <div className="cs cs__sheet-wrap" onClick={() => setCats(false)}>
          <div className="cs__sheet" role="dialog" aria-label="Categories" onClick={(e) => e.stopPropagation()}>
            <i className="cs__grab" aria-hidden="true" />
            <h3>
              Categories
              <span>
                <button type="button" onClick={s.allSchemas}>
                  All
                </button>
                ·
                <button type="button" onClick={s.noSchemas}>
                  None
                </button>
              </span>
            </h3>
            <div className="cs__sw-list">
              {s.schemas.map(([x, n]) => (
                <button key={x} type="button" className={`cs__sw${s.on.has(x) ? ' is-on' : ''}`} role="switch" aria-checked={s.on.has(x)} onClick={() => s.toggleSchema(x)}>
                  <span>{schemaLabel(x)}</span>
                  <small className="num">{formatNumber(n, 0)}</small>
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
            <button type="button" className="cs__go is-flat" onClick={() => setCats(false)}>
              <b>Done</b>
            </button>
          </div>
        </div>
        </Sheet>
      )}

      {/* The price check before a move to the lowest. */}
      {review && plan?.kind === 'reprice' && plan.review && (
        <Sheet host={host}>
        <div className="cs cs__sheet-wrap">
          <div className="cs__sheet is-tall" role="dialog" aria-label="Move to the lowest">
            <i className="cs__grab" aria-hidden="true" />
            <h3>Move {formatNumber(plan.review.length, 0)} to the lowest</h3>
            <p className="cs__sub">Every listing that changes, biggest drop first. Nothing is signed until you start.</p>
            <div className="cs__tot">
              <div>
                <small>Listed at</small>
                <b className="num">{wax(plan.review.reduce((n, x) => n + x.from, 0))}</b>
              </div>
              <div>
                <small>New</small>
                <b className="num">{wax(plan.review.reduce((n, x) => n + x.to, 0))}</b>
              </div>
              <div>
                <small>Difference</small>
                <b className="num is-bad">−{wax(plan.review.reduce((n, x) => n + x.from - x.to, 0))}</b>
              </div>
            </div>
            <div className="cs__review">
              {plan.review.map((x, i) => (
                <div key={i} className="cs__li">
                  <span className="cs__n">
                    <b>{x.name}</b>
                    {x.mint ? <small className="num">mint {x.mint}</small> : null}
                  </span>
                  <span className="cs__p num">
                    <s>{wax(x.from)}</s>
                    {wax(x.to)}
                  </span>
                  <span className="cs__d num">
                    −{wax(x.from - x.to)}
                    <small>{formatNumber(x.from > 0 ? ((x.from - x.to) / x.from) * 100 : 0, 0)}%</small>
                  </span>
                </div>
              ))}
            </div>
            <div className="cs__acts">
              <button
                type="button"
                className="cs__go is-flat"
                onClick={() => {
                  setReview(false)
                  s.setPlan(null)
                }}
              >
                <b>Cancel</b>
              </button>
              <button
                type="button"
                className="cs__go"
                disabled={s.spectating || !!s.pending}
                onClick={() => {
                  setReview(false)
                  void s.go()
                }}
              >
                <b>Start · {txs(Math.ceil(plan.review.length / REPRICE_PER_TX))}</b>
              </button>
            </div>
          </div>
        </div>
        </Sheet>
      )}
    </section>
  )
}
