import { create } from 'zustand'

import type { MiningMode } from './types'

/** Which favourite land the Mine button picks, set in Settings and kept in this browser. */
const STORE = 'pd:mining:mode'

function read(): MiningMode {
  try {
    return localStorage.getItem(STORE) === 'shard' ? 'shard' : 'tlm'
  } catch {
    return 'tlm'
  }
}

export const useMiningMode = create<{ mode: MiningMode; setMode: (mode: MiningMode) => void }>((set) => ({
  mode: read(),
  setMode(mode) {
    try {
      localStorage.setItem(STORE, mode)
    } catch {
      // Storage blocked: the choice lasts until the page is reloaded.
    }
    set({ mode })
  }
}))
