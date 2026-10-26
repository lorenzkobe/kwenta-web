import * as React from 'react'
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('animate-pulse rounded bg-stone-200', className)} {...props} />
}

/** The shape of a detail screen (back link, header card, rows) while its first answer loads. */
function DetailPageSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-5" role="status" aria-label={label}>
      <Skeleton className="h-8 w-20 rounded-full" />
      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <Skeleton className="h-7 w-1/2" />
        <Skeleton className="mt-2 h-4 w-1/3" />
        <Skeleton className="mt-5 h-16 w-full rounded-2xl" />
      </div>
      <div className="space-y-2 rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-2 h-3 w-1/4" />
          </div>
        ))}
      </div>
    </div>
  )
}

export { Skeleton, DetailPageSkeleton }
