import { useMemo, useState } from 'react'

import { depositAction, withdrawBalanceAction } from '@/chain/actions/pd'
import { CONTRACTS } from '@/chain/config'
import { useGameBalance, usePlayer } from '@/data/game'
import { useSwapPools, type SwapPools } from '@/data/market'
import { DECIMALS, quantityOf, type BalanceSymbol } from '@/lib/deposit'
import { formatNumber, percent } from '@/lib/format'
import { midPrice, quoteRoute, swapExactInAction, type Pool, type Route } from '@/lib/pool'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * Swap and the game balance on one page, as on the old deck (its Swap page and its Game balance
 * dialog). Swap: WAX, TLM and DEF on Alcor, the direct pool or the two-pool route through the third
 * token, whichever returns more, with a minimum received the pools must meet. Game balance: TLM and
 * DEF deposited with core.pdef, where joins take their entry fees from; withdrawn with `withdrawbal`.
 */

type Token = 'WAX' | 'TLM' | 'DEF'
const TOKENS: Token[] = ['WAX', 'TLM', 'DEF']
const LOGO: Record<Token, string> = { WAX: './img/Logo_token_WAX.png', TLM: './img/Logo_token_TLM.png', DEF: './img/Logo_token_DEF.webp' }
const SLIPPAGES = [0.005, 0.01, 0.02]

/** The pool between two tokens. */
function poolFor(pools: SwapPools, a: Token, b: Token): Pool {
  const pair = [a, b].sort().join('/')
  return pair === 'DEF/WAX' ? pools.def : pair === 'TLM/WAX' ? pools.tlm : pools.tlmdef
}

/** Direct, and through the third token: whichever returns more first. */
function routesFor(pools: SwapPools, from: Token, to: Token, amount: number): Route[] {
  const via = TOKENS.find((t) => t !== from && t !== to)!
  return [quoteRoute([poolFor(pools, from, to)], from, amount), quoteRoute([poolFor(pools, from, via), poolFor(pools, via, to)], from, amount)].sort(
    (x, y) => y.out - x.out
  )
}

/** Mid-market rate of a route (no fee, no size), to show the price impact. */
function midRate(route: Route): number {
  let rate = 1
  route.pools.forEach((p, i) => {
    const aPerB = midPrice(p)
    rate *= p.a.symbol === route.path[i] ? aPerB : 1 / aPerB
  })
  return rate
}

const parse = (text: string) => Math.max(0, Number(text.replace(',', '.')) || 0)

function Coin({ t }: { t: Token }) {
  return <img className="sw__logo" src={LOGO[t]} alt="" />
}

function TokenPicker({ value, onChange }: { value: Token; onChange: (t: Token) => void }) {
  return (
    <span className="seg sw__tokens">
      {TOKENS.map((t) => (
        <button key={t} type="button" className={value === t ? 'is-on' : ''} onClick={() => onChange(t)}>
          <Coin t={t} /> {t}
        </button>
      ))}
    </span>
  )
}

export function Swap({ account, spectating }: { account: string; spectating: boolean }) {
  return (
    <main className="sw wrap">
      <SwapCard account={account} spectating={spectating} />
      <GameBalanceCard account={account} spectating={spectating} />
    </main>
  )
}

function SwapCard({ account, spectating }: { account: string; spectating: boolean }) {
  const { run, pending } = useTransaction()
  const player = usePlayer(account)
  const pools = useSwapPools()
  const [from, setFrom] = useState<Token>('TLM')
  const [to, setTo] = useState<Token>('WAX')
  const [text, setText] = useState('1000')
  const [slippage, setSlippage] = useState(0.01)

  const amount = parse(text)
  const routes = useMemo(() => (pools.data && from !== to && amount > 0 ? routesFor(pools.data, from, to, amount) : []), [pools.data, from, to, amount])

  if (!pools.data || !player.data) return <section className="box sw__card muted">{pools.isError ? 'The Alcor pools could not be read.' : 'Reading Alcor…'}</section>

  const balance: Record<Token, number> = { WAX: player.data.wax, TLM: player.data.tlm, DEF: player.data.def }
  const best = routes[0]
  const impact = best ? 1 - best.rate / midRate(best) : 0
  const minOut = best ? best.out * (1 - slippage) : 0
  const tooMuch = amount > balance[from]
  const pick = (side: 'from' | 'to', t: Token) => {
    if (side === 'from') {
      if (t === to) setTo(from)
      setFrom(t)
    } else {
      if (t === from) setFrom(to)
      setTo(t)
    }
  }
  // Every pair's current rate, for the reference strip.
  const rates = TOKENS.flatMap((a) => TOKENS.filter((b) => b !== a).map((b) => ({ a, b, r: routesFor(pools.data!, a, b, 1)[0] })))

  return (
    <section className="box sw__card">
      <h3 className="h">
        Swap
        <small>on Alcor</small>
      </h3>

      <div className="sw__side">
        <div className="sw__top">
          <span className="muted">You pay</span>
          <button type="button" className="h__link" onClick={() => setText(String(Math.floor(balance[from] * 1e4) / 1e4))}>
            {formatNumber(balance[from], 4)} in wallet · max
          </button>
        </div>
        <input className="input sw__amount" inputMode="decimal" aria-label="Amount to pay" value={text} onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))} />
        <TokenPicker value={from} onChange={(t) => pick('from', t)} />
      </div>

      <button
        type="button"
        className="sw__flip"
        aria-label="Swap direction"
        onClick={() => {
          setFrom(to)
          setTo(from)
          if (best) setText(String(Number(best.out.toFixed(4))))
        }}
      >
        ⇅
      </button>

      <div className="sw__side">
        <div className="sw__top">
          <span className="muted">You receive</span>
          <span className="muted">{formatNumber(balance[to], 4)} in wallet</span>
        </div>
        <b className="sw__out">{best ? formatNumber(best.out, 4) : '0'}</b>
        <TokenPicker value={to} onChange={(t) => pick('to', t)} />
      </div>

      {best && (
        <dl className="sw__details">
          <dt>Rate</dt>
          <dd>
            1 {from} = {formatNumber(best.rate, best.rate < 1 ? 6 : 4)} {to}
          </dd>
          <dt title="The direct pool, or through the third token when the two pools together give more.">Route</dt>
          <dd>{best.path.join(' → ')}</dd>
          {routes[1] && (
            <>
              <dt className="muted">Other route</dt>
              <dd className="muted">
                {routes[1].path.join(' → ')}: {formatNumber(routes[1].out, 4)} ({percent(routes[1].out / best.out - 1, 2)})
              </dd>
            </>
          )}
          <dt title="How much worse than the pools' mid price this swap fills, pool fees included.">Price impact</dt>
          <dd className={impact > 0.03 ? 'c-bad' : ''}>{percent(Math.max(0, impact), 2)}</dd>
          <dt>Slippage</dt>
          <dd>
            <span className="seg sw__slip">
              {SLIPPAGES.map((s) => (
                <button key={s} type="button" className={slippage === s ? 'is-on' : ''} onClick={() => setSlippage(s)}>
                  {percent(s, s < 0.01 ? 1 : 0)}
                </button>
              ))}
            </span>
          </dd>
          <dt title="The swap is refused if the pools move and it would return less than this.">Minimum received</dt>
          <dd>
            {formatNumber(minOut, 4)} {to}
          </dd>
        </dl>
      )}

      <button
        type="button"
        className="btn btn--go sw__go"
        disabled={!best || tooMuch || spectating || !!pending}
        onClick={() =>
          void run((a, p) => [swapExactInAction(a, p, best!, amount, minOut)], `Swapped ${formatNumber(amount, 4)} ${from} for about ${formatNumber(best!.out, 4)} ${to}`, 'swap')
        }
      >
        {pending === 'swap' ? 'Swapping…' : tooMuch ? `Not enough ${from}` : `Swap ${from} → ${to}`}
      </button>
      {spectating && <p className="help">Read-only: connect your own wallet to swap.</p>}

      <div className="sw__rates">
        {rates.map(({ a, b, r }) => (
          <button
            key={a + b}
            type="button"
            className={a === from && b === to ? 'is-on' : ''}
            onClick={() => {
              setFrom(a)
              setTo(b)
            }}
          >
            <span>
              {a} → {b}
            </span>
            <b>{formatNumber(r.rate, r.rate < 1 ? 5 : 3)}</b>
          </button>
        ))}
      </div>
    </section>
  )
}

const SYMBOLS: BalanceSymbol[] = ['TLM', 'DEF']
const TOKEN_CONTRACT: Record<BalanceSymbol, string> = { TLM: CONTRACTS.TLM, DEF: CONTRACTS.DEF }
const keyOf = (s: BalanceSymbol) => (s === 'TLM' ? 'tlm' : 'def')
/** Round down to what the token can hold, so Max never asks for a fraction too many. */
const floorTo = (n: number, s: BalanceSymbol) => Math.floor(n * 10 ** DECIMALS[s] + 1e-6) / 10 ** DECIMALS[s]

function GameBalanceCard({ account, spectating }: { account: string; spectating: boolean }) {
  const { run, pending } = useTransaction()
  const player = usePlayer(account)
  const game = useGameBalance(account)
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')
  const [symbol, setSymbol] = useState<BalanceSymbol>('TLM')
  const [text, setText] = useState('')

  const wallet = player.data ? { tlm: player.data.tlm, def: player.data.def } : null
  const inGame = game.data ?? null
  const available = (mode === 'deposit' ? wallet : inGame)?.[keyOf(symbol)] ?? 0
  const amount = floorTo(parse(text), symbol)
  const error = text && amount <= 0 ? 'Enter an amount above zero.' : amount > available + 1e-12 ? `Only ${formatNumber(available, 4)} ${symbol} available.` : null
  const busy = pending === 'game-balance'

  async function submit() {
    if (amount <= 0 || error || busy) return
    const quantity = quantityOf(amount, symbol)
    const ok = await run(
      (a, p) => [mode === 'deposit' ? depositAction(a, p, TOKEN_CONTRACT[symbol], quantity) : withdrawBalanceAction(a, p, quantity)],
      mode === 'deposit' ? `${quantity} deposited to the game` : `${quantity} withdrawn to your wallet`,
      'game-balance'
    )
    if (ok) {
      setText('')
      void game.refetch()
    }
  }

  return (
    <section className="box sw__card">
      <h3 className="h">
        Game balance
        <small>core.pdef</small>
      </h3>
      <p className="help sw__lead">
        Entry fees are taken from here when a division joins a mission, so the loop does not send new TLM or DEF every cycle. Rewards still go to your wallet.
        Withdraw what is left at any time.
      </p>

      <div className="sw__balances">
        {SYMBOLS.map((s) => (
          <button key={s} type="button" className={`sw__bal${symbol === s ? ' is-on' : ''}`} aria-pressed={symbol === s} onClick={() => setSymbol(s)}>
            <span className="sw__sym">
              <Coin t={s} /> {s}
            </span>
            <span className="sw__row">
              <small>In the game</small>
              <b>{inGame ? formatNumber(inGame[keyOf(s)], 4) : '–'}</b>
            </span>
            <span className="sw__row muted">
              <small>In the wallet</small>
              <span>{wallet ? formatNumber(wallet[keyOf(s)], 4) : '–'}</span>
            </span>
          </button>
        ))}
      </div>

      <span className="seg seg--pick">
        <button type="button" className={mode === 'deposit' ? 'is-on' : ''} onClick={() => setMode('deposit')}>
          Deposit
        </button>
        <button type="button" className={mode === 'withdraw' ? 'is-on' : ''} onClick={() => setMode('withdraw')}>
          Withdraw
        </button>
      </span>

      <label className="sw__form">
        <span className="sw__top">
          <span className="muted">Amount</span>
          <button type="button" className="h__link" onClick={() => setText(String(floorTo(available, symbol)))}>
            {formatNumber(available, 4)} {mode === 'deposit' ? 'in the wallet' : 'in the game'} · max
          </button>
        </span>
        <input
          className="input sw__amount"
          inputMode="decimal"
          placeholder={`0 ${symbol}`}
          value={text}
          onChange={(e) => setText(e.target.value.replace(/[^\d.,]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {error && <small className="c-bad">{error}</small>}
      </label>

      <button type="button" className="btn btn--go sw__go" disabled={spectating || amount <= 0 || !!error || !!pending} onClick={() => void submit()}>
        {busy ? (mode === 'deposit' ? 'Depositing…' : 'Withdrawing…') : `${mode === 'deposit' ? 'Deposit' : 'Withdraw'} ${amount > 0 ? `${formatNumber(amount, 4)} ${symbol}` : symbol}`}
      </button>
      {spectating && <p className="help">Read-only: connect your own wallet to deposit or withdraw.</p>}
    </section>
  )
}
