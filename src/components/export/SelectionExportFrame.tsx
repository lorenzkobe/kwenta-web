import type { ReactNode } from 'react'

/**
 * Header, title and footer shared by the two "selected people" image cards. Inline styles, like
 * every export card, because the capture must not depend on the app's theme.
 *
 * `savedAt` is set when the page is showing a cached answer: an image outlives the screen, so the
 * staleness the screen shows must travel with it.
 */
export function SelectionExportFrame({
  label,
  title,
  subtitle,
  savedAt,
  children,
}: {
  label: string
  title: string
  subtitle: string
  savedAt?: string | null
  children: ReactNode
}) {
  return (
    <div style={{ width: '100%', backgroundColor: '#111827', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ backgroundColor: '#0f172a', padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
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
        <span style={{ color: 'white', fontSize: 14, fontWeight: 700, letterSpacing: '0.02em' }}>Kwenta</span>
        <span
          style={{
            marginLeft: 'auto',
            color: '#6b7280',
            fontSize: 11,
            letterSpacing: '0.05em',
            textTransform: 'uppercase' as const,
          }}
        >
          {label}
        </span>
      </div>

      <div style={{ padding: '18px 20px 12px' }}>
        <div style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>{title}</div>
        <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 4 }}>{subtitle}</div>
        {savedAt && (
          <div style={{ color: '#fbbf24', fontSize: 11, marginTop: 6 }}>
            Saved copy from {new Date(savedAt).toLocaleString()} — may be out of date
          </div>
        )}
      </div>

      <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>

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
