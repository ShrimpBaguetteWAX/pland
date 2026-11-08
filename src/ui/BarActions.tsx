import { useToasts } from '@/components/toast'
import { formatNumber } from '@/lib/format'
import { shortDuration, useNow } from '@/lib/time'
import { useField } from '@/lib/useField'
import { useMining, type MineBlock } from '@/mining/useMining'

import { Icon } from './icons'

/*
 * Loop and Mine in the top bar: the two things in the game that run on a timer, one button each.
 * The button is its own progress bar: an amber fill grows behind the label while the next division
 * heads home or the tools cool down, with the countdown beside it. When it is ready the fill goes,
 * the button turns coral and shows what it brings (the divisions back and their TLM, the mine's
 * estimate), and a tap does it. While a run signs it says so and counts the transactions. Ticks once
 * a second, on its own, so the rest of the page does not.
 */

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

  return (
    <div className="bact" aria-live="polite">
      <button
        type="button"
        className={`bact__b${loopGo ? ' is-go' : loopBusy ? ' is-busy' : ''}`}
        style={{ '--f': loopFill } as React.CSSProperties}
        title={loopTitle}
        aria-label={`${loopLabel}${loopNote ? `, ${loopNote}` : ''}`}
        onClick={onLoop}
      >
        <Icon name={claimOnly ? 'gift' : 'rocket'} size={15} />
        <span className="bact__lab">{loopLabel}</span>
        {loopNote && <em>{loopNote}</em>}
        {field.length > 0 && !loopBusy && <span className="bact__n">{field.length}</span>}
      </button>
      <button
        type="button"
        className={`bact__b${mineGo ? ' is-go' : m.busy ? ' is-busy' : ''}`}
        style={{ '--f': mineFill } as React.CSSProperties}
        title={mineTitle}
        aria-label={`Mine${mineNote ? `, ${mineNote}` : ''}`}
        disabled={!!m.block && m.block !== 'loading'}
        onClick={() => mineGo && void m.mine()}
      >
        <Icon name="flame" size={15} />
        <span className="bact__lab">{m.busy ? 'Mining…' : 'Mine'}</span>
        {mineNote && <em>{mineNote}</em>}
      </button>
    </div>
  )
}
