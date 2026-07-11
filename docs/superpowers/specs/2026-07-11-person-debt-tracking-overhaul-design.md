# Person Debt Tracking Overhaul — Design

**Date:** 2026-07-11
**Status:** Approved design, pending spec review → implementation plan
**Scope:** Full sweep (person page, payment/settle flows, balance math, People list, Home rollups, bill-page badges)

---

## 1. Problem

Tracking money between two people is confusing. On a single person's page today the user sees **five balance numbers**, each computed by a different function, that can visibly disagree:

1. the summed headline ("Balanced" / "Receive ₱X" / "Pay ₱X")
2. a "Where this stands" per-source breakdown (Personal + each group)
3. per-bill badges (Receive / Pay / **Covered** / Even — and "Covered" bills confusingly render "Even")
4. per-group nets
5. "available general credit" buried in helper text

There are also **four ways to record a payment** (Add payment → General, Add payment → Distribute, Settle up, Apply credit to groups), whose differences live in one dense paragraph. Worst of all, **"general credit" is money that was paid but does not move the balance** — the exact "I added payments but the balance didn't change" feeling. The money-flow ledger page was built as a workaround to explain all this.

The user's mental model, in their words: *"it's just like how we manage debts in person but digitally and simpler."* Bills add to a tab, payments subtract, the two directions net, and there is one number: who owes whom right now.

---

## 2. Goals & Non-Goals

**Goals**
- One signed number per person (per currency): the net of every bill and payment between the two people, personal **and** group combined.
- Overpayment flips the tab — no "credit" concept at all.
- One page that both **explains** the number (what pulls each way) and lets you **track** every addition and subtraction (the statement). Absorb the separate money-flow ledger page.
- One payment action that replaces General / Distribute / Apply-credit, with an explicit "apply to" choice.
- Rebuild "Settle up" as a prefilled full-balance payment.
- Keep every surface consistent (People list, Home, group pages, bill pages).

**Non-Goals**
- No schema/data migration. The change is in compute + presentation, not stored shape.
- Not reworking group multi-recipient settle-up on the group page (stays as-is).
- Not changing bill creation / splitting logic.
- Not touching sync/realtime mechanics.

---

## 3. Mental Model — the signed running tab

One relationship = one tab, per currency.

- **A bill you're both on** contributes its **pairwise share** as a signed line: `+` if it makes them owe you (you paid / they consumed), `−` if it makes you owe them.
- **A payment** is a signed line in the opposite direction: `−` when they pay you, `+`… (conceptually a payment always moves the tab toward, and past, zero).
- **Balance = the cumulative signed sum.** Positive = they owe you; negative = you owe them; zero = settled up.
- **Overpayment flips the sign.** They owe you ₱100, they pay ₱150 → you owe them ₱50. No banked credit, ever.

There is effectively **one kind of thing**: a signed money event. Bills auto-generate events (their pairwise share); payments are events the user records. The UI presents them in one stream.

---

## 4. Balance math

**Sign convention (unchanged from codebase):** positive = they owe me / I receive; negative = I owe them / I pay.

### 4.1 Combined net (the headline)

```
net(me, other, currency) =
    personalNet(me, other, currency)          // personal bills' pairwise shares − personal payments
  + Σ over shared groups g:
        groupPairwiseNet(g, me, other, currency)   // group bills' pairwise shares − group-tagged payments
```

- **`personalNet`** = signed sum of pairwise shares of every `group_id = null` bill involving the pair, minus every personal payment (`group_id = null` settlement) between them. **No clamping** — this is the key change from `computePairwiseNetPersonalOnly`.
- **`groupPairwiseNet`** = the existing per-group pairwise balance (bills' pairwise shares + group-tagged settlements). Reused as-is.
- The net is computed **per currency**; currencies never mix.

### 4.2 Overpayment / flip

Because the net is a plain signed sum, overpayment falls out for free: paying more than is owed drives the sum past zero into the other direction. There is no special case and no `Math.max(0, …)` clamp anywhere.

### 4.3 "Right now" decomposition

The page's "Right now" summary is the **per-context signed breakdown** that provably sums to the headline:

```
Personal            +₱100
Beach trip (group)  +₱300
Groceries (group)   −₱100
────────────────────────
Net                 +₱300  → "They owe you ₱300"
```

Grouping those rows by sign yields the "what pulls each way" framing (they-owe total vs you-owe total). This is the single source of truth for the hero, the summary, and the export card — computed once and passed down (replacing today's four hand-assembled variants).

### 4.4 Backward compatibility — no migration

- New net = signed sum of bill shares − all payments. Every **existing** settlement row (bill-tagged, group-tagged, untagged "general credit", or bundled) simply counts as a payment in the sum. No rows need rewriting.
- **One visible consequence:** any user who currently holds banked "general credit" will see that relationship's balance **shift once** when this ships — the previously-hidden overpayment surfaces as a flipped (or reduced) balance. This is intended: it makes hidden money visible. Worth a one-time release note.

---

## 5. Person page — hybrid layout

```
← People                                              ⋮
┌──────────────────────────────────────────────────────┐
│ Lorenz                                      🔗 Linked │
│                                                        │
│ Lorenz owes you   ₱400                                 │   ← 1. Balance hero (one signed number)
│                                                        │
│ [ Record a payment ]              [ Settle up ]        │
└────────────────────────────────────────────────────────┘
┌─ Right now ────────────────────────────────────────────┐   ← 2. Composition summary
│ They owe you ₱500   ·   You owe ₱100                    │
│   ▸ Personal        +₱100                               │      (expandable per-context rows,
│   ▸ Beach trip       +₱300                              │       provably sum to the hero)
│   ▸ Groceries       −₱100                               │
└────────────────────────────────────────────────────────┘
┌─ Statement ────────────────────────────────────────────┐   ← 3. Running timeline
│ Aug 3  Beach trip (group)      +₱300   → ₱700           │      (absorbs the money-flow page)
│ Aug 1  Payment · you paid      −₱100   → ₱400           │
│ Jul 20 Dinner                  +₱200   → ₱300           │
│ Jul 12 Payment · they paid     −₱150   → ₱100           │
│                         [ Show more ]                   │
└────────────────────────────────────────────────────────┘
   Linked identities …                                        ← 4. Identity (moved out of money card)
```

1. **Balance hero** — one signed number per currency (multi-currency stacked). Copy: `Lorenz owes you ₱X` / `You owe Lorenz ₱X` / `Settled up`. Buttons: `Record a payment` (primary, always) and `Settle up` (shown only when balance ≠ 0).
2. **"Right now" summary** — the §4.3 decomposition. Collapsed to the one-line "they owe / you owe" split by default; expands to per-context signed rows. Cures "the numbers don't agree."
3. **Statement** — the running timeline: each row = date, title, context tag (Personal / group name), signed amount, and **running balance after this event**. Newest-first, paginated ("Show more"). Bills link to the bill; payments open edit. **No per-bill Receive/Pay/Covered/Even badges.** The standalone `/app/people/:id/ledger` route is retired (its content now lives here).
4. **Linked identities** — moved out of the balance/money card into its own low-emphasis section; it's identity-merging, not money.

---

## 6. Unified payment flow — "Record a payment"

Replaces **General**, **Distribute**, and **Apply-credit** with a single dialog.

**Fields**
- **Direction** — "They paid you" / "You paid them". Defaulted by who currently owes whom.
- **Amount**, **date**, optional **note**.
- **Apply to** — how the payment lands, so every surface stays consistent:
  - **Default: "What's owed"** — auto-spreads across their outstanding debts **oldest-first** (personal + each group), one confirm. The fast path.
  - **Expand to choose** — allocate explicitly to **Personal** and/or a **specific group**, or split, with per-bucket amounts. (The user's chosen behavior: control when wanted.)
- Each resulting settlement row is **tagged** to its context (`group_id` / `bill_id` as appropriate), which is what keeps group pages and the per-context breakdown correct.
- **Excess** beyond everything selected flips the relevant tab (recorded as a payment that carries the sum past zero) — no credit banking, no remainder-as-credit dialog.

**What it produces:** normal settlement rows (same table, same sync), tagged per the allocation. A single logical payment may still fan out into several rows across buckets; the statement groups them under one payment entry (by `bundle_id`) so "I paid once" reads as one line.

**Removed dialogs/plans:** `ApplyGeneralCreditDialog`, the General/Distribute mode toggle in `RecordSettlementDialog`, the "saved as a general payment" remainder confirm.

---

## 7. Settle up — rebuilt

`Settle up` is **not** a separate mechanism. One tap opens Record-a-payment **prefilled**:
- amount = the full current balance,
- direction = whoever owes,
- apply-to = everything (auto-spread across all outstanding debts).

Confirm → tab goes to zero. Today's two-sided offset + credit reconcile (`buildPersonalReconcilePlan`, `SettleUpDialog`'s dual-list) is retired; "offset" is now just the natural result of summing both directions.

---

## 8. Removed concepts & code

- **"General credit"** as a concept — gone from UI and math.
- `computeAvailableGeneralCredit`, `buildManualGeneralCreditSelectionPlan`, `applyGeneralCreditToSelection`, `listEligibleSharedGroupsForGeneralCredit`.
- The credit-clamping branch in `computePairwiseNetPersonalOnly` (replaced by plain signed sum).
- The credit half of `buildPersonalReconcilePlan` and the `SettleUpDialog` reconcile UI.
- `ApplyGeneralCreditDialog`; the General/Distribute toggle + remainder confirm in the record-payment path.
- Per-bill Receive/Pay/Covered/Even badge logic on the person page.
- The standalone `PersonLedgerPage` route (content folded into the statement). `money-flow.ts` simplifies: no clamp, running balance is a plain cumulative sum. It may be reused as the statement's data builder.

---

## 9. Ripple surfaces (full sweep)

- **People list (`PeoplePage`)** — each row shows the one combined signed number: "Owes you ₱X" / "You owe ₱X" / "Settled up". Drops all credit language. (Already uses `computePairwiseNetAllContexts`; that function loses its clamp.)
- **Home rollups (`HomePage`, `useOverallBalanceRollups` / `computePersonalNetRollup`)** — "to receive / to pay" switch to the same combined tab (personal **+** group) so the dashboard agrees with person pages. *Behavior change: personal-only → combined.*
- **Group page (`GroupDetailPage`)** — shape unchanged. Payments tagged to a group (from the person-page flow) appear here as settlements, keeping group balances consistent. Multi-recipient group settle-up stays.
- **Bill pages (`BillDetailPage`, `BillsPage`)** — per-bill "settled" badges become **informational**: a bill contributes its pairwise share to a person's tab; it isn't independently "settled". Copy shifts from a settled/unsettled state to "contributes ₱X to what Y owes you".

---

## 10. Affected files (initial)

| File | Change |
|------|--------|
| `src/lib/people.ts` | Remove clamp from personal net; delete credit functions; `computePairwiseNetAllContexts` becomes the single combined-net source; add per-context decomposition helper |
| `src/lib/money-flow.ts` | Simplify to plain cumulative signed sum (no clamp); serve as the statement data builder |
| `src/lib/settlement.ts` | Remove credit-based reconcile; keep group pairwise + group settle-up |
| `src/db/operations.ts` | Unify payment write path (tagged allocation, oldest-first default); remove `applyGeneralCreditToSelection`; simplify `settleUpPersonalBills` to a full-balance payment |
| `src/pages/PersonDetailPage.tsx` | Rebuild as hybrid (hero + "Right now" + statement); remove per-bill badges, apply-credit button, dense helper paragraph; move linked-identities out |
| `src/pages/PersonLedgerPage.tsx` + route | Retire standalone page; fold into statement |
| `src/components/**` payment dialogs | Collapse to one `RecordPaymentDialog` with "apply to"; delete `ApplyGeneralCreditDialog`, reconcile `SettleUpDialog` |
| `src/pages/PeoplePage.tsx` | Combined-net labels, drop credit language |
| `src/pages/HomePage.tsx` + rollup hook | Combined (personal+group) receive/pay |
| `src/pages/BillDetailPage.tsx`, `BillsPage.tsx` | Badges → informational contribution copy |

---

## 11. Testing plan (mandatory)

Per project policy, tests ship with the change. Priority coverage:

- **`tests/lib/people`** — new signed-sum net (no clamp): overpayment flips; multi-currency isolation; combined personal+group net; per-context decomposition sums to headline.
- **`tests/lib/money-flow`** — running balance is a plain cumulative sum; final row equals combined net (reconciliation invariant preserved); no clamp behavior.
- **`tests/db/operations`** — unified payment write: oldest-first auto-spread tags rows correctly across personal + group; explicit "apply to" allocation; excess flips (no remainder-credit row); `settleUpPersonalBills` full-balance path.
- **`tests/lib/settlement`** — group pairwise net still correct after person-page payments tagged to the group.
- Regression: existing settlement rows (old credit / bundled / tagged) all counted correctly by the new sum (backward-compat proof).
- `npm test` green (currently 219/22; will grow) and `npm run build` clean after each edit.

---

## 12. Risks & open questions

1. **One-time balance shift** for users holding banked general credit (§4.4). Acceptable + intended; note in release.
2. **"Apply to" default** — auto-spread oldest-first is the fast path; confirm the expand-to-choose UI is discoverable but not in the way.
3. **"Right now" for many groups** — decomposition rows could get long; keep collapsed by default, cap/scroll if needed.
4. **Group settle-up coexistence** — person-page settle-up and group-page multi-recipient settle-up both produce tagged settlements; ensure no double-counting (they operate on the same tagged rows, so the sum stays correct — verify with a test).
5. **Statement length** for heavy relationships — pagination handles it; consider a currency filter if multi-currency.

---

## 13. Rollout

Single coherent change (full sweep) since the math change ripples to People + Home regardless. Ship behind normal review; include a one-line release note about the general-credit → visible-balance shift.
