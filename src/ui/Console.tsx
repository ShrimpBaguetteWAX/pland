import { useMemo } from 'react'

import { formatNumber } from '@/lib/format'
import { shortDuration, useNow } from '@/lib/time'
import { useField } from '@/lib/useField'
import { useMining, type MineBlock } from '@/mining/useMining'

import { Icon } from './icons'

/*
 * The console strip under the menu: the two things in the game that run on a timer, each a lane.
 * Field: a timeline from when the earliest division still out left to the last return, one dot per
 * division at the moment it comes back (green once it is back, coral for the next one), labelled,
 * with a hairline at now; the lane's button claims what is back and sends it straight out again.
 * Mine: the tools' cooldown, the favourite land that pays most once they are ready and what it
 * pays, the next better land and when; the lane's button mines there. Ticks once a second, on its
 * own, so the rest of the page does not.
 */

/** Labels closer than this (share of the lane) share one. */
const LABEL_GAP = 0.09
/** The timeline never spans less than this, so it is never a single point. */
const MIN_WINDOW_MS = 60_000

const BLOCKED: Record<MineBlock, string> = {
  'signed-out': 'Connect your wallet to mine',
  spectating: 'Read-only: not your account',
  loading: 'Reading your tools…',
  anchor: 'Not available with Anchor',
  'no-member': 'Mining goes through Mission Control: register there first',
  flagged: 'This account is flagged on Mission Control',
  'no-favorites': 'No favourite lands on Mission Control yet',
  'no-tools': 'No tools equipped'
}

export function Console({ account, onMissions }: { account: string; onMissions: () => void }) {
  const now = useNow(1000)
  const f = useField(account)
  const m = useMining(now)

  // ---- Field lane ----
  const { field, ready, loopable, running } = f
  const start = useMemo(() => {
    const anchors = running.length ? running : field
    return anchors.length ? Math.min(...anchors.map((d) => d.joinedAt)) : now
    // Only the deployments decide the window's start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, running.length])
  const end = Math.max(start + MIN_WINDOW_MS, now, ...field.map((d) => d.unlockAt))
  const pos = (t: number) => Math.min(1, Math.max(0, (t - start) / (end - start)))
  const nextId = running[0]?.divisionId
  /** Returns close together share a label: "#32–#35 · 1 h 12 m". */
  const labels = useMemo(() => {
    const groups: { at: number; ids: number[]; back: boolean }[] = []
    for (const d of field) {
      const last = groups[groups.length - 1]
      if (last && Math.abs(pos(d.unlockAt) - pos(last.at)) < LABEL_GAP && last.back === d.unlockAt <= now) last.ids.push(d.divisionId)
      else groups.push({ at: d.unlockAt, ids: [d.divisionId], back: d.unlockAt <= now })
    }
    return groups
    // pos depends on start/end, which depend on field and now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, start, end, now])
  const idsText = (list: number[]) => {
    const ids = [...list].sort((a, b) => a - b)
    return ids.length <= 2 ? ids.map((i) => `#${i}`).join(' ') : `#${ids[0]}–#${ids[ids.length - 1]}`
  }
  const loopShort = loopable.length ? f.redeployShort(loopable) : ''
  const fieldBusy = f.pending === 'loop-all' || f.pending === 'claim-all'
  const fieldAction = !ready.length ? null : loopable.length ? { label: `Loop ${loopable.length}`, run: () => f.redeploy(loopable), why: loopShort, go: true } : { label: `Claim ${ready.length}`, run: () => f.claim(ready), why: '', go: true }

  // ---- Mine lane ----
  const mineReady = !m.block && !m.cooling && !!m.pick
  const est = m.pick ? m.pick.estimatedTlm : 0

  if (!f.loaded && m.block === 'loading') return null

  return (
    <div className="console" aria-live="polite">
      <div className="console__in wrap">
        <div className="lane lane--field">
          <span className="lane__lab">
            Field
            <b>
              {!field.length ? 'nothing out' : ready.length ? `${ready.length} back${f.waitingTlm ? ` · ≈ ${formatNumber(f.waitingTlm, 0)} TLM waiting` : ''}` : `${field.length} out · next back ${shortDuration(f.nextReturnAt! - now)}`}
            </b>
          </span>
          <button type="button" className="lane__tl" onClick={onMissions} title="Open Missions">
            <span className="tl">
              {field.map((d) => (
                <i
                  key={`${d.missionId}-${d.divisionId}`}
                  className={`tl__dot${d.unlockAt <= now ? ' is-back' : d.divisionId === nextId ? ' is-next' : ''}`}
                  style={{ left: `${pos(d.unlockAt) * 100}%` }}
                  title={d.unlockAt <= now ? `#${d.divisionId} is back` : `#${d.divisionId} back in ${shortDuration(d.unlockAt - now)}`}
                />
              ))}
              {field.length > 0 && <i className="tl__now" style={{ left: `${pos(now) * 100}%` }} />}
            </span>
            <span className="tl__labs">
              {labels.map((g) => (
                <span key={g.at + ':' + g.ids[0]} className={`${g.back ? 'is-back' : ''}${pos(g.at) > 0.8 ? ' is-right' : pos(g.at) < 0.2 ? ' is-left' : ''}`} style={{ left: `${pos(g.at) * 100}%` }}>
                  {idsText(g.ids)} · {g.back ? 'back' : shortDuration(g.at - now)}
                </span>
              ))}
              {!field.length && <span style={{ left: 0, transform: 'none' }}>send divisions out from Missions</span>}
            </span>
          </button>
          {fieldAction ? (
            <button type="button" className={`btn btn--sm${fieldAction.go && !fieldAction.why ? ' btn--go' : ''}`} disabled={fieldBusy || f.spectating || !!fieldAction.why} title={fieldAction.why || undefined} onClick={fieldAction.run}>
              <Icon name={loopable.length ? 'rocket' : 'gift'} size={14} /> {fieldBusy ? 'Signing…' : fieldAction.label}
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={onMissions}>
              Missions
            </button>
          )}
        </div>
        <div className="lane lane--mine">
          <span className="lane__lab">
            Mine
            <b>{m.block ? BLOCKED[m.block] : m.busy ? 'mining…' : m.cooling ? `tools ready in ${shortDuration(m.pickReadyAt! - now)}` : `${m.pick?.landName ?? 'a favourite land'} · ≈ ${formatNumber(est, est >= 1 ? 2 : 4)} TLM`}</b>
          </span>
          <span className="lane__prog">
            <span className={`prog${mineReady ? ' is-ready' : ''}`}>
              <i style={{ width: `${Math.round((m.block ? 0 : m.progress) * 1000) / 10}%` }} />
            </span>
            <small>
              {m.block
                ? ' '
                : m.cooling
                  ? `then ${m.pick?.landName ?? '…'} pays ≈ ${formatNumber(est, est >= 1 ? 2 : 4)} TLM${m.mode === 'shard' && m.pick ? ` and ≈ ${formatNumber(m.pick.shards, 1)} shards` : ''}`
                  : m.upgrade
                    ? `${m.upgrade.land.landName} pays ≈ ${formatNumber(m.upgrade.land.estimatedTlm, 4)} TLM in ${shortDuration(m.upgrade.at - now)}`
                    : m.pick
                      ? 'the best of your favourite lands right now'
                      : ' '}
            </small>
          </span>
          <button type="button" className={`btn btn--sm${mineReady ? ' btn--go' : ''}`} disabled={!!m.block || m.busy || m.cooling} title={m.block ? BLOCKED[m.block] : m.cooling ? 'Your tools are cooling down' : `Mines on ${m.pick?.landName}`} onClick={() => void m.mine()}>
            <Icon name="flame" size={14} /> {m.busy ? 'Mining…' : 'Mine'}
          </button>
        </div>
      </div>
    </div>
  )
}
