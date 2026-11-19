import { useEffect, useState } from 'react'

import type { AtomicSale } from '@/chain/atomic'
import { formatNumber } from '@/lib/format'
import { shortDuration } from '@/lib/time'
import { cardSources, COLLECTIONS, LIST_PER_TX, MARKET_FEES, MIN_MOVE_WAX, nameOf, REPRICE_PER_TX, schemaLabel, useSell, waxOf } from '@/lib/useSell'

import { Icon } from './icons'

/*
 * Market → Sell: sell what you hold of the Planetary Defense or the Alien Worlds collection at the
 * lowest listing of each template (the logic lives in lib/useSell.ts, shared with couch mode's
 * Sell tab). Every template you hold in the categories you pick, with how many you have, how many
 * are free and the lowest listing; listing is cut into transactions of a dozen NFTs, ticked off as
 * each is signed. Your listings above the lowest can be moved down to it after a look at every
 * price. Your recent sales of the collection close the page.
 */

/** A card picture that tries its sources in turn and shows a plain square when none loads. */
export function Thumb({ srcs }: { srcs: string[] }) {
  const [i, setI] = useState(0)
  const key = srcs.join('|')
  useEffect(() => setI(0), [key])
  if (i >= srcs.length) return <i />
  return <img src={srcs[i]} alt="" loading="lazy" onError={() => setI((n) => n + 1)} />
}

export function MarketSell({ account, spectating }: { account: string; spectating: boolean }) {
  const {
    pending,
    collection,
    setCollection,
    mode,
    setMode,
    schemas,
    on,
    toggleSchema,
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
  } = useSell(account)
  /** Show only the templates you hold but have no listing of. */
  const [notSellingOnly, setNotSellingOnly] = useState(false)

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
                {schemaLabel(s)} <small className="num">{formatNumber(n, 0)}</small>
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
              title="Every free one of each template but one: one of each is kept"
              onClick={() => setMode('all')}
            >
              All but one
            </button>
            <button
              type="button"
              className={mode === 'everything' ? 'is-on' : ''}
              aria-pressed={mode === 'everything'}
              title="Every free one of each template: nothing is kept"
              onClick={() => setMode('everything')}
            >
              Everything
            </button>
            <button
              type="button"
              className={mode === 'one' ? 'is-on' : ''}
              aria-pressed={mode === 'one'}
              title="One of each template you hold at least two of and are not selling yet: one always stays"
              onClick={() => setMode('one')}
            >
              One of each
            </button>
          </span>
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
                <button type="button" className="btn btn--sm" disabled={stopAsked} onClick={stop}>
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
          {plan.review && <RepriceReview rows={plan.review} />}
          <ol className="ms__steps">
            {plan.steps.map((s, i) => (
              <li key={i} className={`is-${s.state}`}>
                <span className="ms__tick" aria-hidden="true">
                  {s.state === 'done' ? <Icon name="check" size={13} /> : s.state === 'failed' ? '!' : i + 1}
                </span>
                {s.label}
                {s.note ? <small className="muted"> · {s.note}</small> : null}
              </li>
            ))}
          </ol>
          <p className="help">Each step is one transaction for your wallet to sign. A refused or failed one stops the list; Go on picks it up again.</p>
        </section>
      )}

      {(mine.data?.length ?? 0) > 0 && <MyListings sales={mineByPrice} floors={myFloors.data} collection={collection} />}

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
                // Alien Worlds cards: the small pictures from Alien Legends first (the IPFS originals are
                // often large and the resizer gives up on them), then IPFS.
                const srcs = cardSources(collection, r.templateId, r.img)
                return (
                  <tr key={r.templateId}>
                    <td className="ms__name">
                      <Thumb srcs={srcs} />
                      <span>
                        <b>{r.name}</b>
                        <small>
                          {schemaLabel(r.schema)} · #{r.templateId}
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
                        onChange={(e) => setCount(r.templateId, Math.max(0, Math.min(r.max, Math.round(Number(e.target.value) || 0))))}
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


/** Every listing a move to the lowest changes: listed at, new price, and the difference. */
function RepriceReview({ rows }: { rows: { name: string; from: number; to: number }[] }) {
  const from = rows.reduce((n, r) => n + r.from, 0)
  const to = rows.reduce((n, r) => n + r.to, 0)
  return (
    <div className="ms__review">
      <div className="ms__scroll">
        <table className="num">
          <thead>
            <tr>
              <th>NFT</th>
              <th>Listed at</th>
              <th>New price</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="ms__name">
                  <b>{r.name}</b>
                </td>
                <td>{formatNumber(r.from, 2)}</td>
                <td>{formatNumber(r.to, 2)}</td>
                <td className="c-bad">
                  −{formatNumber(r.from - r.to, 2)} <small className="muted">({formatNumber(r.from > 0 ? ((r.from - r.to) / r.from) * 100 : 0, 0)}%)</small>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{rows.length} listings</th>
              <th>{formatNumber(from, 2)} WAX</th>
              <th>{formatNumber(to, 2)} WAX</th>
              <th className="c-bad">−{formatNumber(from - to, 2)} WAX</th>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

/** Your listings in this collection, the dearest first, each against the lowest listing of its template. */
function MyListings({ sales, floors, collection }: { sales: AtomicSale[]; floors: Map<string, number> | undefined; collection: string }) {
  const [open, setOpen] = useState(true)
  const rows = sales
  const total = rows.reduce((n, x) => n + waxOf(x), 0)
  return (
    <section className="box ms__mine" aria-label="Your listings">
      <button type="button" className="ms__mine-hd" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <b>Your listings</b>
        <span className="muted">
          {formatNumber(rows.length, 0)} · {formatNumber(total, 2)} WAX · dearest first
        </span>
        <span className="ms__mine-chev" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div className="ms__review">
          <div className="ms__scroll">
            <table className="num">
              <thead>
                <tr>
                  <th>NFT</th>
                  <th>Listed at</th>
                  <th>Lowest</th>
                  <th>Above it</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const a = x.assets[0]
                  const t = x.assets.length === 1 ? a?.template?.template_id : undefined
                  const low = t ? floors?.get(t) : undefined
                  const price = waxOf(x)
                  const over = low !== undefined ? price - low : null
                  const img = a?.data?.img ? String(a.data.img) : undefined
                  const srcs = cardSources(collection, t, img)
                  return (
                    <tr key={x.sale_id}>
                      <td className="ms__name">
                        <Thumb srcs={srcs} />
                        <span>
                          <b>{x.assets.length > 1 ? `${x.assets.length} NFTs: ${nameOf(a)}…` : a ? nameOf(a) : `Sale ${x.sale_id}`}</b>
                          <small>
                            #{a?.asset_id}
                            {a?.template_mint ? ` · mint ${a.template_mint}` : ''}
                          </small>
                        </span>
                      </td>
                      <td>{formatNumber(price, 2)}</td>
                      <td>{low !== undefined ? formatNumber(low, 2) : <span className="muted">…</span>}</td>
                      <td>
                        {over === null ? (
                          <span className="muted">–</span>
                        ) : over >= MIN_MOVE_WAX - 1e-9 ? (
                          <span className="c-bad">+{formatNumber(over, 2)}</span>
                        ) : (
                          <span className="c-good">lowest</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
