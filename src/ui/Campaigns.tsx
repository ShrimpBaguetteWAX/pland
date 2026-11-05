import { Fragment, useMemo, useState, type CSSProperties } from 'react'

import { claimMission, recalcDivision } from '@/chain/actions/pd'
import { claimSiegeAction, contributeDefAction, depositTlmAction, joinSiegeAction } from '@/chain/actions/siege'
import { useArmy, useDeployments, usePlayer, useTemplates, type Division } from '@/data/game'
import {
  FUNDER_BONUS,
  joinOpen,
  refreshSieges,
  useEntryCredit,
  useLeaderboard,
  usePastSeasons,
  useRankPrizes,
  useSeasonFunders,
  useSiegeEntries,
  useSieges,
  useTlmBalance,
  type RankPrize,
  type Siege,
  type SiegeEntry
} from '@/data/siege'
import { formatNumber, titleCase } from '@/lib/format'
import { missionLockSeconds } from '@/lib/stats'
import { shortDuration, useNow } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'

/*
 * Campaigns, as a war room: the six worlds down the left, the picked one in full on the right. A
 * world runs in three phases on siege.pdef. The community funds it with DEF (memo "unlock:<id>",
 * final), the three biggest funders getting a score bonus for the season; then for a season every
 * division you send adds its attack and defense to your score, for a TLM entry fee taken from the
 * balance core.pdef holds for you; when the season closes the ranks are paid in DEF and NFTs. The
 * head names the phase and its one action, the steps show where the world stands, and below come
 * the figures for that phase, who leads it, your divisions and the prize table.
 */

const QUICK_DEF = [10, 50, 100, 500]
const kfmt = (n: number) => (Math.abs(n) >= 1e6 ? `${formatNumber(n / 1e6, 2)} M` : Math.abs(n) >= 1e4 ? `${formatNumber(n / 1e3, 0)} k` : formatNumber(n, 0))
const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const img = (p: string) => `./img/planets/${p}.png`

type Phase = 'sealed' | 'fund' | 'live' | 'settled'
const phaseOf = (s: Siege, now: number): Phase =>
  !s.onChain ? 'sealed' : s.status === 'locked' ? 'fund' : s.status === 'active' && (s.endAt === null || s.endAt > now) ? 'live' : 'settled'

function railLabel(s: Siege, now: number): { text: string; tone: string } {
  const p = phaseOf(s, now)
  if (p === 'sealed') return { text: 'Sealed', tone: 'sealed' }
  if (p === 'fund') return { text: `Funding · ${formatNumber((s.fundedDef / (s.thresholdDef || 1)) * 100, 1)} %`, tone: 'fund' }
  if (p === 'live') return { text: s.endAt ? `Siege · ${shortDuration(s.endAt - now)} left` : 'Siege open', tone: 'live' }
  return { text: s.status === 'failed' ? `Season ${s.season} · failed` : `Season ${s.season} · targets met`, tone: s.status === 'failed' ? 'sealed' : 'met' }
}

export function Campaigns({ account, spectating }: { account: string; spectating: boolean }) {
  const sieges = useSieges()
  const now = useNow(1000)
  const [picked, setPicked] = useState<string | null>(null)
  const list = sieges.data ?? []
  // Open on the world with the most going on: a live siege, then one being funded, then any opened.
  const fallback = list.find((s) => phaseOf(s, now) === 'live')?.planet ?? list.find((s) => phaseOf(s, now) === 'fund')?.planet ?? list.find((s) => s.onChain)?.planet ?? null
  const planet = picked ?? fallback
  const siege = list.find((s) => s.planet === planet) ?? null

  if (sieges.isError) return <p className="wrap page-msg c-bad">The worlds could not be read: {String(sieges.error)}</p>
  if (!sieges.data) return <p className="wrap page-msg muted">Surveying the worlds…</p>

  return (
    <main className="camp wrap">
      <aside className="camp__worlds">
        <span className="eyebrow">Worlds</span>
        {list.map((s) => {
          const l = railLabel(s, now)
          return (
            <button key={s.planet} type="button" className={`world${s.planet === planet ? ' is-on' : ''}${l.tone === 'sealed' && !s.onChain ? ' is-sealed' : ''}`} onClick={() => setPicked(s.planet)}>
              <img className="world__pic" src={img(s.planet)} alt="" />
              <span className="world__text">
                <b>{titleCase(s.planet)}</b>
                <span className={`pill is-${l.tone}`}>{l.text}</span>
              </span>
            </button>
          )
        })}
      </aside>
      {siege && <World key={siege.planet} siege={siege} now={now} account={account} spectating={spectating} />}
    </main>
  )
}

function World({ siege: s, now, account, spectating }: { siege: Siege; now: number; account: string; spectating: boolean }) {
  const phase = phaseOf(s, now)
  const name = titleCase(s.planet)
  const fundPct = s.thresholdDef ? Math.min(100, (s.fundedDef / s.thresholdDef) * 100) : 0
  const atkPct = s.targetAtk ? (s.cumAtk / s.targetAtk) * 100 : 0
  const defPct = s.targetDef ? (s.cumDef / s.targetDef) * 100 : 0
  const timePct = s.startAt && s.endAt ? Math.min(100, Math.max(0, ((now - s.startAt) / (s.endAt - s.startAt)) * 100)) : 0

  if (phase === 'sealed')
    return (
      <section className="camp__world">
        <div className="box camp__lead">
          <img className="camp__pic is-sealed" src={img(s.planet)} alt="" />
          <span>
            <span className="eyebrow">Sealed</span>
            <h2>{name}</h2>
            <p>The game has not opened {name} for campaigns yet. When it does, the community funds it with DEF and a season follows.</p>
          </span>
        </div>
      </section>
    )

  const eyebrow = phase === 'fund' ? `Season ${s.season} · being funded` : phase === 'live' ? `Season ${s.season} · siege on` : `Season ${s.season} · ${s.status === 'failed' ? 'failed' : 'finished'}`
  const blurb =
    phase === 'fund'
      ? `${formatNumber(s.thresholdDef, 0)} DEF from the community opens a ${s.durationDays}-day siege. The three biggest funders get +15, +10 and +5 % on their score for the whole season. Funding is final: the DEF is not returned.`
      : phase === 'live'
        ? `Every division you send adds its attack and defense to your score. ${formatNumber(s.entryTlm, 0)} TLM a join; a division is held ${formatNumber(s.cooldownBase / 3600, 1)} h plus 10 s per move point, then can go again.`
        : `The season closed${s.endAt ? ` on ${day(s.endAt)}` : ''}${s.status === 'failed' ? ' without reaching its targets.' : ` with both targets reached. ${formatNumber(s.distributedRanks, 0)} ranks were paid.`}`

  return (
    <section className="camp__world">
      <div className="box camp__head">
        <div className="camp__lead">
          <img className="camp__pic" src={img(s.planet)} alt="" />
          <span>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{name}</h2>
            <p>{blurb}</p>
          </span>
        </div>
        <div className="phases">
          <div className={`phase${phase === 'fund' ? ' is-now' : ' is-done'}`}>
            <span className="eyebrow">1 · Fund</span>
            <b className="num">
              {formatNumber(s.fundedDef, 0)} / {formatNumber(s.thresholdDef, 0)} DEF
            </b>
            <span className="bar2" style={{ '--k': 'var(--move)' } as CSSProperties}>
              <i style={{ width: `${fundPct}%` }} />
            </span>
            <span>{phase === 'fund' ? `${formatNumber(Math.max(0, s.thresholdDef - s.fundedDef), 0)} DEF to go` : 'funded'}</span>
          </div>
          <div className={`phase${phase === 'live' ? ' is-now' : phase === 'settled' ? ' is-done' : ''}`}>
            <span className="eyebrow">2 · Siege</span>
            <b>{phase === 'live' && s.endAt ? `${shortDuration(s.endAt - now)} left` : `${s.durationDays} days`}</b>
            {phase === 'fund' ? (
              <span>
                {formatNumber(s.entryTlm, 0)} TLM a join · {formatNumber(s.cooldownBase / 3600, 1)} h cooldown · at least {formatNumber(s.minAtk, 0)} atk and {formatNumber(s.minDef, 0)} def per division
              </span>
            ) : (
              <>
                <span className="bar2" style={{ '--k': 'var(--ink)' } as CSSProperties}>
                  <i style={{ width: `${phase === 'settled' ? 100 : timePct}%` }} />
                </span>
                <span>
                  {s.startAt ? day(s.startAt) : '…'} – {s.endAt ? day(s.endAt) : '…'} · {formatNumber(s.participants, 0)} players · {formatNumber(s.deployments, 0)} joins
                </span>
              </>
            )}
          </div>
          <div className={`phase${phase === 'settled' ? ' is-now' : ''}`}>
            <span className="eyebrow">3 · Payout</span>
            <b>Ranks in DEF + NFTs</b>
            <span>
              {phase === 'settled'
                ? `${formatNumber(s.distributedRanks, 0)} ranks paid`
                : `once ${kfmt(s.targetAtk)} atk and ${kfmt(s.targetDef)} def are reached together`}
            </span>
          </div>
        </div>
        {phase !== 'fund' && (
          <div className="targets">
            <div className="target">
              <span>
                <b className="c-atk">Attack</b>
                <b className="num">
                  {kfmt(s.cumAtk)} / {kfmt(s.targetAtk)}
                </b>
              </span>
              <span className="bar2" style={{ '--k': 'var(--atk)' } as CSSProperties}>
                <i style={{ width: `${Math.min(100, atkPct)}%` }} />
              </span>
            </div>
            <div className="target">
              <span>
                <b className="c-def">Defense</b>
                <b className="num">
                  {kfmt(s.cumDef)} / {kfmt(s.targetDef)}
                </b>
              </span>
              <span className="bar2" style={{ '--k': 'var(--def)' } as CSSProperties}>
                <i style={{ width: `${Math.min(100, defPct)}%` }} />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="camp__two">
        {phase === 'fund' ? <FundPanel siege={s} account={account} spectating={spectating} /> : <Leaderboard siege={s} account={account} />}
        <Prizes siege={s} />
      </div>
      {phase === 'live' && <DeployPanel siege={s} now={now} account={account} spectating={spectating} />}
      {phase === 'fund' && <DivisionsPreview siege={s} account={account} />}
    </section>
  )
}

// ---- Funding ---------------------------------------------------------------------------------------

function FundPanel({ siege: s, account, spectating }: { siege: Siege; account: string; spectating: boolean }) {
  const { funders, isLoading } = useSeasonFunders(s)
  const player = usePlayer(account)
  const { run, pending } = useTransaction()
  const [amount, setAmount] = useState('')
  const mine = funders.find((f) => f.account === account)
  const third = funders[2]
  // What it takes to be third: one more than whoever holds third now (or nothing, if there is no third yet).
  const toThird = mine && mine.rank <= 3 ? 0 : Math.max(1, Math.floor((third?.def ?? 0) - (mine?.def ?? 0)) + 1)
  const held = player.data?.def ?? 0
  const value = Number(amount)
  const fund = (def: number) => {
    if (!(def > 0)) return
    void run((a, p) => contributeDefAction(a, p, s.planetId, def), `${formatNumber(def, 2)} DEF sent to fund ${titleCase(s.planet)}`, 'siege-fund').then((ok) => {
      if (ok) {
        setAmount('')
        void refreshSieges(account)
      }
    })
  }
  const rows = funders.slice(0, 5)
  return (
    <div className="box">
      <h3 className="h">
        Top funders
        <small>the bonus goes to the first three when the season opens</small>
      </h3>
      {isLoading ? (
        <p className="muted">Reading who funded it…</p>
      ) : (
        <table className="t">
          <thead>
            <tr>
              <th>#</th>
              <th>Funder</th>
              <th className="num">DEF</th>
              <th>Bonus</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.account} className={f.account === account ? 'is-me' : ''}>
                <td>
                  <span className={`rank r${f.rank}`}>{f.rank}</span>
                </td>
                <td>
                  {f.account}
                  {f.account === account && <small className="muted"> · you</small>}
                </td>
                <td className="num">{formatNumber(f.def, 0)}</td>
                <td>{f.rank <= 3 ? <span className="pill is-met">+{Math.round(FUNDER_BONUS[f.rank - 1] * 100)} % score</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={4} className="muted">
                  Nobody has funded this season yet: any amount puts you first.
                </td>
              </tr>
            )}
            {!mine && rows.length > 0 && (
              <tr className="is-me">
                <td>
                  <span className="rank">–</span>
                </td>
                <td>
                  <b>{account}</b>
                  <small className="muted"> · you</small>
                </td>
                <td className="num">0</td>
                <td className="muted">{formatNumber(toThird, 0)} DEF puts you 3rd</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="fundrow">
        {QUICK_DEF.map((d) => (
          <button key={d} type="button" className="btn btn--sm" onClick={() => setAmount(String(d))}>
            {d} DEF
          </button>
        ))}
        <input className="input" inputMode="decimal" placeholder="DEF" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button
          type="button"
          className="btn btn--sm btn--go"
          disabled={!!pending || spectating || !(value > 0) || value > held}
          title={value > held ? `You hold ${formatNumber(held, 2)} DEF` : undefined}
          onClick={() => fund(value)}
        >
          Fund {value > 0 ? `${formatNumber(value, 2)} DEF` : ''}
        </button>
        {toThird > 0 && !spectating && (
          <button type="button" className="btn btn--sm" disabled={!!pending || toThird > held} onClick={() => fund(toThird)}>
            Fund {formatNumber(toThird, 0)} · take 3rd
          </button>
        )}
      </div>
      <p className="help">
        You hold {formatNumber(held, 2)} DEF. Funding is final.{spectating ? ' Read-only: this is not your account.' : ''}
      </p>
    </div>
  )
}

// ---- Scores -----------------------------------------------------------------------------------------

function Leaderboard({ siege: s, account }: { siege: Siege; account: string }) {
  const board = useLeaderboard(s)
  const prizes = usePrizeTable(s)
  const prizeOf = useMemo(() => new Map(prizes.list.map((p) => [p.rank, p])), [prizes.list])
  const name = usePrizeNames()
  const rows = board.data ?? []
  const meIx = rows.findIndex((r) => r.account === account)
  // The top ten, and the player's own row with its neighbours when it is further down.
  const shown = rows.filter((_, i) => i < 10 || (meIx >= 0 && Math.abs(i - meIx) <= 1))
  return (
    <div className="box">
      <h3 className="h">
        Leaderboard
        <small>score = attack + defense of every join · {formatNumber(rows.length, 0)} players</small>
      </h3>
      {board.isLoading ? (
        <p className="muted">Reading the scores…</p>
      ) : !rows.length ? (
        <p className="none">Nobody has joined yet.</p>
      ) : (
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th className="num">Score</th>
                <th className="num">Joins</th>
                <th>Prize</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const p = prizeOf.get(r.rank)
                const gap = i > 0 && r.rank - shown[i - 1].rank > 1
                return (
                  <Fragment key={r.account}>
                    {gap && (
                      <tr>
                        <td colSpan={5} className="muted">
                          …
                        </td>
                      </tr>
                    )}
                    <tr className={r.account === account ? 'is-me' : ''}>
                      <td>
                        <span className={`rank r${r.rank}`}>{r.rank}</span>
                      </td>
                      <td>
                        {r.account}
                        {r.account === account && <small className="muted"> · you</small>}
                      </td>
                      <td className="num">{formatNumber(r.score, 0)}</td>
                      <td className="num">{formatNumber(r.deployments, 0)}</td>
                      <td className="prize">{p ? <PrizeText p={p} name={name} short /> : <span className="muted">no prize</span>}</td>
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {meIx < 0 && rows.length > 0 && <p className="help">You have not joined this season.</p>}
    </div>
  )
}

// ---- Prizes -----------------------------------------------------------------------------------------

/** The live prize table, or the last season's when the live one is empty (between seasons). */
function usePrizeTable(s: Siege): { list: RankPrize[]; from: string; loading: boolean } {
  const live = useRankPrizes(s.onChain ? s.planetId : null)
  const past = usePastSeasons(s.onChain && !(live.data?.length ?? 0) ? s.planetId : null)
  if (live.data?.length) return { list: live.data, from: `season ${s.season}`, loading: false }
  const last = past.data?.[past.data.length - 1]
  if (last?.prizes.length) return { list: last.prizes, from: `season ${last.season}, the last one paid`, loading: false }
  return { list: [], from: '', loading: live.isLoading || past.isLoading }
}

function usePrizeNames() {
  const templates = useTemplates()
  return (id: string, schema: string) => templates.data?.[id]?.name ?? (schema === 'loot' ? 'Quantum Chest' : titleCase(schema))
}

function PrizeText({ p, name, short }: { p: RankPrize; name: (id: string, schema: string) => string; short?: boolean }) {
  const loot = p.nfts.filter((n) => n.schema === 'loot').reduce((n, x) => n + x.count, 0)
  const other = p.nfts.filter((n) => n.schema !== 'loot')
  return (
    <span>
      <b>{formatNumber(p.def, 0)} DEF</b>
      {loot > 0 && ` · ${loot} chest${loot === 1 ? '' : 's'}`}
      {other.length > 0 &&
        (short
          ? ` · ${other.reduce((n, x) => n + x.count, 0)} NFTs`
          : other.map((n) => ` · ${n.count} ${name(n.templateId, n.schema)}`).join(''))}
    </span>
  )
}

function Prizes({ siege: s }: { siege: Siege }) {
  const t = usePrizeTable(s)
  const name = usePrizeNames()
  // Ranks paid the same, folded into one row ("6–10").
  const rows = useMemo(() => {
    const out: { from: number; to: number; p: RankPrize }[] = []
    const key = (p: RankPrize) => `${p.def}|${p.nfts.map((n) => `${n.templateId}x${n.count}`).join(',')}`
    for (const p of t.list) {
      const last = out[out.length - 1]
      if (last && last.to === p.rank - 1 && key(last.p) === key(p)) last.to = p.rank
      else out.push({ from: p.rank, to: p.rank, p })
    }
    return out
  }, [t.list])
  return (
    <div className="box">
      <h3 className="h">
        {t.from.startsWith('season ' + s.season) ? 'Prizes' : 'What a season pays'}
        <small>{t.from}</small>
      </h3>
      {t.loading ? (
        <p className="muted">Reading the prizes…</p>
      ) : !rows.length ? (
        <p className="none">No prize table set yet.</p>
      ) : (
        <table className="t">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Prize</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.from}>
                <td>{r.from === r.to ? <span className={`rank r${r.from}`}>{r.from}</span> : <span className="num muted">{`${r.from}–${r.to}`}</span>}</td>
                <td className="prize">
                  <PrizeText p={r.p} name={name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---- Your divisions ---------------------------------------------------------------------------------

interface DivState {
  division: Division
  qualifies: boolean
  /** When it can join: now, or when it comes back from a mission or this siege. */
  readyAt: number
  /** What has to be claimed in the same transaction before it can join. */
  claim: { kind: 'siege'; entryId: number } | { kind: 'mission'; missionId: number } | null
  where: string
}

function useDivisionStates(s: Siege, account: string, now: number): { states: DivState[]; loading: boolean } {
  const army = useArmy(account)
  const deployments = useDeployments(account)
  const entries = useSiegeEntries(account, s.onChain ? [s.planetId] : [])
  const states = useMemo(() => {
    const byDivEntry = new Map<number, SiegeEntry>()
    for (const e of entries.data ?? []) byDivEntry.set(e.divisionId, e)
    const byDivMission = new Map((deployments.data ?? []).map((d) => [d.divisionId, d]))
    return (army.data?.divisions ?? [])
      .filter((d) => d.units.length > 0)
      .map((d): DivState => {
        const qualifies = d.atk >= s.minAtk && d.def >= s.minDef
        const e = byDivEntry.get(d.id)
        const m = byDivMission.get(d.id)
        if (e) return { division: d, qualifies, readyAt: e.unlockAt, claim: { kind: 'siege', entryId: e.entryId }, where: e.unlockAt > now ? `in ${titleCase(s.planet)} · back in ${shortDuration(e.unlockAt - now)}` : `back from ${titleCase(s.planet)}` }
        if (m) return { division: d, qualifies, readyAt: m.unlockAt, claim: { kind: 'mission', missionId: m.missionId }, where: m.unlockAt > now ? `on a mission · back in ${shortDuration(m.unlockAt - now)}` : 'back from a mission' }
        return { division: d, qualifies, readyAt: 0, claim: null, where: 'at home' }
      })
      .sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || a.readyAt - b.readyAt || b.division.atk + b.division.def - (a.division.atk + a.division.def))
  }, [army.data, deployments.data, entries.data, s, now])
  return { states, loading: !army.data || !deployments.data || (s.onChain && !entries.data && entries.isLoading) }
}

function DivisionRow({ x, s, now, action, preview }: { x: DivState; s: Siege; now: number; action?: React.ReactNode; preview?: boolean }) {
  const d = x.division
  const short = [d.atk < s.minAtk && `${formatNumber(s.minAtk - d.atk, 0)} atk`, d.def < s.minDef && `${formatNumber(s.minDef - d.def, 0)} def`].filter(Boolean).join(', ')
  return (
    <div className={`fp${x.qualifies ? '' : ' is-short'}`} style={{ '--rc': rarityColor(d.leader?.rarity) } as CSSProperties}>
      <Portrait img={d.leader?.img} rarity={d.leader?.rarity} className="fp__pic" />
      <span className="fp__text">
        <b>
          #{d.id} {d.leader?.name ?? 'No warlord'}
        </b>
        <small>
          <span className="c-atk">{formatNumber(d.atk, 0)}</span> <span className="c-def">{formatNumber(d.def, 0)}</span> · {x.where}
        </small>
      </span>
      {!x.qualifies ? <span className="pill">short {short}</span> : !preview && x.readyAt > now ? <span className="fp__tag is-out">{shortDuration(x.readyAt - now)}</span> : action ?? <span className="pill is-met">qualifies</span>}
    </div>
  )
}

function DivisionsPreview({ siege: s, account }: { siege: Siege; account: string }) {
  const now = useNow(30_000)
  const { states, loading } = useDivisionStates(s, account, now)
  const ok = states.filter((x) => x.qualifies).length
  return (
    <div className="box">
      <h3 className="h">
        Your divisions for {titleCase(s.planet)}
        <small>
          once the season opens · {ok} of {states.length} meet {formatNumber(s.minAtk, 0)} atk and {formatNumber(s.minDef, 0)} def
        </small>
      </h3>
      {loading ? <p className="muted">Reading your divisions…</p> : <div className="fps fps--grid">{states.map((x) => <DivisionRow key={x.division.id} x={x} s={s} now={now} preview />)}</div>}
    </div>
  )
}

function DeployPanel({ siege: s, now, account, spectating }: { siege: Siege; now: number; account: string; spectating: boolean }) {
  const { run, runSequence, pending } = useTransaction()
  const { states, loading } = useDivisionStates(s, account, now)
  const balance = useTlmBalance(account)
  const credit = useEntryCredit(account, s.planetId)
  const open = joinOpen(s, now)
  const ready = states.filter((x) => x.qualifies && x.readyAt <= now)
  const available = (credit.data ?? 0) + (balance.data ?? 0)

  // A join: claim the division back first if it has to be, top up the entry fee, refresh its stats, join.
  const actionsFor = (x: DivState, deposit: number) => (a: string, p: string) => [
    ...(x.claim?.kind === 'siege' ? [claimSiegeAction(a, p, s.planetId, x.claim.entryId)] : []),
    ...(x.claim?.kind === 'mission' ? [claimMission(a, p, x.claim.missionId, x.division.id)] : []),
    ...(deposit > 0 ? [depositTlmAction(a, p, deposit)] : []),
    ...(x.division.fresh ? [] : [recalcDivision(a, p, x.division.id)]),
    joinSiegeAction(a, p, s.planetId, x.division.id)
  ]
  const lockH = (x: DivState) => formatNumber(missionLockSeconds(s.cooldownBase, x.division.move) / 3600, 1)

  const one = async (x: DivState) => {
    const ok = await run(actionsFor(x, Math.max(0, s.entryTlm - available)), `Division #${x.division.id} joined ${titleCase(s.planet)}: back in ${lockH(x)} h`, `siege-${x.division.id}`)
    if (ok) void refreshSieges(account)
  }
  const all = async () => {
    if (!ready.length) return
    // The first transaction deposits what every entry needs beyond the balance and credit; the contract takes one join per transaction.
    const deposit = Math.max(0, s.entryTlm * ready.length - available)
    await runSequence(
      ready.map((x, i) => ({ build: actionsFor(x, i === 0 ? deposit : 0), success: `Division #${x.division.id} joined ${titleCase(s.planet)}`, settle: i === 0 })),
      'siege-all',
      `Sending ${ready.length} divisions to ${titleCase(s.planet)}`
    )
    void refreshSieges(account)
  }
  const busy = !!pending

  return (
    <div className="box">
      <h3 className="h">
        Your divisions
        <small>
          {formatNumber(s.entryTlm, 0)} TLM a join · held {formatNumber(s.cooldownBase / 3600, 1)} h + 10 s per move · balance {balance.data === undefined ? '…' : formatNumber(balance.data, 2)} TLM
          {(credit.data ?? 0) > 0 ? `, credit ${formatNumber(credit.data!, 2)}` : ''}
        </small>
        {open && ready.length > 1 && (
          <button type="button" className="btn btn--sm btn--go h__end" disabled={busy || spectating} onClick={() => void all()}>
            <Icon name="flag" size={14} /> Send {ready.length} ready · {formatNumber(ready.length * s.entryTlm, 0)} TLM
          </button>
        )}
      </h3>
      {loading ? (
        <p className="muted">Reading your divisions…</p>
      ) : !states.length ? (
        <p className="none">No division with crew. Build one on the Divisions page.</p>
      ) : (
        <div className="fps fps--grid">
          {states.map((x) => (
            <DivisionRow
              key={x.division.id}
              x={x}
              s={s}
              now={now}
              action={
                open ? (
                  <button type="button" className="btn btn--sm" disabled={busy || spectating} title={`Adds ${formatNumber(x.division.atk + x.division.def, 0)} to your score; back in ${lockH(x)} h`} onClick={() => void one(x)}>
                    <Icon name="flag" size={14} /> {x.claim ? 'Claim & send' : 'Send'}
                  </button>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
      <p className="help">Entry fees beyond your balance are deposited in the same transaction. A division back from a mission or this siege is claimed in the same transaction too.</p>
    </div>
  )
}
