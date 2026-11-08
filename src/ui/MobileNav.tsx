import { useEffect, useState } from 'react'

import { useField } from '@/lib/useField'

import { Icon, type IconName } from './icons'

/*
 * The phone's menu: a tab bar at the bottom, under the thumb, with the four pages used most
 * (Divisions, Missions, Campaigns, Swap) and More, which slides up a sheet with every other page,
 * couch mode and Settings. Missions carries a badge with the divisions that are back. Shown only on
 * narrow screens (in CSS); the top menu strip is hidden there in its place.
 */

export type NavPage = 'divisions' | 'missions' | 'campaigns' | 'forge' | 'market' | 'blend' | 'swap' | 'ledger' | 'settings' | 'couch'

const TABS: [NavPage, string, IconName][] = [
  ['divisions', 'Divisions', 'army'],
  ['missions', 'Missions', 'rocket'],
  ['campaigns', 'Campaigns', 'flag'],
  ['swap', 'Swap', 'wallet']
]
const MORE: [NavPage, string, IconName, string][] = [
  ['market', 'Market', 'cart', 'Buy and upgrade'],
  ['forge', 'Forge', 'flame', 'Levels and slots'],
  ['blend', 'Blend', 'spark', 'Blend new cards'],
  ['ledger', 'Ledger', 'ledger', 'Spent, earned, token flow']
]
const ALSO: [NavPage, string, IconName][] = [
  ['couch', 'Couch mode', 'sofa'],
  ['settings', 'Settings', 'gear']
]

/** Divisions back and waiting for the loop, for the Missions badge. */
function BackBadge({ account }: { account: string }) {
  const f = useField(account)
  const n = f.ready.length
  return n ? <span className="mnav__badge">{n}</span> : null
}

export function MobileNav({ page, account, onPage }: { page: NavPage; account: string; onPage: (p: NavPage) => void }) {
  const [open, setOpen] = useState(false)
  const inMore = !TABS.some(([p]) => p === page)
  const go = (p: NavPage) => {
    setOpen(false)
    onPage(p)
  }
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [open])

  return (
    <>
      <nav className="mnav" aria-label="Main">
        {TABS.map(([p, label, icon]) => (
          <button key={p} type="button" className={`mnav__tab${page === p ? ' is-on' : ''}`} aria-current={page === p ? 'page' : undefined} onClick={() => go(p)}>
            <span className="mnav__pill">
              <Icon name={icon} size={19} />
            </span>
            {label}
            {p === 'missions' && <BackBadge account={account} />}
          </button>
        ))}
        <button type="button" className={`mnav__tab${inMore || open ? ' is-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
          <span className="mnav__pill">
            <Icon name="more" size={19} />
          </span>
          More
        </button>
      </nav>

      <div className={`mnav__scrim${open ? ' is-open' : ''}`} onClick={() => setOpen(false)} />
      <section className={`mnav__sheet${open ? ' is-open' : ''}`} role="dialog" aria-label="More pages" aria-hidden={!open}>
        <span className="mnav__grab" aria-hidden="true" />
        <div className="mnav__tiles">
          {MORE.map(([p, label, icon, note]) => (
            <button key={p} type="button" className={`mnav__tile${page === p ? ' is-on' : ''}`} tabIndex={open ? 0 : -1} onClick={() => go(p)}>
              <Icon name={icon} size={22} />
              <b>{label}</b>
              <small>{note}</small>
            </button>
          ))}
        </div>
        <div className="mnav__sub">Also</div>
        <div className="mnav__tiles is-also">
          {ALSO.map(([p, label, icon]) => (
            <button key={p} type="button" className={`mnav__tile${page === p ? ' is-on' : ''}`} tabIndex={open ? 0 : -1} onClick={() => go(p)}>
              <Icon name={icon} size={22} />
              <b>{label}</b>
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
