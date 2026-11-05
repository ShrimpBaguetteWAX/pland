import type { PowRequest, PowResult } from './pow'

/** Runs the proof-of-work search off the main thread. */
export function computeNonce(request: PowRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<PowResult>) => {
      worker.terminate()
      resolve(event.data.nonce)
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'Nonce worker failed'))
    }
    worker.postMessage(request)
  })
}
