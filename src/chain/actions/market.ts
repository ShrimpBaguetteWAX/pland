import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/** The AtomicMarket contract every listing lives on. */
export const ATOMICMARKET = 'atomicmarket'

/** The marketplace named on every purchase (registered on AtomicMarket; it receives the buying side's marketplace cut). */
export const BUY_MARKETPLACE = 'shop.ale'

export interface SaleToBuy {
  saleId: string
  assetId: string
  /** Raw listing price in the token's smallest unit (WAX: 8 decimals), as the API gives it. */
  listingPrice: string
}

/** 12345678901 raw units -> "123.45678901 WAX", exact (no floating point). */
export function waxAsset(raw: bigint): string {
  const whole = raw / 100_000_000n
  const frac = (raw % 100_000_000n).toString().padStart(8, '0')
  return `${whole}.${frac} WAX`
}

/**
 * Buys WAX-priced listings the way AtomicHub does: every sale is asserted first (the purchase
 * fails if the seller changed the price or the assets in the meantime), the total is deposited
 * once, then each sale is purchased. Everything lands in one transaction, so it all goes through
 * or nothing does.
 */
export function buySalesActions(account: string, permission: string, sales: SaleToBuy[]): AnyAction[] {
  const auth = [{ actor: account, permission }]
  const total = sales.reduce((n, s) => n + BigInt(s.listingPrice), 0n)
  return [
    ...sales.map((s): AnyAction => ({
      account: ATOMICMARKET,
      name: 'assertsale',
      authorization: auth,
      data: {
        sale_id: s.saleId,
        asset_ids_to_assert: [s.assetId],
        listing_price_to_assert: waxAsset(BigInt(s.listingPrice)),
        settlement_symbol_to_assert: '8,WAX'
      }
    })),
    {
      account: 'eosio.token',
      name: 'transfer',
      authorization: auth,
      data: { from: account, to: ATOMICMARKET, quantity: waxAsset(total), memo: 'deposit' }
    },
    ...sales.map((s): AnyAction => ({
      account: ATOMICMARKET,
      name: 'purchasesale',
      authorization: auth,
      data: { buyer: account, sale_id: s.saleId, intended_delphi_median: 0, taker_marketplace: BUY_MARKETPLACE }
    }))
  ]
}

/** The NFTs just bought arrive in the same transaction, so they can be staked right after. */
export const stakeBoughtAction = (account: string, permission: string, assetIds: string[]): AnyAction => ({
  account: CONTRACTS.ATOMICASSETS,
  name: 'transfer',
  authorization: [{ actor: account, permission }],
  data: { from: account, to: CONTRACTS.CORE, asset_ids: assetIds, memo: 'stake' }
})

export interface SaleToList {
  assetId: string
  /** Asking price in WAX. */
  priceWax: number
}

/** "123.45678901 WAX" from a WAX amount, rounded to the chain's 8 decimals. */
export const waxAmount = (wax: number) => waxAsset(BigInt(Math.round(wax * 1e8)))

/**
 * Lists NFTs on AtomicMarket the way AtomicHub does: for each one, the sale is announced at its
 * price and the NFT is offered to the market contract (memo "sale"). The NFT stays in the wallet
 * until someone buys it; AtomicMarket's `cancelsale` takes it off again.
 */
export function listSalesActions(account: string, permission: string, sales: SaleToList[], marketplace = ''): AnyAction[] {
  const auth = [{ actor: account, permission }]
  return sales.flatMap((s): AnyAction[] => [
    {
      account: ATOMICMARKET,
      name: 'announcesale',
      authorization: auth,
      data: {
        seller: account,
        asset_ids: [s.assetId],
        listing_price: waxAmount(s.priceWax),
        settlement_symbol: '8,WAX',
        maker_marketplace: marketplace
      }
    },
    {
      account: CONTRACTS.ATOMICASSETS,
      name: 'createoffer',
      authorization: auth,
      data: { sender: account, recipient: ATOMICMARKET, sender_asset_ids: [s.assetId], recipient_asset_ids: [], memo: 'sale' }
    }
  ])
}

/** Takes a listing of the player's off the market. */
export const cancelSaleAction = (account: string, permission: string, saleId: string): AnyAction => ({
  account: ATOMICMARKET,
  name: 'cancelsale',
  authorization: [{ actor: account, permission }],
  data: { sale_id: saleId }
})

export interface SaleToReprice extends SaleToList {
  saleId: string
}

/** Changes a listing's price the way AtomicHub does: the sale is cancelled and announced again. */
export function repriceSalesActions(account: string, permission: string, sales: SaleToReprice[], marketplace = ''): AnyAction[] {
  return sales.flatMap((s) => [cancelSaleAction(account, permission, s.saleId), ...listSalesActions(account, permission, [s], marketplace)])
}

/**
 * Sells one NFT into an open buy offer. The NFT is first offered to the market (memo "tbuyoffer"
 * for a template offer, "buyoffer" for an offer on this very NFT), then fulfilltbuyo or acceptbuyo:
 * the contract takes the last offer made to it, so the order matters. The price is asserted, so a
 * changed or withdrawn offer fails the transaction instead of selling cheaper. The WAX is paid
 * straight to the seller.
 */
export function sellToBuyofferActions(
  account: string,
  permission: string,
  offer: { id: string; kind: 'template' | 'asset'; amount: string },
  assetId: string
): AnyAction[] {
  const auth = [{ actor: account, permission }]
  const price = waxAsset(BigInt(offer.amount))
  const handOver = (memo: string): AnyAction => ({
    account: CONTRACTS.ATOMICASSETS,
    name: 'createoffer',
    authorization: auth,
    data: { sender: account, recipient: ATOMICMARKET, sender_asset_ids: [assetId], recipient_asset_ids: [], memo }
  })
  if (offer.kind === 'template') {
    return [
      handOver('tbuyoffer'),
      {
        account: ATOMICMARKET,
        name: 'fulfilltbuyo',
        authorization: auth,
        data: {
          seller: account,
          buyoffer_id: offer.id,
          asset_id: assetId,
          expected_price: price,
          taker_marketplace: BUY_MARKETPLACE
        }
      }
    ]
  }
  return [
    handOver('buyoffer'),
    {
      account: ATOMICMARKET,
      name: 'acceptbuyo',
      authorization: auth,
      data: { buyoffer_id: offer.id, expected_asset_ids: [assetId], expected_price: price, taker_marketplace: BUY_MARKETPLACE }
    }
  ]
}
