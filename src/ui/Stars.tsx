import { useCallback, useMemo } from 'react'

import { useAscensionConfig } from '@/data/ascension'
import type { AssetRef } from '@/data/assets'
import { useAssetStats, useTemplates } from '@/data/game'

/*
 * Ascension stars, as a small rail under a card's name: filled stars for the ones the card has,
 * outlined ones for those it can still earn. A card that cannot ascend shows nothing, so the rail
 * only appears where it means something.
 *
 * An ascended card is a template of its own, one star up (ascend.pdef's starupmaps). Its stars are
 * in the template list, and on chain as the Forge level the card needs (N stars need Forge N). How
 * far a rarity goes comes from the star-up costs: Common to Rare reach 3 stars, Epic and above 5.
 *
 * `?stars=demo` in the address paints made-up stars on every card, to see the rail before anyone
 * owns an ascended card. Nothing else reads it.
 */

const fallbackMax = (rarity: string) => (['common', 'uncommon', 'rare'].includes(rarity) ? 3 : 5)
const DEMO = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('stars') === 'demo'

export interface StarInfo {
  stars: number
  max: number
}

/** A lookup from a template to its stars and the most its rarity can reach (null: cannot ascend). */
export function useStarInfo(): (templateId: string, rarity: string) => StarInfo | null {
  const ascension = useAscensionConfig()
  const stats = useAssetStats()
  const templates = useTemplates()

  const { ascendable, maxByRarity } = useMemo(() => {
    const ascendable = new Set<string>()
    const maxByRarity = new Map<string, number>()
    for (const [from, to] of ascension.data?.next ?? []) {
      ascendable.add(from)
      ascendable.add(to)
    }
    for (const key of ascension.data?.costs.keys() ?? []) {
      const [rarity, fromStars] = key.split(':')
      maxByRarity.set(rarity, Math.max(maxByRarity.get(rarity) ?? 0, Number(fromStars) + 1))
    }
    return { ascendable, maxByRarity }
  }, [ascension.data])

  return useCallback(
    (templateId: string, rarity: string) => {
      const info = templates.data?.[templateId]
      const r = (rarity || info?.rarity || '').toLowerCase()
      if (DEMO) {
        const max = maxByRarity.get(r) ?? fallbackMax(r)
        return { stars: Number(templateId) % (max + 1), max }
      }
      const known = ascendable.has(templateId)
      // The template list names the stars; a template newer than the list shows them as its Forge level.
      const stars = info ? Number(info.stars) || 0 : known ? Number(stats.data?.get(templateId)?.min_forge_level ?? 0) : 0
      if (!known && stars <= 0) return null
      const max = Math.max(stars, maxByRarity.get(r) ?? fallbackMax(r))
      return { stars, max }
    },
    [templates.data, stats.data, ascendable, maxByRarity]
  )
}

const Star = ({ on }: { on: boolean }) => (
  <svg className={`stars__star ${on ? 'is-on' : 'is-off'}`} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.6l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.2 20.1l1.4-6.4L2.7 9.3l6.5-.7z" />
  </svg>
)

/** The rail for a known star count. */
export function StarRailView({ info, size = 'md', className = '' }: { info: StarInfo; size?: 'sm' | 'md'; className?: string }) {
  const label = `Ascended ${info.stars} of ${info.max} stars`
  return (
    <span className={`stars stars--${size} ${className}`} role="img" aria-label={label} title={label}>
      {Array.from({ length: info.max }, (_, i) => (
        <Star key={i} on={i < info.stars} />
      ))}
    </span>
  )
}

/** The star rail of a card; nothing for a card that cannot ascend. */
export function StarRail({ asset, size = 'md', className }: { asset?: Pick<AssetRef, 'templateId' | 'rarity'> | null; size?: 'sm' | 'md'; className?: string }) {
  const lookup = useStarInfo()
  if (!asset) return null
  const info = lookup(asset.templateId, asset.rarity)
  return info ? <StarRailView info={info} size={size} className={className} /> : null
}
