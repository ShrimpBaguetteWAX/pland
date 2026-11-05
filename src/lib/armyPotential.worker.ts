/// <reference lib="webworker" />
import { potentialArmy, type SearchInput, type Tried } from './armySearch'

export interface PotentialRequest {
  id: number
  input: SearchInput
}

export type PotentialReply = { id: number; type: 'done'; tried: Tried[]; perHour: number; nowPerHour: number; ms: number } | { id: number; type: 'error'; message: string }

// What a wallet can field at once, worked out off the page while it shows the army.
self.onmessage = (event: MessageEvent<PotentialRequest>) => {
  const { id, input } = event.data
  const post = (reply: PotentialReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply)
  try {
    post({ id, type: 'done', ...potentialArmy(input) })
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
