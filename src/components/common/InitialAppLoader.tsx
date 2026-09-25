import { Sparkles } from 'lucide-react'

/**
 * Full-viewport splash for a first sign-in on this device, while the first full download runs.
 * Uses motion only when the user has not requested reduced motion.
 */
export function InitialAppLoader() {

  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-[linear-gradient(180deg,#faf8f5_0%,#f0ebe3_55%,#ebe4da_100%)] px-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div
        className="relative flex size-20 items-center justify-center rounded-3xl border border-teal-800/15 bg-linear-to-br from-teal-800/20 to-stone-800/10 shadow-[0_20px_50px_rgba(19,78,74,0.12)] motion-safe:animate-[kwentaBootPulse_2.4s_ease-in-out_infinite]"
        aria-hidden
      >
        <div
          className="pointer-events-none absolute inset-1 rounded-[1.35rem] opacity-40 motion-safe:animate-[kwentaBootShimmer_2.8s_linear_infinite]"
          style={{
            background:
              'linear-gradient(110deg, transparent 0%, rgba(255,255,255,0.35) 45%, transparent 90%)',
            backgroundSize: '200% 100%',
          }}
        />
        <Sparkles className="relative size-9 text-teal-800 motion-safe:animate-[kwentaBootPulse_2.4s_ease-in-out_infinite]" />
      </div>
      <div className="max-w-sm text-center">
        <p className="font-display text-lg font-semibold tracking-tight text-stone-800">Kwenta</p>
        <p className="mt-2 text-sm text-stone-600">Syncing your bills and groups…</p>
      </div>
    </div>
  )
}
