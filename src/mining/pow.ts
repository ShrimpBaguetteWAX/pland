/*
 * Alien Worlds proof of work: find 8 random bytes so that
 * sha256(account[8] ++ lastMineTx[8] ++ random[8]) starts with "0000" and the
 * next hex digit is <= difficulty.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const W = new Uint32Array(64)
const block = new Uint8Array(64)

/** SHA-256 of a message that fits in one block (<= 55 bytes), written into `out` as 8 state words. */
export function sha256Short(msg: Uint8Array, out: Uint32Array) {
  block.fill(0)
  block.set(msg)
  block[msg.length] = 0x80
  const bits = msg.length * 8
  block[62] = (bits >>> 8) & 0xff
  block[63] = bits & 0xff

  for (let i = 0; i < 16; i++) {
    W[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]
  }
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15]
    const w2 = W[i - 2]
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0
  }

  let a = 0x6a09e667
  let b = 0xbb67ae85
  let c = 0x3c6ef372
  let d = 0xa54ff53a
  let e = 0x510e527f
  let f = 0x9b05688c
  let g = 0x1f83d9ab
  let h = 0x5be0cd19

  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const ch = (e & f) ^ (~e & g)
    const t1 = (h + s1 + ch + K[i] + W[i]) | 0
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (s0 + maj) | 0
    h = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }

  out[0] = (0x6a09e667 + a) | 0
  out[1] = (0xbb67ae85 + b) | 0
  out[2] = (0x3c6ef372 + c) | 0
  out[3] = (0xa54ff53a + d) | 0
  out[4] = (0x510e527f + e) | 0
  out[5] = (0x9b05688c + f) | 0
  out[6] = (0x1f83d9ab + g) | 0
  out[7] = (0x5be0cd19 + h) | 0
}

/** EOSIO name -> 8 little-endian bytes of its uint64 value. */
export function nameToBytes(name: string): Uint8Array {
  const charValue = (ch: string) => {
    if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 97 + 6
    if (ch >= '1' && ch <= '5') return ch.charCodeAt(0) - 49 + 1
    return 0
  }
  let value = 0n
  for (let i = 0; i <= 12; i++) {
    const c = i < name.length ? charValue(name[i]) : 0
    if (i < 12) value |= BigInt(c & 0x1f) << BigInt(64 - 5 * (i + 1))
    else value |= BigInt(c & 0x0f)
  }
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn)
  return out
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export interface PowRequest {
  account: string
  lastMineTx?: string
  difficulty: number
}

export interface PowResult {
  nonce: string
  iterations: number
}

/** The 24-byte message with the random tail left zeroed. */
export function powMessage(account: string, lastMineTx?: string): Uint8Array {
  const message = new Uint8Array(24)
  message.set(nameToBytes(account), 0)
  const last = (lastMineTx || '0'.repeat(64)).slice(0, 16)
  for (let i = 0; i < 8; i++) message[8 + i] = parseInt(last.slice(i * 2, i * 2 + 2), 16)
  return message
}

/** Hex digest starts with "0000" and its fifth digit is <= difficulty. */
export const meetsDifficulty = (firstWord: number, difficulty: number) =>
  firstWord >>> 16 === 0 && ((firstWord >>> 12) & 0xf) <= difficulty

export function findNonce({ account, lastMineTx, difficulty }: PowRequest): PowResult {
  const message = powMessage(account, lastMineTx)
  const random = message.subarray(16, 24)
  const digest = new Uint32Array(8)
  let iterations = 0

  for (;;) {
    crypto.getRandomValues(random)
    sha256Short(message, digest)
    iterations++
    if (meetsDifficulty(digest[0], difficulty)) return { nonce: toHex(random), iterations }
  }
}
