import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useArmy, type Division } from '@/data/game'
import { isCurrent, type Preset } from '@/lib/armyPresets'
import type { EffortLevel } from '@/lib/armySearch'
import { formatDuration, formatNumber } from '@/lib/format'
import { formatDateTimeShort } from '@/lib/time'
import { useField } from '@/lib/useField'
import { EFFORT_LEVELS, PHASES, STORE_ALIGN, STORE_OFF, useOptimizer, write } from '@/lib/useOptimizer'
import { count, usePresets } from '@/lib/usePresets'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait } from '../Art'
import { divisionState } from '../divisionState'

import './Army.css'

/*
 * Couch mode's Army page: the divisions in one list, grouped by where they are (at home, back with
 * a reward, then each mission, soonest back first), each with its warlord, crew and strength. Two
 * keys at the bottom: Presets (load one, delete one) and Optimize army (a sheet with the three
 * choices that matter, the search, its answer, saved as a preset or signed). The settings and the
 * signing are the Divisions page's own (lib/useOptimizer, lib/usePresets).
 *
 * The page stays mounted (hidden) once opened, so a search keeps running while you look elsewhere;
 * `active` says whether it is the page on screen, and only then are its sheets drawn.
 */

const wholeNum = (n: number) => formatNumber(n, 0)

/** A sheet over the whole couch screen: drawn into the couch's root, above the tab bar. */
function Sheet({ host, onClose, children, label }: { host: Element | null; onClose: () => void; children: ReactNode; label: string }) {
  if (!host) return null
  return createPortal(
    <div className="ca-sheet" role="dialog" aria-label={label}>
      <div className="ca-sheet__dim" onClick={onClose} />
      <div className="ca-sheet__box">
        <i className="ca-sheet__grab" aria-hidden="true" />
        {children}
      </div>
    </div>,
    host
  )
}

export function ArmyPage({ account, active }: { account: string; active: boolean }) {
  const { spectating } = useTransaction()
  const army = useArmy(account)
  const f = useField(account)
  const [sheet, setSheet] = useState<'opt' | 'presets' | null>(null)
  const page = useRef<HTMLElement>(null)
  const [host, setHost] = useState<Element | null>(null)
  useEffect(() => setHost(page.current?.closest('.couch') ?? null), [])

  const divisions = useMemo(() => army.data?.divisions ?? [], [army.data])
  const unlock = useMemo(() => new Map(f.field.map((d) => [d.divisionId, d])), [f.field])
  const editable = (d: Division) => divisionState(d, unlock.get(d.id)?.unlockAt, f.now).editable

  // At home first, then back with a reward to claim, then each mission, the soonest back first.
  const groups = useMemo(() => {
    const homeList = divisions.filter((d) => !unlock.has(d.id))
    const back = divisions.filter((d) => {
      const u = unlock.get(d.id)
      return u && u.unlockAt <= f.now
    })
    const byMission = new Map<number, Division[]>()
    for (const dep of f.field) {
      if (dep.unlockAt <= f.now) continue
      const d = f.byId.get(dep.divisionId)
      if (d) byMission.set(dep.missionId, [...(byMission.get(dep.missionId) ?? []), d])
    }
    const out: { key: string; title: string; note: string; list: Division[] }[] = []
    if (homeList.length) out.push({ key: 'home', title: 'At home', note: `${homeList.length}`, list: homeList })
    if (back.length) out.push({ key: 'back', title: 'Back, reward to claim', note: `${back.length}`, list: back })
    for (const [missionId, list] of byMission) {
      const times = list.map((d) => unlock.get(d.id)!.unlockAt - f.now)
      const lo = Math.min(...times)
      const hi = Math.max(...times)
      const span = hi - lo < 60_000 ? formatDuration(lo / 1000) : `${formatDuration(lo / 1000)} – ${formatDuration(hi / 1000)}`
      out.push({ key: `m${missionId}`, title: f.econ.get(missionId)?.title ?? `Mission ${missionId}`, note: `${list.length} · back in ${span}`, list })
    }
    return out
  }, [divisions, unlock, f.field, f.byId, f.econ, f.now])

  const totals = divisions.reduce((n, d) => ({ atk: n.atk + d.atk, def: n.def + d.def }), { atk: 0, def: 0 })
  const outCount = f.field.length
  const close = () => setSheet(null)
  // Here, not in the sheet: a search keeps running with the sheet closed (and while another page is open).
  const o = useOptimizer(account, { sessionAccount: account, spectating, onDone: close, potential: false })

  return (
    <section className="couch__bankpage ca ca--army" aria-label="Army" ref={page} hidden={!active}>
      <div className="ca__head">
        <h3>Army</h3>
        <small className="num">
          {army.data
            ? `${count(divisions.length, 'division')} · ${outCount === divisions.length && outCount ? 'all out' : outCount ? `${outCount} out` : 'all home'}`
            : 'Reading…'}
        </small>
      </div>
      <div className="ca__sum">
        <div>
          <small>Attack</small>
          <b className="num">{wholeNum(totals.atk)}</b>
        </div>
        <div>
          <small>Defense</small>
          <b className="num">{wholeNum(totals.def)}</b>
        </div>
        <div>
          <small>TLM / h</small>
          <b className="num">{formatNumber(f.earning, 1)}</b>
        </div>
      </div>

      {groups.map((g) => (
        <div key={g.key} className="ca__group">
          <div className="ca__gh">
            <span>{g.title}</span>
            <small className="num">{g.note}</small>
          </div>
          <ul className="ca__dlist">
            {g.list.map((d) => {
              const dep = unlock.get(d.id)
              const left = dep ? dep.unlockAt - f.now : 0
              const whole = dep ? dep.unlockAt - dep.joinedAt : 0
              const st = divisionState(d, dep?.unlockAt, f.now)
              return (
                <li key={d.id} className="ca__d">
                  <Portrait img={d.leader?.img} rarity={d.leader?.rarity} className="ca__pic" />
                  <span className="ca__dn">
                    <span className="ca__no num">#{d.id}</span> {d.leader?.name ?? 'No warlord'}
                  </span>
                  <span className="ca__stats num">
                    <span>
                      {wholeNum(d.atk)}
                      <small>ATK</small>
                    </span>
                    <span>
                      {wholeNum(d.def)}
                      <small>DEF</small>
                    </span>
                    <span>
                      {wholeNum(d.move)}
                      <small>MOVE</small>
                    </span>
                  </span>
                  <span className="ca__st">
                    <span className="num">
                      {d.units.length}/{d.slotsMax} crew
                    </span>
                    {' · '}
                    {left > 0 ? (
                      <>
                        back in <b className="num">{formatDuration(left / 1000)}</b>
                      </>
                    ) : (
                      st.label
                    )}
                  </span>
                  {left > 0 && whole > 0 && <i className="ca__bar" style={{ '--w': `${Math.round(Math.max(0, Math.min(1, 1 - left / whole)) * 100)}%` } as CSSProperties} />}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {army.data && !divisions.length && <p className="ca__none">No divisions yet.</p>}

      <div className="ca__dock">
        <button type="button" className="ca__ghost" onClick={() => setSheet('presets')}>
          Presets
        </button>
        <button type="button" className="ca__go" disabled={!army.data} onClick={() => setSheet('opt')}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />
          </svg>
          {o.search.running ? 'Searching…' : o.search.done && o.result ? 'Optimizer: answer ready' : 'Optimize army'}
        </button>
      </div>

      {active && sheet === 'opt' && (
        <Sheet host={host} onClose={close} label="Optimize army">
          <OptimizeSheet o={o} spectating={spectating} onClose={close} />
        </Sheet>
      )}
      {active && sheet === 'presets' && (
        <Sheet host={host} onClose={close} label="Presets">
          <PresetsSheet account={account} divisions={divisions} editable={editable} spectating={spectating} onClose={close} />
        </Sheet>
      )}
    </section>
  )
}

/* ---- Optimize army ----------------------------------------------------------------------------- */

function OptimizeSheet({ o, spectating, onClose }: { o: ReturnType<typeof useOptimizer>; spectating: boolean; onClose: () => void }) {
  const { search, result, mode, effort, alignMove, steps, state, finished, nothingToDo, busy, canSign, shown, kept, balanced, pick } = o
  const ready = o.divisions.length - o.away.length
  // With nothing at home there is nothing to rearrange: the comparison with everything home.
  const { setMode } = o
  useEffect(() => {
    if (!o.loading && !ready && mode === 'ready' && !search.running) setMode('all')
  }, [o.loading, ready, mode, search.running, setMode])
  const [saved, setSaved] = useState(false)
  useEffect(() => setSaved(false), [result, pick])
  const phases = PHASES.filter((p) => alignMove || !p.balancingOnly)
  // Missions switched off are kept in this browser (shared with the Divisions page): say so, and let them back in.
  const [showMissions, setShowMissions] = useState(false)
  const allowed = o.candidates.filter((m) => !o.off.has(m.id)).length
  const allowAll = () => {
    o.setOff(new Set())
    write(STORE_OFF, [])
  }
  const at = search.running ? phases.findIndex((p) => p.id === search.progress?.phase) : phases.length

  const missionsOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of shown) m.set(d.mission.title, (m.get(d.mission.title) ?? 0) + 1)
    return [...m].map(([t, n]) => `${t} ×${n}`).join(' · ')
  }, [shown])
  const moved = o.diff ? o.diff.changed.length : 0

  // Before a run: the three choices that matter (the site's sliders keep their saved values).
  if (!search.running && !search.done)
    return (
      <>
        <h4 className="ca-sheet__h">
          Optimize army <small className="num">now {o.nowTotal === null ? '…' : formatNumber(o.nowTotal, 1)} TLM / h</small>
        </h4>
        <div className="ca-sheet__field">
          <span className="ca__cap">Divisions</span>
          <div className="ca__seg">
            <button type="button" className={mode === 'ready' ? 'is-on' : ''} disabled={!ready} onClick={() => o.setMode('ready')}>
              Ready only <small className="num">{ready}</small>
            </button>
            <button type="button" className={mode === 'all' ? 'is-on' : ''} onClick={() => o.setMode('all')}>
              All <small className="num">{o.divisions.length}</small>
            </button>
          </div>
          <p>
            {mode === 'ready' && ready
              ? 'Rearranges the divisions at home; the ones out stay as they are. The answer can be signed.'
              : 'Pretends every division were home, to see what the whole army could earn. Save the answer as a preset and load it once they are back.'}
          </p>
        </div>
        <div className="ca-sheet__field">
          <span className="ca__cap">How hard</span>
          <div className="ca__seg">
            {EFFORT_LEVELS.map((l) => (
              <button key={l.key} type="button" className={effort === l.key ? 'is-on' : ''} onClick={() => o.setEffort(l.key as EffortLevel)}>
                {l.label}
              </button>
            ))}
          </div>
          <p>{EFFORT_LEVELS.find((l) => l.key === effort)?.what}</p>
        </div>
        <div className="ca-sheet__field">
          <button type="button" className={`ca-sheet__pick${allowed < o.candidates.length ? ' is-warn' : ''}`} onClick={() => setShowMissions((v) => !v)} aria-expanded={showMissions}>
            <span>
              <span className="ca__cap">Missions</span>
              <b className="num">
                {allowed} of {o.candidates.length} allowed
              </b>
            </span>
            <i aria-hidden="true">{showMissions ? '−' : '+'}</i>
          </button>
          {allowed < o.candidates.length && !showMissions && (
            <p className="ca-sheet__warn">
              Only {allowed} of the paying missions may be used, so the answer can only use those.{' '}
              <button type="button" className="ca-sheet__link" onClick={allowAll}>
                Allow all
              </button>
            </p>
          )}
          {showMissions && (
            <>
              <span className="ca-sheet__chips">
                {o.candidates.map((m) => (
                  <button key={m.id} type="button" className={o.off.has(m.id) ? '' : 'is-on'} aria-pressed={!o.off.has(m.id)} onClick={() => o.toggleMission(m.id)}>
                    {m.title}
                  </button>
                ))}
              </span>
              <p>
                Tap a mission to leave it out of the search.{' '}
                {o.off.size > 0 && (
                  <button type="button" className="ca-sheet__link" onClick={allowAll}>
                    Allow all
                  </button>
                )}
              </p>
            </>
          )}
        </div>
        <label className="ca-sheet__sw">
          <span>
            Balance return times
            <small>Same divisions, cards shuffled so each mission length comes back together</small>
          </span>
          <input
            type="checkbox"
            checked={alignMove}
            onChange={(e) => {
              o.setAlignMove(e.target.checked)
              write(STORE_ALIGN, e.target.checked)
            }}
          />
          <i className="ca-sheet__tog" aria-hidden="true" />
        </label>
        <button
          type="button"
          className="ca__go"
          disabled={o.loading || !o.input}
          onClick={() => search.start()}
        >
          {o.loading ? 'Reading the army…' : 'Run the optimizer'}
        </button>
      </>
    )

  return (
    <>
      <h4 className="ca-sheet__h">
        {search.running ? 'Searching' : 'Best army found'}
        <small className="num">{search.progress ? `${formatNumber(search.progress.ms / 1000, 0)} s` : ''}</small>
      </h4>
      {search.running && (
        <>
          <span className={`ca-sheet__prog${search.progress && search.progress.pct < 0 ? ' is-endless' : ''}`}>
            <i style={search.progress && search.progress.pct >= 0 ? { width: `${Math.max(2, search.progress.pct * 100)}%` } : undefined} />
          </span>
          <ol className="ca-sheet__phases">
            {phases.map((p, i) => (
              <li key={p.id} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
                <i>{i < at ? '✓' : i + 1}</i>
                <span>{p.label}</span>
                <small className="num">{i === at && o.bestTotal !== null ? `best so far ${formatNumber(o.bestTotal, 1)}` : ''}</small>
              </li>
            ))}
          </ol>
          {search.progress && (
            <p className="ca-sheet__note num">
              {formatNumber(search.progress.moves, 0)} changes tried by {search.seeds.length} searches side by side
            </p>
          )}
        </>
      )}
      {search.error && <p className="ca-sheet__warn">{search.error}</p>}
      {allowed < o.candidates.length && (
        <p className="ca-sheet__warn">
          Searched with {allowed} of {o.candidates.length} missions allowed.{' '}
          <button type="button" className="ca-sheet__link" disabled={search.running} onClick={() => (allowAll(), search.stop())}>
            Allow all
          </button>{' '}
          and search again for the whole picture.
        </p>
      )}
      {search.stale && (search.running || search.done) && (
        <p className="ca-sheet__warn">Prices or cards changed since this search started: search again for today’s numbers.</p>
      )}

      {result && (
        <>
          {balanced && (
            <div className="ca__seg">
              <button type="button" className={pick !== 'balanced' ? 'is-on' : ''} onClick={() => o.setPick('best')}>
                Best TLM / h
              </button>
              <button type="button" className={pick === 'balanced' ? 'is-on' : ''} onClick={() => o.setPick('balanced')}>
                Balanced
              </button>
            </div>
          )}
          <div className="ca-sheet__vs">
            <div>
              <small>Now</small>
              <b className="num">{o.nowTotal === null ? '…' : formatNumber(o.nowTotal, 1)}</b>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <small>{search.running ? 'Best so far' : o.showBalanced ? 'Balanced' : 'Best found'}</small>
              <b className={`num${o.gain !== null && o.gain > 0.05 ? ' is-up' : ''}`}>
                {o.showBalanced && balanced ? formatNumber(o.keptPerHour + balanced.perHour, 1) : o.bestTotal === null ? '…' : formatNumber(o.bestTotal, 1)}
              </b>
            </div>
          </div>
          {!search.running && (
            <div className="ca-sheet__changes">
              <div>
                <span>Divisions</span>
                <b className="num">
                  {o.divisions.filter((d) => d.units.length).length} → {kept.length + shown.length}
                </b>
              </div>
              {mode === 'ready' && (
                <div>
                  <span>Changed</span>
                  <b className="num">{count(moved, 'division')}</b>
                </div>
              )}
              {missionsOf && (
                <div>
                  <span>Missions</span>
                  <b>{missionsOf}</b>
                </div>
              )}
              {mode === 'ready' && steps.length > 0 && (
                <div>
                  <span>Signing</span>
                  <b className="num">{count(steps.length, 'step')}</b>
                </div>
              )}
              {result.reason && <p className="ca-sheet__note">{result.reason}</p>}
              {(() => {
                const values = search.seeds.map((x) => x.result?.perHour).filter((v): v is number => v !== undefined).sort((a, b) => b - a)
                if (values.length < 2) return null
                const spread = values[0] - values[values.length - 1]
                return (
                  <p className="ca-sheet__note num">
                    {formatNumber(result.moves, 0)} changes tried in {formatNumber(result.ms / 1000, 0)} s. Best of {values.length} searches; the others reached{' '}
                    {values
                      .slice(1)
                      .map((v) => formatNumber(o.keptPerHour + v, 1))
                      .join(', ')}
                    {spread < 0.05 ? ': all agree.' : spread < values[0] * 0.02 ? ': close, a solid answer.' : ': they differ, Thorough may find more.'}
                  </p>
                )
              })()}
            </div>
          )}
        </>
      )}

      {search.running ? (
        <button type="button" className="ca__ghost" onClick={search.stop}>
          Stop and keep the best so far
        </button>
      ) : (
        <>
          {shown.length > 0 && (
            <div className="ca-sheet__row">
              <button
                type="button"
                className="ca__ghost"
                disabled={saved}
                onClick={() => {
                  o.savePreset()
                  setSaved(true)
                }}
              >
                {saved ? 'Saved' : 'Save as preset'}
              </button>
              {mode === 'ready' && !nothingToDo && !finished && (
                <button type="button" className="ca__go" disabled={!canSign} onClick={() => void o.execute(state)}>
                  {busy ? 'Signing…' : state.failed ? `Resume at step ${steps.indexOf(state.failed) + 1}` : 'Apply'}
                </button>
              )}
              {mode === 'ready' && (finished || nothingToDo) && (
                <button type="button" className="ca__go" disabled={busy || !!o.walletShort || spectating} title={o.walletShort || undefined} onClick={() => void o.deployAll()}>
                  {o.pending === 'opt-deploy' ? 'Deploying…' : `Deploy ${shown.length}`}
                </button>
              )}
            </div>
          )}
          {mode === 'ready' && (state.done.length > 0 || state.failed) && (
            <ol className="ca-sheet__phases">
              {steps.map((s, i) => {
                const done = state.done.includes(s)
                return (
                  <li key={s} className={done ? 'is-done' : state.failed === s ? 'is-failed' : !done && state.done.length === i && busy ? 'is-now' : ''}>
                    <i>{done ? '✓' : i + 1}</i>
                    <span>{o.stepLabel(s)}</span>
                  </li>
                )
              })}
            </ol>
          )}
          <p className="ca-sheet__note">
            {spectating
              ? 'Read-only: not your account. The answer can still be saved as a preset in this browser.'
              : mode === 'all'
                ? 'A comparison, as if every division were home: save it as a preset and load it once they are back.'
                : nothingToDo
                  ? 'Your divisions at home already stand as the search would arrange them.'
                  : finished
                    ? 'Done: the army is rearranged.'
                    : 'Signed with your wallet, step by step. Divisions out on a mission stay as they are.'}
          </p>
          <div className="ca-sheet__row">
            <button type="button" className="ca__ghost" disabled={busy} onClick={() => search.start()}>
              Search again
            </button>
            <button type="button" className="ca__ghost" disabled={busy} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </>
  )
}

/* ---- Presets: load one, delete one ------------------------------------------------------------- */

function PresetsSheet({
  account,
  divisions,
  editable,
  spectating,
  onClose
}: {
  account: string
  divisions: Division[]
  editable: (d: Division) => boolean
  spectating: boolean
  onClose: () => void
}) {
  const p = usePresets(account, divisions, editable)
  const [confirm, setConfirm] = useState<string | null>(null)
  const remove = (x: Preset) => {
    p.save(p.presets.filter((y) => y.id !== x.id))
    setConfirm(null)
  }

  if (p.restoring && p.plan && p.diff) {
    const { plan, steps, state, finished, busy } = p
    return (
      <>
        <h4 className="ca-sheet__h">
          Load “{p.restoring.name}”
          <small className="num">{count(p.restoring.divisions.length, 'division')}</small>
        </h4>
        <div className="ca-sheet__changes">
          {plan.keep.length > 0 && (
            <div>
              <span>As they are</span>
              <b className="num">{count(plan.keep.length, 'division')}</b>
            </div>
          )}
          {p.targets.length > 0 && (
            <div>
              <span>Built or adjusted</span>
              <b className="num">{count(p.targets.length, 'division')}</b>
            </div>
          )}
          {plan.locked.length > 0 && (
            <div>
              <span>Out, can’t change</span>
              <b className="num">{count(plan.locked.length, 'division')}</b>
            </div>
          )}
        </div>
        {plan.skipped.map((s) => (
          <p key={s.division.leader} className="ca-sheet__warn">
            The division under {p.nameOf(s.division.leader)} is left out: {s.reason}.
          </p>
        ))}
        {plan.missing.length > 0 && <p className="ca-sheet__warn">No longer staked, so left out: {[...new Set(plan.missing.map(p.nameOf))].join(', ')}.</p>}
        {plan.held.length > 0 && (
          <p className="ca-sheet__note">
            {count(plan.held.length, 'card')} of the preset {plan.held.length === 1 ? 'is' : 'are'} in a division that is out and will be missing until it is back.
          </p>
        )}
        {steps.length === 0 ? (
          <p className="ca-sheet__note">The army already stands as this preset says, as far as it can right now. Nothing to sign.</p>
        ) : (
          <ol className="ca-sheet__phases">
            {steps.map((s, i) => {
              const done = state.done.includes(s)
              return (
                <li key={s} className={done ? 'is-done' : state.failed === s ? 'is-failed' : !done && state.done.length === i && busy ? 'is-now' : ''}>
                  <i>{done ? '✓' : i + 1}</i>
                  <span>{p.stepLabel(s)}</span>
                </li>
              )
            })}
          </ol>
        )}
        <div className="ca-sheet__row">
          <button
            type="button"
            className="ca__ghost"
            disabled={busy}
            onClick={() => {
              if (finished) return onClose()
              p.setRestoring(null)
              p.setPlan(null)
            }}
          >
            {finished ? 'Close' : 'Back'}
          </button>
          {steps.length > 0 && !finished && (
            <button type="button" className="ca__go" disabled={busy || spectating} onClick={() => void p.execute(state)}>
              {busy ? 'Signing…' : state.failed ? `Resume at step ${steps.indexOf(state.failed) + 1}` : 'Load it'}
            </button>
          )}
        </div>
        {finished && <p className="ca-sheet__note is-good">Done: “{p.restoring.name}” is back.</p>}
      </>
    )
  }

  return (
    <>
      <h4 className="ca-sheet__h">
        Presets <small className="num">{p.presets.length ? count(p.presets.length, 'preset') : ''}</small>
      </h4>
      <ul className="ca-sheet__presets">
        {p.presets.map((x) => {
          const now = isCurrent(x, divisions)
          const leaders = x.divisions.map((d) => p.cards.get(d.leader)).filter(Boolean).slice(0, 6)
          return (
            <li key={x.id} className="ca-preset">
              <span className="ca-preset__txt">
                <b>
                  {x.name}
                  {now && <em>the army now</em>}
                </b>
                <small className="num">
                  {count(x.divisions.length, 'division')} · {x.divisions.reduce((n, d) => n + d.units.length, 0)} mercenaries · {formatDateTimeShort(new Date(x.savedAt))}
                </small>
                <span className="ca-preset__pics">
                  {leaders.map((w, i) => (
                    <Portrait key={i} img={w!.img} rarity={w!.rarity} className="ca-preset__pic" />
                  ))}
                  {x.divisions.length > leaders.length && <small className="num">+{x.divisions.length - leaders.length}</small>}
                </span>
              </span>
              {confirm === x.id ? (
                <span className="ca-preset__acts">
                  <button type="button" className="ca__ghost is-bad" onClick={() => remove(x)}>
                    Delete
                  </button>
                  <button type="button" className="ca__ghost" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <span className="ca-preset__acts">
                  <button type="button" className="ca__ghost ca__icon" aria-label={`Delete ${x.name}`} onClick={() => setConfirm(x.id)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />
                    </svg>
                  </button>
                  <button type="button" className="ca__go is-small" disabled={now || spectating || !p.free} onClick={() => p.startRestore(x)}>
                    {now ? 'In place' : 'Load'}
                  </button>
                </span>
              )}
            </li>
          )
        })}
        {!p.presets.length && <p className="ca-sheet__note">No preset saved for {account} in this browser yet. Run the optimizer and save its answer, or save one on the Divisions page.</p>}
      </ul>
      <p className="ca-sheet__note">Presets live in this browser. Loading one signs only what differs; divisions out on a mission stay as they are.</p>
      <button type="button" className="ca__ghost" onClick={onClose}>
        Close
      </button>
    </>
  )
}
