import { useState } from 'react'

import { toast } from '@/components/toast'
import { chainDate } from '@/lib/time'
import { useSession } from '@/state/session'
import { canMine, MINING_BLOCKED_MESSAGE } from '@/wallet/session'
import { useTransaction } from '@/wallet/useTransaction'

import { refreshMining, useFavoriteLands, useMiner } from './data'
import { mineReadyAt, nextFavoriteUpgrade, pickFavoriteLand } from './estimates'
import { buildMine, mineLanded, mineResult } from './mine'
import { useMiningMode } from './mode'
import type { FavoriteLand } from './types'

/** Why the Mine button cannot be pressed at all, if it cannot. */
export type MineBlock = 'signed-out' | 'spectating' | 'loading' | 'anchor' | 'no-member' | 'flagged' | 'no-favorites' | 'no-tools'

/**
 * Everything the Mine button shows and does, the way WAX Mission Control's button works with
 * favourite lands: it counts down to the best favourite coming off cooldown, shows what that land
 * pays and when a better one will be ready, and on a click reads the pools again, picks the land
 * that pays most right now and mines there in one transaction.
 */
export function useMining(now: number) {
  const { account, run, spectating } = useTransaction()
  const wallet = useSession((s) => s.wallet)
  const mode = useMiningMode((s) => s.mode)
  const [busy, setBusy] = useState(false)
  const miner = useMiner(account)
  const { member, tools, lands, loaded, estimateNow } = useFavoriteLands(account, false)

  // Tools and the last mine set the cooldown on every land; the land's delay scales it.
  const lastMine = miner.data?.last_mine
  const readyAt = (land: FavoriteLand) => mineReadyAt(land.delay, tools.data, lastMine)
  const startedAt = Math.max(
    0,
    ...(tools.data ?? []).map((t) => (t.last_use ?? 0) * 1000),
    lastMine ? +chainDate(lastMine) || 0 : 0
  )
  const pick = pickFavoriteLand(lands, readyAt, mode, now)
  const pickReadyAt = pick ? readyAt(pick) : null
  const cooling = pickReadyAt !== null && pickReadyAt > now
  const upgrade = !cooling ? nextFavoriteUpgrade(lands, readyAt, mode, now) : null
  const progress = cooling && pickReadyAt ? Math.min(1, Math.max(0, (now - startedAt) / Math.max(1, pickReadyAt - startedAt))) : 1

  const block: MineBlock | null = !account
    ? 'signed-out'
    : spectating
      ? 'spectating'
      : !canMine(wallet)
        ? 'anchor'
        : !member.isFetched || !loaded || !miner.isFetched
          ? 'loading'
          : !member.data
            ? 'no-member'
            : member.data.flagged
              ? 'flagged'
              : !tools.data?.length
                ? 'no-tools'
                : !lands.length
                  ? 'no-favorites'
                  : null

  async function mine() {
    if (!account || busy || block) return
    if (!canMine(wallet)) {
      toast.error(MINING_BLOCKED_MESSAGE)
      return
    }
    setBusy(true)
    try {
      // The pools move with every mine anyone makes: read them again and pick where it pays most now.
      const fresh = await estimateNow()
      const land = pickFavoriteLand(fresh, readyAt, mode, Date.now())
      if (!land) return
      let txId = ''
      const ok = await run((a, p) => buildMine(a, p, tools.data, land.asset_id), '', 'mine', {
        register: false,
        refresh: false,
        onSigned: (id) => (txId = id)
      })
      if (!ok) return
      // The button stays busy until the chain has answered, so it never shows MINE again too early.
      const paid = await mineResult(txId)
      const landed = !!paid || (await mineLanded(account, txId))
      await refreshMining(account)
      if (!landed) toast.error('The mine did not reach the chain. Nothing was spent, please try again.')
      else toast.success(paid ?? 'Mine successful')
    } finally {
      setBusy(false)
    }
  }

  return { mode, block, busy, pick, pickReadyAt, cooling, upgrade, progress, mine }
}
