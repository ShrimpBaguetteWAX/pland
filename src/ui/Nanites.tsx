import { useMemo, useState } from 'react'

import { buySalesActions } from '@/chain/actions/market'
import { usePlayer } from '@/data/game'
import type { Listing } from '@/data/market'
import { refineAction, useNaniteAccount, useNaniteConfig } from '@/data/nanites'
import { queryClient } from '@/data/queryClient'
import type { Market } from '@/lib/blendEconomy'
import { formatNumber } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'

/*
 * Blend → Nanites: the nanite refinery (nanites.pdef). Every material the refinery takes, with how
 * many nanites one gives, its cheapest listing and what a nanite costs that way, and how many you
 * hold; refine one or all of them (sent to nanites.pdef with the memo "refine", burned, nanites
 * added at once; at most max_refine per transaction). Read from the chain, so a new or changed
 * recipe shows up by itself.
 */

const RANK = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']
const READ_ONLY = 'Read-only: not your account'
/** Buying and refining in one transaction: two market actions per material, so fewer than a plain refine. */
const BUY_REFINE_PER_TX = 10
const WANT_PICKS = [100, 500, 1000, 2500]

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

/**
 * The listings that give at least `want` nanites for the least WAX in all (not just the best WAX
 * per nanite: 100 nanites should not buy a 1,250-nanite material). A small knapsack over the
 * nanite step (the refinery's common divisor, 50 today); per material only as many listings as
 * could ever be needed. With too little listed, everything listed.
 */
function cheapestFor(want: number, refinery: Map<string, number>, listings: Map<string, Listing[]>) {
  const step = [...refinery.values()].filter((n) => n > 0).reduce((g, n) => gcd(g, n), 0) || 1
  const W = Math.ceil(want / step)
  const items = [...refinery].flatMap(([t, n]) => (n > 0 ? (listings.get(t) ?? []).slice(0, Math.ceil(W / (n / step))).map((l) => ({ l, n, u: n / step })) : []))
  const total = items.reduce((k, x) => k + x.u, 0)
  if (W <= 0 || total < W) {
    const pick = W <= 0 ? [] : items
    return { pick, nanites: pick.reduce((k, x) => k + x.n, 0), wax: pick.reduce((k, x) => k + x.l.price, 0), short: W > 0 }
  }
  // cost[c]: least WAX for at least c steps; took[i][c]: item i used to reach c.
  const cost = new Array<number>(W + 1).fill(Infinity)
  cost[0] = 0
  const took = items.map(() => new Uint8Array(W + 1))
  items.forEach((x, i) => {
    for (let c = W; c >= 1; c--) {
      const v = cost[Math.max(0, c - x.u)] + x.l.price
      if (v < cost[c]) {
        cost[c] = v
        took[i][c] = 1
      }
    }
  })
  const pick: typeof items = []
  for (let i = items.length - 1, c = W; i >= 0 && c > 0; i--)
    if (took[i][c]) {
      pick.push(items[i])
      c = Math.max(0, c - items[i].u)
    }
  return { pick, nanites: pick.reduce((k, x) => k + x.n, 0), wax: pick.reduce((k, x) => k + x.l.price, 0), short: false }
}

interface Row {
  templateId: string
  name: string
  rarity: string
  img?: string
  nanites: number
  owned: string[]
  lowest: number | null
  perNanite: number | null
}

export function Nanites({ account, market, spectating }: { account: string; market: Market; spectating: boolean }) {
  const config = useNaniteConfig()
  const cfg = config.data
  const mine = useNaniteAccount(account || null, cfg?.perNanite)
  const { runSequence, pending } = useTransaction()
  const [onlyHeld, setOnlyHeld] = useState(false)
  const [want, setWant] = useState(100)
  const [buyAsk, setBuyAsk] = useState(false)
  const wax = usePlayer(account || null).data?.wax
  /** A refine burns NFTs: it asks once more, by row (or "all"). */
  const [confirm, setConfirm] = useState<{ key: string; ids: string[]; nanites: number; label: string } | null>(null)

  const rows = useMemo<Row[]>(() => {
    if (!cfg) return []
    return [...cfg.refinery.entries()]
      .map(([templateId, nanites]) => {
        const t = market.templates.get(templateId)
        const lowest = market.listings.get(templateId)?.[0]?.price ?? null
        return {
          templateId,
          name: t?.name ?? `#${templateId}`,
          rarity: t?.rarity ?? '',
          img: t?.img,
          nanites,
          owned: market.owned.get(templateId) ?? [],
          lowest,
          perNanite: lowest !== null && nanites > 0 ? lowest / nanites : null
        }
      })
      .sort((a, b) => (a.perNanite ?? Infinity) - (b.perNanite ?? Infinity) || RANK.indexOf(a.rarity.toLowerCase()) - RANK.indexOf(b.rarity.toLowerCase()))
  }, [cfg, market])

  if (!cfg)
    return (
      <div className="box">
        <p className="muted bl-loading">
          <span className="bl-spin" /> Reading the nanite refinery…
        </p>
      </div>
    )

  const buy = cheapestFor(Math.max(0, want), cfg.refinery, market.listings)
  const buyBusy = pending === 'buy-refine'
  const tooDear = wax !== undefined && buy.wax > wax + 1e-8

  /** Buys the cheapest materials and refines them in the same transaction, a few per transaction. */
  async function buyAndRefine() {
    setBuyAsk(false)
    const parts = []
    for (let i = 0; i < buy.pick.length; i += BUY_REFINE_PER_TX) {
      const part = buy.pick.slice(i, i + BUY_REFINE_PER_TX)
      const n = part.reduce((k, x) => k + x.n, 0)
      parts.push({
        build: (a: string, p: string) => [
          ...buySalesActions(
            a,
            p,
            part.map(({ l }) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
          ),
          refineAction(
            a,
            p,
            part.map(({ l }) => l.assetId)
          )
        ],
        success: `Bought and refined ${part.length} material${part.length === 1 ? '' : 's'}: +${formatNumber(n, 0)} nanites`
      })
    }
    const done = await runSequence(parts, 'buy-refine', `Buy and refine ${buy.pick.length} materials`)
    if (done)
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['market-listings'] }),
        queryClient.invalidateQueries({ queryKey: ['owned-blend-inputs'] }),
        queryClient.invalidateQueries({ queryKey: ['player', account] }),
        queryClient.invalidateQueries({ queryKey: ['nft-floors'] }),
        mine.refetch()
      ])
  }
  const mix = [...buy.pick.reduce((m, x) => m.set(x.l.templateId, (m.get(x.l.templateId) ?? 0) + 1), new Map<string, number>())]
    .map(([t, k]) => `${k}× ${market.templates.get(t)?.name ?? '#' + t}`)
    .join(', ')

  const shown = onlyHeld ? rows.filter((r) => r.owned.length) : rows
  const best = rows.find((r) => r.perNanite !== null)
  const heldNanites = rows.reduce((n, r) => n + r.owned.length * r.nanites, 0)
  const allIds = rows.flatMap((r) => r.owned)
  const tester = cfg.testers.has(account)
  const busy = !!pending && pending.startsWith('refine')

  async function refine(key: string, ids: string[], label: string) {
    const parts = []
    for (let i = 0; i < ids.length; i += cfg!.maxRefine) {
      const part = ids.slice(i, i + cfg!.maxRefine)
      parts.push({ build: (a: string, p: string) => [refineAction(a, p, part)], success: `Refined ${part.length} material${part.length === 1 ? '' : 's'}` })
    }
    setConfirm(null)
    const done = await runSequence(parts, `refine-${key}`, label)
    if (done) void Promise.all([queryClient.invalidateQueries({ queryKey: ['owned-blend-inputs'] }), mine.refetch()])
  }

  const ask = (key: string, ids: string[], nanites: number, label: string) => setConfirm({ key, ids, nanites, label })

  return (
    <>
      <div className="box">
        <h3 className="h">
          Nanites
          <small>materials refined into nanites, spent to restore your divisions</small>
        </h3>
        <div className="bl-figrow">
          <span className="bl-fig" title="Nanites you hold on nanites.pdef.">
            <small>You hold</small>
            <b className="num">{mine.data ? formatNumber(mine.data.nanites, mine.data.nanites % 1 ? 2 : 0) : '…'}</b>
          </span>
          <span className="bl-fig" title="Nanites the materials in your wallet would give if you refined them all.">
            <small>In your materials</small>
            <b className="num">{formatNumber(heldNanites, 0)}</b>
          </span>
          <span className="bl-fig" title="The cheapest way to a nanite today: the refinery material with the lowest listing per nanite.">
            <small>Cheapest nanite</small>
            <b className="num">{best?.perNanite != null ? `${formatNumber(best.perNanite, 2)} WAX` : '–'}</b>
          </span>
          <span className="bl-fig" title="Wear restored by one nanite.">
            <small>One nanite restores</small>
            <b className="num">{formatNumber(cfg.pointsPerNanite, 0)} points</b>
          </span>
        </div>
        <p className="bl-blurb">
          Missions wear your divisions down; nanites restore them, {formatNumber(cfg.pointsPerNanite, 0)} points each. Refining sends the materials
          to nanites.pdef and burns them; the nanites are yours at once, at most {cfg.maxRefine} materials per transaction.{' '}
          {tester
            ? 'You are one of the testers: wear and restoring already count for your divisions.'
            : `Refining is open to everyone; wear and restoring are still in testing (${cfg.testers.size} test accounts so far).`}
        </p>
        {mine.data && mine.data.refined > 0 && (
          <p className="help">
            Refined {formatNumber(mine.data.refined, 0)} · spent {formatNumber(mine.data.spent, 0)}
          </p>
        )}
      </div>

      <div className="box">
        <h3 className="h">
          Buy and refine
          <small>the cheapest materials on AtomicMarket, bought and refined in one go</small>
        </h3>
        <div className="nn__buy">
          <label className="nn__want">
            <span>Nanites wanted</span>
            <input
              type="number"
              min={1}
              step={50}
              inputMode="numeric"
              value={want || ''}
              onChange={(e) => {
                setWant(Math.max(0, Math.floor(Number(e.target.value) || 0)))
                setBuyAsk(false)
              }}
            />
          </label>
          <span className="seg" role="group" aria-label="Quick amounts">
            {WANT_PICKS.map((n) => (
              <button
                key={n}
                type="button"
                className={want === n ? 'is-on' : ''}
                onClick={() => {
                  setWant(n)
                  setBuyAsk(false)
                }}
              >
                {formatNumber(n, 0)}
              </button>
            ))}
          </span>
        </div>
        {buy.pick.length > 0 ? (
          <>
            <div className="bl-figrow">
              <span className="bl-fig">
                <small>You get</small>
                <b className="num">{formatNumber(buy.nanites, 0)} nanites</b>
              </span>
              <span className="bl-fig">
                <small>You pay</small>
                <b className={`num${tooDear ? ' c-bad' : ''}`}>{formatNumber(buy.wax, 2)} WAX</b>
              </span>
              <span className="bl-fig">
                <small>Per nanite</small>
                <b className="num">{formatNumber(buy.wax / buy.nanites, 2)} WAX</b>
              </span>
              <span className="bl-fig">
                <small>Transactions</small>
                <b className="num">{Math.ceil(buy.pick.length / BUY_REFINE_PER_TX)}</b>
              </span>
            </div>
            <p className="help">
              {mix}
              {buy.short ? ` · only ${formatNumber(buy.nanites, 0)} nanites are listed` : ''}
              {tooDear ? ` · you hold ${formatNumber(wax ?? 0, 2)} WAX` : ''}
            </p>
            {buyAsk ? (
              <span className="nn__confirm">
                <span>
                  Buy {buy.pick.length} material{buy.pick.length === 1 ? '' : 's'} for {formatNumber(buy.wax, 2)} WAX and refine them into{' '}
                  {formatNumber(buy.nanites, 0)} nanites? They are burned right away.
                </span>
                <button type="button" className="btn btn--sm btn--go" disabled={spectating || buyBusy || !!pending} onClick={() => void buyAndRefine()}>
                  {buyBusy ? 'Signing…' : 'Yes, buy and refine'}
                </button>
                <button type="button" className="btn btn--sm" disabled={buyBusy} onClick={() => setBuyAsk(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn--go nn__go"
                disabled={spectating || buyBusy || !!pending || tooDear}
                title={spectating ? READ_ONLY : tooDear ? 'Not enough WAX in your wallet' : 'Asks once more before signing'}
                onClick={() => setBuyAsk(true)}
              >
                {buyBusy ? 'Signing…' : `Buy and refine · ${formatNumber(buy.wax, 2)} WAX`}
              </button>
            )}
          </>
        ) : (
          <p className="muted">{want > 0 ? 'No refinery material is listed right now.' : 'Pick how many nanites you want.'}</p>
        )}
      </div>

      <div className="box">
        <h3 className="h">
          The refinery
          <small>
            {rows.length} materials · {allIds.length ? `you hold ${allIds.length}` : 'none in your wallet'}
          </small>
        </h3>
        <div className="nn__bar">
          <label className={`opt__toggle ${onlyHeld ? 'is-on' : ''}`}>
            <input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} />
            Only what I hold
          </label>
          {allIds.length > 0 &&
            (confirm?.key === 'all' ? null : (
              <button
                type="button"
                className="btn btn--sm"
                disabled={spectating || busy}
                title={spectating ? READ_ONLY : 'Every refinery material in your wallet; asks once more'}
                onClick={() => ask('all', allIds, heldNanites, `Refine ${allIds.length} materials`)}
              >
                Refine everything · {formatNumber(heldNanites, 0)} nanites
              </button>
            ))}
        </div>
        {confirm?.key === 'all' && <Confirm c={confirm} busy={busy} spectating={spectating} onYes={() => void refine('all', confirm.ids, confirm.label)} onNo={() => setConfirm(null)} />}

        <div className="nn__tbl">
          <table>
            <thead>
              <tr>
                <th>Material</th>
                <th className="r">Nanites</th>
                <th className="r">Lowest</th>
                <th className="r">WAX per nanite</th>
                <th className="r">You hold</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isBest = r === best
                return (
                  <tr key={r.templateId} className={isBest ? 'is-best' : ''}>
                    <td>
                      <span className="nn__mat">
                        <Portrait img={r.img} rarity={r.rarity} className="bl-pic" />
                        <span>
                          <b>{r.name}</b>
                          <small>
                            <i className="dot" style={{ background: rarityColor(r.rarity) }} /> <span className="cap">{r.rarity}</span>
                          </small>
                        </span>
                      </span>
                    </td>
                    <td className="r num">
                      <b>{formatNumber(r.nanites, 0)}</b>
                    </td>
                    <td className="r num">{r.lowest !== null ? `${formatNumber(r.lowest, 2)} WAX` : <span className="muted">none listed</span>}</td>
                    <td className="r num">
                      {r.perNanite !== null ? (
                        <>
                          {formatNumber(r.perNanite, 2)}
                          {isBest && <small className="nn__best">cheapest</small>}
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td className="r num">{r.owned.length || <span className="muted">0</span>}</td>
                    <td className="r">
                      {confirm?.key === r.templateId ? (
                        <Confirm c={confirm} busy={busy} spectating={spectating} onYes={() => void refine(r.templateId, confirm.ids, confirm.label)} onNo={() => setConfirm(null)} compact />
                      ) : r.owned.length ? (
                        <span className="nn__acts">
                          <button
                            type="button"
                            className="btn btn--sm"
                            disabled={spectating || busy}
                            title={spectating ? READ_ONLY : `Refines one ${r.name} into ${r.nanites} nanites; asks once more`}
                            onClick={() => ask(r.templateId, r.owned.slice(0, 1), r.nanites, `Refine 1 ${r.name}`)}
                          >
                            Refine 1
                          </button>
                          {r.owned.length > 1 && (
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={spectating || busy}
                              title={spectating ? READ_ONLY : `Refines all ${r.owned.length} into ${formatNumber(r.owned.length * r.nanites, 0)} nanites; asks once more`}
                              onClick={() => ask(r.templateId, r.owned, r.owned.length * r.nanites, `Refine ${r.owned.length} ${r.name}`)}
                            >
                              All {r.owned.length}
                            </button>
                          )}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    None of the refinery's materials in your wallet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Confirm({
  c,
  busy,
  spectating,
  onYes,
  onNo,
  compact = false
}: {
  c: { ids: string[]; nanites: number; label: string }
  busy: boolean
  spectating: boolean
  onYes: () => void
  onNo: () => void
  compact?: boolean
}) {
  return (
    <span className={`nn__confirm${compact ? ' is-compact' : ''}`}>
      {!compact && (
        <span>
          {c.label} for {formatNumber(c.nanites, 0)} nanites? The materials are burned.
        </span>
      )}
      <button type="button" className="btn btn--sm btn--go" disabled={busy || spectating} onClick={onYes} title={compact ? `${c.label} for ${formatNumber(c.nanites, 0)} nanites: the materials are burned` : undefined}>
        {busy ? 'Signing…' : compact ? `Yes, ${formatNumber(c.nanites, 0)}` : 'Yes, refine'}
      </button>
      <button type="button" className="btn btn--sm" disabled={busy} onClick={onNo}>
        Cancel
      </button>
    </span>
  )
}
