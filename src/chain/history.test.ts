import { describe, expect, it } from 'vitest'

import { timesRun, type HistoryAction } from './history'

const transfer = (receipts: string[] | undefined): HistoryAction =>
  ({
    '@timestamp': '2026-11-17T06:44:06.500',
    trx_id: 't',
    act: { account: 'alien.worlds', name: 'transfer', data: { quantity: '20000.0000 TLM' } },
    ...(receipts ? { receipts: receipts.map((receiver) => ({ receiver })) } : {})
  }) as unknown as HistoryAction

describe('timesRun', () => {
  it('counts a transfer once by its own contract receipt', () => {
    expect(timesRun(transfer(['alien.worlds', '5thba.wam']))).toBe(1)
  })

  it('counts folded identical transfers once each', () => {
    expect(timesRun(transfer(['alien.worlds', 'alien.worlds', 'alien.worlds', '5thba.wam']))).toBe(3)
  })

  it('does not count the echo Hyperion returns with only a notification receipt (a swap to Alcor)', () => {
    // 20,000 TLM to Alcor came back as two entries: the transfer and an echo holding swap.alcor's receipt.
    const both = [transfer(['alien.worlds', '5thba.wam']), transfer(['swap.alcor'])]
    expect(both.reduce((n, a) => n + 20000 * timesRun(a), 0)).toBe(20000)
  })

  it('counts an entry without receipts once', () => {
    expect(timesRun(transfer(undefined))).toBe(1)
  })
})
