import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import type { AnyAction } from '@wharfkit/session'

import { addUnit, assignGear, createDivision, deleteDivision, removeUnit, stakeAssets, unassignGear } from '@/chain/actions/pd'
import { divisionAllowance } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import { useArmy, useDeployments, usePlayer, useWalletNfts, type Division, type Unit } from '@/data/game'
import { formatNumber } from '@/lib/format'
import { GEAR_KINDS, kindOf, power, unitTotals, type GearKind, type Kind } from '@/lib/stats'
import { shortDuration, useClockFor } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import { Portrait, rarityColor } from './Art'
import { Icon } from './icons'
import { DeployPanel } from './DeployPanel'
import { divisionState } from './divisionState'
import { MissionBuilder } from './MissionBuilder'
import { OptimizePanel } from './Optimize'
import { PresetsPanel } from './Presets'
import { StarRail } from './Stars'
import { readPresets, writePresets, type Preset, type PresetDivision } from '@/lib/armyPresets'
import { presetCreate, presetDisband, presetDismiss, presetEquip, presetMoveGear, presetRecruit, presetTakeOff, virtualArmy } from '@/lib/presetEdit'
import { toast } from '@/components/toast'

/*
 * The army, on one screen: the divisions on the left, the chosen division and its crew in the
 * middle, and on the right whatever the crew is being fitted with. Every mercenary shows its four
 * gear sockets on its card; picking a socket opens that slot's spare gear on the right, and an
 * item can also be dragged onto any socket, and a mercenary onto another division in the list,
 * gear and all. Nothing opens over the page.
 */

const GEAR_LABEL: Record<GearKind, string> = { weapon: 'Equipment', supply: 'Supply', creature: 'Creature', lavalux: 'Lava Lux' }

/** Which Forge purchase caps each gear kind across the whole army; creatures need no slot. */
const GEAR_POWERUP: Record<GearKind, string | null> = { weapon: 'eqpslot', supply: 'supslot', creature: null, lavalux: 'lavaslot' }

const GEAR_HELP: Record<GearKind, string> = {
  weapon: 'Equipment adds flat attack and defense. Each piece needs a free equipment slot from the Forge.',
  supply: 'A supply adds attack and defense and lowers this mercenary’s move cost, so its missions cool down faster. Needs a supply slot.',
  creature: 'A creature adds attack and defense. Higher tiers need a higher forge level; no slot purchase needed.',
  lavalux: 'A Lava Lux pass multiplies attack and defense (×1.16 to ×1.70) and also raises move cost. Best on your strongest mercenaries. Needs a Lava Lux slot.'
}

/** Empty crew places drawn as cards; the rest are counted in one more card. */
const EMPTY_CARDS = 5

type Side = 'gear' | 'recruit' | 'stake'

/** Something on its way somewhere: an NFT from a list, or a mercenary leaving its division. */
interface Dragged {
  a: AssetRef
  /** A mercenary leaving its division. */
  from?: { unit: Unit; division: Division }
  /** Gear taken off a mercenary's socket: onto another one it moves, anywhere else it comes off. */
  gear?: { unit: Unit; kind: GearKind }
}

const totalsOf = (u: Unit, gear: Unit['gear'] = u.gear) =>
  unitTotals({
    unit: u.asset.stats,
    weapon: gear.weapon?.stats,
    supply: gear.supply?.stats,
    creature: gear.creature?.stats,
    lavalux: gear.lavalux?.stats
  })

const unitPower = (u: Unit) => {
  const t = totalsOf(u)
  return t.atk + t.def
}

/** Several NFTs of one template, shown once with a count. */
interface Stack {
  first: AssetRef
  all: AssetRef[]
}
function stacks(list: AssetRef[], rank: (a: AssetRef) => number): Stack[] {
  const m = new Map<string, Stack>()
  for (const a of list) {
    const s = m.get(a.templateId)
    if (s) s.all.push(a)
    else m.set(a.templateId, { first: a, all: [a] })
  }
  return [...m.values()].sort((x, y) => rank(y.first) - rank(x.first) || x.first.name.localeCompare(y.first.name))
}

/** What one piece of gear does, in the units the cards use. */
function effectOf(a: AssetRef) {
  const s = a.stats
  if (!s) return []
  const kind = kindOf(s)
  if (kind === 'lavalux') {
    const out: { cls: string; text: string }[] = []
    if (s.attack_mult_bp) out.push({ cls: 'c-atk', text: `×${(s.attack_mult_bp / 10000).toFixed(2)}` })
    if (s.defense_mult_bp) out.push({ cls: 'c-def', text: `×${(s.defense_mult_bp / 10000).toFixed(2)}` })
    if (s.movecost_mult_bp) out.push({ cls: 'c-move', text: `×${(s.movecost_mult_bp / 10000).toFixed(2)}` })
    return out
  }
  return [
    { cls: 'c-atk', text: `+${s.attack}` },
    { cls: 'c-def', text: `+${s.defense}` },
    ...(s.movecost_reduction ? [{ cls: 'c-move', text: `−${s.movecost_reduction}` }] : [])
  ]
}

const gearRank = (a: AssetRef) =>
  kindOf(a.stats) === 'lavalux' ? Number(a.stats?.attack_mult_bp || 0) + Number(a.stats?.defense_mult_bp || 0) : power(a.stats)

const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±') + formatNumber(Math.abs(n), 0)

function Delta({ n, lowerIsBetter = false, unit }: { n: number; lowerIsBetter?: boolean; unit: string }) {
  if (!n) return null
  const good = lowerIsBetter ? n < 0 : n > 0
  return (
    <span className={good ? 'is-good' : 'is-bad'}>
      {signed(n)} {unit}
    </span>
  )
}

function Stats({ atk, def, move }: { atk: number; def: number; move: number }) {
  return (
    <span className="trio">
      <span className="c-atk" title="Attack">
        {formatNumber(atk, 0)}
      </span>
      <span className="c-def" title="Defense">
        {formatNumber(def, 0)}
      </span>
      <span className="c-move" title="Move cost">
        {formatNumber(move, 0)}
      </span>
    </span>
  )
}

export function Army({ account }: { account: string }) {
  const { run, pending, spectating, account: sessionAccount } = useTransaction()
  const army = useArmy(account)
  const player = usePlayer(account)
  const deployments = useDeployments(account)
  const wallet = useWalletNfts(account)

  const [divId, setDivId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  /** The optimizer in place of the board and the side column. */
  const [optimizing, setOptimizing] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  /**
   * A preset open for editing: the page shows it as if it were the army and every change edits it
   * here, nothing is signed, until it is saved (or saved as a new preset) or discarded.
   */
  const [editing, setEditing] = useState<{ preset: Preset; name: string; divisions: PresetDivision[]; dirty: boolean } | null>(null)
  const change = (next: PresetDivision[]) => setEditing((e) => (e ? { ...e, divisions: next, dirty: true } : e))
  /** How a new division is put together: a warlord picked by hand, or built for a mission. */
  const [how, setHow] = useState<'warlord' | 'mission'>('warlord')
  /** The warlord of a division just created: it is selected as soon as the chain shows it. */
  const [newLeader, setNewLeader] = useState<string | null>(null)
  const [unitId, setUnitId] = useState<string | null>(null)
  const [kind, setKind] = useState<GearKind>('weapon')
  const [side, setSide] = useState<Side>('gear')
  const [confirmDisband, setConfirmDisband] = useState(false)
  /**
   * What is being dragged: a staked NFT from a list, or a mercenary out of its division. Kept in a
   * ref the moment the drag starts (Chrome cancels a drag when the page changes as it begins); the
   * visible state follows a tick later.
   */
  const dragRef = useRef<Dragged | null>(null)
  const [drag, setDrag] = useState<Dragged | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)

  const armyData = useMemo(() => (editing && army.data ? virtualArmy(army.data, editing.divisions) : army.data), [editing, army.data])
  const divisions = useMemo(() => armyData?.divisions ?? [], [armyData])
  const selected = creating || optimizing || presetsOpen ? null : (divisions.find((d) => d.id === divId) ?? divisions[0] ?? null)

  useEffect(() => {
    if (divId === null && divisions[0]) setDivId(divisions[0].id)
  }, [divId, divisions])
  useEffect(() => {
    if (!newLeader) return
    const d = divisions.find((x) => x.leader?.assetId === newLeader)
    if (d) {
      setDivId(d.id)
      setNewLeader(null)
    }
  }, [divisions, newLeader])
  useEffect(() => {
    setUnitId(null)
    setConfirmDisband(false)
  }, [selected?.id])

  const unlockByDivision = useMemo(() => {
    const m = new Map<number, number>()
    for (const d of deployments.data ?? []) m.set(d.divisionId, d.unlockAt)
    return m
  }, [deployments.data])
  const now = useClockFor([...unlockByDivision.values()])

  if (army.isError) return <p className="wrap page-msg c-bad">The army could not be read: {String(army.error)}</p>
  if (!armyData || !player.data) return <p className="wrap page-msg muted">Mustering the army…</p>

  const { free, gearUsed } = armyData
  const { forgeLevel, powerups } = player.data
  const allowance = divisionAllowance(powerups)

  const stateOf = (d: Division) =>
    editing ? { label: 'In the preset', tone: 'ready' as const, editable: true } : divisionState(d, unlockByDivision.get(d.id), now)

  /** Free Forge slots of a gear kind across the whole army. */
  const freeSlots = (k: GearKind) => {
    const key = GEAR_POWERUP[k]
    return key ? (powerups.get(key) ?? 0) - gearUsed[k] : Infinity
  }
  const usable = (a: AssetRef) => Number(a.stats?.min_forge_level ?? 0) <= forgeLevel

  const state = selected ? stateOf(selected) : null
  const editable = editing ? !!selected : !!state?.editable && !spectating
  const crew = selected ? [...selected.units].sort((a, b) => unitPower(b) - unitPower(a)) : []
  const unit = crew.find((u) => u.asset.assetId === unitId) ?? crew[0] ?? null
  const open = selected ? Math.max(0, selected.slotsMax - selected.units.length) : 0
  const stats = selected ? (selected.live ?? { atk: selected.atk, def: selected.def, move: selected.move }) : null
  const gearCount = crew.reduce((n, u) => n + GEAR_KINDS.filter((k) => u.gear[k]).length, 0)
  const walletCount = wallet.data?.length ?? 0

  // ---- Transactions ------------------------------------------------------------------------------

  /** Puts gear on a mercenary; a filled slot is emptied first, in the same transaction. */
  function equip(u: Unit, k: GearKind, item: AssetRef) {
    if (!selected) return
    const d = selected
    const old = u.gear[k]
    setUnitId(u.asset.assetId)
    setKind(k)
    if (editing) return change(presetEquip(editing.divisions, u.asset.assetId, k, item.assetId))
    void run(
      (a, p) => [
        ...(old ? [unassignGear(a, p, d.id, u.asset.assetId, old.assetId)] : []),
        assignGear(a, p, d.id, u.asset.assetId, k, item.assetId)
      ],
      `${item.name} ${old ? 'swapped onto' : 'equipped on'} ${u.asset.name}`,
      `eq-${u.asset.assetId}`
    )
  }
  /**
   * Moves a piece of gear from one mercenary to another in the division, in one transaction. If the
   * other one already wears that kind, the two swap. No Forge slot changes hands either way.
   */
  function moveGear(src: Unit, dst: Unit, k: GearKind) {
    const g = src.gear[k]
    if (!selected || !g || src.asset.assetId === dst.asset.assetId) return
    const d = selected
    const old = dst.gear[k]
    setUnitId(dst.asset.assetId)
    setKind(k)
    if (editing) return change(presetMoveGear(editing.divisions, src.asset.assetId, dst.asset.assetId, k))
    void run(
      (a, p) => [
        unassignGear(a, p, d.id, src.asset.assetId, g.assetId),
        ...(old
          ? [unassignGear(a, p, d.id, dst.asset.assetId, old.assetId), assignGear(a, p, d.id, src.asset.assetId, k, old.assetId)]
          : []),
        assignGear(a, p, d.id, dst.asset.assetId, k, g.assetId)
      ],
      old ? `${g.name} and ${old.name} swapped places` : `${g.name} moved to ${dst.asset.name}`,
      `eq-${dst.asset.assetId}`
    )
  }
  function takeOff(u: Unit, k: GearKind) {
    const g = u.gear[k]
    if (!selected || !g) return
    const d = selected
    if (editing) return change(presetTakeOff(editing.divisions, u.asset.assetId, k))
    void run((a, p) => unassignGear(a, p, d.id, u.asset.assetId, g.assetId), `${g.name} back in the armory`, `eq-${u.asset.assetId}`)
  }
  function recruit(m: AssetRef) {
    if (!selected) return
    const d = selected
    if (editing) return change(presetRecruit(editing.divisions, d.leader!.assetId, m.assetId))
    void run((a, p) => addUnit(a, p, d.id, m.assetId), `${m.name} joined division #${d.id}`, `add-${m.templateId}`)
  }
  /** Sends a mercenary back to the reserve; its gear comes off first, in the same transaction. */
  function dismiss(u: Unit) {
    if (!selected) return
    const d = selected
    if (editing) return change(presetDismiss(editing.divisions, u.asset.assetId))
    void run(
      (a, p) => [
        ...GEAR_KINDS.filter((k) => u.gear[k]).map((k) => unassignGear(a, p, d.id, u.asset.assetId, u.gear[k]!.assetId)),
        removeUnit(a, p, u.asset.assetId)
      ],
      `${u.asset.name} back in the reserve`,
      `rm-${u.asset.assetId}`
    )
  }
  async function disband() {
    if (!selected) return
    const d = selected
    if (editing) {
      change(presetDisband(editing.divisions, d.leader!.assetId))
      setConfirmDisband(false)
      setDivId(null)
      return
    }
    const ok = await run(
      (a, p): AnyAction[] => [
        ...d.units.flatMap((u) => GEAR_KINDS.filter((k) => u.gear[k]).map((k) => unassignGear(a, p, d.id, u.asset.assetId, u.gear[k]!.assetId))),
        ...d.units.map((u) => removeUnit(a, p, u.asset.assetId)),
        ...(d.leader ? [deleteDivision(a, p, d.leader.assetId)] : [])
      ],
      `Division #${d.id} disbanded`,
      'disband',
      { split: true }
    )
    if (ok) {
      setConfirmDisband(false)
      setDivId(null)
    }
  }
  async function create(w: AssetRef) {
    if (editing) {
      const next = presetCreate(editing.divisions, w.assetId)
      change(next)
      setCreating(false)
      setDivId(next.length)
      return
    }
    const ok = await run((a, p) => createDivision(a, p, w.assetId), `New division under ${w.name}`, `new-${w.assetId}`)
    if (ok) {
      setCreating(false)
      setNewLeader(w.assetId)
    }
  }
  function stake(list: AssetRef[], what: string, key: string) {
    void run((a, p) => stakeAssets(a, p, list.map((x) => x.assetId)), `${what} staked`, key)
  }

  /**
   * Moves a mercenary to another division with everything it carries: the gear comes off, the
   * mercenary leaves and joins the other division, and the same gear goes back on, all in one
   * transaction (so no Forge slot is ever needed twice).
   */
  function moveUnit(x: Dragged, target: Division) {
    if (!x.from) return
    if (editing) return change(presetRecruit(editing.divisions, target.leader!.assetId, x.from.unit.asset.assetId))
    const { unit, division: from } = x.from
    const gear = GEAR_KINDS.flatMap((k) => (unit.gear[k] ? [[k, unit.gear[k]!] as const] : []))
    void run(
      (a, p) => [
        ...gear.map(([, g]) => unassignGear(a, p, from.id, unit.asset.assetId, g.assetId)),
        removeUnit(a, p, unit.asset.assetId),
        addUnit(a, p, target.id, unit.asset.assetId),
        ...gear.map(([k, g]) => assignGear(a, p, target.id, unit.asset.assetId, k, g.assetId))
      ],
      `${unit.asset.name} moved to division #${target.id}${gear.length ? ` with ${gear.length} gear` : ''}`,
      `rm-${unit.asset.assetId}`
    )
  }
  /** Why a division cannot take the mercenary being dragged, or null when it can. */
  const refuses = (d: Division, x: Dragged): string | null => {
    if (!x.from) return 'Not a mercenary'
    if (d.id === x.from.division.id) return 'Already here'
    if (spectating && !editing) return 'Read-only'
    if (!stateOf(x.from.division).editable) return 'Its division is away'
    if (!stateOf(d).editable) return 'Away on a mission'
    if (d.units.length >= d.slotsMax) return 'Every place is taken'
    return null
  }

  /** The edited preset written back (or as a new one); the list is this account's presets in this browser. */
  function savePreset(asNew: boolean) {
    if (!editing) return
    const list = readPresets(account)
    const name = editing.name.trim() || editing.preset.name
    const next = asNew
      ? [{ id: `${Date.now()}`, name: list.some((x) => x.name === name) ? `${name} 2` : name, savedAt: Date.now(), divisions: editing.divisions }, ...list]
      : list.map((x) => (x.id === editing.preset.id ? { ...x, name, savedAt: Date.now(), divisions: editing.divisions } : x))
    if (!writePresets(account, next)) return toast.error('This browser would not keep the preset (storage blocked or full).')
    toast.success(asNew ? `Saved as a new preset: "${next[0].name}"` : `"${name}" saved`)
    setEditing(null)
    setDivId(null)
    setPresetsOpen(true)
  }

  // ---- Drag and drop: gear onto sockets, recruits onto open places, mercenaries onto divisions ---

  const startDrag = (e: DragEvent, x: Dragged) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', x.a.assetId)
    dragRef.current = x
    setTimeout(() => dragRef.current === x && setDrag(x), 0)
  }
  const endDrag = () => {
    dragRef.current = null
    setDrag(null)
    setDropAt(null)
  }
  const dragProps = (a: AssetRef, allowed: boolean) =>
    allowed ? { draggable: true, onDragStart: (e: DragEvent) => startDrag(e, { a }), onDragEnd: endDrag } : {}
  const unitDragProps = (u: Unit, d: Division) =>
    editable
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => startDrag(e, { a: u.asset, from: { unit: u, division: d } }),
          onDragEnd: endDrag
        }
      : {}
  const gearDragProps = (u: Unit, k: GearKind, g: AssetRef) =>
    editable
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => startDrag(e, { a: g, gear: { unit: u, kind: k } }),
          onDragEnd: endDrag
        }
      : {}
  /**
   * A drop target. One that takes what is dragged keeps the drop to itself; one that does not lets
   * it fall through to the page, where gear off a socket comes off.
   */
  const dropProps = (key: string, accepts: (x: Dragged) => boolean, onDrop: (x: Dragged) => void) => ({
    onDragOver: (e: DragEvent) => {
      const x = dragRef.current
      if (x && accepts(x)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (dropAt !== key) setDropAt(key)
      }
    },
    onDragLeave: () => dropAt === key && setDropAt(null),
    onDrop: (e: DragEvent) => {
      const x = dragRef.current
      if (!x || !accepts(x)) return
      e.preventDefault()
      e.stopPropagation()
      endDrag()
      onDrop(x)
    }
  })
  /** Gear off a socket dropped anywhere on the page that is not a mercenary: it comes off. */
  const pageDrop = {
    onDragOver: (e: DragEvent) => {
      if (dragRef.current?.gear) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dropAt !== null) setDropAt(null)
      }
    },
    onDrop: (e: DragEvent) => {
      const x = dragRef.current
      if (!x?.gear) return
      e.preventDefault()
      endDrag()
      takeOff(x.gear.unit, x.gear.kind)
    }
  }
  /** Whether a piece of gear may go into this slot of this mercenary right now. */
  const fits = (u: Unit, k: GearKind, a: AssetRef) => editable && kindOf(a.stats) === k && usable(a) && (!!u.gear[k] || freeSlots(k) > 0)
  /**
   * Whether dragged gear can go onto this mercenary (into slot k, or its own kind's slot): gear
   * from another mercenary always can (it brings its slot along), spare gear needs a free slot.
   */
  const takesGear = (u: Unit, x: Dragged, k?: GearKind) => {
    const gk = x.gear?.kind ?? kindOf(x.a.stats)
    if (!editable || x.from || !gk || gk === 'warlord' || gk === 'mercenary' || (k && gk !== k)) return false
    return x.gear ? x.gear.unit.asset.assetId !== u.asset.assetId : fits(u, gk, x.a)
  }
  const placeGear = (u: Unit, x: Dragged) => {
    if (x.gear) moveGear(x.gear.unit, u, x.gear.kind)
    else equip(u, kindOf(x.a.stats) as GearKind, x.a)
  }

  // ---- The page ----------------------------------------------------------------------------------

  return (
    <main className={`army wrap${editing ? ' is-editing' : ''}`} {...pageDrop}>
      {editing && (
        <div className="preset-bar">
          <span className="preset-bar__tag">
            <Icon name="chest" size={16} /> Editing a preset
          </span>
          <input
            className="input preset-bar__name"
            value={editing.name}
            maxLength={40}
            onChange={(e) => setEditing((x) => (x ? { ...x, name: e.target.value, dirty: true } : x))}
          />
          <span className="muted">
            {editing.dirty ? 'Unsaved changes' : 'No changes yet'} · nothing here is signed; the army on chain stays as it is until you restore the preset.
          </span>
          <span className="preset-bar__acts">
            <button type="button" className="btn btn--go btn--sm" disabled={!editing.dirty} onClick={() => savePreset(false)}>
              Save
            </button>
            <button type="button" className="btn btn--sm" onClick={() => savePreset(true)}>
              Save as new
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                setEditing(null)
                setDivId(null)
                setPresetsOpen(true)
              }}
            >
              {editing.dirty ? 'Discard' : 'Close'}
            </button>
          </span>
        </div>
      )}
      <aside className="roster">
        <h3 className="h">
          Divisions
          <small>
            {divisions.length} of {allowance}
          </small>
        </h3>
        {divisions.map((d) => {
          const s = stateOf(d)
          const no = drag?.from ? refuses(d, drag) : null
          return (
            <button
              key={d.id}
              type="button"
              className={`div${selected?.id === d.id ? ' is-on' : ''}${drag?.from ? (no ? ' is-no' : ' is-target') : ''}${dropAt === `div-${d.id}` ? ' is-drop' : ''}`}
              {...dropProps(`div-${d.id}`, (x) => !refuses(d, x), (x) => moveUnit(x, d))}
              onClick={() => {
                setCreating(false)
                setOptimizing(false)
                setPresetsOpen(false)
                setDivId(d.id)
              }}
            >
              <Portrait img={d.leader?.img} rarity={d.leader?.rarity} className="div__pic" />
              <span className="div__text">
                <b>
                  #{d.id} {d.leader?.name ?? 'No warlord'}
                </b>
                <small>
                  {drag?.from ? (
                    <>
                      <i className={`dot ${no ? 'is-empty' : 'is-ready'}`} />
                      {no ?? 'Drop to move here'}
                    </>
                  ) : (
                    <>
                      <i className={`dot is-${s.tone}`} />
                      {s.label}
                      {s.until ? ` · ${shortDuration(s.until - now)}` : ''}
                    </>
                  )}
                </small>
              </span>
              <span className="div__count">
                {d.units.length}/{d.slotsMax}
              </span>
              {/* What the division fields: the roster as it stands now (live), the chain's cached figures until that is read. */}
              {(() => {
                const st = d.live ?? d
                return (
                  <span className="div__stats" aria-label={`Attack ${formatNumber(st.atk, 0)}, defense ${formatNumber(st.def, 0)}, move cost ${formatNumber(st.move, 0)}`}>
                    <span className="c-atk" title="Attack">
                      <Icon name="atk" size={12} />
                      {formatNumber(st.atk, 0)}
                    </span>
                    <span className="c-def" title="Defense">
                      <Icon name="def" size={12} />
                      {formatNumber(st.def, 0)}
                    </span>
                    <span className="c-move" title="Move cost">
                      <Icon name="move" size={12} />
                      {formatNumber(st.move, 0)}
                    </span>
                  </span>
                )
              })()}
            </button>
          )
        })}
        <button
          type="button"
          className={`div-new${creating ? ' is-on' : ''}`}
          onClick={() => {
            setOptimizing(false)
            setPresetsOpen(false)
            setCreating(true)
          }}
        >
          <Icon name="plus" size={16} /> New division
        </button>
        {!editing && (
          <>
            <button
              type="button"
              className={`div-new div-opt${optimizing ? ' is-on' : ''}`}
              onClick={() => {
                setCreating(false)
                setPresetsOpen(false)
                setOptimizing(true)
              }}
            >
              <Icon name="spark" size={16} /> Optimize army
            </button>
            <button
              type="button"
              className={`div-new div-opt${presetsOpen ? ' is-on' : ''}`}
              onClick={() => {
                setCreating(false)
                setOptimizing(false)
                setPresetsOpen(true)
              }}
            >
              <Icon name="chest" size={16} /> Presets
            </button>
          </>
        )}
      </aside>

      {optimizing && (
        <OptimizePanel
          sessionAccount={sessionAccount ?? ''}
          spectating={spectating}
          initialAccount={account}
          onClose={() => setOptimizing(false)}
          onDone={(id) => {
            setOptimizing(false)
            if (id !== null) setDivId(id)
          }}
        />
      )}
      {presetsOpen && (
        <PresetsPanel
          account={account}
          divisions={divisions}
          editable={(d) => stateOf(d).editable}
          spectating={spectating}
          onClose={() => setPresetsOpen(false)}
          onDone={() => setPresetsOpen(false)}
          onEdit={(preset) => {
            setPresetsOpen(false)
            setCreating(false)
            setDivId(null)
            setEditing({ preset, name: preset.name, divisions: preset.divisions.map((d) => ({ leader: d.leader, units: d.units.map((u) => ({ merc: u.merc, gear: { ...u.gear } })) })), dirty: false })
          }}
        />
      )}
      <section className="board" hidden={optimizing || presetsOpen}>
        {creating ? (
          <div className="box newdiv">
            <div className="newdiv__head">
              <h2>Raise a new division</h2>
              <div className="seg seg--how">
                <button type="button" className={how === 'warlord' ? 'is-on' : ''} onClick={() => setHow('warlord')}>
                  Pick a warlord
                </button>
                <button type="button" className={how === 'mission' ? 'is-on' : ''} disabled={!!editing} title={editing ? 'Not while editing a preset' : undefined} onClick={() => setHow('mission')}>
                  <Icon name="rocket" size={16} /> Build division for a mission
                </button>
              </div>
            </div>
            <p className="muted">
              {how === 'warlord'
                ? 'Pick the warlord who leads it. The warlord decides how many mercenaries the division can take.'
                : 'Pick a mission and what matters most; the best division for it is put together from your reserve, ready to sign.'}
              {divisions.length >= allowance && (
                <b className="c-bad"> All {allowance} division places are in use: buy a Division slot in the Forge, or disband one first.</b>
              )}
            </p>
            {spectating && !editing && <ReadOnly account={account} />}
            {how === 'mission' && !editing ? (
              <MissionBuilder
                account={account}
                free={free}
                forgeLevel={forgeLevel}
                slotsFree={{ weapon: freeSlots('weapon'), supply: freeSlots('supply'), lavalux: freeSlots('lavalux') }}
                blocked={
                  spectating
                    ? 'Read-only: connect your wallet to build'
                    : divisions.length >= allowance
                      ? 'Every division place is in use'
                      : null
                }
                onBuilt={(leader) => {
                  setCreating(false)
                  setNewLeader(leader)
                }}
              />
            ) : free.warlord.length ? (
              <div className="warlords">
                {stacks(free.warlord, (a) => Number(a.stats?.slots_max || 0)).map(({ first, all }) => (
                  <div key={first.templateId} className="wl" style={{ '--rc': rarityColor(first.rarity) } as CSSProperties}>
                    <Portrait img={first.img} rarity={first.rarity} className="wl__pic" />
                    {all.length > 1 && <span className="count">×{all.length}</span>}
                    <b>{first.name}</b>
                    <StarRail asset={first} size="sm" />
                    <small>
                      <i className="dot" style={{ background: rarityColor(first.rarity) }} />
                      {first.rarity || 'common'} · {first.stats?.slots_max ?? '?'} crew
                      {first.stats?.movecost_reduction ? ` · −${first.stats.movecost_reduction} move` : ''}
                    </small>
                    <button
                      type="button"
                      className="btn btn--go btn--sm"
                      disabled={(spectating && !editing) || divisions.length >= allowance || !!pending}
                      title={
                        spectating && !editing
                          ? 'Read-only: connect your wallet to act'
                          : divisions.length >= allowance
                            ? 'Every division place is in use'
                            : undefined
                      }
                      onClick={() => void create(first)}
                    >
                      {pending === `new-${first.assetId}` ? 'Signing…' : 'Lead a division'}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="none">
                No free warlord is staked. Stake one from the <button className="link" onClick={() => setSide('stake')}>Wallet</button> tab on the right.
              </p>
            )}
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Back to the army
            </button>
          </div>
        ) : !selected ? (
          <div className="box newdiv">
            <h2>No divisions yet</h2>
            <p className="muted">A division is a warlord and the mercenaries they lead. Raise your first one to start.</p>
            <button type="button" className="btn btn--go" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Raise a division
            </button>
          </div>
        ) : (
          <>
            <div className="box lead" style={{ '--rc': rarityColor(selected.leader?.rarity) } as CSSProperties}>
              <Portrait img={selected.leader?.img} rarity={selected.leader?.rarity} className="lead__pic" />
              <div className="lead__body">
                <span className="eyebrow">Division #{selected.id}</span>
                <h1>
                  {selected.leader?.name ?? 'No warlord'}
                  <StarRail asset={selected.leader} />
                </h1>
                <span className="muted">
                  <span className="cap">{selected.leader?.rarity || 'common'}</span> warlord · leads up to {selected.slotsMax} mercenaries
                  {selected.leader?.stats?.movecost_reduction ? ` · takes ${selected.leader.stats.movecost_reduction} off the move cost` : ''}
                </span>
                <div className="chips">
                  <span className="chip">
                    <i className={`dot is-${state!.tone}`} />
                    {state!.label}
                    {state!.until ? ` · back in ${shortDuration(state!.until - now)}` : ''}
                  </span>
                  <span className="chip">
                    {selected.units.length} / {selected.slotsMax} crew
                  </span>
                  <span className="chip">{gearCount} gear equipped</span>
                </div>
                {stats && (
                  <div className="stats">
                    <div className="stat">
                      <small className="c-atk">
                        <Icon name="atk" size={14} /> Attack
                      </small>
                      <b>{formatNumber(stats.atk, 0)}</b>
                    </div>
                    <div className="stat">
                      <small className="c-def">
                        <Icon name="def" size={14} /> Defense
                      </small>
                      <b>{formatNumber(stats.def, 0)}</b>
                    </div>
                    <div className="stat">
                      <small className="c-move">
                        <Icon name="move" size={14} /> Move cost
                      </small>
                      <b>{formatNumber(stats.move, 0)}</b>
                    </div>
                  </div>
                )}
                <div className="slotbar" aria-label={`${selected.units.length} of ${selected.slotsMax} places filled`}>
                  {Array.from({ length: selected.slotsMax }, (_, i) => (
                    <i key={i} className={i < selected.units.length ? 'is-full' : ''} />
                  ))}
                </div>
                {!state!.editable ? (
                  <p className="notice">
                    <Icon name="lock" size={16} />
                    {state!.tone === 'claim'
                      ? 'This division has a reward waiting. Claim it in the deck, then its crew can be changed again.'
                      : 'Out on a mission. The crew and gear can be changed once it is back.'}
                  </p>
                ) : (
                  <div className="acts">
                    {confirmDisband ? (
                      <span className="confirm">
                        Disband #{selected.id}? Its crew and gear go back to the reserve.
                        <button type="button" className="btn btn--bad btn--sm" disabled={!!pending} onClick={() => void disband()}>
                          {pending === 'disband' ? 'Signing…' : 'Disband'}
                        </button>
                        <button type="button" className="btn btn--sm" onClick={() => setConfirmDisband(false)}>
                          Keep it
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn" disabled={!editable} onClick={() => setConfirmDisband(true)}>
                        Disband
                      </button>
                    )}
                  </div>
                )}
                {spectating && !editing && state!.editable && <ReadOnly account={account} />}
              </div>
            </div>

            {state!.tone === 'ready' && !editing && (
              <DeployPanel
                account={account}
                division={selected}
                disabled={spectating ? 'Read-only: connect your wallet to deploy.' : null}
              />
            )}

            <div className="crew-h">
              <h2>Crew</h2>
              <span className={drag?.gear ? 'drag-hint' : 'muted'}>
                {drag?.gear
                  ? 'Drop on another mercenary to move it there · anywhere else takes it off'
                  : editable && divisions.length > 1
                    ? 'strongest first · drag one onto a division to move it'
                    : 'strongest first'}
              </span>
              <span className="gap" />
              <span className="legend">
                {GEAR_KINDS.map((k) => (
                  <span key={k}>
                    <Icon name={k} size={14} />
                    {GEAR_LABEL[k]}
                  </span>
                ))}
              </span>
            </div>
            <div className="crew">
              {crew.map((u) => {
                const t = totalsOf(u)
                const on = unit?.asset.assetId === u.asset.assetId
                return (
                  <div
                    key={u.asset.assetId}
                    className={`unit${on ? ' is-on' : ''}${pending === `eq-${u.asset.assetId}` || pending === `rm-${u.asset.assetId}` ? ' is-busy' : ''}${dropAt === `unit-${u.asset.assetId}` ? ' is-drop' : ''}`}
                    style={{ '--rc': rarityColor(u.asset.rarity) } as CSSProperties}
                    title={editable && divisions.length > 1 ? 'Drag onto another division to move it there, gear and all' : undefined}
                    {...unitDragProps(u, selected)}
                    {...dropProps(`unit-${u.asset.assetId}`, (x) => takesGear(u, x), (x) => placeGear(u, x))}
                    onClick={() => {
                      setUnitId(u.asset.assetId)
                      setSide('gear')
                    }}
                  >
                    <div className="unit__top">
                      <Portrait img={u.asset.img} rarity={u.asset.rarity} className="unit__pic" />
                      <span className="unit__text">
                        <b>{u.asset.name}</b>
                        <span className="rar">
                          <i className="dot" style={{ background: rarityColor(u.asset.rarity) }} />
                          {u.asset.rarity || 'common'}
                        </span>
                        <StarRail asset={u.asset} size="sm" />
                        <Stats atk={t.atk} def={t.def} move={t.move} />
                      </span>
                    </div>
                    {editable && (
                      <button
                        type="button"
                        className="unit__x"
                        title="Back to the reserve"
                        disabled={!!pending}
                        onClick={(e) => {
                          e.stopPropagation()
                          dismiss(u)
                        }}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                    <div className="sockets">
                      {GEAR_KINDS.map((k) => {
                        const g = u.gear[k]
                        const key = `${u.asset.assetId}:${k}`
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`sock${g ? ' is-full' : ''}${on && side === 'gear' && kind === k ? ' is-sel' : ''}${dropAt === key ? ' is-drop' : ''}`}
                            style={g ? ({ '--rc': rarityColor(g.rarity) } as CSSProperties) : undefined}
                            title={g ? `${GEAR_LABEL[k]}: ${g.name}` : `Empty ${GEAR_LABEL[k].toLowerCase()} slot`}
                            onClick={(e) => {
                              e.stopPropagation()
                              setUnitId(u.asset.assetId)
                              setKind(k)
                              setSide('gear')
                            }}
                            {...dropProps(key, (x) => takesGear(u, x, k), (x) => placeGear(u, x))}
                            {...(g ? gearDragProps(u, k, g) : {})}
                          >
                            {g ? (
                              <>
                                <Portrait img={g.img} rarity={g.rarity} className="sock__pic" />
                                <span className="sock__k">
                                  <Icon name={k} size={10} width={2.2} />
                                </span>
                              </>
                            ) : (
                              <Icon name={k} size={16} />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              {Array.from({ length: Math.min(open, EMPTY_CARDS) }, (_, i) => (
                <button
                  key={`open-${i}`}
                  type="button"
                  className={`unit unit--open${dropAt === `open-${i}` ? ' is-drop' : ''}`}
                  onClick={() => setSide('recruit')}
                  {...dropProps(`open-${i}`, (x) => !x.from && editable && kindOf(x.a.stats) === 'mercenary', (x) => recruit(x.a))}
                >
                  <Icon name="plus" size={22} />
                  {i === EMPTY_CARDS - 1 && open > EMPTY_CARDS ? `${open - EMPTY_CARDS + 1} more places` : 'Add mercenary'}
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <aside className="side" hidden={optimizing || presetsOpen}>
        <div className="seg seg--side">
          <button type="button" className={side === 'gear' ? 'is-on' : ''} onClick={() => setSide('gear')}>
            Gear
          </button>
          <button type="button" className={side === 'recruit' ? 'is-on' : ''} onClick={() => setSide('recruit')}>
            Reserve <small>{free.mercenary.length}</small>
          </button>
          {!editing && (
            <button type="button" className={side === 'stake' ? 'is-on' : ''} onClick={() => setSide('stake')}>
              Wallet <small>{wallet.isLoading ? '…' : walletCount}</small>
            </button>
          )}
        </div>

        {side === 'gear' && (
          <GearPanel
            unit={unit}
            kind={kind}
            setKind={setKind}
            free={free}
            freeSlots={freeSlots}
            slotsOwned={(k) => (GEAR_POWERUP[k] ? (powerups.get(GEAR_POWERUP[k]!) ?? 0) : Infinity)}
            usable={usable}
            forgeLevel={forgeLevel}
            editable={editable}
            locked={!!selected && !state!.editable}
            spectating={spectating}
            pending={pending}
            onEquip={equip}
            onTakeOff={takeOff}
            dragProps={dragProps}
          />
        )}

        {side === 'recruit' && (
          <div className="box panel">
            <h3 className="h">
              Reserve
              <small>staked mercenaries in no division</small>
            </h3>
            {selected && (
              <div className={`budget${!open ? ' is-full' : ''}`}>
                <span>Places in #{selected.id}</span>
                <b>
                  {selected.units.length} of {selected.slotsMax} filled
                </b>
              </div>
            )}
            <div className="items">
              {stacks(free.mercenary, (a) => power(a.stats)).map(({ first, all }) => (
                <div
                  key={first.templateId}
                  className="item"
                  style={{ '--rc': rarityColor(first.rarity) } as CSSProperties}
                  {...dragProps(first, editable && open > 0)}
                >
                  <Portrait img={first.img} rarity={first.rarity} className="item__pic" />
                  <span className="item__text">
                    <b>
                      {first.name}
                      {all.length > 1 && <em className="times">×{all.length}</em>}
                    </b>
                    <StarRail asset={first} size="sm" />
                    <small>
                      <Stats atk={Number(first.stats?.attack ?? 0)} def={Number(first.stats?.defense ?? 0)} move={Number(first.stats?.movecost ?? 0)} />
                    </small>
                  </span>
                  <button
                    type="button"
                    className="btn btn--go btn--sm"
                    disabled={!editable || !open || !!pending}
                    onClick={() => recruit(first)}
                  >
                    {pending === `add-${first.templateId}` ? '…' : 'Add'}
                  </button>
                </div>
              ))}
              {!free.mercenary.length && <p className="none">No mercenary waiting. Stake more from the Wallet tab, or buy some on the Market.</p>}
            </div>
            <p className="help">
              {selected && !state!.editable
                ? 'This division is away, so no one can join it right now.'
                : 'Add one at a time, or drag one onto an open place in the crew.'}
            </p>
          </div>
        )}

        {side === 'stake' && !editing && (
          <div className="box panel">
            <h3 className="h">
              In your wallet
              <small>game NFTs not staked yet</small>
            </h3>
            {wallet.isLoading ? (
              <p className="none">Reading the wallet…</p>
            ) : (
              <>
                {!!walletCount && (
                  <button
                    type="button"
                    className="btn btn--go stake-all"
                    disabled={spectating || !!pending}
                    onClick={() => stake(wallet.data!, `${walletCount} NFTs`, 'stake-all')}
                  >
                    {pending === 'stake-all' ? 'Signing…' : `Stake all ${walletCount}`}
                  </button>
                )}
                <div className="items">
                  {(['warlord', 'mercenary', ...GEAR_KINDS] as Kind[]).map((k) => {
                    const list = (wallet.data ?? []).filter((a) => kindOf(a.stats) === k)
                    if (!list.length) return null
                    return (
                      <div key={k} className="group">
                        <span className="group__h">
                          {k === 'warlord' ? 'Warlords' : k === 'mercenary' ? 'Mercenaries' : GEAR_LABEL[k as GearKind]}
                        </span>
                        {stacks(list, gearRank).map(({ first, all }) => (
                          <div key={first.templateId} className="item" style={{ '--rc': rarityColor(first.rarity) } as CSSProperties}>
                            <Portrait img={first.img} rarity={first.rarity} className="item__pic" />
                            <span className="item__text">
                              <b>
                                {first.name}
                                {all.length > 1 && <em className="times">×{all.length}</em>}
                              </b>
                              <small className="cap">{first.rarity || 'common'}</small>
                            </span>
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={spectating || !!pending}
                              onClick={() => stake(all, `${all.length} × ${first.name}`, `stake-${first.templateId}`)}
                            >
                              {pending === `stake-${first.templateId}` ? '…' : 'Stake'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                  {!walletCount && <p className="none">Every game NFT in this wallet is staked already.</p>}
                </div>
                <p className="help">Staking moves an NFT into the game so it can join a division. Unstaking brings it back any time it is not in one.</p>
              </>
            )}
          </div>
        )}
      </aside>
    </main>
  )
}

/** Says why nothing can be changed while another account is viewed, and how to act instead. */
function ReadOnly({ account }: { account: string }) {
  return (
    <p className="notice notice--read">
      <Icon name="lock" size={16} />
      You are viewing {account} read-only, so nothing can be signed here. Use Connect wallet at the top to build your own army.
    </p>
  )
}

// ---- The gear column: the chosen mercenary's four slots, and the spare gear for one of them ----

function GearPanel({
  unit,
  kind,
  setKind,
  free,
  freeSlots,
  slotsOwned,
  usable,
  forgeLevel,
  editable,
  locked,
  spectating,
  pending,
  onEquip,
  onTakeOff,
  dragProps
}: {
  unit: Unit | null
  kind: GearKind
  setKind: (k: GearKind) => void
  free: Record<Kind, AssetRef[]>
  freeSlots: (k: GearKind) => number
  slotsOwned: (k: GearKind) => number
  usable: (a: AssetRef) => boolean
  forgeLevel: number
  editable: boolean
  locked: boolean
  spectating: boolean
  pending: string | null
  onEquip: (u: Unit, k: GearKind, a: AssetRef) => void
  onTakeOff: (u: Unit, k: GearKind) => void
  dragProps: (a: AssetRef, allowed: boolean) => object
}) {
  if (!unit)
    return (
      <div className="box panel">
        <h3 className="h">Loadout</h3>
        <p className="none">Add a mercenary to the division, then fit them with gear here.</p>
      </div>
    )
  const t = totalsOf(unit)
  const cur = unit.gear[kind]
  const spare = stacks(free[kind], gearRank)
  const slotsFree = freeSlots(kind)
  const owned = slotsOwned(kind)
  const noSlot = !cur && slotsFree <= 0
  const busy = pending === `eq-${unit.asset.assetId}`
  return (
    <>
      <div className="box panel" style={{ '--rc': rarityColor(unit.asset.rarity) } as CSSProperties}>
        <h3 className="h">Loadout</h3>
        <div className="load-h">
          <Portrait img={unit.asset.img} rarity={unit.asset.rarity} className="load-h__pic" />
          <span>
            <b>
              {unit.asset.name} <StarRail asset={unit.asset} size="sm" />
            </b>
            <small>
              <span className="c-atk">{t.atk} attack</span> · <span className="c-def">{t.def} defense</span> ·{' '}
              <span className="c-move">{t.move} move</span>
            </small>
          </span>
        </div>
        <div className="slots">
          {GEAR_KINDS.map((k) => {
            const g = unit.gear[k]
            return (
              <button key={k} type="button" className={`slot${k === kind ? ' is-sel' : ''}`} onClick={() => setKind(k)}>
                {g ? (
                  <Portrait img={g.img} rarity={g.rarity} className="slot__pic is-full" />
                ) : (
                  <span className="slot__pic">
                    <Icon name={k} />
                  </span>
                )}
                <span className="slot__text">
                  <b>{g ? g.name : 'Empty'}</b>
                  <small>{GEAR_LABEL[k]}</small>
                </span>
                <span className="slot__eff">
                  {g &&
                    effectOf(g).map((e) => (
                      <span key={e.text + e.cls} className={e.cls}>
                        {e.text}
                      </span>
                    ))}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="box panel">
        <h3 className="h">
          Armory
          <small>spare gear you have staked</small>
        </h3>
        <div className="seg seg--kinds">
          {GEAR_KINDS.map((k) => (
            <button key={k} type="button" className={k === kind ? 'is-on' : ''} onClick={() => setKind(k)}>
              {GEAR_LABEL[k]}
              <small>{free[k].length} spare</small>
            </button>
          ))}
        </div>
        <div className={`budget${owned !== Infinity && slotsFree <= 0 ? ' is-full' : ''}`}>
          <span>{GEAR_LABEL[kind]} slots in the army</span>
          <b>{owned === Infinity ? 'no limit' : `${owned - slotsFree} of ${owned} used`}</b>
        </div>
        <div className="items">
          {cur && (
            <div className="item is-current" style={{ '--rc': rarityColor(cur.rarity) } as CSSProperties}>
              <Portrait img={cur.img} rarity={cur.rarity} className="item__pic" />
              <span className="item__text">
                <b>{cur.name}</b>
                <small>On this mercenary</small>
              </span>
              <button type="button" className="btn btn--sm" disabled={!editable || !!pending} onClick={() => onTakeOff(unit, kind)}>
                {busy ? '…' : 'Take off'}
              </button>
            </div>
          )}
          {spare.map(({ first, all }) => {
            const after = totalsOf(unit, { ...unit.gear, [kind]: first })
            const allowed = editable && !noSlot && usable(first)
            const why = spectating
              ? 'Read-only while viewing another account'
              : locked
                ? 'The division is away'
                : !usable(first)
                  ? `Needs forge level ${first.stats?.min_forge_level} (you are at ${forgeLevel})`
                  : noSlot
                    ? 'No free slot'
                    : undefined
            return (
              <div
                key={first.templateId}
                className={`item${allowed ? '' : ' is-off'}`}
                style={{ '--rc': rarityColor(first.rarity) } as CSSProperties}
                {...dragProps(first, allowed)}
              >
                <Portrait img={first.img} rarity={first.rarity} className="item__pic" />
                <span className="item__text">
                  <b>
                    {first.name}
                    {all.length > 1 && <em className="times">×{all.length}</em>}
                  </b>
                  <StarRail asset={first} size="sm" />
                  <small className="delta">
                    <Delta n={after.atk - t.atk} unit="atk" /> <Delta n={after.def - t.def} unit="def" />{' '}
                    <Delta n={after.move - t.move} unit="move" lowerIsBetter />
                    {after.atk === t.atk && after.def === t.def && after.move === t.move && <span>no change</span>}
                  </small>
                </span>
                <button
                  type="button"
                  className={`btn btn--sm${allowed ? ' btn--go' : ''}`}
                  disabled={!allowed || !!pending}
                  title={why}
                  onClick={() => onEquip(unit, kind, first)}
                >
                  {cur ? 'Swap' : 'Equip'}
                </button>
              </div>
            )
          })}
          {!spare.length && (
            <p className="none">
              No spare {GEAR_LABEL[kind].toLowerCase()} staked. Stake one from the Wallet tab, or buy one on the Market.
            </p>
          )}
          {!!spare.length && noSlot && (
            <p className="none">
              All {owned} {GEAR_LABEL[kind].toLowerCase()} slots are in use. Take gear off another mercenary, or buy a slot in the Forge.
            </p>
          )}
        </div>
        <p className="help">{GEAR_HELP[kind]} You can also drag an item onto any socket in the crew.</p>
      </div>
    </>
  )
}
