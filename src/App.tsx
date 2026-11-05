import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { usePlayer } from '@/data/game'
import { formatNumber } from '@/lib/format'
import { useSession } from '@/state/session'

import { Army } from './ui/Army'
import { Icon, type IconName } from './ui/icons'
import { Console } from './ui/Console'
import { Missions } from './ui/Missions'
import { Toaster } from './ui/Toaster'

/*
 * The new Planetary Defense site, tabletop look. Divisions and Missions are built (Missions holds
 * what the old deck split into Missions and Deployments); the other pages are in the menu so the
 * bar reads as the finished game will, and say they are still to come.
 */

type Page = 'divisions' | 'missions'
const PAGES: Record<string, Page> = { Divisions: 'divisions', Missions: 'missions' }

const MENU: [string, IconName][] = [
  ['Divisions', 'army'],
  ['Missions', 'rocket'],
  ['Campaigns', 'flag'],
  ['Forge', 'flame'],
  ['Market', 'cart'],
  ['Blend', 'spark']
]

/**
 * Leaves read-only viewing for the player's own wallet: the ?as= account goes from the address (a
 * reload would bring it back otherwise), then the wallet opens. Cancelled, the view stays as it was.
 */
async function connectOwn(login: () => Promise<boolean>) {
  const ok = await login()
  if (!ok) return
  const url = new URL(window.location.href)
  url.searchParams.delete('as')
  window.history.replaceState(null, '', url)
}

function TopBar({ page, onPage }: { page: Page; onPage: (p: Page) => void }) {
  const { account, spectating, login, logout } = useSession(
    useShallow((s) => ({ account: s.account, spectating: s.spectating, login: s.login, logout: s.logout }))
  )
  const player = usePlayer(account)
  const p = player.data
  return (
    <header className="bar">
      <div className="bar__in wrap">
        <div className="brand">
          <span className="brand__mark">
            <Icon name="logo" size={20} width={1.8} />
          </span>
          <span className="brand__name">
            Planetary Defense
            <small>Command deck</small>
          </span>
        </div>
        <span className="bar__gap" />
        {p && (
          <div className="purse">
            <span className="coin">
              <img src="./img/Logo_token_TLM.png" alt="" />
              {formatNumber(p.tlm, 0)}
              <small>TLM</small>
            </span>
            <span className="coin">
              <img src="./img/Logo_token_DEF.webp" alt="" />
              {formatNumber(p.def, 0)}
              <small>DEF</small>
            </span>
            <span className="coin">
              <img src="./img/Logo_token_WAX.png" alt="" />
              {formatNumber(p.wax, 0)}
              <small>WAX</small>
            </span>
          </div>
        )}
        {account ? (
          <div className="me">
            <span className="me__text">
              <b>{account}</b>
              <small>{spectating ? 'Viewing read-only' : p ? `Forge level ${p.forgeLevel}` : '…'}</small>
            </span>
            {spectating ? (
              <button type="button" className="btn btn--go btn--sm" onClick={() => void connectOwn(login)}>
                <Icon name="wallet" size={16} />
                Connect wallet
              </button>
            ) : (
              <button type="button" className="btn btn--sm" onClick={() => void logout()}>
                Sign out
              </button>
            )}
          </div>
        ) : (
          <button type="button" className="btn btn--go" onClick={() => void login()}>
            <Icon name="wallet" />
            Connect wallet
          </button>
        )}
      </div>
      <nav className="menu" aria-label="Main">
        <div className="menu__in wrap">
          {MENU.map(([label, icon]) => (
            <button
              key={label}
              type="button"
              className={PAGES[label] === page ? 'is-on' : ''}
              disabled={!PAGES[label]}
              title={PAGES[label] ? undefined : `${label} comes next; use the old deck for it meanwhile`}
              onClick={() => PAGES[label] && onPage(PAGES[label])}
            >
              <Icon name={icon} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>
    </header>
  )
}

export function App() {
  const { account, restored, spectating, login } = useSession(useShallow((s) => ({ account: s.account, restored: s.restored, spectating: s.spectating, login: s.login })))
  const [page, setPage] = useState<Page>('divisions')
  return (
    <div className="app">
      <TopBar page={page} onPage={setPage} />
      {restored && account && <Console account={account} onMissions={() => setPage('missions')} />}
      {!restored ? (
        <p className="wrap muted page-msg">Opening the deck…</p>
      ) : account ? (
        page === 'missions' ? (
          <Missions account={account} spectating={spectating} />
        ) : (
          <Army account={account} />
        )
      ) : (
        <section className="wrap welcome">
          <div className="box welcome__card">
            <h1>Muster your army</h1>
            <p>Connect your wallet to build divisions, recruit mercenaries and fit them with gear.</p>
            <p className="muted">
              Or look at any army read-only by adding <code>?as=account</code> to the address.
            </p>
            <button type="button" className="btn btn--go" onClick={() => void login()}>
              <Icon name="wallet" />
              Connect wallet
            </button>
          </div>
        </section>
      )}
      <Toaster />
    </div>
  )
}
