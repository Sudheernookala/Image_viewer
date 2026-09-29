import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App, { UI_PRESETS } from './App.tsx'
import { initialFromParams } from './sdk/params'

// Standalone app. Deep links: ?url=https://…/part.step   or   ?source=plm&id=PRT-1001
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App config={{ rememberRecent: true }} ui={{ ...UI_PRESETS.full, globalKeys: true }} initial={initialFromParams(new URLSearchParams(location.search))} />
  </StrictMode>,
)
