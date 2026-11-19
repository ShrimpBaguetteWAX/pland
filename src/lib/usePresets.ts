import { useMemo, useState } from 'react'

import { createDivision } from '@/chain/actions/pd'
import { toast } from '@/components/toast'
import type { AssetRef } from '@/data/assets'
import { useArmy, type Division } from '@/data/game'
import { diffArmy } from '@/lib/armyDiff'
import { planRestore, readPresets, snapshot, writePresets, type Preset, type RestorePlan } from '@/lib/armyPresets'
import type { PlannedDivision } from '@/lib/armySearch'
import { GEAR_KINDS, type GearKind } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * Army presets, shared by Divisions → Presets and couch mode's Army page: the account's presets in
 * this browser, and restoring one. Restoring signs only the differences: divisions that already
 * stand as the preset says are left alone, ones whose warlord the preset also uses are adjusted,
 * the rest are taken apart and the preset's other divisions raised. Divisions that are out cannot
 * change and stay; a preset division that needs one of their cards is left out, and said so.
 */

export type RestoreStep = 'free' | 'create' | 'fill'
type Step = RestoreStep
interface Run {
  done: Step[]
  failed: Step | null
  created: Map<string, number>
}

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function usePresets(account: string, divisions: Division[], editable: (d: Division) => boolean) {
  const army = useArmy(account)
  const { run, pending } = useTransaction()
  const [presets, setPresets] = useState<Preset[]>(() => readPresets(account))
  const [restoring, setRestoring] = useState<Preset | null>(null)
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [runState, setRunState] = useState<Run | null>(null)
  const busy = pending === 'preset'
  const free = army.data?.free

  /** Every staked card by id, for the restore plan's names and pictures. */
  const cards = useMemo(() => {
    const m = new Map<string, AssetRef>(army.data?.assets ?? [])
    for (const d of divisions) {
      if (d.leader) m.set(d.leader.assetId, d.leader)
      for (const u of d.units) {
        m.set(u.asset.assetId, u.asset)
        for (const k of GEAR_KINDS) if (u.gear[k]) m.set(u.gear[k]!.assetId, u.gear[k]!)
      }
    }
    return m
  }, [army.data, divisions])

  const save = (list: Preset[]) => {
    setPresets(list)
    if (!writePresets(account, list)) toast.error('This browser would not keep the preset (storage blocked or full).')
  }
  const current = snapshot(divisions)
  const overwrite = (p: Preset) => {
    save(presets.map((x) => (x.id === p.id ? { ...x, savedAt: Date.now(), divisions: current } : x)))
    toast.success(`"${p.name}" now holds the army as it is`)
  }
  // ---- Restoring: the preset's divisions as targets, then the same diff the optimizer signs -------

  const targets = useMemo<PlannedDivision[]>(() => {
    if (!plan) return []
    const ref = (id: string) => cards.get(id)
    return plan.build.flatMap((d) => {
      const warlord = ref(d.leader)
      if (!warlord) return []
      const units = d.units.flatMap((u) => {
        const merc = ref(u.merc)
        if (!merc) return []
        const gear: Partial<Record<GearKind, AssetRef>> = {}
        for (const k of GEAR_KINDS) {
          const g = u.gear[k] ? ref(u.gear[k]!) : undefined
          if (g) gear[k] = g
        }
        return [{ merc, gear, atk: 0, def: 0, move: 0 }]
      })
      return [{ warlord, units, mission: null as never, atk: 0, def: 0, move: 0, pace: 0, perHour: 0, unchanged: false }]
    })
  }, [plan, cards])
  // Kept divisions are targets too, so the diff leaves them alone and only the rest changes.
  const diff = useMemo(() => {
    if (!plan) return null
    const keptTargets: PlannedDivision[] = plan.keep.map((d) => ({
      warlord: d.leader!,
      units: d.units.map((u) => ({ merc: u.asset, gear: { ...u.gear }, atk: 0, def: 0, move: 0 })),
      mission: null as never,
      atk: 0,
      def: 0,
      move: 0,
      pace: 0,
      perHour: 0,
      unchanged: true
    }))
    return diffArmy([...plan.keep, ...plan.disband], [...keptTargets, ...targets])
  }, [plan, targets])
  const steps: Step[] = diff
    ? [...(diff.counts.free ? (['free'] as Step[]) : []), ...(diff.create.length ? (['create'] as Step[]) : []), ...(diff.counts.fill ? (['fill'] as Step[]) : [])]
    : []
  const state: Run = runState ?? { done: [], failed: null, created: new Map() }
  const finished = !!plan && steps.length > 0 && state.done.length === steps.length

  const startRestore = (p: Preset) => {
    if (!free) return
    setRestoring(p)
    setPlan(planRestore(p, divisions, free, editable))
    setRunState(null)
  }

  async function execute(from: Run) {
    if (!plan || !diff || !restoring) return
    let cur: Run = { ...from, failed: null }
    setRunState(cur)
    const nowByLeader = new Map(divisions.flatMap((d) => (d.leader ? [[d.leader.assetId, d.id] as const] : [])))
    for (const step of steps) {
      if (cur.done.includes(step)) continue
      let ok = false
      if (step === 'free') ok = await run((a, p) => diff.free(a, p), 'Divisions taken apart', 'preset', { split: true, refresh: false })
      else if (step === 'create') {
        ok = await run((a, p) => diff.create.map((l) => createDivision(a, p, l)), `${count(diff.create.length, 'division')} raised`, 'preset', { refresh: false })
        if (ok) {
          const created = new Map<string, number>()
          for (let i = 0; i < 10 && created.size < diff.create.length; i++) {
            const fresh = await army.refetch()
            for (const d of fresh.data?.divisions ?? []) if (d.leader && diff.create.includes(d.leader.assetId)) created.set(d.leader.assetId, d.id)
            if (created.size < diff.create.length) await new Promise((r) => setTimeout(r, 1500))
          }
          if (created.size < diff.create.length) {
            toast.error('The new divisions have not all shown up yet. Wait a moment and press Resume.')
            ok = false
          }
          cur = { ...cur, created }
        }
      } else {
        const created = cur.created
        ok = await run((a, p) => diff.fill(a, p, (l) => created.get(l) ?? nowByLeader.get(l)), `"${restoring.name}" restored`, 'preset', { split: true })
      }
      if (!ok) {
        cur = { ...cur, failed: step }
        setRunState(cur)
        return
      }
      cur = { ...cur, done: [...cur.done, step] }
      setRunState(cur)
    }
  }

  const stepLabel = (s: Step) =>
    s === 'free'
      ? `Take apart what differs: ${count(diff!.counts.free, 'action')}`
      : s === 'create'
        ? `Raise ${count(diff!.create.length, 'division')}`
        : `Put every mercenary and piece of gear in place: ${count(diff!.counts.fill, 'action')}`
  const nameOf = (id: string) => cards.get(id)?.name ?? `#${id}`

  return { army, presets, setPresets, save, current, overwrite, restoring, setRestoring, plan, setPlan, setRunState, busy, free, cards, targets, diff, steps, state, finished, startRestore, execute, stepLabel, nameOf }
}
