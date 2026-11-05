/** Which favourite land the Mine button picks: the one paying the most TLM, or the most shards. */
export type MiningMode = 'tlm' | 'shard'

export interface Miner {
  miner: string
  last_mine_tx: string
  last_mine: string
  current_land: string
}

export interface Bag {
  account: string
  items: string[]
}

export interface ToolUse {
  asset_id: string
  last_use: number
}

export interface AwTool {
  template_id: number
  toolname: string
  rarity: string
  shine: string
  mining_power: number
  nft_power: number
  pow: number
  cooldown_seconds: number
}

export interface LandType {
  landtype_id: number
  landname: string
  mining_power_mod: number
  nft_power_mod: number
}

export interface PoolBucket {
  key: string
  value: string
}

/** Immutable data of an alien.worlds land NFT. */
export interface LandData {
  name: string
  cardid: number
  commission: number
  delay: number
  luck: number
}

/** Immutable data of an alien.worlds tool NFT. */
export interface ToolData {
  name: string
  rarity: string
  shine: string
  delay: number
}

export interface EquippedTool extends ToolData {
  asset_id: string
  last_use: number
  mining_power: number
  nft_power: number
  pow: number
}

export interface FavoriteLand {
  asset_id: string
  /** The land's name without its planet ("Pirate Cove"). */
  landName: string
  planet: string
  delay: number
  /** TLM per mine after commission. */
  estimatedTlm: number
  shards: number
}

/** WAX Mission Control's member row (members.mc mcmembers): favourites live in its settings. */
export interface McMember {
  wallet: string
  member: number
  trial: number
  flagged: number
  usrsettings?: { key: string; value: string }[]
}
