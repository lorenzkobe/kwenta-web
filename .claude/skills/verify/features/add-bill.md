# Add bill

What: two forms with the same fields. `/app/bills/new` (`src/pages/AddBillPage.tsx`, personal
or group via `?group=`) and the group screen's Add bill dialog
(`src/components/common/AddBillDialog.tsx`).

Reach: bottom nav or home Quick actions for the page; `/app/groups/:id` then "Add bill" for
the dialog.

Drive:
1. Type a Title. "Paid by" opens a picker with an autofocused search input (font must be
   16px on touch; on desktop assert the `@media (pointer: coarse)` rule exists instead).
2. "Paid in": pick another currency (e.g. VND); an Exchange rate box appears.
3. "Total amount" (simple) or Items (itemized: name + `0.00` price) accept decimals; the
   split summary shows the formatted amount (e.g. "₫42,000 each").
4. Leave without saving (navigate away or close the dialog).

Proves it: the summary line and item rows show the entered amount in the Paid-in currency.

Gotchas: NEVER press "Save bill" / "Save changes" (writes to the live account). The group
dialog needs a group the account belongs to; take one from `/app/groups`.
