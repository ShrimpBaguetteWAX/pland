import { useCallback, useEffect, useState } from 'react'

import { toast } from '@/components/toast'
import { useMiningMode } from '@/mining/mode'
import type { MiningMode } from '@/mining/types'
import { useSession } from '@/state/session'
import { AUTO_GROUPS, AUTO_SIGN_PERMISSION, actionKey, saveActions, savedActions } from '@/wallet/autoSign'
import {
  autoSignStatus,
  disableAutoSign,
  enableAutoSign,
  formatTransactError,
  isUserCancel,
  reloadAutoSign,
  syncAutoSign,
  type AutoSignStatus
} from '@/wallet/session'

/*
 * Settings: which favourite land the Mine button picks, and which game actions the site may sign by
 * itself. Auto-sign works as on the old deck: a key kept in this browser, added to the account under
 * its own permission and linked only to the actions ticked here; everything else still asks the
 * wallet. Turning it on, changing the actions while it is on, and turning it off each ask the
 * wallet once.
 */

const STATE_LABEL: Record<AutoSignStatus['state'], string> = {
  active: 'On',
  inactive: 'On for another device, not this one',
  // Only a browser without its own key can see this: another device set it up with other actions.
  mismatch: 'On for another device, with other actions',
  'not-setup': 'Off'
}

const MODES: { key: MiningMode; title: string; sub: string }[] = [
  { key: 'tlm', title: 'Favourite lands by TLM', sub: 'Mines the ready favourite land that pays the most TLM.' },
  { key: 'shard', title: 'Favourite lands by Shards', sub: 'Mines the ready favourite land that pays the most shards.' }
]

export function Settings() {
  const account = useSession((s) => s.account)
  const spectating = useSession((s) => s.spectating)
  const [picked, setPicked] = useState<string[]>(savedActions)
  const [saved, setSaved] = useState<string[]>(savedActions)
  const [status, setStatus] = useState<AutoSignStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const mode = useMiningMode((s) => s.mode)
  const setMode = useMiningMode((s) => s.setMode)

  const canSign = !!account && !spectating
  const refresh = useCallback(async () => {
    if (!canSign) return
    try {
      setStatus(await autoSignStatus())
      // The status read brings the actions in line with the chain (another device may have changed them).
      const now = savedActions()
      setPicked(now)
      setSaved(now)
    } catch {
      setStatus(null)
    }
  }, [canSign])
  useEffect(() => {
    void refresh()
  }, [refresh, account])

  const changed = picked.length !== saved.length || picked.some((k) => !saved.includes(k))
  const on = status?.state === 'active' || status?.state === 'mismatch'

  /** Runs one wallet step, then reads the status again; a cancelled prompt is not an error. */
  async function step(key: string, work: () => Promise<void>, success: string) {
    setBusy(key)
    try {
      await work()
      toast.success(success)
    } catch (err) {
      if (!isUserCancel(err)) toast.error(formatTransactError(err))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  /** Keeps the picked actions in this browser; with auto-signing on, links them on chain too. */
  async function save() {
    saveActions(picked)
    setSaved(picked)
    await step(
      'save',
      async () => {
        await reloadAutoSign()
        if (on) await syncAutoSign()
      },
      on ? 'Auto-sign actions updated' : 'Saved'
    )
  }

  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))

  return (
    <main className="set wrap">
      <section className="box set__card">
        <h3 className="h">
          Mine button
          <small>which of your WAX Mission Control favourite lands it picks</small>
        </h3>
        <div className="set__modes" role="radiogroup" aria-label="Mining mode">
          {MODES.map((m) => (
            <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} className={`set__mode${mode === m.key ? ' is-on' : ''}`} onClick={() => setMode(m.key)}>
              <span className="set__radio" aria-hidden="true" />
              <span>
                <b>{m.title}</b>
                <small>{m.sub}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="help">Your favourites are kept with your Mission Control membership, so the list is the same there and here. The choice is kept in this browser.</p>
      </section>

      <section className="box set__card">
        <div className="set__status">
          <div>
            <h3 className="h">
              Auto-sign
              <span className={`pill ${on ? 'is-met' : status?.state === 'inactive' ? 'is-fund' : ''}`}>{status ? STATE_LABEL[status.state] : canSign ? '…' : 'Off'}</span>
            </h3>
            <p className="set__lead">
              The site signs the actions you tick below by itself, with a key kept in this browser and added to your account as the <code>{AUTO_SIGN_PERMISSION}</code>{' '}
              permission. Everything else still asks your wallet.
            </p>
            <p className="help">
              Each phone or computer gets its own key under the same permission: turn it on in every browser you play in. Turning it off removes only this
              browser&apos;s key. The actions are shared: changing them here changes them for every device.
            </p>
            {status?.publicKey && (
              <p className="help">
                Key <code>{status.publicKey}</code>
              </p>
            )}
          </div>
          <div className="set__btns">
            {!canSign ? (
              <span className="muted">{spectating ? 'Viewing another account read-only.' : 'Sign in with your wallet to set it up.'}</span>
            ) : on ? (
              <button type="button" className="btn" disabled={!!busy} onClick={() => void step('off', disableAutoSign, 'Auto-sign turned off')}>
                {busy === 'off' ? 'Signing…' : 'Turn off'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--go"
                disabled={!!busy || changed || !saved.length}
                title={changed ? 'Save the actions first' : !saved.length ? 'Tick at least one action and save' : undefined}
                onClick={() => void step('on', enableAutoSign, 'Auto-sign is on')}
              >
                {busy === 'on' ? 'Signing…' : status?.state === 'inactive' || status?.state === 'mismatch' ? 'Add this device' : 'Turn on'}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="box set__card">
        <h3 className="h">
          Actions the site may sign
          <button type="button" className={`btn btn--sm h__end${changed ? ' btn--go' : ''}`} disabled={!changed || !!busy} onClick={() => void save()}>
            {busy === 'save' ? 'Saving…' : on ? 'Save and update' : 'Save'}
          </button>
        </h3>
        <div className="set__groups">
          {AUTO_GROUPS.map((g) => (
            <fieldset key={g.title} className="set__group">
              <legend>{g.title}</legend>
              {g.actions.map((a) => {
                const key = actionKey(a)
                return (
                  <label key={key} className={`set__action${a.warning ? ' is-risky' : ''}`}>
                    <input type="checkbox" checked={picked.includes(key)} onChange={() => toggle(key)} />
                    <span>
                      {a.label}
                      <code>
                        {a.contract}::{a.action}
                      </code>
                      {a.warning && <small>{a.warning}</small>}
                    </span>
                  </label>
                )
              })}
            </fieldset>
          ))}
        </div>
        <p className="help">
          A transaction is signed by itself only when every action in it is ticked here. The key lives in this browser only; clearing its data turns auto-sign off
          here.
        </p>
      </section>
    </main>
  )
}
