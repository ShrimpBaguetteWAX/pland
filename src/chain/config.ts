export const CHAIN_ID = '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4'

export const APP_NAME = 'planetary-defense'

/**
 * Candidate WAX API nodes, one per operator. The order is only a hint: EndpointPool.probe()
 * ranks them by latency at runtime and reads rotate across the fastest few.
 */
export const RPC_NODES: readonly string[] = [
  'https://wax.blacklusion.io',
  'https://wax.greymass.com',
  'https://wax-api.alcor.exchange',
  'https://wax.a-dex.xyz',
  'https://api.waxsweden.org',
  'https://api.wax.bountyblok.io',
  'https://waxapi.blocksindia.com',
  'https://wax.eosphere.io',
  'https://api.wax.detroitledger.tech',
  'https://wax.api.eosnation.io',
  'https://wax.cryptolions.io',
  'https://api.hivebp.io',
  'https://hyperion7.sentnl.io',
  'https://wax.eosdac.io',
  'https://wax.eosusa.io',
  'https://api.wax.alohaeos.com',
  'https://wax.eosrio.io'
]

/** text/plain is CORS-safelisted, so chain POSTs skip the OPTIONS preflight. Nodes ignore it. */
export const CORS_SAFE_CONTENT_TYPE = 'text/plain;charset=UTF-8'

export const ATOMIC_NODES = [
  'https://wax.api.atomicassets.io',
  'https://atomic-api.wax.cryptolions.io',
  'https://aa.wax.blacklusion.io',
  'https://atomic.hivebp.io',
  'https://wax-aa.eu.eosamsterdam.net',
  'https://aa-wax-public1.neftyblocks.com',
  'https://atomicassets-api.alienworlds.io'
]

/** The Planetary Defense contracts (the game moved off the monolithic magordefense/narondefense). */
export const CONTRACTS = {
  CORE: 'core.pdef',
  FORGE: 'forge.pdef',
  MISSIONS: 'miss.pdef',
  PLANETS: 'planet.pdef',
  ATOMICASSETS: 'atomicassets',
  TLM: 'alien.worlds',
  DEF: 'defensetoken',
  USER_POINTS: 'uspts.worlds',
  ALCOR_SWAP: 'swap.alcor',
  /** Ascension: sacrifices (memo "burn") and star-ups (memo "ascend") by NFT transfer. */
  ASCEND: 'ascend.pdef',
  /** Planetary sieges: worlds funded with DEF and held for a season by everyone's divisions. */
  SIEGE: 'siege.pdef',
  /** Alien Worlds mining: the land a player mines on, and the mine itself. */
  MINING: 'm.federation',
  /** WAX Mission Control's CPU payer, signed first in every mine it makes. */
  MC_CPU: 'cpu.mc'
} as const

/** The Fragment material, ascension's currency. */
export const FRAGMENT_TEMPLATE = '888509'

/** Alcor TLM/DEF concentrated-liquidity pool: the DEF price used to value mixed-token loops. */
export const ALCOR_TLM_DEF_POOL_ID = 10447

/** Alcor pools the Market prices Forge costs through: DEF for slots and TLM for levels, both bought with WAX. */
export const ALCOR_DEF_WAX_POOL_ID = 10448
export const ALCOR_TLM_WAX_POOL_ID = 0

export const COLLECTIONS = ['planetdefnft', 'alien.worlds'] as const

/** Every action of a mission is one division; the contract accepts at most this many per join. */
export const MAX_DIVISIONS_PER_JOIN = 10

/**
 * Divisions every player may field without buying a Division slot. Not stored in any table: read
 * off the chain, where accounts hold exactly this many more divisions than the slots they bought
 * (8 with 3 bought, 11 with 6 bought). Each Forge Division slot adds one.
 */
export const FREE_DIVISIONS = 5

/** How many divisions a player may have: the free ones plus the Division slots bought in the Forge. */
export const divisionAllowance = (powerups: Map<string, number>) => FREE_DIVISIONS + (powerups.get('divslot') ?? 0)

/** Cooldown of a mission for a division: base seconds plus this many seconds per point of move cost. */
export const SECONDS_PER_MOVE_POINT = 10

/** shardrews.shard_reward is raw Alien Worlds points; shown shards are points / 10. */
export const SHARD_POINTS_PER_UNIT = 10

export const PLANETS = ['naron', 'neri', 'veles', 'kavian', 'eyeke', 'magor'] as const
export type Planet = (typeof PLANETS)[number]

export const DISCORD_URL = 'https://discord.gg/planetarydefense'
export const GUIDE_URL = 'https://planetary-defense-guide.gitbook.io/guide/web-game/divisions-overview'
export const OLD_SITE_URL = 'https://beta.planetarydefense.io'

/** Order of a stake row's `role` / an assetstats `category`. */
export const CATEGORY = { WARLORD: 0, MERCENARY: 1, WEAPON: 2, SUPPLY: 3, CREATURE: 4, LAVALUX: 5, LAVALUX_ALT: 6 } as const

export const RARITY_ORDER: Record<string, number> = { mythic: 0, legendary: 1, epic: 2, rare: 3, uncommon: 4, common: 5 }

export const RARITY_COLORS: Record<string, string> = {
  mythic: '#ff4d8d',
  legendary: '#ffa333',
  epic: '#b56cff',
  rare: '#3d9cff',
  uncommon: '#37d67a',
  common: '#9aa6b8'
}
