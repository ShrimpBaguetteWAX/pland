import { useMemo, useState, type CSSProperties } from 'react'

import { QUANTUM_CHEST, QUANTUM_KEY, useBlends, useCollectionTemplates, useTemplatePrices } from '@/data/blends'
import { useListings } from '@/data/market'
import { floorOf, marketFrom, openingsOf, SALE_KEEP, valueOf, type Opening } from '@/lib/blendEconomy'
import { oddsOf } from '@/lib/chestOdds'
import { formatNumber } from '@/lib/format'

import { Portrait, rarityColor } from './Art'

/*
 * What a Quantum Chest and a Quantum Key are worth, from what opening them gives. Each opening pulls
 * one material at the odds the blend sets; every material is valued the way the builder values it
 * (the lower of its cheapest listing and its recent sale median), less the 7% the market keeps on a
 * sale, since that is what the pull fetches when sold. A chest's worth is the average of opening it
 * alone; a key's worth is what it adds: opening the chest with the key against opening it alone.
 * Materials with no price at all count as nothing and are named, so the figure is never too high.
 */

interface Ev {
  /** Average WAX a pull fetches when sold. */
  value: number
  /** Share of the odds on materials with no price. */
  unpriced: number
  rows: { templateId: string; chance: number; worth: number | null }[]
}

export function ChestValue({ account }: { account: string }) {
  const listings = useListings()
  const blends = useBlends()
  const collection = useCollectionTemplates()
  const prices = useTemplatePrices()
  const [show, setShow] = useState<'chest' | 'key' | null>(null)

  const data = useMemo(() => {
    if (!listings.data || !blends.data || !collection.data) return null
    const m = marketFrom(listings.data, new Map(), collection.data, account, prices.data ?? [])
    const { chest, chestKey } = openingsOf(blends.data)
    const ev = (o: Opening | null): Ev | null => {
      if (!o) return null
      let value = 0
      let unpriced = 0
      const rows: Ev['rows'] = []
      for (const [t, chance] of oddsOf(o)) {
        const v = valueOf(m, t)
        const worth = v === null ? null : v * SALE_KEEP
        if (worth === null) unpriced += chance
        else value += chance * worth
        rows.push({ templateId: t, chance, worth })
      }
      rows.sort((a, b) => b.chance * (b.worth ?? 0) - a.chance * (a.worth ?? 0))
      return { value, unpriced, rows }
    }
    return { chest: ev(chest), key: ev(chestKey), chestFloor: floorOf(m, QUANTUM_CHEST), keyFloor: floorOf(m, QUANTUM_KEY) }
  }, [listings.data, blends.data, collection.data, prices.data, account])

  if (!data) return <div className="box chv">Working out what chests and keys are worth…</div>
  const { chest, key, chestFloor, keyFloor } = data
  const keyAdds = chest && key ? key.value - chest.value : null
  const name = (t: string) => collection.data?.get(t)?.name ?? `#${t}`
  const verdict = (worth: number | null, price: number | null) =>
    worth === null || price === null ? null : worth >= price ? { text: `worth ${formatNumber(worth - price, 1)} WAX more than it costs`, good: true } : { text: `costs ${formatNumber(price - worth, 1)} WAX more than it is worth`, good: false }

  const card = (label: string, kind: 'chest' | 'key', worth: number | null, price: number | null, sub: string, ev: Ev | null) => {
    const v = verdict(worth, price)
    return (
      <div className="chv__card">
        <span className="eyebrow">{label}</span>
        <b className="num">{worth === null ? '—' : `${formatNumber(worth, 1)} WAX`}</b>
        <small className="muted">{sub}</small>
        <span className="chv__vs">
          Cheapest listing <b className="num">{price === null ? 'none' : `${formatNumber(price, 2)} WAX`}</b>
        </span>
        {v && <span className={`pill ${v.good ? 'is-met' : 'is-live'}`}>{v.text}</span>}
        {ev && ev.unpriced > 0.001 && <small className="muted">{formatNumber(ev.unpriced * 100, 1)} % of the odds go to materials with no price yet, counted as nothing.</small>}
        {ev && (
          <button type="button" className="link chv__more" onClick={() => setShow(show === kind ? null : kind)}>
            {show === kind ? 'Hide' : 'Show'} what it gives
          </button>
        )}
      </div>
    )
  }

  const shown = show === 'chest' ? chest : show === 'key' ? key : null

  return (
    <div className="box chv">
      <h3 className="h">
        What they are worth
        <small>the average sale value of what opening gives, less the market&apos;s 7 %</small>
      </h3>
      <div className="chv__cards">
        {card('A chest, opened alone', 'chest', chest?.value ?? null, chestFloor, 'one material at the chest’s odds', chest)}
        {card('A chest with a key', 'key', key?.value ?? null, chestFloor !== null && keyFloor !== null ? chestFloor + keyFloor : null, 'the better odds, chest and key used up', key)}
        <div className="chv__card">
          <span className="eyebrow">A key on its own</span>
          <b className="num">{keyAdds === null ? '—' : `${formatNumber(keyAdds, 1)} WAX`}</b>
          <small className="muted">what a key adds to opening a chest</small>
          <span className="chv__vs">
            Cheapest listing <b className="num">{keyFloor === null ? 'none' : `${formatNumber(keyFloor, 2)} WAX`}</b>
          </span>
          {verdict(keyAdds, keyFloor) && (
            <span className={`pill ${verdict(keyAdds, keyFloor)!.good ? 'is-met' : 'is-live'}`}>{verdict(keyAdds, keyFloor)!.text}</span>
          )}
        </div>
      </div>
      {shown && (
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>Material</th>
                <th className="num">Chance</th>
                <th className="num">Sells for</th>
                <th className="num">Adds on average</th>
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((r) => {
                const c = collection.data?.get(r.templateId)
                return (
                  <tr key={r.templateId}>
                    <td>
                      <span className="chv__item" style={{ '--rc': rarityColor(c?.rarity) } as CSSProperties}>
                        <Portrait img={c?.img} rarity={c?.rarity} className="chv__pic" />
                        {name(r.templateId)}
                      </span>
                    </td>
                    <td className="num">{formatNumber(r.chance * 100, r.chance < 0.01 ? 2 : 1)} %</td>
                    <td className="num">{r.worth === null ? <span className="muted">no price</span> : `${formatNumber(r.worth, 2)} WAX`}</td>
                    <td className="num">{r.worth === null ? '—' : `${formatNumber(r.chance * r.worth, 2)} WAX`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="help">
        Values are today&apos;s market: a material is worth the lower of its cheapest listing and its recent sale median. Opening many at once and selling them all
        would push those prices down.
      </p>
    </div>
  )
}
