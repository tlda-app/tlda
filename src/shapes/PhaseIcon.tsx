import { baseName, phaseFromName } from '../../shared/lineage-name.mjs'

// The ONE place a friendly name becomes "base text + phase glyph" for React
// surfaces. Everywhere else the friendly name is an opaque atom — only rotation
// and search ever split it; this is the only display split. Give it the full
// name (e.g. "conc5:day"); it renders the base ("conc5") plus the phase glyph.
// `slotWidth` reserves a fixed-width glyph box (blank for dawn) so a column of
// names aligns — used by the agents panel.
export function AgentName({ name, slotWidth }: { name: string | null | undefined; slotWidth?: number }) {
  const text = baseName(name || '').replace('fleet:', '')
  const icon = <PhaseIcon phase={phaseFromName(name)} />
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
      {slotWidth != null
        ? <span style={{ width: slotWidth, flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
        : icon}
      {text}
    </span>
  )
}

// Single source of truth for the lineage phase icon (React form). The HTML-string
// form in src/fleet/chat-render.mjs (PHASE_ICON_DAY/PHASE_ICON_DUSK) mirrors this
// exactly. dawn (the default worker) gets NO icon; only the non-default roles are
// marked — day (manager) is a midday sun, dusk (consultant) is a horizon sun.
export function PhaseIcon({ phase }: { phase: string | null }) {
  if (!phase || phase === 'dawn') return null
  const size = 12
  const style = { opacity: 0.6, flexShrink: 0, marginRight: 3 }
  if (phase === 'day') {
    // midday sun — full disc with rays (clearly distinct from dusk's horizon sun)
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
  if (phase === 'dusk') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" style={style}>
        <line x1="0.5" y1="11" x2="15.5" y2="11" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <path d="M1 11 a3 3 0 0 1 6 0" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="4" y1="6" x2="4" y2="4" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        <line x1="1" y1="9" x2="-0.5" y2="8" stroke="currentColor" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return null
}
