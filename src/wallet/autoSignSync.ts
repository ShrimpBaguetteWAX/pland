import type { AnyAction, Session } from '@wharfkit/session'

import { AUTO_SIGN_PERMISSION, saveActions } from './autoSign'

/*
 * Keeping this browser's auto-signing true to the chain.
 *
 * Auto-signing can be on in several browsers at once: each keeps its own key, and every key sits
 * under the one pdauto permission on the account, linked to one shared list of actions. So any
 * browser can change what the others may sign, or take their key away, and a browser that only
 * believed what it stored would go on signing with a key or an action the chain no longer accepts:
 * every auto-signed transaction failing until the player found the switch.
 *
 * So the chain decides: when the session is restored, before Settings shows the status, and after
 * the chain turns a key's signature down. A key the permission no longer holds is dropped (back to
 * the wallet for everything); the actions it may sign are the ones still linked on the chain.
 */

export interface ChainPermission {
  /** Its keys, in one spelling, so they compare as strings. */
  keys: string[]
  /** The linked actions, as "contract::action". */
  links: string[]
}

export interface AutoSignReading {
  /** Whether this browser holds a key the chain still accepts. */
  active: boolean
  /** Whether the permission is on the account at all. */
  exists: boolean
  /** The actions linked on the chain, shared by every device. */
  links: string[]
}

/** What this browser should believe, from what it holds and what the chain says. */
export function reconcile(localKey: string | null, chain: ChainPermission | null): AutoSignReading {
  return { active: !!localKey && !!chain && chain.keys.includes(localKey), exists: !!chain, links: chain?.links ?? [] }
}

const wharf = () => import('@wharfkit/session')

/*
 * A key added a moment ago is not on every node yet: the read that follows the setup can come from
 * a node a few blocks behind, which still shows the permission without it. Believing that read
 * threw the brand-new key away, so "Add this device" never stuck. Two guards: a key set up in this
 * browser in the last few minutes is kept whatever a read says, and a key missing from a read is
 * only dropped when it is still missing on a second and a third read a little later.
 */
const JUST_SET_UP = 'pd-army.autosign.setupAt'
const GRACE_MS = 5 * 60_000
const RECHECKS = [2_000, 4_000]

/** Called right after this browser's key was set up (or added next to another device's). */
export function markJustSetUp() {
  try {
    localStorage.setItem(JUST_SET_UP, String(Date.now()))
  } catch {
    /* storage blocked: the re-reads below still protect the new key */
  }
}
function setUpRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(JUST_SET_UP) ?? 0)
    return at > 0 && Date.now() - at < GRACE_MS
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function normaliseKey(key: unknown): Promise<string> {
  const { PublicKey } = await wharf()
  return String(PublicKey.from(String(key)))
}

/** The pdauto permission off the account; null when it is not there. Throws when the node does. */
export async function readPermission(session: Session): Promise<ChainPermission | null> {
  const account = await session.client.v1.chain.get_account(session.actor)
  const perm = account.permissions.find((p) => String(p.perm_name) === AUTO_SIGN_PERMISSION)
  if (!perm) return null
  const raw = perm as unknown as {
    required_auth: { keys: { key: unknown }[] }
    linked_actions?: { account: unknown; action?: unknown }[]
  }
  return {
    keys: await Promise.all(raw.required_auth.keys.map((k) => normaliseKey(k.key))),
    links: (raw.linked_actions ?? []).map((l) => `${String(l.account)}::${String(l.action ?? '')}`)
  }
}

type KeyWallet = {
  getPublicKey: () => unknown
  getPrimaryWallet: () => unknown
  whitelist: unknown
}
const keyWallet = (session: Session): KeyWallet | null => {
  const w = session.walletPlugin as unknown as Partial<KeyWallet>
  return typeof w.getPublicKey === 'function' && typeof w.getPrimaryWallet === 'function' ? (w as KeyWallet) : null
}

/**
 * Brings this browser in line with the chain and says where it stands. Returns null, changing
 * nothing, when the chain can't be read: a node that doesn't answer is no reason to switch a
 * player's auto-signing off.
 */
export async function syncAutoSign(session: Session): Promise<AutoSignReading | null> {
  let chain: ChainPermission | null
  try {
    chain = await readPermission(session)
  } catch {
    return null
  }
  const plugin = keyWallet(session)
  const mine = plugin ? await normaliseKey(plugin.getPublicKey()) : null
  let reading = reconcile(mine, chain)
  // This browser holds a key the read does not show: just set up, or a node behind? Ask again
  // before dropping it, and never drop one set up in the last few minutes.
  if (mine && !reading.active) {
    for (const wait of RECHECKS) {
      if (setUpRecently()) break
      await sleep(wait)
      try {
        chain = await readPermission(session)
      } catch {
        return null
      }
      reading = reconcile(mine, chain)
      if (reading.active) break
    }
    if (!reading.active && setUpRecently()) reading = { ...reading, active: true, exists: true }
  }
  // WharfKit compares whitelist entries with .equals, so they must be its Name objects.
  const { Name } = await wharf()
  const byContract = new Map<string, string[]>()
  for (const k of reading.links) {
    const [contract, action] = k.split('::')
    byContract.set(contract, [...(byContract.get(contract) ?? []), ...(action ? [action] : [])])
  }
  const list = [...byContract].map(([contract, actions]) => ({
    contract: Name.from(contract),
    actions: actions.map((a) => Name.from(a))
  }))

  if (plugin) {
    if (reading.active) plugin.whitelist = list
    // Taken away in another browser: back to the wallet for everything, as WharfKit does on removal.
    else (session as unknown as { _walletPlugin: unknown })._walletPlugin = plugin.getPrimaryWallet()
    await (session as unknown as { onPersist?: (s: Session) => Promise<void> }).onPersist?.(session)
  }
  const manager = (session as unknown as { sessionKeyManager?: { whitelist: unknown } }).sessionKeyManager
  if (manager && reading.exists) manager.whitelist = list
  // What Settings shows and the next setup starts from: the shared list, not this browser's memory.
  if (reading.exists) saveActions(reading.links)
  return reading
}

/** Whether the chain turned down who signed (a key no longer on the permission, an action unlinked). */
export function isAuthorityError(err: unknown): boolean {
  let text: string
  try {
    text = JSON.stringify(err) + String((err as { message?: unknown })?.message ?? err)
  } catch {
    text = String(err)
  }
  return /unsatisfied_authorization|irrelevant_auth|missing_auth|missing required authority|do not satisfy declared authorit|provided keys, permissions, and delays/i.test(
    text
  )
}

/** Whether this transaction will be signed by this browser's key. */
export function signsWithKey(session: Session, actions: AnyAction[]): boolean {
  const w = session.walletPlugin as unknown as { allActionsWhitelisted?: (a: AnyAction[]) => boolean }
  try {
    return !!w.allActionsWhitelisted?.(actions)
  } catch {
    return false
  }
}

/** The same account through the wallet alone, for a transaction the key may not sign. */
export async function walletOnly(session: Session): Promise<Session> {
  const plugin = keyWallet(session)
  if (!plugin) return session
  const { Session: S } = await wharf()
  const s = session as unknown as { chain: unknown; permissionLevel: unknown; fetch: unknown; ui: unknown }
  return new S(
    { chain: s.chain, permissionLevel: s.permissionLevel, walletPlugin: plugin.getPrimaryWallet() } as ConstructorParameters<
      typeof S
    >[0],
    { fetch: s.fetch, ui: s.ui } as ConstructorParameters<typeof S>[1]
  )
}
