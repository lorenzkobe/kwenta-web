import { formatCurrency } from '@/lib/utils'
import type { SettlementHistoryItem } from '@/lib/settlement'

export interface PersonBillEntry {
  title: string
  note: string | null
  currency: string
  net: number
  items: Array<{
    id: string
    name: string
    amount: number
    splits: Array<{
      id: string
      displayName: string
      computed_amount: number
      [key: string]: unknown
    }>
    [key: string]: unknown
  }>
}

interface PersonGroupEntry {
  groupName: string
  currency: string
  theirNet: number
}

interface Props {
  displayName: string
  netByCurrency: Map<string, number>
  unsettledPersonalBills: PersonBillEntry[]
  sharedGroups: PersonGroupEntry[]
  payments?: SettlementHistoryItem[]
}

export function PersonExportCard({ displayName, netByCurrency, unsettledPersonalBills, sharedGroups, payments = [] }: Props) {
  const netEntries = Array.from(netByCurrency.entries()).filter(([, v]) => Math.abs(v) > 0.005)

  function netColor(net: number) {
    if (Math.abs(net) < 0.005) return '#9ca3af'
    return net > 0 ? '#34d399' : '#fbbf24'
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
            textTransform: 'uppercase' as const,
          }}
        >
          Balance Summary
        </span>
      </div>

      {/* Person info */}
      <div style={{ padding: '18px 20px 14px' }}>
        <div style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>{displayName}</div>
        {netEntries.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: 13, marginTop: 6 }}>All settled up</div>
        ) : (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {netEntries.map(([currency, net]) => (
              <span key={currency} style={{ color: netColor(net), fontSize: 18, fontWeight: 700 }}>
                {formatCurrency(Math.abs(net), currency)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Unsettled personal bills with full breakdown */}
      {unsettledPersonalBills.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div
            style={{
              color: '#6b7280',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              marginBottom: 10,
            }}
          >
            Open Personal Bills
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {unsettledPersonalBills.map((bill, i) => (
              <div
                key={`${bill.title}-${i}`}
                style={{ backgroundColor: '#1f2937', borderRadius: 8, overflow: 'hidden' }}
              >
                {/* Bill header */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    padding: '8px 10px',
                  }}
                >
                  <div style={{ flex: 1, marginRight: 8 }}>
                    <div style={{ color: '#e5e7eb', fontSize: 12, fontWeight: 600 }}>{bill.title}</div>
                    {bill.note && (
                      <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{bill.note}</div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div
                      style={{
                        color: bill.net > 0 ? '#34d399' : '#fbbf24',
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {formatCurrency(Math.abs(bill.net), bill.currency)}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: 10 }}>
                      {bill.net > 0 ? 'they pay you' : 'you pay'}
                    </div>
                  </div>
                </div>

                {/* Items or flat split */}
                {bill.items.length > 1 ? (
                  <div style={{ borderTop: '1px solid #374151', padding: '8px 10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {bill.items.map((item) => (
                        <div key={item.id}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#d1d5db', fontSize: 11, fontWeight: 600 }}>{item.name}</span>
                            <span style={{ color: '#d1d5db', fontSize: 11, fontWeight: 600 }}>
                              {formatCurrency(item.amount, bill.currency)}
                            </span>
                          </div>
                          {item.splits.length > 0 && (
                            <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {item.splits.map((split) => (
                                <div key={split.id} style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 10 }}>
                                  <span style={{ color: '#6b7280', fontSize: 10 }}>{split.displayName}</span>
                                  <span style={{ color: '#9ca3af', fontSize: 10 }}>
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
                ) : (bill.items[0]?.splits.length ?? 0) > 0 ? (
                  <div style={{ borderTop: '1px solid #374151', padding: '8px 10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {bill.items[0].splits.map((split) => (
                        <div key={split.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#9ca3af', fontSize: 10 }}>{split.displayName}</span>
                          <span style={{ color: '#d1d5db', fontSize: 10, fontWeight: 600 }}>
                            {formatCurrency(split.computed_amount, bill.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Group balances */}
      {sharedGroups.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div
            style={{
              color: '#6b7280',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              marginBottom: 10,
            }}
          >
            Group Balances
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sharedGroups.map((g) => {
              const settled = Math.abs(g.theirNet) < 0.005
              return (
                <div
                  key={g.groupName}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '7px 10px',
                    backgroundColor: '#1f2937',
                    borderRadius: 8,
                  }}
                >
                  <span
                    style={{
                      color: '#d1d5db',
                      fontSize: 12,
                      fontWeight: 500,
                      flex: 1,
                      marginRight: 8,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {g.groupName}
                  </span>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {settled ? (
                      <div style={{ color: '#9ca3af', fontSize: 12 }}>Even</div>
                    ) : (
                      <>
                        <div
                          style={{
                            color: g.theirNet > 0 ? '#34d399' : '#fbbf24',
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {formatCurrency(Math.abs(g.theirNet), g.currency)}
                        </div>
                        <div style={{ color: '#6b7280', fontSize: 10 }}>
                          {g.theirNet > 0 ? 'receives' : 'pays'}
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

      {/* Payments between these two people */}
      {payments.length > 0 && (
        <div style={{ borderTop: '1px solid #1f2937', padding: '14px 20px' }}>
          <div style={{ color: '#6b7280', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' as const, marginBottom: 10 }}>
            Payments
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {payments.map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', backgroundColor: '#1f2937', borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#d1d5db', fontSize: 12, fontWeight: 500 }}>
                    {p.fromName} → {p.toName}
                  </div>
                  {p.label && (
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>{p.label}</div>
                  )}
                  {p.groupName && (
                    <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>{p.groupName}</div>
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
