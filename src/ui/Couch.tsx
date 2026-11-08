import { useEffect, useRef, useState } from 'react'

import { useToasts } from '@/components/toast'
import { refreshToday, useTodayEarnings } from '@/data/today'
import { CHIME_FOR, chimeNow, useChimeSchedule, useChimeSetting, type ChimeEvent } from '@/lib/chime'
import { formatNumber } from '@/lib/format'
import type { PlanLine } from '@/lib/loop'
import { useNow } from '@/lib/time'
import { readCashOut, useLoopPlan } from '@/lib/useLoop'
import { useMining } from '@/mining/useMining'
import { useReportCount, useTabTitle } from '@/state/tabCount'
import { useTransaction } from '@/wallet/useTransaction'

import { useBloodOrb } from './couch/bloodOrb'
import { KittenFrame } from './couch/KittenFrame'
import { Moons, type MoonMission } from './couch/Moons'
import { KITTEN_THEMES, readTint, saveTint, type KittenTheme } from './couch/themes'

import './Couch.css'
import './couch/Kitten.css'

/*
 * Couch mode: one screen for the phone lying next to you. Today's TLM on two plaques at the top; in
 * the middle the orb, the mission that brings back the most, in a ring with a sleepy kitten napping
 * on a cloud on top: it fills as that mission's next division heads home, and a tap loops it when
 * it is back. Round it a moon per other mission, each with its own timer. Under them two tablets
 * (the divisions out, the idle ones, which open a panel to send them to their best TLM mission) and
 * the mine as a bar that fills toward the next mine. It keeps the screen awake and buzzes when
 * something becomes ready; with the bell on it chimes too, also in a background tab.
 *
 * The kitten shows the state: asleep while everything is out, eyes open when something is back,
 * happy when the loop is ready. The colours come in themes (couch/themes.ts), switched with the
 * small swatch at the top right and remembered in this browser.
 */

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}
const tlm = (n: number | undefined) => (n === undefined ? '–' : formatNumber(n, n >= 100 ? 0 : 2))

/** Couch mode's typefaces (Fredoka; Grenze Gotisch for Rose's big words), loaded only when it opens. */
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600&family=Grenze+Gotisch:wght@600;700&display=swap'
function useCouchFonts() {
  useEffect(() => {
    if (document.querySelector(`link[href="${FONT_HREF}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = FONT_HREF
    document.head.appendChild(link)
  }, [])
}

/**
 * While couch mode is open the page under it cannot scroll or bounce (a phone would otherwise drag
 * it and show the site's own background below the couch), and that background takes the couch's
 * night colour, so an overscroll shows the same sky.
 */
function usePinnedPage(night: string) {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('is-couch')
    root.style.setProperty('--couch-night', night)
    return () => {
      root.classList.remove('is-couch')
      root.style.removeProperty('--couch-night')
    }
  }, [night])
}

/** The colour theme, remembered in this browser; a tap on the swatch moves on to the next one. */
function useTint(): [KittenTheme, () => void] {
  const [tint, setTint] = useState<KittenTheme>(readTint)
  const next = () =>
    setTint((t) => {
      const n = KITTEN_THEMES[(KITTEN_THEMES.indexOf(t) + 1) % KITTEN_THEMES.length]
      saveTint(n)
      return n
    })
  return [tint, next]
}

/** Keeps the screen on while the page is open and visible; the browser drops the lock when hidden. */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }
    const take = () => {
      if (document.visibilityState !== 'visible' || !nav.wakeLock) return
      nav.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {})
    }
    take()
    document.addEventListener('visibilitychange', take)
    return () => {
      document.removeEventListener('visibilitychange', take)
      void lock?.release().catch(() => {})
    }
  }, [])
}

/** The kitten's night: twinkling stars, a pink glow below, hearts and little flames drifting up; drawn once. */
const STARS = Array.from({ length: 30 }, (_, i) => ({
  left: `${(i * 37 + 11) % 100}%`,
  top: `${(i * 23) % 62}%`,
  delay: `${-((i * 0.7) % 3)}s`,
  opacity: 0.3 + ((i * 13) % 7) / 10
}))
const FLOATIES = Array.from({ length: 12 }, (_, i) => ({
  left: `${(i * 43 + 5) % 100}%`,
  size: 6 + ((i * 5) % 8),
  dx: `${((i * 29) % 60) - 30}px`,
  rot: `${((i * 37) % 90) - 45}deg`,
  duration: `${9 + ((i * 3) % 8)}s`,
  delay: `${-((i * 1.7) % 14)}s`,
  heart: i % 3 !== 0
}))
function Night() {
  return (
    <div className="couch__pit" aria-hidden="true">
      {STARS.map((x, i) => (
        <span key={i} className="couch__star" style={{ left: x.left, top: x.top, animationDelay: x.delay, opacity: x.opacity }} />
      ))}
      {FLOATIES.map((x, i) => (
        <svg
          key={i}
          className="couch__floaty"
          viewBox="-7 -8 14 14"
          style={
            {
              left: x.left,
              width: x.size,
              height: x.size,
              '--dx': x.dx,
              '--rot': x.rot,
              animationDuration: x.duration,
              animationDelay: x.delay
            } as React.CSSProperties
          }
        >
          {x.heart ? (
            <path d="M0 3.4C-6.2-1.4-3.4-6.4 0-3C3.4-6.4 6.2-1.4 0 3.4Z" fill="#ff7aab" />
          ) : (
            <path d="M0-7C3-3 5 0 3 3a3.4 3.4 0 0 1-6 0C-5 0-2-2 0-7Z" fill="#ff9a5c" />
          )}
        </svg>
      ))}
    </div>
  )
}

/** Press and hold to confirm: let go early and nothing happens. */
function HoldButton({ label, disabled, onConfirm }: { label: string; disabled?: boolean; onConfirm: () => void }) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const stop = () => {
    clearTimeout(timer.current)
    setHolding(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={`couch__hold${holding ? ' is-holding' : ''}`}
      disabled={disabled}
      onPointerDown={() => {
        setHolding(true)
        timer.current = setTimeout(() => {
          setHolding(false)
          navigator.vibrate?.(40)
          onConfirm()
        }, 1000)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfirm()
        }
      }}
    >
      <i aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

const CORNERS = ['a', 'b', 'c', 'd'] as const

/**
 * The toasts, docked: while a run of transactions goes (the loop, a march) or a toast is up, one
 * card takes the tablets' place instead of a toast floating over the screen. The newest run wins,
 * otherwise the newest toast. A hairline along its foot counts the transactions. A finished or
 * failed card can be tapped away; a running one cannot.
 */
function useDockedToast() {
  const live = useToasts((s) => s.live)
  const toasts = useToasts((s) => s.toasts)
  const close = useToasts((s) => s.close)
  const dismiss = useToasts((s) => s.dismiss)
  const setDocked = useToasts((s) => s.setDocked)
  useEffect(() => {
    setDocked(true)
    return () => setDocked(false)
  }, [setDocked])

  const run = live[live.length - 1]
  if (run) {
    return {
      key: `l${run.id}`,
      title: run.title,
      line: run.line,
      count: `${run.steps.filter((x) => x === 'ok').length} / ${run.steps.length}`,
      steps: run.steps,
      tone: run.state === 'failed' ? 'bad' : run.state === 'done' ? 'done' : 'run',
      onTap: run.state === 'running' ? undefined : () => close(run.id)
    }
  }
  const t = toasts[toasts.length - 1]
  if (!t) return null
  return {
    key: `t${t.id}`,
    title: t.kind === 'error' ? 'Something went wrong' : t.kind === 'success' ? 'Done' : 'Note',
    line: t.message,
    count: '',
    steps: [t.kind === 'error' ? 'bad' : t.kind === 'success' ? 'ok' : 'busy'],
    tone: t.kind === 'error' ? 'bad' : t.kind === 'success' ? 'done' : 'run',
    onTap: () => dismiss(t.id)
  }
}

export default function Couch({ onClose }: { onClose: () => void }) {
  const { account, runSequence, pending, spectating } = useTransaction()
  const now = useNow(1000)
  const loop = useLoopPlan(account, readCashOut())
  const m = useMining(now)
  const today = useTodayEarnings(account)
  const [panel, setPanel] = useState<'out' | 'idle' | null>(null)
  /** The Deployed list for one mission only (a moon or the orb opened it), or every mission. */
  const [only, setOnly] = useState<number | null>(null)
  const card = useDockedToast()
  const [tint, nextTint] = useTint()
  useCouchFonts()
  useWakeLock()
  usePinnedPage(tint.night)
  useTabTitle()

  const back = loop.ready
  const out = loop.running
  const plan = back.length ? loop.cycle(loop.ready, loop.loopable) : null
  const looping = pending === 'loop-all'
  const canLoop = !!plan && plan.funding.affordable && !looping && !spectating
  const mineOn = !m.block || m.block === 'loading'
  const mineReady = !m.block && !m.cooling && !!m.pick && !m.busy
  useReportCount('mine', mineReady ? 1 : 0)
  useReportCount('loop', back.length)

  const sendable = loop.idle.flatMap((x) => (x.line ? [x.line] : []))
  const deploying = pending === 'deploy-idle'

  // A short buzz when something becomes ready, so the phone only needs a look when there's a reason.
  const readyNow = mineReady || canLoop
  const wasReady = useRef(false)
  useEffect(() => {
    if (readyNow && !wasReady.current) navigator.vibrate?.(80)
    wasReady.current = readyNow
  }, [readyNow])

  const mineLeft = m.pickReadyAt ? Math.max(0, m.pickReadyAt - now) : null

  // The bell: a chime booked for the next mine and for every division's return.
  const [sound, setSound] = useChimeSetting()
  const chimes: ChimeEvent[] = [
    ...(mineOn && !m.busy && m.pickReadyAt && m.pickReadyAt > now ? [{ kind: 'mine' as const, at: m.pickReadyAt }] : []),
    ...out.map((d) => ({ kind: 'loop' as const, at: d.unlockAt }))
  ]
  useChimeSchedule(sound, chimes)
  const toggleSound = () => {
    const next = !sound
    setSound(next)
    // This tap unlocks sound in the browser; the chime says it works.
    if (next) chimeNow(CHIME_FOR.loop)
  }

  const nextOut = out[0]
  // A bar or orb that is on never drops below a small start, so it doesn't vanish right after a mine or loop.
  const START = 0.03
  const share = (d: { joinedAt: number; unlockAt: number }) =>
    Math.min(1, Math.max(START, (now - d.joinedAt) / Math.max(1, d.unlockAt - d.joinedAt)))
  const mineProgress = !mineOn ? 0 : mineReady ? 1 : Math.max(START, m.progress)

  // Back to the page it was opened from; to Missions when it was opened on its own (a home screen icon).
  const close = onClose


  async function doMine() {
    if (!mineReady) return
    await m.mine()
    refreshToday(account)
  }

  async function send(lines: PlanLine[]) {
    if (!lines.length) return
    const { parts } = loop.deploy(lines)
    const title = lines.length === 1 ? `Sending #${lines[0].division.id}` : `Sending ${lines.length} divisions`
    const done = await runSequence(parts, 'deploy-idle', title)
    if (done === lines.length && lines.length === sendable.length) setPanel(null)
  }
  const deployFunding = sendable.length ? loop.deploy(sendable).funding : null
  const canSend = !!deployFunding?.affordable && !deploying && !spectating && !looping

  // What a division comes back with: its mission's TLM (and DEF, if it pays any).
  const haul = (missionId: number) => {
    const e = loop.econ.get(missionId)
    if (!e) return ''
    return [
      e.rewardTlm > 0 ? `+${formatNumber(e.rewardTlm, e.rewardTlm >= 100 ? 0 : 2)} TLM` : '',
      e.rewardDef > 0 ? `+${formatNumber(e.rewardDef, 2)} DEF` : ''
    ]
      .filter(Boolean)
      .join(' · ')
  }
  // One moon per mission with divisions on it: how many, how many back, the next return, what they bring.
  const moons: MoonMission[] = []
  {
    const by = new Map<number, MoonMission>()
    for (const d of [...back, ...out]) {
      const e = loop.econ.get(d.missionId)
      let m = by.get(d.missionId)
      if (!m) by.set(d.missionId, (m = { missionId: d.missionId, title: e?.title ?? `Mission #${d.missionId}`, divs: 0, back: 0, next: null, value: 0 }))
      m.divs++
      // DEF rewards count at the pool price, so a DEF mission is not drawn as nothing.
      m.value += (e?.rewardTlm ?? 0) + (e?.rewardDef ?? 0) * loop.market.rate
      if (d.unlockAt <= now) m.back++
      else if (!m.next || d.unlockAt < m.next.unlockAt) m.next = { joinedAt: d.joinedAt, unlockAt: d.unlockAt }
    }
    moons.push(...by.values())
  }
  // The orb is the mission that brings back the most; the moons are the others.
  const big = moons.reduce<MoonMission | null>((b, x) => (!b || x.value > b.value || (x.value === b.value && x.divs > b.divs) ? x : b), null)
  const orbit = big ? moons.filter((x) => x.missionId !== big.missionId) : moons
  // The orb is ready when its mission is back; a tap then loops everything that is back.
  const canLoopBig = !!big?.back && canLoop
  // The orb brims while the big mission's divisions are back, and otherwise fills with its next return.
  const level = looping ? 0.05 : big?.back ? 0.94 : big?.next ? 0.04 + share(big.next) * 0.86 : 0.03
  const orb = useBloodOrb(level, tint.orb)

  const openList = (missionId: number | null) => {
    setOnly(missionId)
    setPanel('out')
  }
  /**
   * A mission's orb or moon tapped: when that mission's divisions are back, every mission that is
   * back is looped together (one tap, all of it); otherwise it lists that mission's divisions.
   */
  async function tapMission(missionId: number, isOrb = false) {
    const isBack = missionId >= 0 && back.some((d) => d.missionId === missionId)
    if (isOrb) orb.slosh(isBack && canLoop ? 1 : 0.5)
    if (!isBack || !canLoop || !plan) return openList(missionId >= 0 ? missionId : null)
    navigator.vibrate?.(30)
    const missions = new Set(back.map((d) => d.missionId)).size
    await runSequence(plan.parts, 'loop-all', `Looping ${back.length} division${back.length === 1 ? '' : 's'} on ${missions} mission${missions === 1 ? '' : 's'}`)
    refreshToday(account)
  }

  const comingTlm = [...back, ...out].reduce((n, d) => n + (loop.econ.get(d.missionId)?.rewardTlm ?? 0), 0)
  const mineText = !mineOn ? 'Off' : m.busy ? 'Mining…' : mineReady ? 'Ready' : mineLeft !== null ? clock(mineLeft) : '…'

  return (
    <div
      className="couch is-kitten"
      data-kt={tint.id}
      style={
        {
          '--moon-l1': tint.moon.l1,
          ...(tint.moon.mid ? { '--moon-lm': tint.moon.mid } : {}),
          '--moon-l2': tint.moon.l2,
          '--moon-glass': tint.moon.glass,
          '--moon-rim': tint.moon.rim,
          '--moon-ready': tint.moon.ready
        } as React.CSSProperties
      }
    >
      <Night />
      <div className="couch__vignette" aria-hidden="true" />

      <button type="button" className="couch__close" onClick={close} aria-label="Close couch mode">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <button
        type="button"
        className="couch__tint"
        onClick={nextTint}
        style={{ '--t1': tint.swatch[0], '--t2': tint.swatch[1], '--t3': tint.swatch[2] } as React.CSSProperties}
        aria-label={`Colours: ${tint.name}. Switch to ${KITTEN_THEMES[(KITTEN_THEMES.indexOf(tint) + 1) % KITTEN_THEMES.length].name}`}
        title={`${tint.name} · tap for ${KITTEN_THEMES[(KITTEN_THEMES.indexOf(tint) + 1) % KITTEN_THEMES.length].name}`}
      />

      <header className="couch__top" aria-label="Earned today">
        <div className="couch__orn">
          <svg viewBox="0 0 46 14" aria-hidden="true">
            <path d="M23 1l5 6-5 6-5-6z" fill="#0a0606" stroke="currentColor" />
            <path d="M2 7h12M32 7h12" stroke="currentColor" />
            <circle cx="14" cy="7" r="1.6" fill="currentColor" />
            <circle cx="32" cy="7" r="1.6" fill="currentColor" />
          </svg>
        </div>
        <div className="couch__plaques">
          <div className="couch__plaque">
            <small>Divisions · today</small>
            <b className="num">
              {tlm(today.data?.divisions)}
              <i>TLM</i>
            </b>
          </div>
          <div className="couch__plaque is-mine">
            <small>Mining · today</small>
            <b className="num">
              {tlm(today.data?.mining)}
              <i>TLM</i>
            </b>
          </div>
        </div>
        <button
          type="button"
          className="couch__bell"
          aria-pressed={sound}
          aria-label={sound ? 'Chime when ready: on' : 'Chime when ready: off'}
          title={sound ? 'Chimes when a mine or a division is ready' : 'No sound'}
          onClick={toggleSound}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
            <path d="M10 20a2 2 0 0 0 4 0" />
            <path className="couch__bell-off" d="M4 4l16 16" />
          </svg>
        </button>
      </header>

      <main className="couch__stage">
        <div
          className={`couch__orb${orbit.length ? ' has-moons' : ''}${big?.back && !looping ? ' is-ready' : ''} is-${canLoopBig ? 'eager' : back.length || looping ? 'awake' : 'asleep'}`}
        >
          <KittenFrame theme={tint} />
          <canvas ref={orb.ref} className="couch__blood" />
          <div className="couch__label" aria-live="polite">
            {looping || big?.back ? (
              <>
                <b>LOOP</b>
                <small>
                  {looping
                    ? 'The warband marches…'
                    : spectating
                      ? 'Read-only'
                      : !plan?.funding.affordable
                        ? 'Not enough TLM'
                        : `${back.length} back${(plan?.earnedTlm ?? 0) > 0 ? ` · +${formatNumber(plan!.earnedTlm, 0)} TLM` : ''}`}
                </small>
                {!looping && big && <em>{big.title}</em>}
              </>
            ) : big?.next ? (
              <>
                <b className="num is-clock">{clock(big.next.unlockAt - now)}</b>
                <em>until {big.title} returns</em>
              </>
            ) : (
              <>
                <b className="is-clock">–</b>
                <em>No division is out</em>
              </>
            )}
          </div>
          <button
            type="button"
            className="couch__hit"
            onClick={() => big && void tapMission(big.missionId, true)}
            aria-disabled={!big}
            aria-label={
              !big
                ? 'No division is out'
                : canLoopBig
                  ? `Loop all ${back.length} division${back.length === 1 ? '' : 's'} that are back`
                  : `${big.title}: show its divisions`
            }
          />
          <Moons missions={orbit} now={now} each={tint.moonEach} onTap={(id) => void tapMission(id)} />
        </div>
      </main>

      <section className="couch__lower">
        <div className={`couch__dock${card ? ' is-carding' : ''}`}>
          <div className="couch__tablets" aria-hidden={!!card}>
            <button type="button" className="couch__tablet" onClick={() => openList(null)}>
              <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 26L24 8M24 4v4h4M26 26L8 8M8 4v4H4" />
                <path d="M4 22l6 6M28 22l-6 6" opacity=".7" />
              </svg>
              <b className="num">
                {out.length + back.length}
                <small>Deployed</small>
              </b>
              <span>
                {back.length ? (
                  `${back.length} returned`
                ) : nextOut ? (
                  <>
                    #{nextOut.divisionId} back in <em className="num">{clock(nextOut.unlockAt - now)}</em>
                  </>
                ) : (
                  'None out'
                )}
              </span>
            </button>
            <button
              type="button"
              className={`couch__tablet${sendable.length ? ' is-alert' : ''}`}
              onClick={() => setPanel('idle')}
            >
              <svg
                viewBox="0 0 32 32"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 29V3" />
                <path d="M8 4h17l-4 6 4 6H8" fill="currentColor" fillOpacity=".25" />
              </svg>
              <b className="num">
                {loop.idle.length}
                <small>Idle</small>
              </b>
              <span>{sendable.length ? 'Ready for orders' : loop.idle.length ? 'No TLM mission open' : 'All are out'}</span>
            </button>
          </div>
          {card && (
            <button
              key={card.key}
              type="button"
              className={`couch__card is-${card.tone}`}
              onClick={card.onTap}
              aria-live="polite"
              aria-label={`${card.title}: ${card.line}${card.onTap ? '. Tap to close.' : ''}`}
            >
              <span className="couch__card-hd">
                <b>{card.title}</b>
                {card.count && <span className="num">{card.count}</span>}
              </span>
              <span className="couch__card-line">{card.line}</span>
              <span className="couch__card-hair" aria-hidden="true">
                {card.steps.map((x, i) => (
                  <i key={i} className={`is-${x}`} />
                ))}
              </span>
            </button>
          )}
        </div>
        <button
          type="button"
          className={`couch__mine${mineReady ? ' is-ready' : ''}${m.busy ? ' is-working' : ''}`}
          style={{ '--f': mineProgress } as React.CSSProperties}
          onClick={() => void doMine()}
          disabled={!mineReady}
          aria-label={mineReady ? `Mine, about ${formatNumber(m.pick?.estimatedTlm ?? 0, 2)} TLM` : `Mine: ${mineText}`}
        >
          <i className="couch__mine-fill" aria-hidden="true" />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 9.5c4-5 12-5 16 0" />
            <path d="M12 6.5v14.5" />
          </svg>
          <b>Mine</b>
          <span className="num">{mineReady ? `≈ ${formatNumber(m.pick?.estimatedTlm ?? 0, 2)} TLM` : mineText}</span>
        </button>
      </section>

      <div className={`couch__scrim${panel ? ' is-open' : ''}`} onClick={() => setPanel(null)} />

      <section
        className={`couch__tip is-out${panel === 'out' ? ' is-open' : ''}`}
        aria-label="Deployed divisions"
        aria-hidden={panel !== 'out'}
      >
        {CORNERS.map((c) => (
          <i key={c} className={`couch__cn is-${c}`} />
        ))}
        <button type="button" className="couch__x" onClick={() => setPanel(null)} aria-label="Close">
          ✕
        </button>
        <header>
          <h3>
            {only !== null
              ? `${loop.econ.get(only)?.title ?? `Mission #${only}`} · ${[...back, ...out].filter((d) => d.missionId === only).length}`
              : `Deployed · ${out.length + back.length}`}
          </h3>
          <small>{comingTlm > 0 ? `+${formatNumber(comingTlm, 0)} TLM on its way` : 'Marching through the burning world'}</small>
        </header>
        <div className="couch__div">
          <i />
        </div>
        <ul>
          {back.filter((d) => only === null || d.missionId === only).map((d) => (
            <li key={`b-${d.missionId}-${d.divisionId}`} className="is-home">
              <span>
                <b>{loop.econ.get(d.missionId)?.title ?? `Mission #${d.missionId}`}</b>
                <small>Division {d.divisionId}</small>
              </span>
              <span className="t">
                Returned
                <small className="haul">{haul(d.missionId)}</small>
              </span>
              <span className="p">
                <i style={{ width: '100%' }} />
              </span>
            </li>
          ))}
          {out.filter((d) => only === null || d.missionId === only).map((d) => (
            <li key={`${d.missionId}-${d.divisionId}`}>
              <span>
                <b>{loop.econ.get(d.missionId)?.title ?? `Mission #${d.missionId}`}</b>
                <small>Division {d.divisionId}</small>
              </span>
              <span className="t num">
                {clock(d.unlockAt - now)}
                <small className="haul">{haul(d.missionId)}</small>
              </span>
              <span className="p">
                <i style={{ width: `${share(d) * 100}%` }} />
              </span>
            </li>
          ))}
          {!out.length && !back.length && <li className="is-empty">No division is on a mission.</li>}
        </ul>
      </section>

      <section
        className={`couch__tip is-idle${panel === 'idle' ? ' is-open' : ''}`}
        aria-label="Idle divisions"
        aria-hidden={panel !== 'idle'}
      >
        {CORNERS.map((c) => (
          <i key={c} className={`couch__cn is-${c}`} />
        ))}
        <button type="button" className="couch__x" onClick={() => setPanel(null)} aria-label="Close">
          ✕
        </button>
        <header>
          <h3>Idle · {loop.idle.length}</h3>
          <small>Awaiting your command</small>
        </header>
        <div className="couch__div">
          <i />
        </div>
        <ul>
          {loop.idle.map(({ division, line }) => (
            <li key={division.id} className={line ? undefined : 'is-off'}>
              <span>
                <b>
                  Division {division.id}
                  {line ? ` → ${line.mission.title}` : ''}
                </b>
                <small>
                  {line
                    ? `+${formatNumber(line.perHour, 1)} TLM/h · back in ${clock(line.seconds * 1000)}`
                    : 'No open mission pays TLM for it'}
                </small>
              </span>
              {line && (
                <button type="button" className="couch__send" disabled={!canSend} onClick={() => void send([line])}>
                  March
                </button>
              )}
            </li>
          ))}
          {!loop.idle.length && <li className="is-empty">Every division is on a mission.</li>}
        </ul>
        {sendable.length > 0 && (
          <div className="couch__tip-foot">
            <HoldButton
              label={deploying ? 'They march…' : `Hold to march ${sendable.length === 1 ? '' : 'all '}${sendable.length}`}
              disabled={!canSend}
              onConfirm={() => void send(sendable)}
            />
            {deployFunding && !deployFunding.affordable && (
              <p className="couch__warn">
                Not enough TLM for the entries ({formatNumber(deployFunding.tlmTotal, 2)} TLM needed).
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
