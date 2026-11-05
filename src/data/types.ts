// Row shapes of the tables this app reads. Chain integers wider than 53 bits arrive as strings.

export interface AssetStats {
  template_id: number
  category: number
  attack: number
  defense: number
  movecost: number
  movecost_reduction: number
  slots_max: number
  attack_mult_bp: number
  defense_mult_bp: number
  movecost_mult_bp: number
  min_forge_level: number
  image: string
}

export interface PlayerRow {
  owner: string
  forge_level: number
  created_at: string
}

export interface PlayerTotals {
  owner: string
  total_atk: number
  total_def: number
  total_movecost: number
  updated_at: string
}

export interface DivisionRow {
  division_id: number
  leader_asset_id: string
  leader_type: number
  slots_max: number
  atk_cached: number
  def_cached: number
  movecost_cached: number
  cache_valid: number | boolean
  stats_epoch: number
  created_at: string
  updated_at: string
}

export interface DivUnitRow {
  id: number
  division_id: number
  unit_asset_id: string
  unit_type: number
  creature_asset_id: string | number
  weapon_asset_id: string | number
  supply_asset_id: string | number
  lavalux_asset_id: string | number
}

export interface StakeRow {
  asset_id: string
  owner: string
  role: number
  division_id: number
  linked_unit_asset_id: string | number
  staked_at: string
}

export interface DivLockRow {
  division_id: number
  mission_id: number
  locked_until: string
  locked_at: string
}

export interface MissionRow {
  mission_id: number
  type: number
  start: string
  end_base: string
  min_div_attack: number
  max_divisions_total: number
  divisions_joined: number
  total_attack: number
  status: number
  reward_config_id: number
  meta: string
  min_div_defense: number
  total_defense: number
  cooldown_base_sec: number
}

export interface RewardTier {
  min_atk: number
  reward_asset: string
  weight: number
  nft_drop_pool_id: number
  token_contract: string
  token_symbol: string
}

export interface RewardConfigRow {
  reward_config_id: number
  tiers: RewardTier[]
  reward_mode: number
  nft_reward_collection: string
  nft_reward_schema: string
  nft_reward_template_id: number
  nft_reward_count: number
}

export interface RewardPoolRow {
  pool_id: number
  mission_id: number
  tlm_pool: string
  shards_pool: number
  nft_pool_id: number
  nft_asset_ids: string[]
}

export interface EntryCostRow {
  mission_id: number
  cost: string
}

export interface ShardRewardRow {
  reward_config_id: number
  shard_reward: number
}

export interface ShardCapRow {
  mission_id: number
  max_joins: number
  joins_consumed: number
}

export interface MissionEntryRow {
  entry_id: number
  owner: string
  division_id: number
  atk: number
  movecost: number
  join_time: string
  unlock_time: string
  def: number
}

export interface ForgeLevelRow {
  level: number
  cost_mode: number
  tlm_cost: string
  def_cost: string
  nft_template_id: number
  nft_collection: string
  nft_count: number
}

export interface ForgeProgressRow {
  level: number
  paid_tlm: string
  paid_def: string
  paid_nft_count: number
}

export interface ForgeTokensRow {
  id: number
  tlm_contract: string
  tlm_symbol: string
  def_contract: string
  def_symbol: string
}

export interface ShopItemRow {
  id: number
  min_forge_level: number
  price: string
  price_contract: string
  reward_type: number
  reward_token: string
  reward_token_contract: string
  reward_powerup: string
  reward_powerup_amt: number
}

export interface PowerupRow {
  powerup_id: string
  amount: number
}

export interface UserPointsRow {
  user: string
  total_points: number
  redeemable_points: number
}

export interface GlobalStatsRow {
  id: number
  player_count: number
  missions_completed: number
  tlm_distributed: string
  def_distributed: string
}

/** One entry of public/data/templates.json: what an NFT template is, for names, rarity and art. */
export interface TemplateInfo {
  name: string
  schema: string
  rarity: string
  type: string
  stars: number
  img: string
  effect?: string
  element?: string
}
