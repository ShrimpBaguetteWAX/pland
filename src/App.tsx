import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { usePlayer, useRewardPool } from '@/data/game'
import { formatNumber } from '@/lib/format'
import { useSession } from '@/state/session'
import { useTheme } from '@/state/theme'

import { Army } from './ui/Army'
import { Icon, type IconName } from './ui/icons'
import { Blend } from './ui/Blend'
import { Campaigns } from './ui/Campaigns'
import { Console } from './ui/Console'
import { Forge } from './ui/Forge'
import { Market } from './ui/Market'
import { Settings } from './ui/Settings'
import { Missions } from './ui/Missions'
import { Swap } from './ui/Swap'
import { Toaster } from './ui/Toaster'

/*
 * The new Planetary Defense site, tabletop look. Divisions and Missions are built (Missions holds
 * what the old deck split into Missions and Deployments); the other pages are in the menu so the
 * bar reads as the finished game will, and say they are still to come.
 */

type Page = 'divisions' | 'missions' | 'campaigns' | 'forge' | 'market' | 'blend' | 'swap' | 'settings'
const PAGES: Record<string, Page> = { Divisions: 'divisions', Missions: 'missions', Campaigns: 'campaigns', Forge: 'forge', Market: 'market', Blend: 'blend', Swap: 'swap' }

const ALL_PAGES: Page[] = ['divisions', 'missions', 'campaigns', 'forge', 'market', 'blend', 'swap', 'settings']
/** The page named in the address (#missions); Divisions when there is none or it is unknown. */
function pageFromHash(): Page {
  const h = window.location.hash.replace('#', '') as Page
  return ALL_PAGES.includes(h) ? h : 'divisions'
}

const MENU: [string, IconName][] = [
  ['Divisions', 'army'],
  ['Missions', 'rocket'],
  ['Campaigns', 'flag'],
  ['Forge', 'flame'],
  ['Market', 'cart'],
  ['Blend', 'spark'],
  ['Swap', 'wallet']
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

/**
 * The wallet name in the bar, with the balances, the Forge level and Sign out (or Connect wallet,
 * when viewing another account) in a dropdown under it, so the bar itself stays quiet.
 */
function AccountMenu({
  account,
  spectating,
  balances,
  onConnect,
  onSignOut,
  onSettings,
  onSwap
}: {
  account: string
  spectating: boolean
  balances: { tlm: number; def: number; wax: number; forge: number } | null
  onConnect: () => void
  onSignOut: () => void
  onSettings: () => void
  onSwap: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pool = useRewardPool()
  const [theme, setTheme] = useTheme()
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const coins: [string, number, string][] = balances
    ? [
        ['./img/Logo_token_TLM.png', balances.tlm, 'TLM'],
        ['./img/Logo_token_DEF.webp', balances.def, 'DEF'],
        ['./img/Logo_token_WAX.png', balances.wax, 'WAX']
      ]
    : []
  return (
    <div className={`me${open ? ' is-open' : ''}`} ref={ref}>
      <button type="button" className="me__chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="me__text">
          <b>{account}</b>
          <small>{spectating ? 'Viewing read-only' : balances ? `Forge level ${balances.forge}` : '…'}</small>
        </span>
        <span className="me__chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="me__menu" role="menu">
          {coins.length ? (
            <div className="me__coins">
              {coins.map(([img, amount, sym]) => (
                <span key={sym} className="coin">
                  <img src={img} alt="" />
                  {formatNumber(amount, sym === 'WAX' ? 2 : 0)}
                  <small>{sym}</small>
                </span>
              ))}
            </div>
          ) : (
            <span className="muted">Reading the balances…</span>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setOpen(false)
              onSwap()
            }}
          >
            Swap · deposit · withdraw
          </button>
          <span className="me__pool" title="TLM the missions contract (miss.pdef) holds for player rewards right now">
            <small>Left for player rewards</small>
            <b>{pool.data === undefined ? '…' : `${formatNumber(pool.data, 0)} TLM`}</b>
          </span>
          <div className="me__theme" role="group" aria-label="Theme">
            <button type="button" className={theme === 'light' ? 'is-on' : ''} onClick={() => setTheme('light')}>
              Light
            </button>
            <button type="button" className={theme === 'dark' ? 'is-on' : ''} onClick={() => setTheme('dark')}>
              Dark
            </button>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setOpen(false)
              onSettings()
            }}
          >
            Settings
          </button>
          {spectating ? (
            <button type="button" className="btn btn--go btn--sm" onClick={onConnect}>
              <Icon name="wallet" size={16} />
              Connect wallet
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  )
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
        {account ? (
          <AccountMenu account={account} spectating={spectating} balances={p ? { tlm: p.tlm, def: p.def, wax: p.wax, forge: p.forgeLevel } : null} onConnect={() => void connectOwn(login)} onSignOut={() => void logout()} onSettings={() => onPage('settings')} onSwap={() => onPage('swap')} />
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
  // The page is in the address (#market), so a reload or a shared link opens the same page.
  const [page, setPage] = useState<Page>(pageFromHash)
  useEffect(() => {
    const want = page === 'divisions' ? '' : '#' + page
    if (window.location.hash !== want) window.history.replaceState(null, '', window.location.pathname + window.location.search + want)
    // The browser tab names the page too.
    document.title = 'Planetary Defense · ' + page.charAt(0).toUpperCase() + page.slice(1)
  }, [page])
  useEffect(() => {
    const back = () => setPage(pageFromHash())
    window.addEventListener('hashchange', back)
    return () => window.removeEventListener('hashchange', back)
  }, [])
  /** Pages opened so far this visit; each stays mounted from then on. */
  const [seen, setSeen] = useState<Set<Page>>(() => new Set([pageFromHash()]))
  useEffect(() => setSeen((s) => (s.has(page) ? s : new Set([...s, page]))), [page])
  return (
    <div className="app">
      <TopBar page={page} onPage={setPage} />
      {restored && account && <Console account={account} onMissions={() => setPage('missions')} />}
      {!restored ? (
        <p className="wrap muted page-msg">Opening the deck…</p>
      ) : account ? (
        /* A page stays mounted once opened and is only hidden when another is shown, so whatever it
           is doing (an optimizer search, a market scan, a plan) carries on and is still there on return. */
        <>
          {seen.has('divisions') && (
            <div className="page" hidden={page !== 'divisions'}>
              <Army account={account} />
            </div>
          )}
          {seen.has('missions') && (
            <div className="page" hidden={page !== 'missions'}>
              <Missions account={account} spectating={spectating} />
            </div>
          )}
          {seen.has('campaigns') && (
            <div className="page" hidden={page !== 'campaigns'}>
              <Campaigns account={account} spectating={spectating} />
            </div>
          )}
          {seen.has('market') && (
            <div className="page" hidden={page !== 'market'}>
              <Market account={account} spectating={spectating} onMissions={() => setPage('missions')} />
            </div>
          )}
          {seen.has('blend') && (
            <div className="page" hidden={page !== 'blend'}>
              <Blend account={account} spectating={spectating} />
            </div>
          )}
          {seen.has('swap') && (
            <div className="page" hidden={page !== 'swap'}>
              <Swap account={account} spectating={spectating} />
            </div>
          )}
          {seen.has('settings') && (
            <div className="page" hidden={page !== 'settings'}>
              <Settings />
            </div>
          )}
          {seen.has('forge') && (
            <div className="page" hidden={page !== 'forge'}>
              <Forge account={account} spectating={spectating} />
            </div>
          )}
        </>
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
