import { useToasts } from '@/components/toast'
import { formatNumber } from '@/lib/format'
import { shortDuration, useNow } from '@/lib/time'
import { useField } from '@/lib/useField'
import { useMining, type MineBlock } from '@/mining/useMining'

import { Icon } from './icons'

/*
 * Loop and Mine in the top bar: the two things in the game that run on a timer, one two-line key
 * each, in honey. The key is its own progress bar: a gold fill grows behind it while the next
 * division heads home or the tools cool down. Top line: the action, then the countdown or what it
 * brings (the divisions back and their TLM, the mine's estimate). Underneath, as on the old deck:
 * for Loop a timeline with a dot per division at its return (gold once back, the next one ringed,
 * a hairline at now); for Mine the land it mines on, with the cooldown line or the "better land"
 * hint. Ready, the key turns honey yellow and a tap does it. While a run signs it says so and counts
 * the transactions. On a phone only the top line shows. Ticks once a second, on its own.
 */

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

/** 44:38, or 1:02:05 past an hour. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}

/** A fill that is on never drops below a sliver, so it does not vanish right after a loop or a mine. */
const fill = (f: number) => Math.min(1, Math.max(0.03, f))

export function BarActions({ account, onMissions }: { account: string; onMissions: () => void }) {
  const now = useNow(1000)
  const f = useField(account)
  const m = useMining(now)
  const live = useToasts((s) => s.live)
  const run = live[live.length - 1]

  // ---- Loop ----
  const { field, ready, loopable, running } = f
  const next = running[0]
  const loopShort = loopable.length ? f.redeployShort(loopable) : ''
  const loopBusy = f.pending === 'loop-all' || f.pending === 'claim-all' || !!f.pending?.startsWith('loop-')
  const claimOnly = ready.length > 0 && !loopable.length
  const loopGo = ready.length > 0 && !loopBusy && !f.spectating && !(loopable.length && loopShort)
  const loopFill = next ? fill((now - next.joinedAt) / Math.max(1, next.unlockAt - next.joinedAt)) : ready.length ? 1 : 0
  const loopLabel = loopBusy ? (claimOnly ? 'Claiming…' : 'Looping…') : ready.length ? `${claimOnly ? 'Claim' : 'Loop'} ${claimOnly ? ready.length : loopable.length}` : 'Loop'
  const loopNote = loopBusy
    ? run && run.state === 'running'
      ? `${run.steps.filter((x) => x === 'ok').length} / ${run.steps.length}`
      : ''
    : ready.length
      ? loopShort || (f.waitingTlm > 0 ? `+${formatNumber(f.waitingTlm, f.waitingTlm >= 100 ? 0 : 2)} TLM` : `${ready.length} back`)
      : next
        ? clock(next.unlockAt - now)
        : 'none out'
  const loopTitle = loopBusy
    ? 'Signing'
    : f.spectating && ready.length
      ? 'Read-only: not your account'
      : loopShort
        ? `${loopShort}: open Missions`
        : ready.length
          ? claimOnly
            ? 'Claims every ready reward (their missions are closed, so they stay home)'
            : 'Claims every ready reward and sends those divisions back to the same missions'
          : next
            ? `#${next.divisionId} back in ${shortDuration(next.unlockAt - now)} · ${field.length} out · open Missions`
            : 'No division is out: open Missions'
  const onLoop = () => {
    if (loopBusy) return
    if (!loopGo) return onMissions()
    if (claimOnly) f.claim(ready)
    else f.redeploy(loopable)
  }

  // ---- Mine ----
  const est = m.pick ? m.pick.estimatedTlm : 0
  const estText = `≈ ${formatNumber(est, est >= 1 ? 2 : 4)} TLM`
  const mineGo = !m.block && !m.cooling && !!m.pick && !m.busy
  const mineFill = m.block ? 0 : mineGo ? 1 : fill(m.progress)
  const mineNote = m.busy ? '' : m.block ? (m.block === 'loading' ? '…' : 'off') : mineGo ? estText : m.pickReadyAt ? clock(m.pickReadyAt - now) : '…'
  const mineTitle = m.block
    ? BLOCKED[m.block]
    : m.busy
      ? 'Mining'
      : m.cooling
        ? `Tools ready in ${shortDuration((m.pickReadyAt ?? now) - now)}, then ${m.pick?.landName ?? 'a favourite land'} pays ${estText}` +
          (m.upgrade ? ` · ${m.upgrade.land.landName} pays ≈ ${formatNumber(m.upgrade.land.estimatedTlm, 4)} TLM in ${shortDuration(m.upgrade.at - now)}` : '')
        : `Mines on ${m.pick?.landName ?? 'the best favourite land'}: ${estText}` + (m.mode === 'shard' && m.pick ? ` and ≈ ${formatNumber(m.pick.shards, 1)} shards` : '')

  if (!f.loaded && m.block === 'loading') return null

  // The timeline runs from when the earliest division still out left to the latest return, so the
  // hairline at now travels along it; with every division back, from the earliest departure to now.
  const anchors = running.length ? running : field
  const start = anchors.length ? Math.min(...anchors.map((d) => d.joinedAt)) : now
  const end = Math.max(start + MIN_WINDOW_MS, now, ...field.map((d) => d.unlockAt))
  const pos = (t: number) => `${Math.round(Math.min(1, Math.max(0, (t - start) / (end - start))) * 1000) / 10}%`
  const dots = [...field].sort((a, b) => a.unlockAt - b.unlockAt)
  const shownLabel = !ready.length && !loopBusy && next ? 'Next back' : loopLabel

  return (
    <div className="bact" aria-live="polite">
      <button
        type="button"
        className={`bact__b${loopGo ? ' is-go' : loopBusy ? ' is-busy' : ''}`}
        style={{ '--f': loopFill } as React.CSSProperties}
        title={loopTitle}
        aria-label={`${shownLabel}${loopNote ? `, ${loopNote}` : ''}`}
        onClick={onLoop}
      >
        <span className="bact__r1">
          {loopBusy ? <span className="bact__spin" /> : <Icon name={claimOnly ? 'gift' : 'rocket'} size={15} />}
          <span className="bact__lab">{shownLabel}</span>
          {loopNote && <em>{loopNote}</em>}
          {field.length > 0 && !loopBusy && <span className="bact__n">{field.length}</span>}
        </span>
        <span className="bact__r2" aria-hidden="true">
          <span className="bact__tl">
            {dots.map((d) => (
              <i
                key={d.divisionId}
                className={d.unlockAt <= now ? 'is-back' : d.divisionId === next?.divisionId ? 'is-next' : ''}
                style={{ left: pos(d.unlockAt) }}
              />
            ))}
            {field.length > 0 && <b style={{ left: pos(now) }} />}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`bact__b bact__b--mine${mineGo ? ' is-go' : m.busy ? ' is-busy' : ''}`}
        style={{ '--f': mineFill } as React.CSSProperties}
        title={mineTitle}
        aria-label={`Mine${mineNote ? `, ${mineNote}` : ''}`}
        disabled={!!m.block && m.block !== 'loading'}
        onClick={() => mineGo && void m.mine()}
      >
        <span className="bact__r1">
          {m.busy ? <span className="bact__spin" /> : <Icon name="flame" size={15} />}
          <span className="bact__lab">{m.busy ? 'Mining' : 'Mine'}</span>
          {(mineNote || m.busy) && <em>{m.busy ? 'proof of work' : mineNote}</em>}
        </span>
        <span className="bact__r2" aria-hidden="true">
          <span className="bact__land">{m.block ? BLOCKED[m.block] : (m.pick?.landName ?? '…')}</span>
          {!m.block && !m.busy && m.cooling ? (
            <span className="bact__cool">
              <i style={{ width: `${Math.round(m.progress * 1000) / 10}%` }} />
            </span>
          ) : !m.block && !m.busy && m.upgrade ? (
            <span className="bact__up">
              <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                <path d="M5 1l4 5H6v3H4V6H1z" />
              </svg>
              {clock(m.upgrade.at - now)}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  )
}
