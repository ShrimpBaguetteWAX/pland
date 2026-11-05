/**
 * Where card art comes from, in order. AtomicHub's resizer answers in tens of milliseconds with a
 * small webp; the gateways serve the original (about 1 MB each) when it cannot.
 */
export const THUMB_GATEWAY = (hash: string, size: 370 | 1110 = 370) =>
  `https://resizer.atomichub.io/images/v1/preview?ipfs=${encodeURIComponent(hash)}&size=${size}`

export const FULL_GATEWAYS = [
  'https://ipfs.alienworlds.io/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/'
]

export function normalizeHash(value?: string | null): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^https?:\/\//.test(text)) {
    const m = text.match(/\/ipfs\/([^?#]+)/) ?? text.match(/[?&]ipfs=([^&]+)/)
    return m ? decodeURIComponent(m[1]) : ''
  }
  return text.replace(/^ipfs:\/\//, '')
}

/** Every URL to try for a hash, best first; an http URL without an IPFS hash is used as is. */
export function imageSources(value?: string | null, size: 370 | 1110 = 370): string[] {
  const text = String(value ?? '').trim()
  if (!text) return []
  const hash = normalizeHash(text)
  if (!hash) return /^https?:\/\//.test(text) ? [text] : []
  // The resizer only understands a plain CID.
  const thumbs = hash.includes('/') ? [] : [THUMB_GATEWAY(hash, size)]
  return [...thumbs, ...FULL_GATEWAYS.map((g) => g + hash)]
}
