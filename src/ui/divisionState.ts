import type { Division } from '@/data/game'
import { chainDate } from '@/lib/time'

export type Tone = 'ready' | 'away' | 'claim' | 'empty'

export interface DivState {
  label: string
  tone: Tone
  until?: number
  /** The contract only lets a division at home be changed. */
  editable: boolean
}

/** Where a division stands: `unlock` is when its current deployment ends, if it has one. */
export function divisionState(d: Division, unlock: number | undefined, now: number): DivState {
  if (unlock !== undefined)
    return unlock <= now
      ? { label: 'Reward to claim', tone: 'claim', editable: false }
      : { label: 'On mission', tone: 'away', until: unlock, editable: false }
  if (d.lock && +chainDate(d.lock.locked_until) > now)
    return { label: 'On mission', tone: 'away', until: +chainDate(d.lock.locked_until), editable: false }
  if (!d.units.length) return { label: 'No crew yet', tone: 'empty', editable: true }
  return { label: 'Ready', tone: 'ready', editable: true }
}
