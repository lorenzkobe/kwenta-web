import { formatCurrency } from '@/lib/utils'
import type { getBillWithDetails } from '@/db/operations'

type BillDetails = NonNullable<Awaited<ReturnType<typeof getBillWithDetails>>>

interface PaymentEntry {
  fromName: string
  toName: string
  amount: number
  currency: string
  createdAt: string
  label: string
}

interface Props {
  bill: BillDetails
  groupName: string | null
  payments?: PaymentEntry[]
}

function computePersonTotals(items: BillDetails['items']): { name: string; amount: number }[] {
  const map = new Map<string, number>()
  for (const item of items) {
    for (const split of item.splits) {
      map.set(split.displayName, (map.get(split.displayName) ?? 0) + split.computed_amount)
    }
  }
  return Array.from(map.entries())
    .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount)
}

export function BillExportCard({ bill, groupName, payments = [] }: Props) {
  const personTotals = computePersonTotals(bill.items)

  return (
    <div
      style={{
        width: '100%',
        backgroundColor: '#111827',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          backgroundColor: '#0f172a',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            backgroundColor: '#0d9488',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            color: 'white',
          }}
        >
          K
        </div>
        <span style={{ color: 'white', fontSize: 14, fontWeight: 700, letterSpacing: '0.02em' }}>
          Kwenta
        </span>
        <span
          style={{
            marginLeft: 'auto',
            color: '#6b7280',
            fontSize: 11,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          Bill Summary
        </span>
      </div>

      {/* Bill Info */}
      <div style={{ padding: '18px 20px 14px' }}>
        {groupName && (
          <div
            style={{
              color: '#0d9488',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            {groupName}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'white', fontSize: 18, fontWeight: 700, lineHeight: 1.2 }}>
              {bill.title}
            </div>
            <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 4 }}>
              {new Date(bill.created_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}{' '}
              · paid by {bill.payorName}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ color: '#2dd4bf', fontSize: 18, fontWeight: 700 }}>
              {formatCurrency(bill.total_amount, bill.currency)}
            </div>
            <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{bill.currency}</div>
          </div>
        </div>

        {bill.note && (
          <div
            style={{
              marginTop: 10,
              padding: '8px 12px',
              backgroundColor: '#1f2937',
              borderRadius: 8,
              color: '#d1d5db',
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {bill.note}
          </div>
        )}
      </div>

      {bill.items.length > 1 ? (
        <>
          {/* Itemized: items with nested splits */}
          <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
            <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
              Items
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bill.items.map((item) => (
                <div key={item.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 600 }}>{item.name}</span>
                    <span style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 600 }}>
                      {formatCurrency(item.amount, bill.currency)}
                    </span>
                  </div>
                  {item.splits.length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {item.splits.map((split) => (
                        <div key={split.id} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 12 }}>
                          <span style={{ color: '#6b7280', fontSize: 11 }}>{split.displayName}</span>
                          <span style={{ color: '#9ca3af', fontSize: 11 }}>
                            {formatCurrency(split.computed_amount, bill.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Per-person totals (itemized only) */}
          {personTotals.length > 0 && (
            <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
              <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
                Each person's share
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {personTotals.map(({ name, amount }) => (
                  <div key={name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', backgroundColor: '#1f2937', borderRadius: 8 }}>
                    <span style={{ color: '#d1d5db', fontSize: 12, fontWeight: 500 }}>{name}</span>
                    <span style={{ color: 'white', fontSize: 12, fontWeight: 700 }}>
                      {formatCurrency(amount, bill.currency)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Simple: flat split list */
        (bill.items[0]?.splits.length ?? 0) > 0 && (
          <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
            <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
              Split
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {bill.items[0].splits.map((split) => (
                <div key={split.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', backgroundColor: '#1f2937', borderRadius: 8 }}>
                  <span style={{ color: '#d1d5db', fontSize: 12, fontWeight: 500 }}>{split.displayName}</span>
                  <span style={{ color: 'white', fontSize: 12, fontWeight: 700 }}>
                    {formatCurrency(split.computed_amount, bill.currency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {/* Payments recorded */}
      {payments.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
            Payments Recorded
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {payments.map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', backgroundColor: '#1f2937', borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#d1d5db', fontSize: 12, fontWeight: 500 }}>
                    {p.fromName} → {p.toName}
                  </div>
                  {p.label && (
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>{p.label}</div>
                  )}
                  <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>
                    {new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
                <span style={{ color: '#34d399', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                  {formatCurrency(p.amount, p.currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          borderTop: '1px solid #1f2937',
          padding: '10px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ color: '#4b5563', fontSize: 11 }}>Shared from Kwenta</span>
      </div>
    </div>
  )
}
