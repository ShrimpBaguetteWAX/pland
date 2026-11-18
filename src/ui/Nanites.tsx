import { useMemo, useState } from 'react'

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
