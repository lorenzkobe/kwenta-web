import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CloudUpload, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'

const DISMISSED_KEY = 'kwenta_account_banner_dismissed'

export function AccountBanner() {
  const { isAuthenticated, loading } = useAuth()
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (loading || isAuthenticated) return
    if (localStorage.getItem(DISMISSED_KEY)) return

    const timer = setTimeout(() => setVisible(true), 800)
    return () => clearTimeout(timer)
  }, [loading, isAuthenticated])

  function handleDismiss() {
    setVisible(false)
    localStorage.setItem(DISMISSED_KEY, '1')
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={handleDismiss}
      />

      <div className="relative w-full max-w-sm animate-[slideUp_0.3s_ease-out] rounded-3xl border border-stone-200 bg-white p-6 shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute right-3 top-3 rounded-full"
          onClick={handleDismiss}
        >
          <X className="size-3.5" />
        </Button>

        <div className="flex flex-col items-center text-center">
          <div className="rounded-2xl bg-teal-800/15 p-3.5 text-teal-800">
            <CloudUpload className="size-6" />
          </div>

          <h2 className="mt-4 text-lg font-semibold tracking-tight text-stone-800">
            Your data lives on this device
          </h2>

          <p className="mt-2 text-sm leading-relaxed text-stone-500">
            Everything is saved locally, but creating a free account lets you
            back up your data to the cloud and access it from other devices.
          </p>

          <div className="mt-5 flex w-full flex-col gap-2">
            <Button
              className="w-full rounded-xl"
              onClick={() => {
                handleDismiss()
                navigate('/login')
              }}
            >
              Create an account
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full rounded-xl text-stone-500"
              onClick={handleDismiss}
            >
              Maybe later
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
