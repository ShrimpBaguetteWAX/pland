import { QueryClient } from '@tanstack/react-query'

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      /** The page shows this query's failure itself, or nothing is lost without it (see LoadError). */
      silentError?: boolean
    }
  }
}

/**
 * For data the player can change outside this site (mining in the Alien Worlds game, spending
 * TLM elsewhere): read it again when the tab regains focus, unless it was read in the last 30 s.
 * Focus refetching is otherwise off, so alt-tabbing doesn't reload every screen.
 */
export const refetchOnReturn = (query: { state: { dataUpdatedAt: number } }) =>
  Date.now() - query.state.dataUpdatedAt > 30_000 ? 'always' : false

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 60_000
    }
  }
})
