/// <reference lib="webworker" />
import { buildAtCount, polish, scanCounts, type Bundle, type SolveInput } from './bundle'

/** One piece of a solve, run in a pool worker (see solverPool.ts and parallelSolve.ts). */
export type SolveTask =
  | { type: 'scan'; input: SolveInput; ta: number; td: number; L: number; counts: number[]; bound: number }
  | { type: 'build'; input: SolveInput; ta: number; td: number; L: number; k: number }
  | { type: 'polish'; input: SolveInput; bundle: Bundle }

export interface TaskRequest {
  id: number
  task: SolveTask
}

export interface TaskResponse {
  id: number
  result: unknown
  error?: string
}

function runTask(task: SolveTask): unknown {
  switch (task.type) {
    case 'scan':
      return scanCounts(task.input, task.ta, task.td, task.L, task.counts, task.bound)
    case 'build':
      return buildAtCount(task.input, task.ta, task.td, task.L, task.k)
    case 'polish':
      return polish(task.bundle, task.input)
  }
}

self.onmessage = (event: MessageEvent<TaskRequest>) => {
  const { id, task } = event.data
  let reply: TaskResponse
  try {
    reply = { id, result: runTask(task) }
  } catch (err) {
    reply = { id, result: null, error: err instanceof Error ? err.message : String(err) }
  }
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(reply)
}
