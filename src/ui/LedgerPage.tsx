import { useState } from 'react'

import { Ledger } from './Ledger'
import { TokenFlow } from './TokenFlow'

/*
 * The Ledger menu item: two tabs, the player's own ledger and the game's token flow. Each stays
 * mounted once opened, so a flow still being read carries on while the ledger is shown.
 */
type Tab = 'ledger' | 'flow'

export function LedgerPage({ account }: { account: string }) {
  const [tab, setTab] = useState<Tab>('ledger')
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set(['ledger']))
  const open = (t: Tab) => {
    setTab(t)
    setSeen((s) => (s.has(t) ? s : new Set([...s, t])))
  }
  return (
    <>
      <nav className="lgp__tabs wrap" aria-label="Ledger views">
        <div className="lgp__seg" role="tablist">
          {(
            [
              ['ledger', 'Ledger'],
              ['flow', 'Token flow']
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'is-on' : ''} onClick={() => open(t)}>
              {label}
            </button>
          ))}
        </div>
      </nav>
      <div hidden={tab !== 'ledger'}>
        <Ledger account={account} />
      </div>
      {seen.has('flow') && (
        <div hidden={tab !== 'flow'}>
          <TokenFlow />
        </div>
      )}
    </>
  )
}
