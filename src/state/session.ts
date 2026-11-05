import { create } from 'zustand'

import { queryClient } from '@/data/queryClient'
import { login as walletLogin, logout as walletLogout, permission, restoreSession, walletId } from '@/wallet/session'

interface SessionState {
  account: string | null
  permission: string
  wallet: string | null
  /** True once the stored wallet session has been restored (or found missing). */
  restored: boolean
  /** Viewing another account read-only (?as=<account>): every transaction is refused. */
  spectating: boolean
  restore: () => Promise<void>
  login: () => Promise<boolean>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  account: null,
  permission: 'active',
  wallet: null,
  restored: false,
  spectating: false,

  async restore() {
    const viewAs = new URLSearchParams(window.location.search).get('as')
    if (viewAs) {
      set({ account: viewAs.trim().toLowerCase(), restored: true, spectating: true })
      return
    }
    try {
      const session = await restoreSession()
      set({ account: session ? String(session.actor) : null, permission: permission(), wallet: walletId(), restored: true })
    } catch {
      set({ account: null, restored: true })
    }
  },

  async login() {
    const session = await walletLogin()
    if (!session) return false
    set({ account: String(session.actor), permission: permission(), wallet: walletId(), spectating: false })
    return true
  },

  async logout() {
    await walletLogout().catch(() => undefined)
    queryClient.clear()
    set({ account: null, wallet: null, spectating: false })
  }
}))

export const useAccount = () => useSession((s) => s.account)
