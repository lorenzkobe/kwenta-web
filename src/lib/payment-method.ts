/**
 * How a payment moved (cash / GCash / …). Free text, not an enum: the presets below are the
 * values that actually show up in this data, but a bank or wallet the app has never heard of has
 * to be typeable or the field is useless.
 *
 * The column has existed since migration 046, but nothing read it back until 069 — so users typed
 * the method into the payment's LABEL instead, which is the one field that survived. Migration
 * 068 moves the unambiguous ones across.
 */

/** Offered as one-tap chips. Order is by observed frequency, not alphabetical. */
export const PAYMENT_METHOD_PRESETS = ['Cash', 'GCash', 'GoTyme', 'BDO', 'Transfer'] as const

/** Matches the `method` column: NOT NULL is not enforced, and blank must round-trip as absent. */
export const PAYMENT_METHOD_MAX_LENGTH = 40

/**
 * Blank and whitespace-only both mean "not recorded". Keeping them distinct from null would paint
 * an empty tag on the payment row and make `method IS NULL` an unreliable test server-side.
 */
export function normalizePaymentMethod(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed.slice(0, PAYMENT_METHOD_MAX_LENGTH)
}
