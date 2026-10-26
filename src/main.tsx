import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Overlays portal here so they escape the pager's stacking context and
        always paint above the tabbar. */}
    <div id="overlay-layer" className="overlay-layer" />
  </StrictMode>,
)
