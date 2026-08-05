import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  PAYMENT_METHOD_MAX_LENGTH,
  PAYMENT_METHOD_PRESETS,
} from '@/lib/payment-method'
import { cn } from '@/lib/utils'

/**
 * Method picker shared by the record and edit payment dialogs, so the two cannot drift.
 *
 * The chips only fill the input — they do not replace it. The method is free text (see
 * `payment-method.ts`), and a preset that silently became an enum would lose every value the
 * presets do not cover.
 */
export function PaymentMethodField({
  id,
  value,
  onChange,
  className,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  className?: string
}) {
  const selected = value.trim().toLowerCase()

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-stone-500">
        Method
      </label>
      <div className="flex flex-wrap gap-1">
        {PAYMENT_METHOD_PRESETS.map((preset) => {
          const active = selected === preset.toLowerCase()
          return (
            <button
              key={preset}
              type="button"
              // Tapping the active chip clears it — otherwise a method set by mistake can only be
              // removed by selecting the text and deleting it.
              onClick={() => onChange(active ? '' : preset)}
              aria-pressed={active}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/40"
            >
              <Badge
                variant={active ? 'default' : 'ghost'}
                className="cursor-pointer px-2 py-0.5 text-[0.7rem]"
              >
                {preset}
              </Badge>
            </button>
          )
        })}
      </div>
      <Input
        id={id}
        type="text"
        placeholder="Cash, GCash…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={PAYMENT_METHOD_MAX_LENGTH}
        className="mt-0.5 rounded-lg"
      />
    </div>
  )
}
