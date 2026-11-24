import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@irshadnazree/just-things-ui/styles.css'
import './index.css'
import App from './App.tsx'
import { installAgentApi } from './app/agent-api'

const agentToken = new URLSearchParams(location.search).get('agent')
const root = document.getElementById('root')
if (!root) { throw new Error('Missing #root element') }

if (agentToken) {
  const { runAgent } = await import('./agent/runner')
  await runAgent(agentToken, root)
} else {
  installAgentApi()
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
