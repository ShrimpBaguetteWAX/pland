import { atomic, type AtomicAsset } from '@/chain/atomic'
import type { AssetStats, TemplateInfo } from './types'

/**
 * Which template an NFT is never changes, so the answer is kept across visits: a returning player
 * opens their army without a single AtomicAssets request.
 */
const CACHE_KEY = 'pd.asset-templates.v2'
const CACHE_LIMIT = 4000

export interface Cached {
  /** template id */
  t: string
  /** schema */
  s: string
  /** collection */
  c: string
  /** name and image from the asset's own data, for templates outside the catalogue (Alien Worlds NFTs) */
  n?: string
  i?: string
}

let memory: Map<string, Cached> | null = null

function load(): Map<string, Cached> {
  if (memory) return memory
  memory = new Map()
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) for (const [id, v] of Object.entries(JSON.parse(raw) as Record<string, Cached>)) memory.set(id, v)
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return memory
}

function save() {
  if (!memory) return
  try {
    const entries = [...memory.entries()].slice(-CACHE_LIMIT)
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* storage full or unavailable */
  }
}

export const cachedOf = (a: AtomicAsset): Cached | null =>
  a.template
    ? {
        t: a.template.template_id,
        s: a.schema.schema_name,
        c: a.collection.collection_name,
        n: typeof a.data.name === 'string' ? a.data.name : undefined,
        i: typeof a.data.img === 'string' ? a.data.img : undefined
      }
    : null

/** Template ids for asset ids, from cache first, then AtomicAssets for the rest. */
export async function resolveTemplates(assetIds: string[]): Promise<Map<string, Cached>> {
  const cache = load()
  const wanted = [...new Set(assetIds.filter((id) => id && id !== '0'))]
  const missing = wanted.filter((id) => !cache.has(id))
  if (missing.length) {
    const assets = await atomic.getAssetsByIds(missing)
    for (const a of assets) {
      const c = cachedOf(a)
      if (c) cache.set(a.asset_id, c)
    }
    save()
  }
  const out = new Map<string, Cached>()
  for (const id of wanted) {
    const hit = cache.get(id)
    if (hit) out.set(id, hit)
  }
  return out
}

/** An NFT as the screens use it: its game stats and its catalogue entry, resolved. */
export interface AssetRef {
  assetId: string
  templateId: string
  schema: string
  stats: AssetStats | null
  info: TemplateInfo | null
  name: string
  rarity: string
  /** IPFS hash (or URL) of the card art. */
  img: string
}

export function makeAssetRef(
  assetId: string,
  c: Cached,
  statsMap: Map<string, AssetStats>,
  templates: Record<string, TemplateInfo>
): AssetRef {
  const stats = statsMap.get(c.t) ?? null
  const info = templates[c.t] ?? null
  return {
    assetId,
    templateId: c.t,
    schema: c.s,
    stats,
    info,
    name: info?.name || c.n || `#${c.t}`,
    rarity: (info?.rarity || '').toLowerCase(),
    img: info?.img || c.i || stats?.image || ''
  }
}
