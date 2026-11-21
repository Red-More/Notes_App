import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Mobile shell: native drag (images, links, selected text) is browser
// behaviour that makes the fixed layout feel movable. Editing controls keep
// their own pointer gestures, so suppressing the default drag is safe.
document.addEventListener('dragstart', (event) => event.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* Overlays portal here so they escape the pager's stacking context and
        always paint above the tabbar. */}
    <div id="overlay-layer" className="overlay-layer" />
  </StrictMode>,
)
