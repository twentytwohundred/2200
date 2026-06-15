import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Router } from './router'
import { ThemeProvider } from './theme/ThemeProvider'
import { LiveSignalProvider } from './ws/useLiveSignal'
import { LiveFavicon } from './favicon/LiveFavicon'
import { AuthGate } from './auth/AuthGate'
import { bootstrapAuth } from './lib/auth'
import './tokens/generated/tokens.css'
import './tokens/generated/theme-default-dark.css'
import './tokens/generated/agent-palette.css'
import './main.css'

bootstrapAuth()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5_000,
    },
  },
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found in document')
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <LiveSignalProvider>
            <LiveFavicon />
            <Router />
          </LiveSignalProvider>
        </AuthGate>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
