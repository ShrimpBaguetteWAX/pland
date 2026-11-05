import type { SolveTask, TaskRequest, TaskResponse } from './bundle.task.worker'

/** Thrown into every waiting task when the pool is shut down for a newer solve. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

interface Job {
  id: number
  /** The task, or a function that makes it when a worker is free (null: nothing to do). */
  task: SolveTask | (() => SolveTask | null)
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

/**
 * A few Web Workers that each run one solve task at a time. Tasks queue until a worker is free, so
 * the solve uses the machine's cores without starting more threads than it has.
 */
export class SolverPool {
  readonly size: number
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: Job[] = []
  private running = new Map<Worker, Job>()
  private seq = 0
  private closed = false

  constructor(size: number) {
    this.size = size
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./bundle.task.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<TaskResponse>) => this.done(w, e.data)
      w.onerror = (e) => this.done(w, { id: -1, result: null, error: e.message || 'worker error' })
      this.workers.push(w)
      this.idle.push(w)
    }
  }

  /** Queues a task; `first` puts it ahead of everything waiting (a result others are waiting on). */
  run<T>(task: SolveTask | (() => SolveTask | null), first = false): Promise<T> {
    if (this.closed) return Promise.reject(new Cancelled())
    return new Promise<T>((resolve, reject) => {
      const job: Job = { id: ++this.seq, task, resolve: resolve as (v: unknown) => void, reject }
      if (first) this.queue.unshift(job)
      else this.queue.push(job)
      this.pump()
    })
  }

  /** Stops every worker; whatever was running or queued is rejected with Cancelled. */
  terminate() {
    this.closed = true
    for (const w of this.workers) w.terminate()
    for (const job of [...this.running.values(), ...this.queue]) job.reject(new Cancelled())
    this.running.clear()
    this.queue = []
    this.idle = []
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const job = this.queue.shift()!
      // A lazy task is made now, so it sees the latest bound; it may turn out to be unnecessary.
      const task = typeof job.task === 'function' ? job.task() : job.task
      if (!task) {
        job.resolve(null)
        continue
      }
      const w = this.idle.pop()!
      this.running.set(w, job)
      const request: TaskRequest = { id: job.id, task }
      w.postMessage(request)
    }
  }

  private done(w: Worker, reply: TaskResponse) {
    const job = this.running.get(w)
    if (!job) return
    this.running.delete(w)
    this.idle.push(w)
    if (reply.error) job.reject(new Error(reply.error))
    else job.resolve(reply.result)
    this.pump()
  }
}

/** Workers to use: most of the cores, leaving one for the page. */
export function poolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  return Math.max(2, Math.min(12, cores - 1))
}
