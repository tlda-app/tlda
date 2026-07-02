// @ts-ignore — vanilla JS module
import { pretty_name_parts } from '../../shared/pretty_name.mjs'

type PrettyGlyphId = 'day' | 'dusk' | 'night' | 'zombie' | string

type PrettyNameValue = string | Array<string | { kind: 'glyph'; id?: string; glyph?: string; label?: string }> | null | undefined

export function PrettyName({ pretty_name, fallback, slotWidth }: { pretty_name: PrettyNameValue; fallback?: string | null; slotWidth?: number }) {
  const parts = pretty_name_parts(pretty_name, fallback || '')
  let firstTextIdx = parts.findIndex((part: any) => typeof part === 'string' && part.length > 0)
  if (firstTextIdx === -1) firstTextIdx = parts.length
  const leadingGlyphs = slotWidth != null ? parts.slice(0, firstTextIdx).filter((part: any) => typeof part !== 'string') : []
  const visibleParts = slotWidth != null ? parts.slice(firstTextIdx) : parts

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
      {slotWidth != null
        ? <span style={{ width: slotWidth, flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{leadingGlyphs.map((part: any, idx: number) => <PrettyNameGlyph key={`leading-${part.id || part.glyph}-${idx}`} part={part} />)}</span>
        : null}
      {visibleParts.map((part: any, idx: number) => typeof part === 'string'
        ? <span key={`text-${idx}`}>{part.replace('fleet:', '')}</span>
        : <PrettyNameGlyph key={`${part.id || part.glyph}-${idx}`} part={part} />
      )}
    </span>
  )
}

export function PrettyNameGlyph({ part }: { part: { id?: PrettyGlyphId | null; glyph?: string; label?: string } | null }) {
  const glyph = part?.id || null
  if (!glyph) return null
  const size = 12
  const style = { opacity: 0.6, flexShrink: 0, marginRight: 3, verticalAlign: 'middle' as const }
  if (glyph === 'day') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
        <circle cx="8" cy="8" r="3" stroke="currentColor" fill="none" strokeWidth={1.5} />
        <line x1="8" y1="1" x2="8" y2="2.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <line x1="8" y1="13.5" x2="8" y2="15" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <line x1="1" y1="8" x2="2.5" y2="8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <line x1="13.5" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    )
  }
  if (glyph === 'dusk') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
        <line x1="0.5" y1="11" x2="15.5" y2="11" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M1 11 a3 3 0 0 1 6 0" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="4" y1="6" x2="4" y2="4" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="1" y1="9" x2="-0.5" y2="8" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (glyph === 'night') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
        <path d="M12 3 a5.5 5.5 0 1 0 0 11 a4.3 4.3 0 0 1 0 -11 Z" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    )
  }
  if (glyph === 'zombie') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
        <path d="M3.5 7.6 a4.5 4.5 0 0 1 9 0 v1.6 a1.5 1.5 0 0 1 -1.5 1.5 v1.3 h-1 v-1.3 h-1 v1.3 h-1 v-1.3 h-1 v1.3 h-1 v-1.3 a1.5 1.5 0 0 1 -1.5 -1.5 Z" stroke="currentColor" fill="none" strokeWidth={1.2} strokeLinejoin="round" />
        <circle cx="6" cy="7.4" r="1.05" fill="currentColor" stroke="none" />
        <circle cx="10" cy="7.4" r="1.05" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return <span style={style}>{part?.glyph || part?.label || glyph}</span>
}
