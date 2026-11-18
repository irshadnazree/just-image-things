import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@irshadnazree/just-things-ui/styles.css'
import './index.css'
import App from './App.tsx'
import { installAgentApi } from './app/agent-api'

// `bun run agent` opens the page with ?agent=<token> and drives it over a local server.
const agentToken = new URLSearchParams(location.search).get('agent')

if (agentToken) {
  void import('./agent/runner').then((m) => m.runAgent(agentToken, document.getElementById('root')!))
} else {
  installAgentApi()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
