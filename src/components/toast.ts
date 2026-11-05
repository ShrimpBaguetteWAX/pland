import { create } from 'zustand'

type Kind = 'success' | 'error' | 'info'

/** Where one step of a live toast stands. */
export type StepState = 'wait' | 'busy' | 'ok' | 'bad'

export interface Toast {
  id: number
  kind: Kind
  message: string
}

/**
 * One toast for a whole run of transactions (the loop, a deployment of several divisions): a
 * segment per transaction that lights up as it lands, a line saying what just happened, and a
 * summary at the end. Rapid auto-signed runs then stay one toast instead of a column of them.
 */
export interface LiveToast {
  id: number
  title: string
  steps: StepState[]
  line: string
  state: 'running' | 'done' | 'failed'
}

interface ToastState {
  toasts: Toast[]
  live: LiveToast[]
  /** A screen shows the toasts itself (Couch mode docks them in place of its tablets): the floating ones stay hidden. */
  docked: boolean
  setDocked: (docked: boolean) => void
  push: (kind: Kind, message: string) => void
  dismiss: (id: number) => void
  start: (title: string, steps: number) => number
  update: (id: number, change: Partial<Omit<LiveToast, 'id'>> | ((t: LiveToast) => Partial<LiveToast>)) => void
  close: (id: number) => void
}

let nextId = 1
/** How long a toast stays before it goes on its own. */
export const TOAST_MS = 4000
/** How long a finished live toast shows its summary. */
export const LIVE_DONE_MS = 3000

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  live: [],
  docked: false,
  setDocked(docked) {
    set({ docked })
  },
  push(kind, message) {
    const id = nextId++
    set({ toasts: [...get().toasts, { id, kind, message }] })
    setTimeout(() => get().dismiss(id), TOAST_MS)
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
  start(title, steps) {
    const id = nextId++
    const t: LiveToast = { id, title, steps: Array.from({ length: steps }, () => 'wait'), line: '', state: 'running' }
    set({ live: [...get().live, t] })
    return id
  },
  update(id, change) {
    set({
      live: get().live.map((t) => (t.id === id ? { ...t, ...(typeof change === 'function' ? change(t) : change) } : t))
    })
  },
  close(id) {
    set({ live: get().live.filter((t) => t.id !== id) })
  }
}))

/** A handle on one live toast, for whoever runs the steps. */
export function liveToast(title: string, steps: number) {
  const s = useToasts.getState()
  const id = s.start(title, steps)
  const setStep = (i: number, state: StepState) => (t: LiveToast) => ({
    steps: t.steps.map((x, k) => (k === i ? state : x))
  })
  return {
    busy(i: number, line: string) {
      s.update(id, (t) => ({ ...setStep(i, 'busy')(t), line }))
    },
    ok(i: number, line: string) {
      s.update(id, (t) => ({ ...setStep(i, 'ok')(t), line }))
    },
    /** A failed step: the toast stays, red, until it is clicked away. */
    fail(i: number, title: string, line: string) {
      s.update(id, (t) => ({ ...setStep(i, 'bad')(t), title, line, state: 'failed' }))
    },
    /** All went through: the summary shows for a moment, then the toast goes. */
    done(title: string, line: string) {
      s.update(id, { title, line, state: 'done' })
      setTimeout(() => useToasts.getState().close(id), LIVE_DONE_MS)
    }
  }
}

export const toast = {
  success: (message: string) => useToasts.getState().push('success', message),
  error: (message: string) => useToasts.getState().push('error', message),
  info: (message: string) => useToasts.getState().push('info', message)
}
