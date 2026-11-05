/// <reference lib="webworker" />
import { balanceDiagnostics, searchArmy, type SearchInput, type SearchProgress, type SearchResult } from './armySearch'

export interface SearchRequest {
  id: number
  input: SearchInput
  /** Development only: answer with balanceDiagnostics instead of a search. */
  diagnose?: number
}

export type SearchReply =
  | { id: number; type: 'progress'; progress: SearchProgress }
  | { id: number; type: 'best'; result: SearchResult }
  | { id: number; type: 'done'; result: SearchResult }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'diagnostics'; data: unknown }

// The search runs for up to its budget: off the page, so the page stays alive while it thinks.
self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const { id, input } = event.data
  const post = (reply: SearchReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply)
  try {
    if (event.data.diagnose) {
      post({ id, type: 'diagnostics', data: balanceDiagnostics(input, event.data.diagnose) })
      return
    }
    const result = searchArmy(
      input,
      (progress) => post({ id, type: 'progress', progress }),
      (result) => post({ id, type: 'best', result })
    )
    post({ id, type: 'done', result })
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
