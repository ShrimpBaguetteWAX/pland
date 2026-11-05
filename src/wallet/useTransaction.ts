import { useRef, useState } from 'react'
import type { AnyAction } from '@wharfkit/session'
import { useShallow } from 'zustand/react/shallow'

import { regPlayer } from '@/chain/actions/pd'
import { liveToast, toast } from '@/components/toast'
import { refreshPlayer, usePlayer } from '@/data/game'
import { sleep } from '@/lib/format'
import { useSession } from '@/state/session'

import { autoSignOn, formatTransactError, isUserCancel, signsByItself, transact } from './session'

/** A node shows a signed transaction about a second later; lagging nodes get one more read. */
const CATCH_UP_MS = 1200
const LATE_NODE_MS = 4000
/** More actions than this do not fit one transaction (CPU and size limits): it is split. */
const MAX_ACTIONS_PER_TX = 25
/** Actions per transaction once split. */
const SPLIT_SIZE = 25
/**
 * Between two transactions signed in a row: a later one may spend what an earlier one deposited,
 * and Anchor drops a request that reaches it while it is still closing the previous one, so the
 * next request waits this long.
 */
const BETWEEN_PARTS_MS = 2000
/**
 * After a transaction the deck signed by itself (auto-sign): no wallet window is closing, and the
 * session pushes every transaction through the same node, which has applied the last one by the
 * time it answers. A short breath is enough.
 */
const AFTER_AUTO_SIGN_MS = 150

/** One transaction, or parts of SPLIT_SIZE in order when there are more than MAX_ACTIONS_PER_TX actions. */
export function splitActions<T>(actions: T[]): T[][] {
  if (actions.length <= MAX_ACTIONS_PER_TX) return [actions]
  return Array.from({ length: Math.ceil(actions.length / SPLIT_SIZE) }, (_, i) =>
    actions.slice(i * SPLIT_SIZE, (i + 1) * SPLIT_SIZE)
  )
}

/** Builds the actions when it is time to sign; may read fresh data first (a pool quote, say). */
type Build = (account: string, permission: string) => AnyAction | AnyAction[] | Promise<AnyAction | AnyAction[]>

/**
 * Signs one or more actions for the signed-in player, shows the outcome and reads the player's
 * data again. A first-time player is registered in the same transaction. `key` names the button
 * that is waiting when a screen has several.
 *
 * With `split` (the Market uses it), more than MAX_ACTIONS_PER_TX actions are sent as several
 * transactions of SPLIT_SIZE, one after
 * the other and in the original order (a deposit always lands before what spends it). Each part is
 * signed separately. If a part fails, the ones before it have already gone through; the message
 * says so.
 *
 * With `refresh: false` the player's data is not read again afterwards; a sequence uses it for
 * all but its last transaction, so the next signature is asked for right away.
 */
export function useTransaction() {
  const { account, permission, spectating } = useSession(
    useShallow((s) => ({ account: s.account, permission: s.permission, spectating: s.spectating }))
  )
  const player = usePlayer(account)
  const [pending, setPending] = useState<string | null>(null)
  /** Set once a transaction of this session registered the player, so the next does not again. */
  const registered = useRef(false)
  /** Whether the last transaction went out signed by the deck itself, which sets the pause before the next. */
  const lastAuto = useRef(false)
  const pause = () => sleep(lastAuto.current ? AFTER_AUTO_SIGN_MS : BETWEEN_PARTS_MS)
  const signPrompt = () => (autoSignOn() ? '' : ' Please sign.')

  /**
   * register: false leaves out the player registration a first-time player otherwise gets (for
   * transactions that have nothing to do with the game, such as an Alcor swap).
   * onSigned: called with the transaction id once each transaction is accepted.
   */
  type Options = {
    split?: boolean
    refresh?: boolean
    register?: boolean
    onSigned?: (trxId: string) => void
    /** Inside a live toast: no toasts of its own; a failure is handed to onFail instead. */
    quiet?: boolean
    onFail?: (message: string, cancelled: boolean) => void
    /** Called as soon as everything is on chain, before the player's data is read again. */
    onLanded?: () => void
  }

  /** Resolves true once signed and refreshed, false when cancelled, refused or failed. */
  async function run(build: Build, success: string, key = 'tx', opts: Options = {}): Promise<boolean> {
    if (!account) return false
    if (spectating) {
      toast.info('You are viewing this account read-only. Sign in with your wallet to act.')
      return false
    }
    setPending(key)
    try {
      // The page is free again the moment the transaction lands; the refresh after it runs in the background.
      return await runOne(account, build, success, { ...opts, onLanded: () => setPending(null) })
    } finally {
      setPending(null)
    }
  }

  async function runOne(account: string, build: Build, success: string, opts: Options): Promise<boolean> {
    try {
      const built = await build(account, permission)
      let actions = Array.isArray(built) ? built : [built]
      const register = opts.register !== false && !!player.data && !player.data.registered && !registered.current
      if (register) actions = [regPlayer(account, permission), ...actions]
      const parts = opts.split ? splitActions(actions) : [actions]
      for (let i = 0; i < parts.length; i++) {
        if (parts.length > 1) {
          if (i > 0) await pause()
          toast.info(`Transaction ${i + 1} of ${parts.length}: ${parts[i].length} actions.${signPrompt()}`)
        }
        try {
          const auto = signsByItself(parts[i])
          const trxId = await transact(parts[i])
          lastAuto.current = auto
          if (register) registered.current = true
          opts.onSigned?.(trxId)
        } catch (err) {
          if (i === 0) throw err
          // Earlier parts are on chain: say so, and show what is there now.
          const why = isUserCancel(err) ? 'was cancelled' : `failed: ${formatTransactError(err)}`
          toast.error(
            `Transaction ${i + 1} of ${parts.length} ${why}. Transactions 1${i > 1 ? `–${i}` : ''} already went through; ` +
              'check the result and do the rest again.'
          )
          await refreshPlayer(account)
          return false
        }
      }
      if (success && !opts.quiet) toast.success(success)
      opts.onLanded?.()
      if (opts.refresh !== false) {
        await sleep(CATCH_UP_MS)
        await refreshPlayer(account)
        setTimeout(() => void refreshPlayer(account), LATE_NODE_MS)
      }
      return true
    } catch (err) {
      const cancelled = isUserCancel(err)
      if (opts.quiet) opts.onFail?.(cancelled ? 'Cancelled in the wallet' : formatTransactError(err), cancelled)
      else if (!cancelled) toast.error(formatTransactError(err))
      return false
    }
  }

  /**
   * Signs several transactions one after another, in order, each with its own success message;
   * stops at the first that fails or is cancelled and says how many went through. Resolves to
   * the number of transactions that went through. The next signature is asked for BETWEEN_PARTS_MS
   * after the previous transaction is accepted, or AFTER_AUTO_SIGN_MS when the deck signed it
   * itself. The player's data is read again only once, at the end (the parts are built from the
   * state before the first one, and the wallet broadcasts them all through one node, so a later
   * part sees what an earlier one did).
   *
   * Two or more transactions report in one live toast (a segment each, what just landed, a
   * summary at the end) instead of a toast per transaction; `title` heads it.
   */
  async function runSequence(
    parts: { build: Build; success: string; settle?: boolean }[],
    key = 'tx',
    title?: string
  ): Promise<number> {
    if (!account) return 0
    if (spectating) {
      toast.info('You are viewing this account read-only. Sign in with your wallet to act.')
      return 0
    }
    setPending(key)
    try {
      if (parts.length === 1) return (await runOne(account, parts[0].build, parts[0].success, {})) ? 1 : 0
      const n = parts.length
      const live = liveToast(title ?? `${n} transactions`, n)
      for (let i = 0; i < n; i++) {
        const last = i === n - 1
        // After a transaction the next one depends on (claims, a deposit) the full wait, auto-sign or not.
        if (i > 0) await (parts[i - 1].settle ? sleep(BETWEEN_PARTS_MS) : pause())
        live.busy(i, `${parts[i].success}…${signPrompt()}`)
        let failure: { message: string; cancelled: boolean } | null = null
        const ok = await runOne(account, parts[i].build, parts[i].success, {
          refresh: last,
          quiet: true,
          onFail: (message, cancelled) => (failure = { message, cancelled })
        })
        if (!ok) {
          const f = failure as { message: string; cancelled: boolean } | null
          live.fail(
            i,
            f?.cancelled ? `Stopped at ${i + 1} of ${n}` : `Transaction ${i + 1} of ${n} failed`,
            `${f && !f.cancelled ? `${f.message}. ` : ''}${i ? `The first ${i} went through.` : 'Nothing went through.'}`
          )
          if (i > 0) void refreshPlayer(account)
          return i
        }
        live.ok(i, parts[i].success)
      }
      live.done(`${title ?? 'Transactions'}: done`, `All ${n} went through. ${parts[n - 1].success}.`)
      return n
    } finally {
      setPending(null)
    }
  }

  return { run, runSequence, busy: pending !== null, pending, account, permission, spectating }
}
