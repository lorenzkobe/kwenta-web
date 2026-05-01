import { formatCurrency } from '@/lib/utils'
import type { GroupBalanceSummary, SettlementHistoryItem } from '@/lib/settlement'

interface BillEntry {
  id: string
  title: string
  note: string | null
  total_amount: number
  currency: string
  created_at: string
  payorName: string
}

interface MemberEntry {
  userId: string
  profileName: string
}

interface Props {
  groupName: string
  currency: string
  members: MemberEntry[]
  balanceSummary: GroupBalanceSummary
  bills: BillEntry[]
  payments?: SettlementHistoryItem[]
}

export function GroupExportCard({ groupName, currency, members, balanceSummary, bills, payments = [] }: Props) {
  const balanceByUser = new Map<string, number>()
  for (const b of balanceSummary.balances) {
    balanceByUser.set(b.userId, b.amount)
  }

  const memberNameById = new Map<string, string>()
  for (const m of members) {
    memberNameById.set(m.userId, m.profileName)
  }

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
          Group Summary
        </span>
      </div>

      {/* Group info */}
      <div style={{ padding: '18px 20px 14px' }}>
        <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{groupName}</div>
        <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 4 }}>
          {currency} · {members.length} member{members.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Member balances */}
      {members.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div
            style={{
              color: '#6b7280',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Member Balances
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {members.map((m) => {
              const raw = balanceByUser.get(m.userId) ?? 0
              const amount = Math.round(raw * 100) / 100
              const settled = Math.abs(amount) <= 0.01
              return (
                <div
                  key={m.userId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '7px 10px',
                    backgroundColor: '#1f2937',
                    borderRadius: 8,
                  }}
                >
                  <span style={{ color: '#d1d5db', fontSize: 12, fontWeight: 500 }}>
                    {m.profileName}
                  </span>
                  <div style={{ textAlign: 'right' }}>
                    {settled ? (
                      <span style={{ color: '#9ca3af', fontSize: 12 }}>Even</span>
                    ) : (
                      <>
                        <span
                          style={{
                            color: amount > 0 ? '#34d399' : '#fbbf24',
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {formatCurrency(Math.abs(amount), currency)}
                        </span>
                        <div style={{ color: '#6b7280', fontSize: 10 }}>
                          {amount > 0 ? 'receives' : 'pays'}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Settlement suggestions */}
      {balanceSummary.groupedSuggestions.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div
            style={{
              color: '#6b7280',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Suggested Payments
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {balanceSummary.groupedSuggestions.map((s) => {
              const key = `${s.fromUserId}-${s.recipients.map((r) => r.toUserId).join('-')}`
              return (
                <div
                  key={key}
                  style={{
                    padding: '8px 10px',
                    backgroundColor: '#1f2937',
                    borderRadius: 8,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: '#d1d5db', fontWeight: 600 }}>{s.fromName}</span>
                    <span style={{ color: '#4b5563', fontSize: 10 }}>→</span>
                    <span style={{ color: '#d1d5db', fontWeight: 600 }}>
                      {s.recipients.length === 1
                        ? s.recipients[0].toName
                        : `${s.recipients.length} people`}
                    </span>
                    <span style={{ marginLeft: 'auto', color: '#2dd4bf', fontWeight: 700 }}>
                      {formatCurrency(s.totalAmount, currency)}
                    </span>
                  </div>
                  {s.recipients.length > 1 && (
                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {s.recipients.map((r) => (
                        <div
                          key={r.toUserId}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            paddingLeft: 8,
                          }}
                        >
                          <span style={{ color: '#6b7280', fontSize: 11 }}>· {r.toName}</span>
                          <span style={{ color: '#9ca3af', fontSize: 11 }}>
                            {formatCurrency(r.amount, currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Payment history */}
      {payments.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
            Payment History ({payments.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {payments.map((p) => (
              <div key={p.id} style={{ padding: '7px 10px', backgroundColor: '#1f2937', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bills */}
      {bills.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div
            style={{
              color: '#6b7280',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Bills ({bills.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {bills.map((bill) => (
              <div
                key={bill.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '6px 10px',
                  backgroundColor: '#1f2937',
                  borderRadius: 8,
                }}
              >
                <div style={{ flex: 1, marginRight: 8, overflow: 'hidden' }}>
                  <div
                    style={{
                      color: '#d1d5db',
                      fontSize: 12,
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {bill.title}
                  </div>
                  {bill.note && (
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>{bill.note}</div>
                  )}
                  <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>
                    Paid by {bill.payorName} ·{' '}
                    {new Date(bill.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                </div>
                <span style={{ color: 'white', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                  {formatCurrency(bill.total_amount, bill.currency)}
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
