import * as React from 'react'
import { Input } from '@/components/ui/input'
import { cn, currencySymbol } from '@/lib/utils'

type MoneyInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> & {
  currency: string
  /** Layout of the field in its row (width, flex, margins). */
  className?: string
  /** The input itself (height, rounding, alignment). */
  inputClassName?: string
}

/**
 * A money field showing its currency symbol before the number. It never generates an id for the
 * input: callers and tests address fields by the ids they pass themselves.
 */
export function MoneyInput({ currency, className, inputClassName, style, ...props }: MoneyInputProps) {
  const symbol = currencySymbol(currency)
  const descriptionId = React.useId()
  const describedBy = [props['aria-describedby'], descriptionId].filter(Boolean).join(' ')

  return (
    <div className={cn('relative', className)}>
      <span
        aria-hidden="true"
        data-slot="currency-prefix"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base text-stone-400"
      >
        {symbol}
      </span>
      <span id={descriptionId} className="sr-only">
        Amount in {currency}
      </span>
      <Input
        type="text"
        inputMode="decimal"
        {...props}
        aria-describedby={describedBy}
        className={inputClassName}
        style={{ ...style, paddingLeft: `${0.75 + symbol.length * 0.65 + 0.3}rem` }}
      />
    </div>
  )
}
