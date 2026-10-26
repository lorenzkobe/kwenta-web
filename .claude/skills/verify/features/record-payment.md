# Record payment

What: `src/components/common/RecordPaymentDialog.tsx`, a payment between you and one person,
split across personal and group contexts (Auto / % / Custom).

Reach: `/app/people` then a person, "Record payment" (or "Settle up", which prefills the balance).

Drive: open the dialog, type an Amount (`id="pay-amt"`, autofocused), switch modes to see the
per-context boxes; Custom shows money inputs, % shows percentage inputs.

Proves it: the per-context rows add up to the typed amount; "owed" lines show the currency.

Gotchas: NEVER press the record/save button. Pick a person with a non-zero balance so the
context list is non-empty.
