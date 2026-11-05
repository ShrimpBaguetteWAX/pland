/// <reference lib="webworker" />
import { findNonce, type PowRequest } from './pow'

self.onmessage = (event: MessageEvent<PowRequest>) => {
  self.postMessage(findNonce(event.data))
}
