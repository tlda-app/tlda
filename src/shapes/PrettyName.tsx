type PrettyNameValue = string | Array<string | { kind: 'glyph'; id?: string; glyph?: string }> | null | undefined

export function PrettyName({ prettyName, slotWidth }: { prettyName: PrettyNameValue; slotWidth?: number }) {
  const parts = Array.isArray(prettyName) ? prettyName : [prettyName || '']
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
      {slotWidth != null ? <span style={{ width: slotWidth, flexShrink: 0 }} /> : null}
      {parts.map((part, idx) => (
        <span key={idx}>{typeof part === 'string' ? part : (part.glyph || '')}</span>
      ))}
    </span>
  )
}
