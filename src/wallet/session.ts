import type { AnyAction, Session, SessionKit } from '@wharfkit/session'

import { APP_NAME, CHAIN_ID } from '@/chain/config'
import { endpointPool } from '@/chain/endpoints'

import { AUTO_SIGN_PERMISSION, savedActions, whitelistOf } from './autoSign'
import { isAuthorityError, signsWithKey, syncAutoSign as matchChain, walletOnly } from './autoSignSync'

let kit: Promise<SessionKit> | null = null
let current: Session | undefined

/** Where WharfKit's BrowserLocalStorage keeps the last session. */
const STORED_SESSION_KEY = 'wharf--session'

/**
 * The wallet code is downloaded on first use, not at startup, and the kit is built after the
 * endpoint pool has been probed, so the wallet broadcasts through a node confirmed up and in
 * sync this session. WAX Cloud Wallet and Anchor are offered. The session key (auto-signing) is set
 * up with the actions picked in Settings; changing them rebuilds the kit (see reloadAutoSign).
 */
function getKit(): Promise<SessionKit> {
  kit ??= (async () => {
    const [{ SessionKit, ChainDefinition }, { default: WebRenderer }, anchor, cloudWallet] = await Promise.all([
      import('@wharfkit/session'),
      import('@wharfkit/web-renderer'),
      import('@wharfkit/wallet-plugin-anchor'),
      import('@wharfkit/wallet-plugin-cloudwallet'),
      endpointPool.probe()
    ])
    const ui = new WebRenderer()
    // Closing the wallet picker cancels its login promise silently, so kit.login() would never
    // settle and the sign-in button would spin forever. Hear the close here.
    const addCancelable = ui.addCancelablePromise
    ui.addCancelablePromise = (cancel: (reason?: string, silent?: boolean) => unknown) =>
      addCancelable((reason?: string, silent?: boolean) => {
        onPickerClosed?.()
        return cancel(reason, silent)
      })
    // Auto-sign on a second device adds that device's key next to the first one's; WharfKit would
    // otherwise ask whether to replace it, which quietly turns auto-sign off on the other device.
    ui.onSessionKeyConflict = async () => 'add'
    const whitelist = whitelistOf(savedActions())
    return new SessionKit(
      {
        appName: APP_NAME,
        chains: [ChainDefinition.from({ id: CHAIN_ID, url: endpointPool.next() })],
        ui,
        walletPlugins: [new cloudWallet.WalletPluginCloudWallet(), new anchor.WalletPluginAnchor()]
      },
      // Session keys are an option of the kit, not one of its arguments.
      whitelist.length ? { sessionKey: { permission: AUTO_SIGN_PERMISSION, whitelist } } : {}
    )
  })()
  kit.catch(() => {
    kit = null
  })
  return kit
}

export function preloadWallet() {
  void getKit().catch(() => undefined)
}

function hasStoredSession(): boolean {
  try {
    return localStorage.getItem(STORED_SESSION_KEY) !== null
  } catch {
    return true
  }
}

export function isUserCancel(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /cancel|closed|rejected by user|user rejected|denied/i.test(message)
}

export async function restoreSession(): Promise<Session | undefined> {
  if (!hasStoredSession()) return undefined
  const k = await getKit()
  try {
    current = await k.restore()
  } catch {
    current = undefined
  }
  // Auto-sign may have been changed or turned off in another browser: let the chain decide.
  if (current) void matchChain(current)
  return current
}

let onPickerClosed: (() => void) | null = null

/** Opens the wallet picker. Resolves to undefined if the user cancels or closes it. */
export async function login(): Promise<Session | undefined> {
  const k = await getKit()
  const closed = new Promise<undefined>((resolve) => {
    onPickerClosed = () => resolve(undefined)
  })
  try {
    const result = await Promise.race([k.login(), closed])
    if (!result) return undefined
    current = result.session
    return result.session
  } catch (err) {
    if (isUserCancel(err)) return undefined
    throw err
  } finally {
    onPickerClosed = null
  }
}

export async function logout(): Promise<void> {
  const k = await getKit()
  await k.logout(current)
  current = undefined
}

/** The wallet the player signed in with; with auto-sign on, the one the session key wraps. */
export function walletId(): string | null {
  if (!current) return null
  const plugin = current.walletPlugin as typeof current.walletPlugin & { getPrimaryWallet?: () => { id: string } }
  return plugin.getPrimaryWallet ? plugin.getPrimaryWallet().id : plugin.id
}

/** Wallets that may not mine, as on WAX Mission Control. */
const NO_MINING_WALLETS = ['anchor']
export const MINING_BLOCKED_MESSAGE = 'Mining is not available with Anchor. Sign in with WAX Cloud Wallet to mine.'
export const canMine = (wallet: string | null) => !wallet || !NO_MINING_WALLETS.includes(wallet)

export function permission(): string {
  return current ? String(current.permission) : 'active'
}

/** Turns a wallet/chain error into the message users should see. */
export function formatTransactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const message = raw
    .replace(/^.*assertion failure with message:\s*/i, '')
    .replace(/\s*- 3\s*$/, '')
    .trim()
  if (!message) return 'Transaction failed'
  return message.charAt(0).toUpperCase() + message.slice(1)
}

export async function transact(actions: AnyAction[]): Promise<string> {
  const session = current ?? (await restoreSession())
  if (!session) throw new Error('Connect a wallet first')
  // The last guard against mining with Anchor, whatever the screen allowed (auto-sign included).
  if (!canMine(walletId()) && actions.some((a) => String(a.account) === 'm.federation' && String(a.name) === 'mine')) {
    throw new Error(MINING_BLOCKED_MESSAGE)
  }
  const opts = { broadcast: true, expireSeconds: 120 }
  const keyed = signsWithKey(session, actions)
  try {
    const result = await session.transact({ actions }, opts)
    return String(result.resolved?.transaction.id ?? '')
  } catch (err) {
    // This browser's key was turned down: taken away in another browser, or the action unlinked
    // there. Bring this browser in line with the chain and send the same transaction once more
    // through the wallet.
    if (!keyed || !isAuthorityError(err)) throw err
    await matchChain(session)
    const result = await (await walletOnly(session)).transact({ actions }, opts)
    return String(result.resolved?.transaction.id ?? '')
  }
}

// ---- Auto-signing (WharfKit session keys) ----------------------------------------------------------

/** The session-key wallet WharfKit puts in front of the player's wallet once auto-sign is set up here. */
type SessionKeyWallet = { allActionsWhitelisted: (actions: AnyAction[]) => boolean }
const sessionKeyWallet = () => {
  const w = current?.walletPlugin as unknown as Partial<SessionKeyWallet> | undefined
  return typeof w?.allActionsWhitelisted === 'function' ? (w as SessionKeyWallet) : null
}

/** Whether auto-sign is set up in this browser for the signed-in account. */
export const autoSignOn = () => !!sessionKeyWallet()

/** Whether the deck signs these actions by itself (no wallet prompt): every one of them is ticked for auto-sign. */
export function signsByItself(actions: AnyAction[]): boolean {
  try {
    return !!sessionKeyWallet()?.allActionsWhitelisted(actions)
  } catch {
    return false
  }
}

async function currentSession(): Promise<Session> {
  const session = current ?? (await restoreSession())
  if (!session) throw new Error('Connect a wallet first')
  return session
}

export type AutoSignState = 'active' | 'inactive' | 'mismatch' | 'not-setup'

export interface AutoSignStatus {
  state: AutoSignState
  /** The session key's public key, once one is set up. */
  publicKey?: string
}

/** Whether auto-signing is on for the signed-in account, and in step with the actions picked here. */
export async function autoSignStatus(): Promise<AutoSignStatus> {
  const session = await currentSession()
  // What another browser changed shows here as it is on the chain.
  await matchChain(session)
  const status = await session.getSessionKeyStatus()
  return { state: status.state, publicKey: status.publicKey }
}

/** Creates the session key and links it to the picked actions: one wallet signature. */
export async function enableAutoSign(): Promise<void> {
  const session = await currentSession()
  await session.setupSessionKey()
}

/** Brings the on-chain links in line with the picked actions: one wallet signature. */
export async function syncAutoSign(): Promise<void> {
  const session = await currentSession()
  await session.updateSessionKeyLinks()
}

/** Removes the session key from the account: one wallet signature. */
export async function disableAutoSign(): Promise<void> {
  const session = await currentSession()
  await session.removeSessionKey()
}

/** After the picked actions change: the kit is built again with them and the session restored under it. */
export async function reloadAutoSign(): Promise<void> {
  kit = null
  current = undefined
  await restoreSession()
}
