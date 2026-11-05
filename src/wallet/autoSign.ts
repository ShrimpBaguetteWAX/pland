import { CONTRACTS } from '@/chain/config'

/*
 * Auto-signing with WharfKit session keys. A session key is a key the deck generates in this
 * browser and adds to the player's account under its own permission, linked (linkauth) to the
 * game actions the player picks here. Transactions made only of those actions are then signed by
 * the deck without a wallet prompt; anything else still goes to the wallet. Setting it up, changing
 * the actions and turning it off each take one wallet signature.
 */

/** The permission the session key lives under on the player's account. */
export const AUTO_SIGN_PERMISSION = 'pdauto'

export interface AutoAction {
  contract: string
  action: string
  label: string
  /** Why this one deserves a second thought before allowing it. */
  warning?: string
}

export interface AutoGroup {
  title: string
  actions: AutoAction[]
}

export const AUTO_GROUPS: AutoGroup[] = [
  {
    title: 'Missions',
    actions: [
      { contract: CONTRACTS.MISSIONS, action: 'join', label: 'Send a division on a mission' },
      { contract: CONTRACTS.MISSIONS, action: 'claim', label: 'Claim a mission’s reward' }
    ]
  },
  {
    title: 'Campaigns',
    actions: [
      { contract: CONTRACTS.SIEGE, action: 'joindiv', label: 'Send a division to a campaign' },
      { contract: CONTRACTS.SIEGE, action: 'claimdiv', label: 'Bring a division back from a campaign' }
    ]
  },
  {
    title: 'Divisions',
    actions: [
      { contract: CONTRACTS.CORE, action: 'creatediv', label: 'Create a division under a warlord' },
      { contract: CONTRACTS.CORE, action: 'addunit', label: 'Add a mercenary to a division' },
      { contract: CONTRACTS.CORE, action: 'removeunit', label: 'Take a mercenary out of a division' },
      { contract: CONTRACTS.CORE, action: 'assign', label: 'Equip gear on a mercenary' },
      { contract: CONTRACTS.CORE, action: 'unassign', label: 'Take gear off a mercenary' },
      { contract: CONTRACTS.CORE, action: 'deldvasset', label: 'Disband an empty division' },
      { contract: CONTRACTS.CORE, action: 'calcdiv', label: 'Refresh a division’s stats before it joins' },
      { contract: CONTRACTS.CORE, action: 'unstake', label: 'Unstake an NFT back to your wallet' },
      { contract: CONTRACTS.CORE, action: 'regplayer', label: 'Register as a player (first action only)' }
    ]
  },
  {
    title: 'Game balance',
    actions: [
      { contract: CONTRACTS.CORE, action: 'withdrawbal', label: 'Withdraw TLM or DEF from the game balance to your wallet' }
    ]
  },
  {
    title: 'Mining',
    actions: [
      { contract: CONTRACTS.MINING, action: 'mine', label: 'Mine with the Mine button' },
      { contract: CONTRACTS.MINING, action: 'setland', label: 'Move to the favourite land the Mine button picks' },
      { contract: CONTRACTS.MC_CPU, action: 'paycpu', label: 'Let Mission Control pay the CPU for a mine' }
    ]
  },
  {
    title: 'Market',
    actions: [{ contract: 'atomicmarket', action: 'cancelsale', label: 'Take one of your listings off the market' }]
  },
  {
    title: 'DEF',
    actions: [
      {
        contract: CONTRACTS.DEF,
        action: 'transfer',
        label: 'Send DEF: mission entry fees, Forge slots, game balance deposits, campaign funding',
        warning: 'A permission for DEF transfers is not limited to the game: whoever holds the key could send your DEF anywhere.'
      }
    ]
  }
]

/*
 * Never offered: TLM, WAX and NFT transfers (staking, blends, ascension, market purchases and
 * listings, swaps on Alcor, Forge levels). A transaction with one of those always asks the wallet.
 */

/** Every action that may be auto-signed. */
const ALLOWED = new Set(AUTO_GROUPS.flatMap((g) => g.actions.map((a) => `${a.contract}::${a.action}`)))

/** Without a choice saved: everything except moving DEF. */
const DEFAULT = [...ALLOWED].filter((k) => k !== `${CONTRACTS.DEF}::transfer`)

/** Actions the first version of this page offered: anything else is new and starts ticked. */
const OFFERED_V1 = new Set([
  'miss.pdef::join',
  'miss.pdef::claim',
  'siege.pdef::joindiv',
  'siege.pdef::claimdiv',
  'core.pdef::calcdiv',
  'core.pdef::regplayer',
  'm.federation::mine',
  'm.federation::setland',
  'cpu.mc::paycpu',
  'alien.worlds::transfer',
  'defensetoken::transfer'
])

const STORE = 'pd:autosign:actions:v2'
const STORE_V1 = 'pd:autosign:actions'

export const actionKey = (a: { contract: string; action: string }) => `${a.contract}::${a.action}`

/** The actions picked in this browser, as "contract::action", limited to what may be auto-signed. */
export function savedActions(): string[] {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) return (JSON.parse(raw) as string[]).filter((k) => ALLOWED.has(k))
    // A choice from the first version: kept, minus TLM transfers, plus the actions added since.
    const old = localStorage.getItem(STORE_V1)
    if (old) {
      const kept = (JSON.parse(old) as string[]).filter((k) => ALLOWED.has(k))
      return [...new Set([...kept, ...DEFAULT.filter((k) => !OFFERED_V1.has(k))])]
    }
  } catch {
    // Blocked storage: the defaults.
  }
  return DEFAULT
}

export function saveActions(keys: string[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(keys))
  } catch {
    // Storage blocked: the choice lasts until the page is reloaded.
  }
}

/** The picked actions as WharfKit's whitelist: one entry per contract with its actions. */
export function whitelistOf(keys: string[]): { contract: string; actions: string[] }[] {
  const byContract = new Map<string, string[]>()
  for (const key of keys) {
    const [contract, action] = key.split('::')
    if (!contract || !action) continue
    byContract.set(contract, [...(byContract.get(contract) ?? []), action])
  }
  return [...byContract].map(([contract, actions]) => ({ contract, actions }))
}
