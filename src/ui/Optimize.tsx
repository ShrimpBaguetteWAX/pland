import { useEffect, useState, type CSSProperties } from 'react'

import { formatDuration, formatNumber } from '@/lib/format'
import { GEAR_KINDS, kindOf, missionLockSeconds, type GearKind } from '@/lib/stats'
import {
  EFFORT_LEVELS,
  GOALS,
  PHASE,
  PHASES,
  STORE_ALIGN,
  STORE_GOAL,
  STORE_OFF,
  STORE_WALLET,
  STORE_WEIGHT,
  STORE_WITHIN,
  useOptimizer,
  WEIGHTS,
  WITHIN,
  write,
  type ShownDivision
} from '@/lib/useOptimizer'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'

/*
 * Optimize the army: the arrangement of warlords, mercenaries and gear into divisions, each on a
 * mission, that earns the most TLM an hour (see lib/armySearch). Any account can be looked at;
 * only the signed-in one can have the result signed. "Ready divisions only" leaves divisions that
 * are out as they are and works with the rest; "all divisions" pretends everything were home, to
 * see whether the army as a whole is the best it could be.
 */


/** The plan's cards by name, for a short list. */
function grouped<T extends { name: string; templateId: string; rarity: string; img: string }>(list: T[]) {
  const m = new Map<string, { a: T; n: number }>()
  for (const a of list) {
    const g = m.get(a.templateId)
    if (g) g.n++
    else m.set(a.templateId, { a, n: 1 })
  }
  return [...m.values()]
}

/** Ids of cards still in the wallet, for the rows to say so. */
let walletIdsForRows = new Set<string>()

export function OptimizePanel({
  sessionAccount,
  spectating,
  initialAccount,
  onClose,
  onDone
}: {
  sessionAccount: string
  spectating: boolean
  initialAccount: string
  onClose: () => void
  /** The army was changed: show it, the given division first. */
  onDone: (divisionId: number | null) => void
}) {
  const [accountText, setAccountText] = useState(initialAccount)
  const [account, setAccount] = useState(initialAccount)
  const o = useOptimizer(account, { sessionAccount, spectating, onDone, potential: true })
  const { mode, setMode, alignMove, setAlignMove, effort, setEffort, off, setOff, includeWallet, setIncludeWallet, weightIx, setWeightIx, matchWeight, goalIx, setGoalIx, goalMin, matchGoal, withinIx, setWithinIx, withinGoalWeight, presetName, setPresetName, pick, setPick, army, walletNfts, walletCards, walletIds, pending, nftTlm, candidates, divisions, away, kept, keptPerHour, loading, input, inPlay, search, potential, result, balanced, showBalanced, balancedPending, shown, nowRows, nowTotal, bestTotal, gain, savePreset, own, diff, steps, state, finished, nothingToDo, busy, canSign, stepLabel, execute, deployAll, walletShort, triedRows, groups, toggleMission } = o
  walletIdsForRows = walletIds
  /** Find the best army with a new account typed: look it up, then start as soon as it is read. */
  const [startWhenReady, setStartWhenReady] = useState(false)
  const go = () => {
    if (!accountText) return
    if (accountText !== account) {
      setAccount(accountText)
      setStartWhenReady(true)
    } else search.start()
  }
  useEffect(() => {
    if (startWhenReady && input) {
      setStartWhenReady(false)
      search.start()
    }
    // search.start is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWhenReady, input])

  return (
    <section className="opt">
      <div className="box opt__head">
        <div className="opt__title">
          <h2>
            <Icon name="spark" /> Optimize the army
          </h2>
          <span className="muted">The arrangement of everything staked that earns the most TLM an hour from the missions on offer.</span>
          <span className="gap" />
          <button type="button" className="btn btn--sm" onClick={onClose} disabled={busy}>
            Back to the army
          </button>
        </div>
        <label className="opt__field opt__field--account">
          Account
          <input
            className="input"
            value={accountText}
            spellCheck={false}
            placeholder="any WAX account"
            onChange={(e) => setAccountText(e.target.value.trim().toLowerCase())}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </label>
        <div className="opt__controls">
          <span className="opt__field">
            Divisions
            <span className="seg">
              <button type="button" className={mode === 'ready' ? 'is-on' : ''} onClick={() => setMode('ready')} title="Divisions that are out stay as they are">
                Only ready ones
              </button>
              <button
                type="button"
                className={mode === 'all' ? 'is-on' : ''}
                onClick={() => setMode('all')}
                title="Every staked card, in a division or not, plus the wallet, as if all of it were home: the best army these cards can make, with as many divisions as the allowance permits"
              >
                Everything
              </button>
            </span>
          </span>
        </div>
        <div className="opt__toggles">
          <label className={`opt__toggle${includeWallet ? ' is-on' : ''}`} title="Game cards still in the wallet count too; the rebuild stakes the ones the plan uses first.">
            <input
              type="checkbox"
              checked={includeWallet}
              onChange={(e) => {
                setIncludeWallet(e.target.checked)
                write(STORE_WALLET, e.target.checked)
              }}
            />
            Wallet cards
            <small>{walletNfts.isLoading ? '…' : (walletNfts.data ?? []).filter((a) => kindOf(a.stats)).length}</small>
          </label>
          <label className={`opt__toggle${alignMove ? ' is-on' : ''}`} title="A second answer next to the best one: same divisions, cards shuffled so divisions of one mission length come back close together.">
            <input
              type="checkbox"
              checked={alignMove}
              onChange={(e) => {
                setAlignMove(e.target.checked)
                write(STORE_ALIGN, e.target.checked)
              }}
            />
            Also balance for move cost
          </label>
          <span className="opt__field">
            Effort
            <span className="seg">
              {EFFORT_LEVELS.map((l) => (
                <button key={l.key} type="button" className={effort === l.key ? 'is-on' : ''} title={l.what} onClick={() => setEffort(l.key)}>
                  {l.label}
                  {l.key === 'normal' ? ' ★' : ''}
                </button>
              ))}
            </span>
          </span>
          {alignMove && (
            <details className="opt__more">
              <summary>
                Balancing: within {goalMin < 1 ? '30 s' : `${goalMin} min`} · {Number.isFinite(matchWeight) ? `${matchWeight} TLM/h per point` : 'any price'} ·{' '}
                {withinGoalWeight === 0 ? 'stop at the goal' : `then ${withinGoalWeight}`}
              </summary>
              <div className="opt__sliders">
                <span className="opt__slider">
                  <span className="opt__slider-row">
                    <span>Goal: back within</span>
                    <b>{goalMin < 1 ? '30 s' : `${goalMin} min`}</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={GOALS.length - 1}
                    step={1}
                    value={goalIx}
                    onChange={(e) => {
                      const ix = Number(e.target.value)
                      setGoalIx(ix)
                      write(STORE_GOAL, ix)
                    }}
                  />
                </span>
                <span className="opt__slider">
                  <span className="opt__slider-row">
                    <span>Income it may give up per move point, beyond the goal</span>
                    <b>{Number.isFinite(matchWeight) ? `${matchWeight} TLM / h` : 'any price'}</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={WEIGHTS.length - 1}
                    step={1}
                    value={weightIx}
                    onChange={(e) => {
                      const ix = Number(e.target.value)
                      setWeightIx(ix)
                      write(STORE_WEIGHT, ix)
                    }}
                  />
                </span>
                <span className="opt__slider">
                  <span className="opt__slider-row">
                    <span>Within the goal, keep tightening if a point costs at most</span>
                    <b>{withinGoalWeight === 0 ? 'nothing' : `${withinGoalWeight} TLM / h`}</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={WITHIN.length - 1}
                    step={1}
                    value={withinIx}
                    onChange={(e) => {
                      const ix = Number(e.target.value)
                      setWithinIx(ix)
                      write(STORE_WITHIN, ix)
                    }}
                  />
                </span>
              </div>
              <p className="help">
                Earnings always assume each division is claimed as soon as it is back. Balancing brings the divisions of each mission length as close
                together in move cost as the cards allow, at any price until the goal is reached by default; it never drops a real division, only
                small side divisions may come and go.
              </p>
            </details>
          )}
          {candidates.length > 0 && (
            <details className="opt__more">
              <summary>
                Missions: {candidates.length - off.size} of {candidates.length} allowed
              </summary>
              <span className="opt__chips">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={off.size === 0}
                  onClick={() => {
                    setOff(new Set())
                    write(STORE_OFF, [])
                  }}
                >
                  All
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={off.size >= candidates.length}
                  onClick={() => {
                    const all = new Set(candidates.map((m) => m.id))
                    setOff(all)
                    write(STORE_OFF, [...all])
                  }}
                >
                  None
                </button>
                {candidates.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`opt__chip${off.has(m.id) ? '' : ' is-on'}`}
                    title={nftTlm.has(m.id) ? `Its NFT reward counts at its floor: ≈ ${formatNumber(nftTlm.get(m.id)!, 0)} TLM a cycle` : undefined}
                    onClick={() => toggleMission(m.id)}
                  >
                    {m.title}
                    {nftTlm.has(m.id) && <small> · NFT ≈ {formatNumber(nftTlm.get(m.id)!, 0)} TLM</small>}
                  </button>
                ))}
              </span>
              <p className="help">
                Click a mission to leave it out. Missions, requirements and rewards come from the chain each time. NFT rewards count
                at their floor (the cheapest listing, swapped to TLM), as on the Missions page; an NFT with no listing counts for
                nothing.
              </p>
            </details>
          )}
        </div>
        <div className="opt__run">
          {search.running ? (
            <button type="button" className="btn" onClick={search.stop}>
              Stop and keep the best so far
            </button>
          ) : (
            <button type="button" className="btn btn--go" disabled={!accountText || (accountText === account && (loading || !input))} onClick={go}>
              <Icon name="spark" />
              {startWhenReady ? 'Reading…' : search.done && accountText === account ? 'Search again' : 'Find the best army'}
            </button>
          )}
          <span className="muted">
            {loading
              ? `Reading ${account}…`
              : army.isError
                ? `Could not read ${account}.`
                : `${divisions.length} division${divisions.length === 1 ? '' : 's'}, ${away.length} out${mode === 'ready' && away.length ? ' (kept as they are)' : ''} · in play: ${inPlay.divisions} cards in divisions, ${inPlay.reserve} in the reserve${walletCards.length ? `, ${walletCards.length} in the wallet` : ''} · up to ${input?.maxDivisions ?? 0} division${input?.maxDivisions === 1 ? '' : 's'}.`}
            {search.error && <b className="c-bad"> {search.error}</b>}
          </span>
        </div>
      </div>

      {!loading && !army.isError && (
        <div className="box opt__compare">
          <div className="opt__fig">
            <small>Now</small>
            <b>
              {nowTotal === null ? '…' : formatNumber(nowTotal, 1)}
              <em>TLM / h</em>
            </b>
            <small>{divisions.filter((d) => d.units.length).length} divisions with crew</small>
          </div>
          <span className="opt__arrow">→</span>
          <div className="opt__fig">
            <small>{search.running ? 'Best so far' : 'Optimized'}</small>
            <b>
              {bestTotal === null ? (search.running ? '…' : '–') : formatNumber(bestTotal, 1)}
              <em>TLM / h</em>
            </b>
            {bestTotal === null && !search.running && <span className="gain muted">press Find the best army</span>}
            {gain !== null && (
              <span className={`gain ${gain > 0.05 ? 'is-good' : 'muted'}`}>
                {gain > 0.05
                  ? `+${formatNumber(gain, 1)} TLM / h`
                  : result?.reason
                    ? 'nothing to rearrange'
                    : alignMove && gain < -0.05
                      ? `${formatNumber(gain, 1)} TLM / h, for matched move costs`
                      : 'nothing better found'}
                {result ? ` · ${kept.length + result.divisions.length} divisions` : ''}
              </span>
            )}
          </div>
          {search.stale && (search.running || search.done) && (
            <div className="opt__progress opt__stale">
              <span>
                <b>Prices or cards changed since this search started.</b> It keeps working on what it read then; search again for today&apos;s numbers.
              </span>
              <button type="button" className="btn btn--sm" onClick={() => search.start()}>
                Search again
              </button>
            </div>
          )}
          {search.done && search.seeds.length > 1 && (() => {
            const values = search.seeds.map((s) => s.result?.perHour).filter((v): v is number => v !== undefined).sort((a, b) => b - a)
            if (values.length < 2) return null
            const spread = values[0] - values[values.length - 1]
            return (
              <div className="opt__progress opt__seeds">
                <span>
                  <b>Best of {values.length} searches:</b> {formatNumber(keptPerHour + values[0], 1)} TLM / h · the others reached{' '}
                  {values
                    .slice(1)
                    .map((v) => formatNumber(keptPerHour + v, 1))
                    .join(', ')}
                  {spread < 0.05 ? ' — all agree, a solid answer.' : spread < values[0] * 0.02 ? ' — close, the answer is solid.' : ' — they differ: Thorough may find more.'}
                </span>
              </div>
            )
          })()}
          {balanced && !search.running && (
            <div className="opt__progress opt__balanced">
              <span>
                <b>Balanced for move cost:</b> {formatNumber(keptPerHour + balanced.perHour, 1)} TLM / h
                {bestTotal !== null ? ` (${formatNumber(keptPerHour + balanced.perHour - bestTotal, 1)} against the best)` : ''} · {balanced.divisions.length} divisions
              </span>
            </div>
          )}
          {(search.running || search.done) && (
            <ol className="opt__phases">
              {PHASES.filter((p) => alignMove || !p.balancingOnly).map((p, i, list) => {
                const at = search.running ? list.findIndex((x) => x.id === search.progress?.phase) : list.length
                const state = i < at ? 'is-done' : i === at ? 'is-now' : ''
                return (
                  <li key={p.id} className={state} title={p.what}>
                    <i>{i < at ? '✓' : i + 1}</i>
                    <span>{p.label}</span>
                  </li>
                )
              })}
            </ol>
          )}
          {search.running && search.progress && (
            <div className="opt__progress">
              <span>
                <b>{PHASES.find((p) => p.id === search.progress!.phase)?.label ?? search.progress.phase}:</b> {PHASE[search.progress.phase] ?? ''}{' '}
                {(() => {
                  const list = PHASES.filter((p) => alignMove || !p.balancingOnly)
                  const next = list[list.findIndex((x) => x.id === search.progress!.phase) + 1]
                  return next ? `Next: ${next.label.toLowerCase()}.` : ''
                })()}{' '}
                {formatNumber(search.progress.moves, 0)} changes tried by {search.seeds.length} searches side by side · {formatNumber(search.progress.ms / 1000, 0)} s ·
                Stop keeps the best so far
              </span>
              <span className={`opt__bar${search.progress.pct < 0 ? ' is-endless' : ''}`}>
                <i style={search.progress.pct < 0 ? undefined : { width: `${Math.max(2, search.progress.pct * 100)}%` }} />
              </span>
            </div>
          )}
          {result && !search.running && result.reason && (
            <div className="opt__progress">
              <span className="muted">{result.reason}</span>
            </div>
          )}
          {result && !search.running && !result.reason && (
            <div className="opt__progress">
              <span className="muted">
                {formatNumber(result.moves, 0)} changes tried in {formatNumber(result.ms / 1000, 0)} s
                {result.converged ? ' · nothing more was found in the last rounds' : ' · stopped at the time limit; more time may find a little more'}
                {result.greedyPerHour > result.nowPerHour + 0.05 && result.perHour > result.greedyPerHour + 0.05
                  ? ` · building division by division, the old way, reaches ${formatNumber(keptPerHour + result.greedyPerHour, 1)}`
                  : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {!loading && (
        <div className="box opt__tried">
          <span className="group__h">
            What this wallet can field at once · every division rebuilt from all its cards, and the whole-army TLM / h with that many
          </span>
          {potential.running ? (
            <span className="muted">Working it out…{potential.tried.length ? ' (updating)' : ''}</span>
          ) : potential.error ? (
            <span className="c-bad">{potential.error}</span>
          ) : !potential.tried.length ? (
            <span className="muted">No paying mission this wallet can field.</span>
          ) : (
            <div className="opt__tried-list">
              {potential.tried.map((t) => (
                <span key={t.mission.id} className="opt__try">
                  <b>
                    {t.count} × {t.mission.title}
                  </b>
                  <small>{formatNumber(t.perHour, 1)} TLM / h</small>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && triedRows.length > 0 && (
        <div className="box opt__tried">
          <span className="group__h">
            {result
              ? 'What was tried · the most divisions of each mission the search managed to field at once, and the best whole-army TLM / h with that many'
              : 'What the army fields now · divisions that meet each mission, and the TLM / h it earns'}
          </span>
          <div className="opt__tried-list">
            {triedRows.map((t) => (
              <span key={t.mission.id} className="opt__try">
                <b>
                  {t.count} × {t.mission.title}
                </b>
                <small>{formatNumber(t.perHour, 1)} TLM / h</small>
              </span>
            ))}
          </div>
        </div>
      )}

      {!loading && mode === 'ready' && away.length > 0 && (
        <p className="notice notice--read opt__kept">
          <Icon name="lock" size={16} />
          <span>
            {away.length} of {divisions.length} division{divisions.length === 1 ? ' is' : 's are'} out and stay{away.length === 1 ? 's' : ''} exactly as {away.length === 1 ? 'it is' : 'they are'}; only the reserve ({inPlay.reserve} cards){walletCards.length ? ` and the wallet (${walletCards.length})` : ''} can be rearranged right now.
            {potential.perHour !== null && bestTotal !== null && potential.perHour > bestTotal + 5
              ? ` With everything home, these cards could reach about ${formatNumber(potential.perHour, 0)} TLM / h: switch to Everything to see that army.`
              : ' Everything shows what the whole army could do.'}
          </span>
        </p>
      )}

      {showBalanced && !search.running && balanced!.note && (
        <p className="notice notice--read opt__kept">
          <Icon name="lock" size={16} />
          <span>{balanced!.note}</span>
        </p>
      )}
      {showBalanced &&
        balanced!.warnings.map((w) => (
          <p key={w} className="opt__warn">
            {w}
          </p>
        ))}
      {result?.warnings.map((w) => (
        <p key={w} className="opt__warn">
          {w}
        </p>
      ))}

      {result && groups.length > 0 && (
        <p className="opt__groups">
          <b className="opt__groups-which">{showBalanced ? 'Balanced for move cost' : 'Best TLM / h (not matched for move)'}:</b>{' '}
          {groups.map((g) => (
            <span key={g.base}>
              <b>{formatDuration(g.base)} missions</b>: {g.moves.length} division{g.moves.length === 1 ? '' : 's'}
              {g.out ? ` (+${g.out} out now)` : ''} at {g.max - g.min <= 3 ? `${g.max} move` : `${g.min}–${g.max} move, ${g.max - g.min} apart (${formatDuration((g.max - g.min) * 10)})`}
              {g.max - g.min <= matchGoal ? ' · within the goal' : showBalanced ? ' · the goal was not reached' : ' · beyond the goal (see Balanced for move cost)'}.{' '}
            </span>
          ))}
        </p>
      )}

      {result && (
        <div className="opt__list">
          <div className="opt__pickbar">
            <span className="group__h">
              {pick === 'now'
                ? `Your divisions as they are now · ${nowTotal === null ? '…' : formatNumber(nowTotal, 1)} TLM / h · nothing here is signed`
                : pick === 'balanced'
                  ? balancedPending
                    ? 'Balanced for move cost · comes after the rearrange'
                    : `Balanced for move cost · ${search.running ? 'the best so far, still balancing' : 'what gets signed if you rearrange now'}`
                  : `Best TLM / h · ${search.running ? 'the best so far, still searching' : 'what gets signed if you rearrange now'}`}
            </span>
            <span className="seg seg--pick">
              <button type="button" className={pick === 'now' ? 'is-on' : ''} onClick={() => setPick('now')}>
                Now
                <small className="seg__value">{nowTotal === null ? '…' : `${formatNumber(nowTotal, 1)} TLM / h`}</small>
              </button>
              <button type="button" className={pick === 'best' ? 'is-on' : ''} onClick={() => setPick('best')}>
                Best TLM / h
                <small className="seg__value">
                  {bestTotal === null ? '…' : `${formatNumber(bestTotal, 1)} TLM / h`}
                  {search.running ? ' so far' : ''}
                </small>
              </button>
              {(balanced || alignMove) && (
                <button type="button" className={pick === 'balanced' ? 'is-on' : ''} onClick={() => setPick('balanced')}>
                  Balanced for move cost
                  <small className="seg__value">
                    {balanced
                      ? `${formatNumber(keptPerHour + balanced.perHour, 1)} TLM / h${search.running ? ' so far' : balanced.goalReached === false ? ' · goal not reached' : balanced.goalReached ? ' · within the goal' : ''}`
                      : search.running
                        ? 'after the rearrange'
                        : '–'}
                  </small>
                </button>
              )}
            </span>
          </div>
          {pick === 'now' && nowRows.map((d) => <PlannedRow key={d.warlord.assetId} d={d} />)}
          {pick === 'now' && !nowRows.length && <p className="none">No divisions yet.</p>}
          {pick !== 'now' &&
            shown.map((d) => (
              <PlannedRow key={d.warlord.assetId} d={d} />
            ))}
          {balancedPending && (
            <p className="none">
              {search.running
                ? 'Balancing starts once the rearrange and polish are done; the balanced army shows here as soon as it is found, and keeps updating.'
                : 'No balanced army: switch on Also balance for move cost and search again.'}
            </p>
          )}
          {pick !== 'now' && !balancedPending && !shown.length && (
            <p className="none">
              {input && input.maxDivisions <= 0
                ? 'Every division place is taken by a division that is out right now.'
                : 'No staked warlord and mercenaries together reach a mission that pays TLM among the ones allowed.'}
            </p>
          )}
        </div>
      )}

      {result && search.done && pick !== 'now' && shown.length > 0 && (
        <form
          className="box opt__save"
          onSubmit={(e) => {
            e.preventDefault()
            savePreset()
          }}
        >
          <span className="group__h">Keep this army as a preset</span>
          <input className="input" value={presetName} placeholder={`Optimized ${showBalanced ? '(balanced)' : ''}`.trim()} maxLength={40} onChange={(e) => setPresetName(e.target.value)} />
          <button type="submit" className="btn btn--sm">
            <Icon name="chest" size={16} /> Save as preset
          </button>
          <span className="muted">
            {kept.length ? `With the ${kept.length} division${kept.length === 1 ? '' : 's'} that stay as they are. ` : ''}Restore it any time from Presets.
          </span>
        </form>
      )}

      {result && search.done && pick !== 'now' && (
        <div className="box opt__steps">
          {mode === 'all' ? (
            <p className="muted" style={{ margin: 0 }}>
              This is the best army all these cards can make, as if everything were home: a comparison only. Switch to <b>Only ready ones</b> to rearrange what can be rearranged now.
            </p>
          ) : !own ? (
            <p className="muted" style={{ margin: 0 }}>
              This is {account}&apos;s army. Only the signed-in account&apos;s army can be changed from here.
            </p>
          ) : nothingToDo ? (
            <p className="muted" style={{ margin: 0 }}>
              Your divisions at home are already arranged the way the search would arrange them. Nothing to sign.
            </p>
          ) : (
            <>
              <ol>
                {steps.map((s, i) => {
                  const done = state.done.includes(s)
                  const current = !done && state.done.length === i && busy
                  return (
                    <li key={s} className={done ? 'is-done' : state.failed === s ? 'is-failed' : current ? 'is-now' : ''}>
                      <i>{done ? '✓' : i + 1}</i> {stepLabel(s)}
                    </li>
                  )
                })}
              </ol>
              <div className="opt__foot">
                {finished ? (
                  <span className="is-good">Done: the army is rearranged.</span>
                ) : state.failed ? (
                  <>
                    <span className="c-bad">Step {steps.indexOf(state.failed) + 1} did not go through. The steps before it are done and stay done.</span>
                    <button type="button" className="btn btn--go" disabled={!canSign} onClick={() => void execute(state)}>
                      Resume at step {steps.indexOf(state.failed) + 1}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--go" disabled={!canSign} onClick={() => void execute(state)}>
                      <Icon name="army" />
                      {busy ? 'Signing…' : 'Rearrange the army'}
                    </button>
                    <span className="muted">
                      {steps.length} transaction{steps.length === 1 ? '' : 's'}
                      {diff && diff.changed.length < shown.length ? ` · ${shown.length - diff.changed.length} division${shown.length - diff.changed.length === 1 ? ' stays' : 's stay'} as they are` : ''}
                      . Long steps are signed in parts of 25 actions.
                    </span>
                  </>
                )}
              </div>
            </>
          )}
          {own && mode === 'ready' && (finished || nothingToDo) && shown.length > 0 && (
            <div className="opt__foot">
              <button type="button" className="btn btn--go" disabled={busy || !!walletShort} title={walletShort || undefined} onClick={() => void deployAll()}>
                <Icon name="rocket" />
                {pending === 'opt-deploy' ? 'Deploying…' : `Deploy ${shown.length} division${shown.length === 1 ? '' : 's'} to their missions`}
              </button>
              <span className="muted">{walletShort || 'One transaction per division. Entry fees come from your game balance where it covers them.'}</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** A planned division, or one of the player's own shown the same way (then it may have no paying mission, and says where it is). */

function PlannedRow({ d }: { d: ShownDivision }) {
  const mercs = grouped(d.units.map((u) => u.merc))
  const gear = grouped(GEAR_KINDS.flatMap((k: GearKind) => d.units.flatMap((u) => (u.gear[k] ? [u.gear[k]!] : []))))
  const lock = d.mission ? missionLockSeconds(d.mission.cooldownBase, d.pace) : null
  return (
    <div className="box od" style={{ '--rc': rarityColor(d.warlord.rarity) } as CSSProperties}>
      <Portrait img={d.warlord.img} rarity={d.warlord.rarity} className="od__pic" />
      <div className="od__body">
        <div className="od__top">
          <b>{d.mission?.title ?? (d.units.length ? 'No mission pays for this division' : 'No crew')}</b>
          {d.mission && (
            <span className="muted">
              needs {formatNumber(d.mission.minAtk, 0)} atk{d.mission.minDef ? ` · ${formatNumber(d.mission.minDef, 0)} def` : ''}
            </span>
          )}
          {d.tag ? (
            <span className="od__tag is-kept">
              #{d.existingId} · {d.tag}
            </span>
          ) : d.unchanged ? (
            <span className="od__tag is-kept">#{d.existingId} as it is</span>
          ) : d.existingId !== undefined ? (
            <span className="od__tag">#{d.existingId} adjusted</span>
          ) : (
            <span className="od__tag is-new">new division</span>
          )}
        </div>
        <div className="od__meta">
          <span>
            <b>{d.warlord.name}</b> · {d.units.length} of {d.warlord.stats?.slots_max} crew · {gear.reduce((n, g) => n + g.n, 0)} gear
          </span>
          <span className="c-atk">{formatNumber(d.atk, 0)} atk</span>
          <span className="c-def">{formatNumber(d.def, 0)} def</span>
          <span className="c-move">{formatNumber(d.move, 0)} move</span>
          {lock !== null && <span>back in {formatDuration(lock)}</span>}
          {(() => {
            const n = [d.warlord, ...d.units.flatMap((x) => [x.merc, ...GEAR_KINDS.flatMap((k) => (x.gear[k] ? [x.gear[k]!] : []))])].filter((a) => walletIdsForRows.has(a.assetId)).length
            return n ? <span className="c-move">{n} from the wallet, staked first</span> : null
          })()}
        </div>
        <div className="od__crew">
          {mercs.map(({ a, n }) => (
            <span key={a.templateId} className="od__u" style={{ '--rc': rarityColor(a.rarity) } as CSSProperties}>
              <Portrait img={a.img} rarity={a.rarity} className="od__mini" />
              {a.name}
              {n > 1 && <em className="times">×{n}</em>}
            </span>
          ))}
          {gear.map(({ a, n }) => (
            <span key={a.templateId} className="od__u is-gear" style={{ '--rc': rarityColor(a.rarity) } as CSSProperties}>
              <Portrait img={a.img} rarity={a.rarity} className="od__mini" />
              {a.name}
              {n > 1 && <em className="times">×{n}</em>}
            </span>
          ))}
        </div>
      </div>
      <div className="od__rate">
        <b>{d.mission ? `+${formatNumber(d.perHour, 1)}` : '–'}</b>
        <small>TLM / h</small>
      </div>
    </div>
  )
}
