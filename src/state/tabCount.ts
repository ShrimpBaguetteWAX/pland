import { useEffect } from 'react'
import { create } from 'zustand'

/*
 * What is waiting for the player, for the browser tab's title: divisions back from their missions
 * (to claim or loop) and a mine that is ready. The top bar's Loop and Mine keys know these and
 * report them here; the title reads "⚡ Planetary Defense (3)" while anything waits and is plain
 * again once nothing does.
 */

interface TabCount {
  loop: number
  mine: number
  set: (part: 'loop' | 'mine', n: number) => void
}

export const useTabCount = create<TabCount>((set) => ({
  loop: 0,
  mine: 0,
  set: (part, n) => set((s) => (s[part] === n ? s : { ...s, [part]: n }))
}))

/** Reports one part of the count while the calling component is on screen; 0 once it is gone. */
export function useReportCount(part: 'loop' | 'mine', n: number) {
  const set = useTabCount((s) => s.set)
  useEffect(() => set(part, n), [set, part, n])
  useEffect(() => () => set(part, 0), [set, part])
}

let base: string | null = null

/** Keeps the tab title in step with the count, on top of the page's own title. */
export function useTabTitle() {
  const n = useTabCount((s) => s.loop + s.mine)
  useEffect(() => {
    // The page's own title, taken once, so the count is never added on top of an earlier one.
    base ??= document.title
    document.title = n > 0 ? `⚡ ${base} (${n})` : base
  }, [n])
}
