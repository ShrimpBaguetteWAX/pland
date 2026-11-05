import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import { endpointPool } from '@/chain/endpoints'
import { queryClient } from '@/data/queryClient'
import { useSession } from '@/state/session'
import { applyTheme, storedTheme } from '@/state/theme'
import { App } from './App'

import './styles/tabletop.css'

applyTheme(storedTheme())

// Rank the WAX nodes and restore any stored wallet session before the first screen.
void endpointPool.probe()
void useSession.getState().restore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
)
