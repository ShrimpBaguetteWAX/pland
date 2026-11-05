import { useState, type CSSProperties } from 'react'

import { imageSources } from '@/lib/ipfs'

/*
 * Card art cut down to the picture. The NFT images carry their own frame, name and stat panel; this
 * shows only the painting inside, so the page can frame it its own way. Planetary Defense cards come
 * in two layouts (a square image with a glowing frame, and a taller one with corner badges); each has
 * its picture in a known window. Anything else (an Alien Worlds NFT) is shown whole.
 */

export const RARITY: Record<string, string> = {
  common: 'var(--r-common)',
  uncommon: 'var(--r-uncommon)',
  rare: 'var(--r-rare)',
  epic: 'var(--r-epic)',
  legendary: 'var(--r-legendary)',
  mythic: 'var(--r-legendary)'
}
export const rarityColor = (rarity?: string) => RARITY[(rarity || '').toLowerCase()] ?? RARITY.common

type Layout = 'square' | 'tall' | 'whole'
const layoutOf = (w: number, h: number): Layout => {
  const r = w / h
  if (Math.abs(r - 1) < 0.02) return 'square'
  if (Math.abs(r - 0.75) < 0.03) return 'tall'
  return 'whole'
}

/**
 * A cropped card picture filling its box; the box sets the size and shape. `whole` is for a picture
 * that is not a card (a mission image): it fills the box uncropped.
 */
export function Portrait({
  img,
  className = '',
  rarity,
  whole = false
}: {
  img?: string
  className?: string
  rarity?: string
  whole?: boolean
}) {
  const sources = imageSources(img)
  const [n, setN] = useState(0)
  const [layout, setLayout] = useState<Layout | null>(null)
  const src = sources[n]
  return (
    <span className={`portrait ${className}`} style={{ '--rc': rarityColor(rarity) } as CSSProperties}>
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          className={layout ? `is-${whole ? 'whole' : layout}` : 'is-loading'}
          onLoad={(e) => setLayout(layoutOf(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight))}
          onError={() => setN((i) => i + 1)}
        />
      )}
    </span>
  )
}
