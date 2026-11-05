export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface TokenAmount {
  amount: number
  symbol: string
  precision: number
}

/** "12.3400 TLM" -> { amount: 12.34, symbol: "TLM", precision: 4 } */
export function parseAsset(value?: string | null): TokenAmount {
  const text = String(value ?? '').trim()
  const [num = '0', symbol = ''] = text.split(/\s+/)
  const precision = num.includes('.') ? num.split('.')[1].length : 0
  return { amount: Number(num) || 0, symbol, precision }
}

/** A chain asset string with the symbol's precision, e.g. asset(5, 'DEF') -> "5.00000000 DEF". */
export function asset(amount: number, symbol: string): string {
  const precision = symbol === 'DEF' || symbol === 'WAX' ? 8 : 4
  return `${amount.toFixed(precision)} ${symbol}`
}

export function formatNumber(value: number, maxFraction = 2): string {
  if (!Number.isFinite(value)) return '–'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFraction }).format(value)
}

/** 12345 -> "12.3k" */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '–'
  const abs = Math.abs(value)
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`
  return formatNumber(value, abs >= 100 ? 0 : abs >= 10 ? 1 : 2)
}

/** Token amounts with a sensible number of decimals for the size. */
export function formatToken(amount: number, symbol?: string): string {
  const abs = Math.abs(amount)
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3
  const text = formatNumber(amount, digits)
  return symbol ? `${text} ${symbol}` : text
}

export const formatSigned = (amount: number, symbol?: string) => `${amount > 0 ? '+' : ''}${formatToken(amount, symbol)}`

/** "2h 15m", "45m", "3d 2h" */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d) return `${d}d ${h}h`
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  if (m) return s && m < 10 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

/** "01:02:03" for a countdown that ticks every second. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h >= 24 ? `${Math.floor(h / 24)}d ${pad(h % 24)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
}

export const percent = (value: number, digits = 0) => `${(value * 100).toFixed(digits)}%`

export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Mission meta JSON: title, planet, image and lore. Anything malformed becomes an empty object. */
export interface MissionMeta {
  title?: string
  name?: string
  planet?: string
  image?: string
  lore?: string
  description?: string
  subtitle?: string
}

export function parseMissionMeta(value: string): MissionMeta {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
