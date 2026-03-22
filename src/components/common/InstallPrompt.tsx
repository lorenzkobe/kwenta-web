import { useState, useEffect } from 'react'
import { Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED_KEY = 'kwenta_install_dismissed'

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setVisible(true)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function handleInstall() {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setVisible(false)
    }
    setDeferredPrompt(null)
  }

  function handleDismiss() {
    setVisible(false)
    localStorage.setItem(DISMISSED_KEY, '1')
  }

  if (!visible) return null

  return (
    <div className="fixed inset-x-4 bottom-20 z-50 mx-auto max-w-md animate-[slideUp_0.3s_ease-out] rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_20px_60px_rgba(28,25,23,0.15)] lg:bottom-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-teal-800/15 p-2.5 text-teal-800">
          <Download className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-stone-800">Install Kwenta</p>
          <p className="mt-0.5 text-xs text-stone-500">
            Add to your home screen for the full offline experience
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="rounded-lg" onClick={handleInstall}>
              Install
            </Button>
            <Button variant="ghost" size="sm" className="rounded-lg" onClick={handleDismiss}>
              Not now
            </Button>
          </div>
        </div>
        <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={handleDismiss}>
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
