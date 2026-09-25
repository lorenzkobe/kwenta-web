import { describeGroupShareRow, type GroupShareRow } from '@/lib/balance-share'
import { formatCurrency } from '@/lib/utils'
import { SelectionExportFrame } from './SelectionExportFrame'
import { SELECTION_TONE, selectionRowStyle } from './selection-styles'

interface Props {
  groupName: string
  currency: string
  rows: GroupShareRow[]
  savedAt?: string | null
}

export function GroupSelectionExportCard({ groupName, currency, rows, savedAt }: Props) {
  return (
    <SelectionExportFrame
      label="Group Balances"
      title={groupName}
      subtitle={`Balances for ${rows.length} ${rows.length === 1 ? 'person' : 'people'} · against the group`}
      savedAt={savedAt}
    >
      {rows.map((row) => {
        const tone =
          row.poolAmount === 0 ? SELECTION_TONE.settled : row.poolAmount > 0 ? SELECTION_TONE.receive : SELECTION_TONE.pay
        const why = describeGroupShareRow(row, currency)
        return (
          <div key={row.userId} style={selectionRowStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>{row.name}</span>
              <span style={{ color: tone, fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                {row.poolAmount === 0
                  ? 'Settled'
                  : `${row.poolAmount > 0 ? 'Receives' : 'Pays'} ${formatCurrency(Math.abs(row.poolAmount), currency)}`}
              </span>
            </div>
            {row.pays.map((p) => (
              <div key={`pay-${p.toUserId}`} style={{ color: '#e5e7eb', fontSize: 12, marginTop: 6 }}>
                Pay {p.toName} <strong>{formatCurrency(p.amount, currency)}</strong>
              </div>
            ))}
            {row.receives.map((r) => (
              <div key={`get-${r.fromUserId}`} style={{ color: '#e5e7eb', fontSize: 12, marginTop: 6 }}>
                Gets <strong>{formatCurrency(r.amount, currency)}</strong> from {r.fromName}
              </div>
            ))}
            {why.length > 0 && (
              <div style={{ marginTop: 8, borderTop: '1px solid #374151', paddingTop: 6 }}>
                {why.map((line) => (
                  <div key={line} style={{ color: '#9ca3af', fontSize: 11, lineHeight: 1.45 }}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </SelectionExportFrame>
  )
}
