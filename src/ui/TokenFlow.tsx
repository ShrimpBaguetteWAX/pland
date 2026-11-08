import { useMemo, useState } from 'react'

import { useFlowData } from '@/data/flowStore'
import { MOVE_LABEL, TREASURY, useTreasury, type MoveKind, type TreasuryMove } from '@/data/treasury'
import { formatNumber } from '@/lib/format'
import { classify, dayOf, FLOW_TOKENS, PD_CONTRACTS, type FlowToken, type FlowTransfer } from '@/lib/flow'

/*
 * The token flow as a map: where TLM or DEF came from and where it went over the period. Sources on
 * the left (players paying in, newly minted tokens, outside funding, Alcor), the treasury and the
 * game contracts in the middle, destinations on the right (mission rewards, withdrawals, wallets the
 * treasury paid, Alcor). Ribbon width is the amount. Beside it, the treasury's own moves: what the
 * project's wallet did that is not gameplay.
 *
 * Gameplay comes from every transfer of the game contracts (data/flowStore.ts: read gently, finished
 * days kept in this browser). The treasury's transfers are read whole (data/treasury.ts). A
 * transfer between the two is taken from the treasury's side only, so nothing counts twice.
 */

type Period = 7 | 30 | 90
const PERIODS: Period[] = [7, 30, 90]
const DAY_MS = 86_400_000
const PD = new Set<string>(PD_CONTRACTS)
const OPTS = { contracts: PD, aliensInside: false }

/** Colours by kind, from the site's palette. */
const COL = {
  play: 'var(--r-common)',
  mint: 'var(--r-epic)',
  fund: 'var(--r-rare)',
  wallets: 'var(--r-legendary)',
  pool: 'var(--good)',
  dex: 'var(--accent)',
  treasury: 'var(--ink)',
  game: 'var(--good)'
} as const
const KIND_COL: Record<MoveKind, string> = { mint: COL.mint, fund: COL.fund, dex: COL.dex, pool: COL.pool, fromgame: COL.play, wallets: COL.wallets }

const compact = (n: number) => {
  const a = Math.abs(n)
  return a >= 1e6 ? `${formatNumber(a / 1e6, a >= 1e7 ? 1 : 2)}M` : a >= 1e4 ? `${formatNumber(a / 1e3, 0)}k` : formatNumber(a, a < 10 ? 2 : 0)
}

interface Flows {
  players: number
  mintToGame: number
  mintToTreasury: number
  fund: number
  alcorIn: number
  treasuryToGame: number
  rewards: number
  withdrawals: number
  otherOut: number
  gameToTreasury: number
  wallets: number
  alcorOut: number
  /** What players paid in, by kind. */
  playersBy: Map<string, number>
}

function flows(game: FlowTransfer[], moves: TreasuryMove[], from: number): Flows {
  const f: Flows = { players: 0, mintToGame: 0, mintToTreasury: 0, fund: 0, alcorIn: 0, treasuryToGame: 0, rewards: 0, withdrawals: 0, otherOut: 0, gameToTreasury: 0, wallets: 0, alcorOut: 0, playersBy: new Map() }
  for (const x of game) {
    if (x.t < from) continue
    // Transfers with the treasury are counted from its side.
    if (x.from === TREASURY || x.to === TREASURY) continue
    const c = classify(x, OPTS)
    if (!c || c.dir === 'internal') continue
    if (c.dir === 'in') {
      if (c.category === 'mint') f.mintToGame += x.amount
      else {
        f.players += x.amount
        f.playersBy.set(c.category, (f.playersBy.get(c.category) ?? 0) + x.amount)
      }
    } else if (c.category === 'reward') f.rewards += x.amount
    else if (c.category === 'withdraw') f.withdrawals += x.amount
    else f.otherOut += x.amount
  }
  for (const m of moves) {
    if (m.t < from) continue
    if (m.kind === 'mint') f.mintToTreasury += m.amount
    else if (m.kind === 'fund') f.fund += m.amount
    else if (m.kind === 'dex') m.dir === 'in' ? (f.alcorIn += m.amount) : (f.alcorOut += m.amount)
    else if (m.kind === 'pool') f.treasuryToGame += m.amount
    else if (m.kind === 'fromgame') f.gameToTreasury += m.amount
    else f.wallets += m.amount
  }
  return f
}

interface SNode {
  id: string
  label: string
  col: string
  x: 0 | 1 | 2
  vin: number
  vout: number
  y: number
  h: number
  oo: number
  io: number
}
interface SLink {
  s: string
  t: string
  v: number
  col: string
}

function FlowMap({ f, token }: { f: Flows; token: FlowToken }) {
  const N: SNode[] = []
  const L: SLink[] = []
  const node = (id: string, label: string, col: string, x: 0 | 1 | 2) => N.push({ id, label, col, x, vin: 0, vout: 0, y: 0, h: 0, oo: 0, io: 0 })
  const link = (s: string, t: string, v: number, col: string) => v > 0 && L.push({ s, t, v, col })
  node('players', 'Players paying in', COL.play, 0)
  node('mint', 'Newly minted', COL.mint, 0)
  node('fund', 'Funding received', COL.fund, 0)
  node('alcorIn', 'Alcor (swaps, liquidity back)', COL.dex, 0)
  node('treasury', `Treasury · ${TREASURY}`, COL.treasury, 1)
  node('game', 'Game contracts · reward pool', COL.game, 1)
  node('rewards', 'Mission rewards', COL.play, 2)
  node('withdrawals', 'Balance withdrawals', COL.fund, 2)
  node('otherOut', 'Campaigns and other payouts', COL.mint, 2)
  node('toTreasury', 'Back to the treasury', COL.treasury, 2)
  node('wallets', 'Paid to wallets', COL.wallets, 2)
  node('alcorOut', 'Alcor (liquidity, sells)', COL.dex, 2)
  link('players', 'game', f.players, COL.play)
  link('mint', 'game', f.mintToGame, COL.mint)
  link('mint', 'treasury', f.mintToTreasury, COL.mint)
  link('fund', 'treasury', f.fund, COL.fund)
  link('alcorIn', 'treasury', f.alcorIn, COL.dex)
  link('treasury', 'game', f.treasuryToGame, COL.pool)
  link('game', 'rewards', f.rewards, COL.play)
  link('game', 'withdrawals', f.withdrawals, COL.fund)
  link('game', 'otherOut', f.otherOut, COL.mint)
  link('game', 'toTreasury', f.gameToTreasury, COL.treasury)
  link('treasury', 'wallets', f.wallets, COL.wallets)
  link('treasury', 'alcorOut', f.alcorOut, COL.dex)
  if (!L.length) return <p className="muted">No {token} moved in this period.</p>

  const byId = new Map(N.map((n) => [n.id, n]))
  for (const l of L) {
    byId.get(l.s)!.vout += l.v
    byId.get(l.t)!.vin += l.v
  }
  // The treasury → game link runs inside the middle column: the treasury sits above, its ribbon
  // curls down into the game contracts' top.
  const W = 900
  const H = 400
  const NW = 12
  const GAP = 26
  const colX = [170, 444, 718]
  const cols = ([0, 1, 2] as const).map((c) => N.filter((n) => n.x === c && (n.vin || n.vout)))
  const size = (n: SNode) => Math.max(n.vin, n.vout)
  const scale = Math.min(...cols.filter((c) => c.length).map((c) => (H - GAP * (c.length - 1)) / c.reduce((s, n) => s + size(n), 0)))
  for (const c of cols) {
    const tot = c.reduce((s, n) => s + Math.max(2, size(n) * scale), 0) + GAP * (c.length - 1)
    let y = (H - tot) / 2
    for (const n of c) {
      n.y = y
      n.h = Math.max(2, size(n) * scale)
      y += n.h + GAP
    }
  }
  // Ribbons leave and arrive in order of the other end's height, so they cross as little as possible.
  const ordered = [...L].sort((a, b) => byId.get(a.t)!.y - byId.get(b.t)!.y || byId.get(a.s)!.y - byId.get(b.s)!.y)
  const ribbons = ordered.map((l) => {
    const s = byId.get(l.s)!
    const t = byId.get(l.t)!
    const w = l.v * scale
    const y0 = s.y + s.oo
    const y1 = t.y + t.io
    s.oo += w
    t.io += w
    let d: string
    if (s.x === t.x) {
      // Within the middle column: out of the treasury's right side, round and into the game contracts' right side.
      const x0 = colX[s.x] + NW
      const bend = x0 + 60 + w
      d = `M${x0} ${y0} C${bend} ${y0} ${bend} ${y1} ${x0} ${y1} L${x0} ${y1 + w} C${bend + w} ${y1 + w} ${bend + w} ${y0 + w} ${x0} ${y0 + w} Z`
    } else {
      const x0 = colX[s.x] + NW
      const x1 = colX[t.x]
      const mx = (x0 + x1) / 2
      d = `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1} L${x1} ${y1 + w} C${mx} ${y1 + w} ${mx} ${y0 + w} ${x0} ${y0 + w} Z`
    }
    return (
      <path key={l.s + l.t} className="tf__lnk" fill={l.col} d={d}>
        <title>{`${s.label} → ${t.label}: ${formatNumber(l.v, FLOW_TOKENS[token].digits)} ${token}`}</title>
      </path>
    )
  })
  const nodes = N.filter((n) => n.h).map((n) => {
    const x = colX[n.x]
    const anchor = n.x === 0 ? 'end' : n.x === 2 ? 'start' : 'middle'
    const tx = n.x === 0 ? x - 8 : n.x === 2 ? x + NW + 8 : x + NW / 2
    const ty = n.x === 1 ? n.y - 20 : n.y + n.h / 2 - 3
    const sub = n.x === 1 ? `in ${compact(n.vin)} · out ${compact(n.vout)}` : `${compact(size(n))} ${token}`
    return (
      <g key={n.id}>
        <rect x={x} y={n.y} width={NW} height={n.h} rx={3} fill={n.col} />
        <text x={tx} y={ty} textAnchor={anchor} className="tf__nl">
          {n.label}
        </text>
        <text x={tx} y={ty + 14} textAnchor={anchor} className="tf__nv">
          {sub}
        </text>
      </g>
    )
  })
  return (
    <div className="tf__scroll">
      <svg viewBox={`-10 -34 ${W + 20} ${H + 50}`} role="img" aria-label={`${token} flow`}>
        {ribbons}
        {nodes}
      </svg>
    </div>
  )
}

/** The treasury's moves, newest first; runs of the same move on one day (Alcor fees, order fills) are one row. */
function groupMoves(moves: TreasuryMove[], from: number) {
  const rows: { key: string; t: number; kind: MoveKind; dir: 'in' | 'out'; who: string; memo: string; amount: number; n: number }[] = []
  const at = new Map<string, number>()
  for (const m of [...moves].reverse()) {
    if (m.t < from) continue
    const key = `${dayOf(m.t)}|${m.kind}|${m.dir}|${m.who}|${m.memo.slice(0, 18)}`
    const i = at.get(key)
    if (i === undefined) {
      at.set(key, rows.length)
      rows.push({ key, t: m.t, kind: m.kind, dir: m.dir, who: m.who, memo: m.memo, amount: m.amount, n: 1 })
    } else {
      rows[i].amount += m.amount
      rows[i].n++
    }
  }
  return rows
}

const LIST_STEP = 25

export function TokenFlow() {
  const [token, setToken] = useState<FlowToken>('TLM')
  const [period, setPeriod] = useState<Period>(30)
  const [round, setRound] = useState(0)
  const [shown, setShown] = useState(LIST_STEP)
  // The first day read: midnight `period` days back (fixed per period, so finished days come from the cache).
  const from = useMemo(() => dayOf(Date.now() - (period - 1) * DAY_MS), [period])
  const game = useFlowData(token, from, round)
  const treasury = useTreasury(token)
  const f = useMemo(() => flows(game.transfers, treasury.data ?? [], from), [game.transfers, treasury.data, from])
  const moves = useMemo(() => groupMoves(treasury.data ?? [], from), [treasury.data, from])
  const ready = !game.loading && !!treasury.data
  const digits = FLOW_TOKENS[token].digits

  return (
    <main className="tf wrap">
      <header className="tf__hd">
        <h2>
          Token flow <small>the game contracts and the project's treasury, from the chain</small>
        </h2>
        <div className="seg tf__seg" role="group" aria-label="Token">
          {(['TLM', 'DEF'] as FlowToken[]).map((t) => (
            <button key={t} type="button" className={token === t ? 'is-on' : ''} onClick={() => setToken(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="seg tf__seg" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              className={period === p ? 'is-on' : ''}
              onClick={() => {
                setPeriod(p)
                setShown(LIST_STEP)
              }}
            >
              {p} days
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--sm"
          disabled={game.loading}
          title="Reads the period again from the chain, including the days this browser kept"
          onClick={() => {
            setRound((r) => r + 1)
            void treasury.refetch()
          }}
        >
          Refresh
        </button>
      </header>

      {game.progress && (
        <div className="tf__load" role="status">
          <span>
            {game.progress.label}
            <small> · the first visit reads every transfer of the period; finished days are kept in this browser</small>
          </span>
          <span className="tf__bar">
            <i style={{ width: `${Math.round(game.progress.share * 100)}%` }} />
          </span>
        </div>
      )}
      {game.error && <p className="tf__warn">Stopped: {game.error}</p>}
      {treasury.isError && <p className="tf__warn">The treasury's history could not be read right now. Try Refresh in a moment.</p>}

      <div className="tf__grid">
        <section className="box tf__map">
          <h3 className="h">
            Where it came from and where it went <small>last {period} days</small>
          </h3>
          {ready ? <FlowMap f={f} token={token} /> : <p className="muted">Reading the transfers…</p>}
          <div className="tf__key">
            <span>
              <i style={{ background: COL.play }} />
              Gameplay
            </span>
            <span>
              <i style={{ background: COL.mint }} />
              Minted
            </span>
            <span>
              <i style={{ background: COL.fund }} />
              Funding
            </span>
            <span>
              <i style={{ background: COL.wallets }} />
              Wallets
            </span>
            <span>
              <i style={{ background: COL.pool }} />
              Reward pool
            </span>
            <span>
              <i style={{ background: COL.dex }} />
              Exchange
            </span>
          </div>
          {ready && f.players > 0 && (
            <p className="tf__foot">
              Players paid in {formatNumber(f.players, digits)} {token}
              {f.playersBy.size > 1
                ? ` (${[...f.playersBy]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([c, v]) => `${CATEGORY_NAME[c] ?? c} ${compact(v)}`)
                    .join(', ')})`
                : ''}
              ; missions paid out {formatNumber(f.rewards, digits)}.
            </p>
          )}
        </section>

        <section className="box tf__moves">
          <h3 className="h">
            Treasury moves <small>{TREASURY}, not gameplay</small>
          </h3>
          {!treasury.data ? (
            <p className="muted">Reading the treasury…</p>
          ) : moves.length === 0 ? (
            <p className="muted">The treasury moved no {token} in the last {period} days.</p>
          ) : (
            <ul>
              {moves.slice(0, shown).map((m) => (
                <li key={m.key} title={m.memo ? `“${m.memo}”` : undefined}>
                  <i style={{ background: KIND_COL[m.kind] }} />
                  <span>
                    <b>{MOVE_LABEL[m.kind]}</b>
                    <small>
                      {m.dir === 'in' ? 'from' : 'to'} {m.who}
                      {m.memo ? ` · ${m.memo}` : ''}
                    </small>
                  </span>
                  <span className={`tf__amt ${m.dir === 'in' ? 'c-good' : 'c-bad'}`}>
                    {m.dir === 'in' ? '+' : '−'}
                    {compact(m.amount)}
                    <small>
                      {new Date(m.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                      {m.n > 1 ? ` · ${m.n}×` : ''}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {moves.length > shown && (
            <button type="button" className="lg__more" onClick={() => setShown((n) => n + LIST_STEP)}>
              Show {Math.min(LIST_STEP, moves.length - shown)} more of {moves.length - shown}
            </button>
          )}
        </section>
      </div>
    </main>
  )
}

/** Short names for what players paid in. */
const CATEGORY_NAME: Record<string, string> = {
  deposit: 'deposits',
  entry: 'entry fees',
  forge: 'Forge levels',
  slot: 'Forge slots',
  'siege-fund': 'campaign funding',
  'siege-in': 'campaign entries',
  fund: 'top-ups',
  'other-in': 'other'
}
