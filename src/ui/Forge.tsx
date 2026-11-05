import { useMemo, useState, type CSSProperties } from 'react'

import { buyShopItem, payForgeLevel } from '@/chain/actions/pd'
import { useArmy, useForgeConfig, useMarket, usePlayer } from '@/data/game'
import type { ShopItemRow } from '@/data/types'
import { asset, formatNumber, parseAsset } from '@/lib/format'
import { tlmForDefOut, type Market } from '@/lib/market'
import { useTransaction } from '@/wallet/useTransaction'

import { Icon } from './icons'

/*
 * The Forge as a workbench. The Forge level is its own piece at the top (price of the next level,
 * what is paid so far, pay the rest or a part). Below it one rail per slot kind: a pip per slot the
 * shop sells, the ones you own in the kind's colour, the level bands with their price range under
 * the rail. Click a pip to plan up to there; the plan panel prices it in DEF and, at Alcor's live
 * rate, in TLM, checks the balances and buys everything in one transaction (split in parts of 25
 * when it is more). Slots whose band needs a higher Forge level put the level payments into the
 * plan first; a level has to be on chain before its band opens, so those go as their own
 * transactions ahead of the slots.
 */

type SlotKind = 'divslot' | 'eqpslot' | 'supslot' | 'lavaslot'
const KINDS: { key: SlotKind; label: string; color: string; what: string }[] = [
  { key: 'divslot', label: 'Division slots', color: 'var(--div)', what: 'one more division each' },
  { key: 'eqpslot', label: 'Equipment slots', color: 'var(--eqp)', what: 'one more weapon or armour piece equipped' },
  { key: 'supslot', label: 'Supply slots', color: 'var(--sup)', what: 'one more supply equipped: attack, defense and less move' },
  { key: 'lavaslot', label: 'Lava Lux slots', color: 'var(--lava)', what: 'one more Lava Lux pass equipped: a multiplier' }
]

/** TLM it takes to buy this much DEF on Alcor now (fee and price impact included); past the pool's depth, the mid price. */
function tlmFor(m: Market, def: number): number {
  if (def <= 0) return 0
  const q = tlmForDefOut(m, def)
  return Number.isFinite(q) ? q : def * m.rate
}

export function Forge({ account, spectating }: { account: string; spectating: boolean }) {
  const forge = useForgeConfig()
  const player = usePlayer(account)
  const army = useArmy(account)
  const market = useMarket()
  const { run, pending } = useTransaction()
  const [plan, setPlan] = useState<Record<SlotKind, number>>({ divslot: 0, eqpslot: 0, supslot: 0, lavaslot: 0 })
  const [partial, setPartial] = useState('')

  const level = player.data?.forgeLevel ?? 0
  const levels = useMemo(() => (forge.data?.levels ?? []).map((l) => ({ level: Number(l.level), tlm: parseAsset(l.tlm_cost).amount })), [forge.data])
  const maxLevel = levels.reduce((n, l) => Math.max(n, l.level), 0)
  const next = levels.find((l) => l.level === level + 1) ?? null
  const progress = player.data?.forgeProgress
  const paid = progress && Number(progress.level) === level + 1 ? parseAsset(progress.paid_tlm).amount : 0
  const remaining = next ? Math.max(0, next.tlm - paid) : 0

  /** Shop rows by kind, in buying order (lowest band first, then id: the prices climb that way). */
  const shop = useMemo(() => {
    const m = new Map<SlotKind, ShopItemRow[]>()
    for (const item of forge.data?.shopItems ?? []) {
      const k = String(item.reward_powerup) as SlotKind
      m.set(k, [...(m.get(k) ?? []), item])
    }
    for (const list of m.values()) list.sort((a, b) => Number(a.min_forge_level) - Number(b.min_forge_level) || Number(a.id) - Number(b.id))
    return m
  }, [forge.data])
  const owned = (k: SlotKind) => player.data?.powerups.get(k) ?? 0
  const used: Record<SlotKind, number> = {
    divslot: army.data?.divisions.length ?? 0,
    eqpslot: army.data?.gearUsed.weapon ?? 0,
    supslot: army.data?.gearUsed.supply ?? 0,
    lavaslot: army.data?.gearUsed.lavalux ?? 0
  }
  const price = (i: ShopItemRow) => parseAsset(i.price)

  /** The plan priced: the slots per kind, the levels they need, the sums. */
  const bill = useMemo(() => {
    const rows = KINDS.map((k) => {
      const items = (shop.get(k.key) ?? []).slice(owned(k.key), owned(k.key) + plan[k.key])
      const def = items.reduce((n, i) => n + (price(i).symbol === 'DEF' ? price(i).amount : 0), 0)
      const tlm = items.reduce((n, i) => n + (price(i).symbol === 'TLM' ? price(i).amount : 0), 0)
      const needs = items.reduce((n, i) => Math.max(n, Number(i.min_forge_level)), 0)
      return { k, items, def, tlm, needs, first: items[0] ? price(items[0]).amount : 0, last: items.length ? price(items[items.length - 1]).amount : 0 }
    })
    const needLevel = rows.reduce((n, r) => Math.max(n, r.needs), 0)
    const levelSteps = levels.filter((l) => l.level > level && l.level <= needLevel).map((l) => ({ ...l, due: l.level === level + 1 ? Math.max(0, l.tlm - paid) : l.tlm }))
    const def = rows.reduce((n, r) => n + r.def, 0)
    const slotsTlm = rows.reduce((n, r) => n + r.tlm, 0)
    const levelsTlm = levelSteps.reduce((n, l) => n + l.due, 0)
    const count = rows.reduce((n, r) => n + r.items.length, 0)
    return { rows, levelSteps, def, slotsTlm, levelsTlm, count, defAsTlm: tlmFor(market, def) }
    // owned reads player.data, which is in the deps through plan/shop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, plan, player.data, levels, level, paid, market])

  if (!forge.data || !player.data) return <p className="wrap page-msg muted">Stoking the forge…</p>

  const tlmContract = forge.data.tokens?.tlm_contract || 'alien.worlds'
  const held = { tlm: player.data.tlm, def: player.data.def }
  const shortDef = Math.max(0, bill.def - held.def)
  const shortTlm = Math.max(0, bill.slotsTlm + bill.levelsTlm - held.tlm)
  const busy = !!pending
  const setCount = (k: SlotKind, n: number) => {
    const max = Math.max(0, (shop.get(k)?.length ?? 0) - owned(k))
    setPlan((p) => ({ ...p, [k]: Math.max(0, Math.min(max, Math.round(n))) }))
  }

  const payLevel = (amount: number) => {
    if (!next || amount <= 0) return
    void run((a, p) => payForgeLevel(a, p, next.level, asset(Math.min(amount, remaining), 'TLM'), tlmContract), amount >= remaining ? `Forge level ${next.level} paid` : `${formatNumber(amount, 2)} TLM paid towards level ${next.level}`, 'forge-level')
  }

  /** Levels first, each its own transaction (a band opens once its level is on chain), then every slot in one go. */
  const buy = async () => {
    if (!bill.count || shortDef || shortTlm) return
    for (const l of bill.levelSteps) {
      const ok = await run((a, p) => payForgeLevel(a, p, l.level, asset(l.due, 'TLM'), tlmContract), `Forge level ${l.level} paid`, 'forge-plan')
      if (!ok) return
    }
    const items = bill.rows.flatMap((r) => r.items)
    const ok = await run((a, p) => items.map((i) => buyShopItem(a, p, Number(i.id), i.price, i.price_contract)), `${items.length} slot${items.length === 1 ? '' : 's'} bought`, 'forge-plan', { split: true })
    if (ok) setPlan({ divslot: 0, eqpslot: 0, supslot: 0, lavaslot: 0 })
  }

  const rateLine = `1 DEF ≈ ${formatNumber(market.rate, 2)} TLM on Alcor${market.live ? '' : ' (last known rate)'}`

  return (
    <main className="forge wrap">
      <div className="forge__main">
        <section className="box level">
          <span className="level__badge">
            {level}
            <small>FORGE</small>
          </span>
          <span className="level__text">
            <h3>{next ? `Forge level ${level} of ${maxLevel}` : `Forge level ${level} · maxed`}</h3>
            {next ? (
              <>
                <p>
                  Level {next.level} costs {formatNumber(next.tlm, 0)} TLM and opens the next band of every slot kind, plus the next tier of supplies and creatures.
                  {paid > 0 ? ` ${formatNumber(paid, 0)} TLM is paid already; ${formatNumber(remaining, 0)} to go.` : ''}
                </p>
                <span className="level__bar">
                  <i style={{ width: `${next.tlm ? Math.min(100, (paid / next.tlm) * 100) : 0}%` }} />
                </span>
                <span className="level__pay">
                  <button type="button" className="btn btn--sm btn--go" disabled={busy || spectating || held.tlm < remaining} title={held.tlm < remaining ? `You hold ${formatNumber(held.tlm, 0)} TLM` : undefined} onClick={() => payLevel(remaining)}>
                    Pay {formatNumber(remaining, 0)} TLM
                  </button>
                  <span className="level__part">
                    <input className="input" inputMode="decimal" placeholder="part" value={partial} onChange={(e) => setPartial(e.target.value)} />
                    <button type="button" className="btn btn--sm" disabled={busy || spectating || !(Number(partial) > 0) || Number(partial) > held.tlm} onClick={() => payLevel(Number(partial))}>
                      Pay a part
                    </button>
                  </span>
                </span>
              </>
            ) : (
              <p>Every band of the shop is open to you and every tier of supplies and creatures can be equipped.</p>
            )}
          </span>
          <span className="steps">
            {levels.map((l) => (
              <span key={l.level} className={`step${l.level <= level ? ' done' : bill.levelSteps.some((s) => s.level === l.level) ? ' plan' : ''}`}>
                <b>L{l.level}</b>
                {formatNumber(l.tlm, 0)} TLM
              </span>
            ))}
          </span>
        </section>

        <section className="box">
          <h3 className="h">
            Slots
            <small>one pip per slot the shop sells · click where you want to be · {rateLine}</small>
          </h3>
          {KINDS.map((k) => {
            const items = shop.get(k.key) ?? []
            const own = owned(k.key)
            const extra = plan[k.key]
            const nextItem = items[own + extra]
            const after = items.slice(own, own + extra)
            const bands = [...new Set(items.map((i) => Number(i.min_forge_level)))].sort((a, b) => a - b).map((L) => {
              const inBand = items.filter((i) => Number(i.min_forge_level) === L)
              return { L, at: items.indexOf(inBand[0]) / Math.max(1, items.length), share: inBand.length / Math.max(1, items.length), min: price(inBand[0]).amount, max: price(inBand[inBand.length - 1]).amount, locked: L > level }
            })
            const defSum = after.reduce((n, i) => n + price(i).amount, 0)
            return (
              <div key={k.key} className="track" style={{ '--k': k.color } as CSSProperties}>
                <span className="track__lab">
                  <b>
                    <i className="kdot" /> {k.label}
                  </b>
                  <small>
                    {own} of {items.length} · {used[k.key]} in use · {k.what}
                  </small>
                </span>
                <span className="rail">
                  <span className="pips" role="group" aria-label={`${k.label}: click a slot to plan up to it`}>
                    {items.map((i, ix) => {
                      const state = ix < own ? ' own' : ix < own + extra ? ' plan' : ix === own + extra ? ' next' : ''
                      const locked = Number(i.min_forge_level) > level
                      return (
                        <button
                          key={i.id}
                          type="button"
                          className={`pip${state}${locked ? ' lock' : ''}`}
                          title={`${k.label.replace(' slots', ' slot')} ${ix + 1}: ${formatNumber(price(i).amount, 0)} ${price(i).symbol}${locked ? ` · needs Forge level ${i.min_forge_level}` : ''}${ix < own ? ' · owned' : ''}`}
                          disabled={ix < own}
                          onClick={() => setCount(k.key, ix + 1 - own === extra ? 0 : ix + 1 - own)}
                        />
                      )
                    })}
                  </span>
                  <span className="bands">
                    {bands.map((b) => (
                      <span key={b.L} className={`${b.locked ? 'is-locked' : ''}${b.share < 0.08 ? ' is-tight' : ''}`} style={{ left: `${b.at * 100}%` }} title={`Level ${b.L} band: ${formatNumber(b.min, 0)} to ${formatNumber(b.max, 0)} DEF a slot`}>
                        L{b.L}
                        {/* The price range only where the band is wide enough to hold it; the title has it always. */}
                        <small hidden={b.share < 0.15}>
                          {' '}
                          · {formatNumber(b.min, 0)}–{formatNumber(b.max, 0)}
                        </small>
                      </span>
                    ))}
                  </span>
                </span>
                <span className="track__act">
                  {/* Always three lines, so a plan never changes the rail's height. */}
                  <b className={own >= items.length ? 'c-good' : 'num'}>
                    {own >= items.length ? 'Complete' : extra ? `+${extra} · ${formatNumber(defSum, 0)} DEF` : `next: ${nextItem ? `${formatNumber(price(nextItem).amount, 0)} DEF` : '—'}`}
                  </b>
                  <span className="num">
                    {own >= items.length
                      ? 'every slot bought'
                      : extra
                        ? `≈ ${formatNumber(tlmFor(market, defSum), 0)} TLM`
                        : nextItem
                          ? `≈ ${formatNumber(tlmFor(market, price(nextItem).amount), 1)} TLM`
                          : ' '}
                  </span>
                  <span className="muted num">{extra && nextItem ? `next after that: ${formatNumber(price(nextItem).amount, 0)} DEF` : ' '}</span>
                  <span className="stepper">
                    <button type="button" disabled={!extra} onClick={() => setCount(k.key, extra - 1)} aria-label="One fewer">
                      −
                    </button>
                    <b className="num">{extra}</b>
                    <button type="button" disabled={own + extra >= items.length} onClick={() => setCount(k.key, extra + 1)} aria-label="One more">
                      +
                    </button>
                  </span>
                </span>
              </div>
            )
          })}
        </section>
      </div>

      <aside className="box planbox">
        <h3 className="h">
          Plan
          <small>{bill.count ? `${bill.count} upgrade${bill.count === 1 ? '' : 's'}` : 'nothing planned yet'}</small>
          {bill.count > 0 && (
            <button type="button" className="h__link" onClick={() => setPlan({ divslot: 0, eqpslot: 0, supslot: 0, lavaslot: 0 })}>
              Clear
            </button>
          )}
        </h3>
        {bill.levelSteps.map((l) => (
          <div key={l.level} className="plan__row is-gate">
            <span>
              Forge level {l.level}
              <small>needed first · its own transaction</small>
            </span>
            <span className="num">{formatNumber(l.due, 0)} TLM</span>
          </div>
        ))}
        {bill.rows
          .filter((r) => r.items.length)
          .map((r) => (
            <div key={r.k.key} className="plan__row" style={{ '--k': r.k.color } as CSSProperties}>
              <span>
                <i className="kdot" /> {r.items.length} {r.k.label.charAt(0).toLowerCase() + r.k.label.slice(1)}
                <small>
                  {owned(r.k.key) + 1}
                  {r.items.length > 1 ? `–${owned(r.k.key) + r.items.length}` : ''} · {formatNumber(r.first, 0)}
                  {r.items.length > 1 ? ` to ${formatNumber(r.last, 0)}` : ''} DEF each
                </small>
              </span>
              <span className="num">
                {formatNumber(r.def, 0)} DEF
                <small>≈ {formatNumber(tlmFor(market, r.def), 0)} TLM</small>
              </span>
            </div>
          ))}
        {bill.count > 0 ? (
          <>
            <div className="plan__total">
              <span>Total</span>
              <span className="num">
                <b>{formatNumber(bill.def, 0)} DEF</b>
                <small>≈ {formatNumber(bill.defAsTlm, 0)} TLM at Alcor&apos;s rate</small>
                {bill.levelsTlm + bill.slotsTlm > 0 && <small>+ {formatNumber(bill.levelsTlm + bill.slotsTlm, 0)} TLM</small>}
              </span>
            </div>
            <div className="bal">
              <span>
                You hold {formatNumber(held.def, 0)} DEF{shortDef ? <b className="c-bad"> · {formatNumber(shortDef, 0)} short (≈ {formatNumber(tlmFor(market, shortDef), 0)} TLM to buy on Alcor)</b> : ` · ${formatNumber(held.def - bill.def, 0)} left after`}
              </span>
              <span className="balbar">
                <i style={{ width: `${held.def > 0 ? Math.min(100, (bill.def / held.def) * 100) : 100}%` }} className={shortDef ? 'is-short' : ''} />
              </span>
              {bill.levelsTlm + bill.slotsTlm > 0 && (
                <span>
                  and {formatNumber(bill.levelsTlm + bill.slotsTlm, 0)} TLM of your {formatNumber(held.tlm, 0)}
                  {shortTlm ? <b className="c-bad"> · {formatNumber(shortTlm, 0)} short</b> : ''}
                </span>
              )}
            </div>
            <button type="button" className="btn btn--go" disabled={busy || spectating || !!shortDef || !!shortTlm} onClick={() => void buy()}>
              <Icon name="flame" size={16} />
              {busy ? 'Signing…' : bill.levelSteps.length ? `Pay ${bill.levelSteps.length} level${bill.levelSteps.length === 1 ? '' : 's'}, then buy ${bill.count - 0} slots` : `Buy all ${bill.count} · one transaction`}
            </button>
            <p className="help">
              Slots are bought in price order, so if something fails midway the cheaper ones are yours. More than 25 go out in parts of 25.
              {spectating ? ' Read-only: this is not your account.' : ''}
            </p>
          </>
        ) : (
          <p className="none">Click a pip on a rail, or use the + buttons, to plan upgrades. The plan is priced here in DEF and in TLM at Alcor&apos;s live rate.</p>
        )}
      </aside>
    </main>
  )
}
