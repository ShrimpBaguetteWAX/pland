import { useState, type CSSProperties, type FormEvent } from 'react'

import { toast } from '@/components/toast'
import { liveStats, type Division } from '@/data/game'
import { formatNumber } from '@/lib/format'
import { isCurrent, type Preset } from '@/lib/armyPresets'
import { formatDateTimeShort } from '@/lib/time'
import { GEAR_KINDS } from '@/lib/stats'
import { count, usePresets } from '@/lib/usePresets'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'

/*
 * Army presets: the army exactly as built, saved in this browser under the account, to come back
 * to with one click. Restoring signs only the differences: divisions that already stand as the
 * preset says are left alone, ones whose warlord the preset also uses are adjusted, the rest are
 * taken apart and the preset's other divisions raised. Divisions that are out cannot change and
 * stay; a preset division that needs one of their cards is left out, and said so.
 */


export function PresetsPanel({
  account,
  divisions,
  editable,
  spectating,
  onClose,
  onDone,
  onEdit
}: {
  account: string
  divisions: Division[]
  editable: (d: Division) => boolean
  spectating: boolean
  onClose: () => void
  onDone: () => void
  /** Open a preset on the army page to change it there. */
  onEdit: (preset: Preset) => void
}) {
  const { presets, save, current, overwrite, restoring, setRestoring, plan, setPlan, busy, free, cards, targets, diff, steps, state, finished, startRestore, execute, stepLabel, nameOf } = usePresets(account, divisions, editable)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const saveNew = (e: FormEvent) => {
    e.preventDefault()
    const label = name.trim() || `Preset ${presets.length + 1}`
    save([{ id: `${Date.now()}`, name: label, savedAt: Date.now(), divisions: current }, ...presets])
    setName('')
    toast.success(`"${label}" saved: ${count(current.length, 'division')}`)
  }
  const remove = (p: Preset) => {
    save(presets.filter((x) => x.id !== p.id))
    setConfirmDelete(null)
  }


  return (
    <section className="opt presets">
      <div className="box opt__head">
        <div className="opt__title">
          <h2>
            <Icon name="chest" /> {restoring ? `Restore "${restoring.name}"` : 'Division presets'}
          </h2>
          <span className="muted">
            {restoring ? 'What has to change to get back to it.' : 'The army exactly as built, saved in this browser, to come back to with one click.'}
          </span>
          <span className="gap" />
          {restoring ? (
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => (finished ? onDone() : (setRestoring(null), setPlan(null)))}>
              {finished ? 'Show the army' : 'Back to the presets'}
            </button>
          ) : (
            <button type="button" className="btn btn--sm" onClick={onClose}>
              Back to the army
            </button>
          )}
        </div>

        {!restoring && (
          <form className="presets__save" onSubmit={saveNew}>
            <input
              className="input"
              value={name}
              placeholder={`Preset ${presets.length + 1}`}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="btn btn--go" disabled={!current.length}>
              <Icon name="plus" /> Save the army as it is
            </button>
            <span className="muted">
              {count(current.length, 'division')} with a warlord{spectating ? ' · viewing read-only: presets save here, but cannot be restored' : ''}
            </span>
          </form>
        )}
      </div>

      {!restoring && (
        <div className="opt__list">
          {presets.map((p) => {
            const now = isCurrent(p, divisions)
            return (
              <div key={p.id} className="box preset">
                <div className="preset__text">
                  <b>
                    {p.name}
                    {now && <span className="od__tag is-kept">the army now</span>}
                  </b>
                  <small className="muted">
                    {count(p.divisions.length, 'division')} · {p.divisions.reduce((n, d) => n + d.units.length, 0)} mercenaries · saved{' '}
                    {formatDateTimeShort(new Date(p.savedAt))}
                  </small>
                  <span className="preset__leaders">
                    {p.divisions.map((d) => {
                      const w = cards.get(d.leader)
                      // The division as the preset has it, added up the contract's way from the cards known now.
                      const units = d.units.flatMap((x) => {
                        const asset = cards.get(x.merc)
                        if (!asset) return []
                        const gear: Division['units'][number]['gear'] = {}
                        for (const k of GEAR_KINDS) {
                          const g = x.gear[k] ? cards.get(x.gear[k]!) : undefined
                          if (g) gear[k] = g
                        }
                        return [{ asset, gear }]
                      })
                      const st = w ? liveStats(units, units.length, w) : null
                      return (
                        <span key={d.leader} className="od__u preset__div" style={{ '--rc': rarityColor(w?.rarity) } as CSSProperties} title={w ? `${w.name} · ${d.units.length} crew` : 'No longer staked'}>
                          <Portrait img={w?.img} rarity={w?.rarity} className="od__mini" />
                          <span>
                            {w?.name ?? 'gone'} · {d.units.length}
                            {st && (
                              <small className="trio">
                                <span className="c-atk">{formatNumber(st.atk, 0)}</span>
                                <span className="c-def">{formatNumber(st.def, 0)}</span>
                                <span className="c-move">{formatNumber(st.move, 0)}</span>
                              </small>
                            )}
                          </span>
                        </span>
                      )
                    })}
                  </span>
                </div>
                <div className="preset__acts">
                  {confirmDelete === p.id ? (
                    <>
                      <span className="c-bad">Delete it?</span>
                      <button type="button" className="btn btn--bad btn--sm" onClick={() => remove(p)}>
                        Delete
                      </button>
                      <button type="button" className="btn btn--sm" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn btn--sm" title="Delete this preset" onClick={() => setConfirmDelete(p.id)}>
                        <Icon name="x" size={14} />
                      </button>
                      <button type="button" className="btn btn--sm" disabled={now || !current.length} title="Replace it with the army as it is" onClick={() => overwrite(p)}>
                        Overwrite
                      </button>
                      <button type="button" className="btn btn--sm" title="Open it on the army page and change it there; nothing is signed until you restore it" onClick={() => onEdit(p)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn--go btn--sm" disabled={now || spectating || !free} onClick={() => startRestore(p)}>
                        {now ? 'In place' : 'Restore'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {!presets.length && <p className="none">No preset saved for {account} in this browser yet. Build the army you want, then save it above.</p>}
        </div>
      )}

      {restoring && plan && diff && (
        <>
          <div className="opt__list">
            {plan.keep.map((d) => (
              <div key={d.id} className="box preset">
                <div className="preset__text">
                  <b>
                    #{d.id} {d.leader?.name} <span className="od__tag is-kept">as it is</span>
                  </b>
                  <small className="muted">{count(d.units.length, 'mercenary', 'mercenaries')} · already stands as the preset says</small>
                </div>
              </div>
            ))}
            {targets.map((t) => {
              const existing = divisions.find((d) => d.leader?.assetId === t.warlord.assetId)
              const from = plan.build.find((b) => b.leader === t.warlord.assetId)
              const dropped = (from?.units.length ?? 0) - t.units.length
              return (
                <div key={t.warlord.assetId} className="box preset" style={{ '--rc': rarityColor(t.warlord.rarity) } as CSSProperties}>
                  <Portrait img={t.warlord.img} rarity={t.warlord.rarity} className="preset__pic" />
                  <div className="preset__text">
                    <b>
                      {t.warlord.name}{' '}
                      {existing ? <span className="od__tag">#{existing.id} adjusted</span> : <span className="od__tag is-new">new division</span>}
                    </b>
                    <small className="muted">
                      {count(t.units.length, 'mercenary', 'mercenaries')}, {t.units.reduce((n, u) => n + Object.keys(u.gear).length, 0)} gear
                      {dropped > 0 ? ` · ${count(dropped, 'mercenary', 'mercenaries')} of the preset cannot be had right now` : ''}
                    </small>
                  </div>
                </div>
              )
            })}
            {plan.skipped.map((s) => (
              <p key={s.division.leader} className="opt__warn">
                The division under {nameOf(s.division.leader)} is left out: {s.reason}.
              </p>
            ))}
            {plan.missing.length > 0 && (
              <p className="opt__warn">
                No longer staked, so left out: {[...new Set(plan.missing.map(nameOf))].join(', ')}.
              </p>
            )}
            {plan.held.length > 0 && (
              <p className="help">
                {count(plan.held.length, 'card')} of the preset {plan.held.length === 1 ? 'is' : 'are'} in a division that is out right now and will be missing until it is back.
              </p>
            )}
          </div>
          <div className="box opt__steps">
            {steps.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                The army already stands as this preset says, as far as it can right now. Nothing to sign.
              </p>
            ) : (
              <>
                <ol>
                  {steps.map((s, i) => {
                    const done = state.done.includes(s)
                    const now = !done && state.done.length === i && busy
                    return (
                      <li key={s} className={done ? 'is-done' : state.failed === s ? 'is-failed' : now ? 'is-now' : ''}>
                        <i>{done ? '✓' : i + 1}</i> {stepLabel(s)}
                      </li>
                    )
                  })}
                </ol>
                <div className="opt__foot">
                  {finished ? (
                    <span className="is-good">Done: &quot;{restoring.name}&quot; is back.</span>
                  ) : state.failed ? (
                    <>
                      <span className="c-bad">Step {steps.indexOf(state.failed) + 1} did not go through. The steps before it are done and stay done.</span>
                      <button type="button" className="btn btn--go" disabled={busy || spectating} onClick={() => void execute(state)}>
                        Resume at step {steps.indexOf(state.failed) + 1}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn btn--go" disabled={busy || spectating} onClick={() => void execute(state)}>
                        <Icon name="chest" />
                        {busy ? 'Signing…' : 'Restore the preset'}
                      </button>
                      <span className="muted">
                        {count(steps.length, 'transaction')}
                        {plan.locked.length ? ` · ${count(plan.locked.length, 'division')} out on a mission ${plan.locked.length === 1 ? 'stays' : 'stay'} as ${plan.locked.length === 1 ? 'it is' : 'they are'}` : ''}. Long steps are signed in parts of 25 actions.
                      </span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
