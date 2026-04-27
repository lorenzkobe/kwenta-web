import { formatCurrency } from '@/lib/utils'

export interface GroupMemberBillEntry {
  id: string
  title: string
  note: string | null
  currency: string
  memberShare: number
}

interface Props {
  groupName: string
  memberName: string
  currency: string
  netBalance: number
  bills: GroupMemberBillEntry[]
}

export function GroupMemberExportCard({ groupName, memberName, currency, netBalance, bills }: Props) {
  const settled = Math.abs(netBalance) <= 0.01

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
          Member Share
        </span>
      </div>

      {/* Member info */}
      <div style={{ padding: '18px 20px 14px' }}>
        <div style={{ color: '#9ca3af', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>
          {groupName}
        </div>
        <div style={{ color: 'white', fontSize: 20, fontWeight: 700, marginTop: 4 }}>{memberName}</div>
        <div
          style={{
            marginTop: 6,
            fontSize: 14,
            fontWeight: 700,
            color: settled ? '#9ca3af' : netBalance > 0 ? '#34d399' : '#fbbf24',
          }}
        >
          {settled
            ? 'Even'
            : netBalance > 0
              ? `Receives ${formatCurrency(netBalance, currency)}`
              : `Pays ${formatCurrency(Math.abs(netBalance), currency)}`}
        </div>
      </div>

      {/* Per-bill share */}
      {bills.length > 0 && (
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
            Bill Breakdown
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {bills.map((bill) => (
              <div
                key={bill.id}
                style={{
                  padding: '8px 10px',
                  backgroundColor: '#1f2937',
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, marginRight: 8 }}>
                    <div style={{ color: '#e5e7eb', fontSize: 12, fontWeight: 600 }}>{bill.title}</div>
                    {bill.note && (
                      <div style={{ color: '#6b7280', fontSize: 10, marginTop: 2 }}>{bill.note}</div>
                    )}
                  </div>
                  <span style={{ color: 'white', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                    {formatCurrency(bill.memberShare, bill.currency)}
                  </span>
                </div>
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
