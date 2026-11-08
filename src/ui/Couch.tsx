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

import { BLOOD, CANDY, useBloodOrb } from './couch/bloodOrb'
import { InfernalFrame } from './couch/InfernalFrame'
import { KittenFrame } from './couch/KittenFrame'
import { Moons, type MoonMission } from './couch/Moons'

import './Couch.css'
import './couch/Kitten.css'

/*
 * Couch mode, Infernal: one screen for the phone lying next to you. Today's TLM on two plaques at
 * the top; in the middle a blood orb in a horned, rune-carved iron ring, which is the loop: it fills
 * as the next division heads home, brims when divisions are back, and a tap claims them and sends
 * them back out. Under it, two tablets (the divisions out, which open the full list, and the idle
 * ones, which open a panel to send them to their best TLM mission) and the mine as a bar of lava
 * that fills toward the next mine. It keeps the screen awake and buzzes when something becomes
 * ready; with the bell on it chimes too, also in a background tab.
 *
 * It comes in two looks, switched at the top right and remembered in this browser: Infernal, and
 * Kitten (Candy night), where the same screen is violet and blush, the blood is a slow pink potion
 * and a little horned kitten on the ring shows the state (asleep, awake, wings out when the loop is
 * ready). Round the orb, a moon per mission the divisions are on, each with its own timer.
 */

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}
const tlm = (n: number | undefined) => (n === undefined ? '–' : formatNumber(n, n >= 100 ? 0 : 2))

/** Couch mode's typefaces (both looks), loaded only when it opens. */
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Cinzel+Decorative:wght@900&family=EB+Garamond:ital,wght@0,500;1,400&family=Fredoka:wght@400;500;600&family=Grenze+Gotisch:wght@600;700&display=swap'
function useCouchFonts() {
  useEffect(() => {
    if (document.querySelector(`link[href="${FONT_HREF}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = FONT_HREF
    document.head.appendChild(link)
  }, [])
}

type Look = 'kitten' | 'infernal'
const LOOK_KEY = 'pd:couch-look'
/** Which look the couch wears, remembered in this browser; the kitten unless Infernal was picked. */
function useLook(): [Look, () => void] {
  const [look, setLook] = useState<Look>(() => {
    try {
      return localStorage.getItem(LOOK_KEY) === 'infernal' ? 'infernal' : 'kitten'
    } catch {
      return 'kitten'
    }
  })
  const toggle = () =>
    setLook((l) => {
      const next = l === 'kitten' ? 'infernal' : 'kitten'
      try {
        localStorage.setItem(LOOK_KEY, next)
      } catch {
        // Private mode: it holds for this visit.
      }
      return next
    })
  return [look, toggle]
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

/** Smoke, cracks of fire and rising embers behind everything; drawn once. */
const EMBERS = Array.from({ length: 24 }, (_, i) => ({
  left: `${(i * 41) % 100}%`,
  bottom: `${-2 + ((i * 7) % 12)}%`,
  size: 1 + (i % 3) * 0.8,
  sx: `${((i * 29) % 60) - 30}px`,
  duration: `${7 + (i % 6) * 1.7}s`,
  delay: `${-((i * 1.3) % 11)}s`
}))
function Pit() {
  return (
    <div className="couch__pit" aria-hidden="true">
      <div className="couch__smoke" />
      <div className="couch__smoke is-low" />
      <svg className="couch__cracks" viewBox="0 0 380 120" preserveAspectRatio="none">
        <path d="M0 90 L40 80 L62 88 L95 70 L120 76 L150 62" />
        <path d="M380 100 L340 88 L318 94 L290 76 L262 82 L240 66" />
        <path d="M95 70 L104 46 L98 30" />
        <path d="M290 76 L298 52 L286 36" />
        <path d="M150 62 L190 72 L240 66" />
      </svg>
      <div className="couch__grain" />
      {EMBERS.map((e, i) => (
        <span
          key={i}
          className="couch__ember"
          style={
            {
              left: e.left,
              bottom: e.bottom,
              width: e.size,
              height: e.size,
              '--sx': e.sx,
              animationDuration: e.duration,
              animationDelay: e.delay
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
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
  const card = useDockedToast()
  const [look, toggleLook] = useLook()
  const kitten = look === 'kitten'
  useCouchFonts()
  useWakeLock()
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
  // The orb brims while divisions are back, drains as they march, and otherwise fills with the next return.
  const level = looping ? 0.05 : back.length ? 0.94 : nextOut ? 0.04 + share(nextOut) * 0.86 : 0.03
  const orb = useBloodOrb(level, kitten ? CANDY : BLOOD)

  // Back to the page it was opened from; to Missions when it was opened on its own (a home screen icon).
  const close = onClose

  async function doLoop() {
    orb.slosh(canLoop ? 1 : 0.5)
    if (!canLoop || !plan) return
    navigator.vibrate?.(30)
    await runSequence(plan.parts, 'loop-all', `Looping ${back.length} division${back.length === 1 ? '' : 's'}`)
    refreshToday(account)
  }

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

  const backTlm = plan ? plan.earnedTlm : 0
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
  const comingTlm = [...back, ...out].reduce((n, d) => n + (loop.econ.get(d.missionId)?.rewardTlm ?? 0), 0)
  const mineText = !mineOn ? 'Off' : m.busy ? 'Mining…' : mineReady ? 'Ready' : mineLeft !== null ? clock(mineLeft) : '…'

  return (
    <div className={`couch${kitten ? ' is-kitten' : ''}`}>
      {kitten ? <Night /> : <Pit />}
      <div className="couch__vignette" aria-hidden="true" />

      <button type="button" className="couch__close" onClick={close} aria-label="Close couch mode">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <button
        type="button"
        className="couch__look"
        onClick={toggleLook}
        aria-label={kitten ? 'Look: Kitten. Switch to Infernal' : 'Look: Infernal. Switch to Kitten'}
        title={kitten ? 'Switch to Infernal' : 'Switch to Kitten'}
      >
        {kitten ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3c3 4 6 6.5 6 10.5a6 6 0 0 1-12 0C6 10 8.5 8 9 5c1.5 1.5 2.4 3 3-2z" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 4l3.5 4.5h7L19 4l1 9a8 8 0 0 1-16 0z" />
            <path d="M9.5 13.5h.01M14.5 13.5h.01M11 16.5l1 .8 1-.8" />
          </svg>
        )}
      </button>

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
          className={`couch__orb${moons.length ? ' has-moons' : ''}${back.length && !looping ? ' is-ready' : ''} is-${canLoop ? 'eager' : back.length || looping ? 'awake' : 'asleep'}`}
        >
          {kitten ? <KittenFrame /> : <InfernalFrame />}
          <canvas ref={orb.ref} className="couch__blood" />
          <div className="couch__label" aria-live="polite">
            {back.length || looping ? (
              <>
                <b>LOOP</b>
                <small>
                  {looping
                    ? 'The warband marches…'
                    : spectating
                      ? 'Read-only'
                      : !plan?.funding.affordable
                        ? 'Not enough TLM'
                        : `${back.length} returned${backTlm > 0 ? ` · +${formatNumber(backTlm, 0)} TLM` : ''}`}
                </small>
              </>
            ) : nextOut ? (
              <>
                <b className="num is-clock">{clock(nextOut.unlockAt - now)}</b>
                <em>until Division {nextOut.divisionId} returns</em>
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
            onClick={() => void doLoop()}
            aria-disabled={!canLoop}
            aria-label={
              canLoop ? `Loop ${back.length} returned division${back.length === 1 ? '' : 's'}` : 'Loop: nothing back yet'
            }
          />
          <Moons missions={moons} now={now} onOpen={() => setPanel('out')} />
        </div>
      </main>

      <section className="couch__lower">
        <div className={`couch__dock${card ? ' is-carding' : ''}`}>
          <div className="couch__tablets" aria-hidden={!!card}>
            <button type="button" className="couch__tablet" onClick={() => setPanel('out')}>
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
          <h3>Deployed · {out.length + back.length}</h3>
          <small>{comingTlm > 0 ? `+${formatNumber(comingTlm, 0)} TLM on its way` : 'Marching through the burning world'}</small>
        </header>
        <div className="couch__div">
          <i />
        </div>
        <ul>
          {back.map((d) => (
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
          {out.map((d) => (
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
