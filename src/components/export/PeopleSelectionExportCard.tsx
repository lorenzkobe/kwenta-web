import type { PeerShareRow } from '@/lib/balance-share'
import { SelectionExportFrame } from './SelectionExportFrame'
import { SELECTION_TONE, selectionRowStyle } from './selection-styles'

interface Props {
  rows: PeerShareRow[]
  savedAt?: string | null
}

export function PeopleSelectionExportCard({ rows, savedAt }: Props) {
  return (
    <SelectionExportFrame
      label="People"
      title="Balances"
      subtitle={`${rows.length} ${rows.length === 1 ? 'person' : 'people'} · personal and group bills combined`}
      savedAt={savedAt}
    >
      {rows.map((row) => (
        <div
          key={row.peerId}
          style={{ ...selectionRowStyle, display: 'flex', justifyContent: 'space-between', gap: 8 }}
        >
          <span style={{ color: '#e5e7eb', fontSize: 14, fontWeight: 600 }}>{row.displayName}</span>
          <div style={{ textAlign: 'right' as const, flexShrink: 0 }}>
            {row.settled ? (
              <div style={{ color: SELECTION_TONE.settled, fontSize: 13, fontWeight: 700 }}>Settled up</div>
            ) : (
              row.lines.map((line) => (
                <div
                  key={line.currency}
                  style={{
                    color: line.amount > 0 ? SELECTION_TONE.receive : SELECTION_TONE.pay,
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  {line.text}
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </SelectionExportFrame>
  )
}
