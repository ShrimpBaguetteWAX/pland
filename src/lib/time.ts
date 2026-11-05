import { useEffect, useState } from 'react'

import { chainNow, endpointPool } from '@/chain/endpoints'

/** Chain timestamps come without a zone suffix but are UTC. */
export function chainDate(value?: string | number | null): Date {
  if (value === undefined || value === null || value === '') return new Date(NaN)
  if (typeof value === 'number') return new Date(value)
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`)
}

export interface TimeLeft {
  days: number
  hours: number
  minutes: number
  seconds: number
  ms: number
}

/** "2d 5h 12min" */
export const countdown = (t: TimeLeft) => `${t.days}d ${t.hours}h ${t.minutes}min`

export function timeLeft(target: Date | number, now = Date.now()): TimeLeft {
  const ms = Math.max(0, +target - now)
  return {
    days: Math.floor(ms / 86_400_000),
    hours: Math.floor((ms / 3_600_000) % 24),
    minutes: Math.floor((ms / 60_000) % 60),
    seconds: Math.floor((ms / 1000) % 60),
    ms
  }
}

export const pad = (n: number) => String(n).padStart(2, '0')

/** "MINE" once ready, otherwise "mm:ss" or "hh:mm:ss" like the original button. */
export function cooldownLabel(target: Date | number, now = Date.now(), ready = 'MINE'): string {
  const t = timeLeft(target, now)
  if (t.ms <= 0) return ready
  const totalHours = t.days * 24 + t.hours
  return totalHours > 0 ? `${pad(totalHours)}:${pad(t.minutes)}:${pad(t.seconds)}` : `${pad(t.minutes)}:${pad(t.seconds)}`
}

/** "1d4h12m30s": how long until mining rewards can be claimed, as the original claim buttons counted. */
export const compactWait = (wait: TimeLeft) =>
  `${wait.days ? `${wait.days}d` : ''}${wait.hours ? `${wait.hours}h` : ''}${wait.minutes ? `${wait.minutes}m` : ''}${wait.seconds}s`

/** "2d 4h", "4h 12m", "12m 30s" or "30s": the two units that matter at that scale. */
export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total / 3_600) % 24)
  const minutes = Math.floor((total / 60) % 60)
  const seconds = total % 60
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function durationLabel(target: Date | number, now = Date.now()): string {
  const t = timeLeft(target, now)
  let out = ''
  if (t.days) out += `${t.days}d `
  if (t.hours) out += `${t.hours}h `
  if (t.minutes) out += `${t.minutes}m `
  return out.trim()
}

/** setTimeout can't wait longer than this (about 24.8 days). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Re-renders the caller once, when `at` (a timestamp) is reached, and returns a counter that
 * changes at that moment — put it in a memo's dependencies to recompute across a boundary
 * (a week ending, a season starting) without ticking every second.
 */
export function useRerenderAt(at: number | undefined): number {
  const [passed, setPassed] = useState(0)
  useEffect(() => {
    if (!at || !Number.isFinite(at)) return
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      const wait = at - Date.now()
      if (wait <= 0) {
        setPassed((n) => n + 1)
        return
      }
      // Very distant targets are re-armed in steps.
      timer = setTimeout(arm, Math.min(wait + 50, MAX_TIMEOUT_MS))
    }
    arm()
    return () => clearTimeout(timer)
  }, [at])
  return passed
}

/**
 * The current time on the chain's clock, for deciding what is ready (a browser clock that runs a
 * minute fast would otherwise show a lock as over before the contract agrees): the caller
 * re-renders only when the next of `times` passes, not on every tick. Pair it with `<Ticking>` for
 * countdown text that must change every second, so only that text re-renders.
 */
export function useClockFor(times: (number | undefined)[]): number {
  const now = chainNow()
  let next = Infinity
  for (const time of times) if (time !== undefined && time > now && time < next) next = time
  // Timers run on the browser's clock, so the wake-up is shifted by the skew.
  useRerenderAt(Number.isFinite(next) ? next + endpointPool.clockSkewMs : undefined)
  return now
}

/** Re-renders the caller every `intervalMs` and returns the current time on the chain's clock. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => chainNow())
  useEffect(() => {
    const id = setInterval(() => setNow(chainNow()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3))

/** "05 March 2025" */
export function formatDate(date: Date): string {
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** "05/03/2025" */
export function formatDateNumeric(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

/** "16 Sep, 14:02" in UTC, the chain's clock. */
export function formatUtcDayTime(at: number): string {
  const date = new Date(at)
  return `${pad(date.getUTCDate())} ${MONTHS_SHORT[date.getUTCMonth()]}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

/** "05 Mar 2025 14:02" */
export function formatDateTimeShort(date: Date): string {
  return `${pad(date.getDate())} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** How long ago a moment was, in the largest unit that fits: "5 min ago", "3 days ago", "2 months ago". */
export function timeAgo(then: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - then) / 60_000))
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return unit(hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 31) return unit(days, 'day')
  const months = Math.floor(days / 30.44)
  if (months < 12) return unit(months, 'month')
  return unit(Math.floor(months / 12), 'year')
}
