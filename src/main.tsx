import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { toast } from 'sonner'
import './index.css'
import App from './App.tsx'

// Re-check for a new build hourly while the app stays open, and whenever the
// user brings it back to the foreground — an installed PWA is rarely reloaded
// on its own, so without this it never discovers a deploy and goes stale.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

const updateServiceWorker = registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    setInterval(() => void registration.update(), UPDATE_CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update()
    })
  },
  onNeedRefresh() {
    // A standalone PWA has no reload button — surface a tap-to-refresh toast
    // rather than yanking the page out from under in-progress data entry.
    // updateServiceWorker(true) skip-waits the new worker, then reloads once
    // it takes control.
    toast('A new version of Kwenta is available.', {
      action: { label: 'Refresh', onClick: () => void updateServiceWorker(true) },
      duration: Infinity,
    })
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
