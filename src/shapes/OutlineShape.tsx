/**
 * OutlineShape — a dedicated canvas shape for the move-only outline.
 *
 * Prototype (2026-06-06). Renders the id-tagged token outline
 * (GET /:doc/outline-model?slug) as a plain markdown bullet list whose
 * STRUCTURE carries handles: little up/down arrows and a drag grip reorder
 * rows; a + inserts a [NEW] candidate; a × marks a row deleted. The canonical
 * representation is exactly the pandoc-ish markdown-with-labels the agent edits
 * over MCP (`- [l3] body`, indent = level), shown live in the "md" view.
 *
 * The shape never rewrites a token's prose (the D12 move-only boundary): existing
 * rows round-trip their original line verbatim, so POST /:doc/outline-apply only
 * ever sees reorder / insert / delete. Promote/demote (re-leveling) is display
 * only for now — the model's apply path doesn't round-trip level yet (see report).
 */
import { BaseBoxShapeUtil, HTMLContainer, stopEventPropagation } from 'tldraw'
import { useEffect, useRef, useState, useCallback } from 'react'
import { outlineProps } from '../../shared/shapes/outline-schema.mjs'

type Row = {
  key: string          // stable react key
  id: string | null    // token id (lN) or null for a new candidate
  level: number        // indent depth (display only for now)
  kind: 'clause' | 'label' | 'display'
  body: string         // display text (tag stripped)
  raw: string          // original md line, round-tripped verbatim for existing tokens
  newText: string      // editable text for inserted candidates
  deleted: boolean
}

let rowSeq = 0
const nextKey = () => `r${++rowSeq}`

function parseOutlineMd(md: string): Row[] {
  const rows: Row[] = []
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const m = line.match(/^(\s*)-\s+\[([A-Za-z0-9]+)\]\s?(.*)$/)
    if (!m) continue
    const level = Math.round(m[1].length / 2)
    let rest = m[3]
    let kind: Row['kind'] = 'clause'
    if (/^¶\s*/.test(rest)) { kind = 'label'; rest = rest.replace(/^¶\s*/, '') }
    else if (/^⟦display⟧\s*/.test(rest)) { kind = 'display'; rest = rest.replace(/^⟦display⟧\s*/, '') }
    rows.push({ key: nextKey(), id: m[2], level, kind, body: rest, raw: line, newText: '', deleted: false })
  }
  return rows
}

// Emit the canonical pandoc-ish markdown the agent edits / apply consumes.
// Existing rows are round-tripped VERBATIM (never rewrite a token); only their
// order changes. New rows become `- [NEW] text`. Deleted rows are dropped.
function emitMd(rows: Row[]): string {
  const lines: string[] = []
  for (const r of rows) {
    if (r.deleted) continue
    if (r.id) lines.push(r.raw)
    else if (r.newText.trim()) lines.push(`- [NEW] ${r.newText.trim()}`)
  }
  return lines.join('\n') + '\n'
}

const KIND_BADGE: Record<Row['kind'], string> = { clause: '', label: '¶', display: '⟦⟧' }

export function OutlineComponent({ shape }: { shape: any }) {
  const doc = shape.props.doc as string
  const slug = shape.props.slug as string
  const [rows, setRows] = useState<Row[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [view, setView] = useState<'outline' | 'md'>('outline')
  const [dirty, setDirty] = useState(false)
  const [apply, setApply] = useState<any>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map())

  const load = useCallback(() => {
    setStatus('loading')
    fetch(`/api/projects/${encodeURIComponent(doc)}/outline-model?slug=${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`outline-model ${r.status}`)
        const j = await r.json()
        setRows(parseOutlineMd(j.markdown || ''))
        setStatus('ready')
        setDirty(false)
        setApply(null)
      })
      .catch((e) => { setStatus('error'); setErrMsg(String(e?.message || e)) })
  }, [doc, slug])

  useEffect(() => { load() }, [load])

  const move = (key: string, dir: -1 | 1) => {
    setRows((rs) => {
      const i = rs.findIndex((r) => r.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= rs.length) return rs
      const copy = rs.slice()
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
    setDirty(true); setApply(null)
  }

  const reorderTo = (key: string, targetIdx: number) => {
    setRows((rs) => {
      const from = rs.findIndex((r) => r.key === key)
      if (from < 0) return rs
      const copy = rs.slice()
      const [it] = copy.splice(from, 1)
      const clamped = Math.max(0, Math.min(targetIdx > from ? targetIdx - 1 : targetIdx, copy.length))
      copy.splice(clamped, 0, it)
      return copy
    })
    setDirty(true); setApply(null)
  }

  const toggleDelete = (key: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, deleted: !r.deleted } : r)))
    setDirty(true); setApply(null)
  }

  const insertAfter = (idx: number) => {
    setRows((rs) => {
      const copy = rs.slice()
      copy.splice(idx + 1, 0, { key: nextKey(), id: null, level: 0, kind: 'clause', body: '', raw: '', newText: '', deleted: false })
      return copy
    })
    setDirty(true); setApply(null)
  }

  const setNewText = (key: string, text: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, newText: text } : r)))
    setDirty(true)
  }

  const doApply = () => {
    fetch(`/api/projects/${encodeURIComponent(doc)}/outline-apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, editedMd: emitMd(rows) }),
    })
      .then((r) => r.json())
      .then((j) => setApply(j))
      .catch((e) => setApply({ error: String(e?.message || e) }))
  }

  // --- drag reorder via the grip ---
  const onGripDown = (e: React.PointerEvent, key: string) => {
    stopEventPropagation(e)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragKey(key)
  }
  const onGripMove = (e: React.PointerEvent) => {
    if (!dragKey) return
    stopEventPropagation(e)
    const y = e.clientY
    let idx = rows.length
    for (let i = 0; i < rows.length; i++) {
      const el = rowRefs.current.get(rows[i].key)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      if (y < rect.top + rect.height / 2) { idx = i; break }
    }
    setDropIdx(idx)
  }
  const onGripUp = (e: React.PointerEvent) => {
    if (!dragKey) return
    stopEventPropagation(e)
    if (dropIdx != null) reorderTo(dragKey, dropIdx)
    setDragKey(null); setDropIdx(null)
  }

  const dim = 'rgba(127,127,127,0.55)'
  const hoverShow: React.CSSProperties = { opacity: 0, transition: 'opacity 0.15s' }

  return (
    <HTMLContainer style={{ width: '100%', height: '100%', pointerEvents: 'all' }}>
      <style>{`
        .outline-shape .ol-row:hover .ol-handle { opacity: 1 !important; }
        .outline-shape .ol-row:hover { background: rgba(127,127,127,0.06); }
        .outline-shape .ol-arrow:hover, .outline-shape .ol-del:hover, .outline-shape .ol-ins:hover { color: rgba(127,127,127,1); }
        .outline-shape .ol-tab.active { color: var(--text, #1a1a1a); border-bottom: 1px solid currentColor; }
      `}</style>
      <div
        className="outline-shape"
        onPointerDown={(e) => stopEventPropagation(e)}
        onWheel={(e) => e.stopPropagation()}
        style={{
          width: '100%', height: '100%', boxSizing: 'border-box',
          background: 'var(--note-bg, #fbfbfa)', border: '1px solid rgba(127,127,127,0.18)',
          borderRadius: 6, display: 'flex', flexDirection: 'column',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 13, color: 'var(--text, #1a1a1a)', overflow: 'hidden',
        }}
      >
        {/* header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
          borderBottom: '1px solid rgba(127,127,127,0.12)', flexShrink: 0,
          fontSize: 11, color: dim,
        }}>
          <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>OUTLINE</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, opacity: 0.7 }} title={slug}>{slug || '(no slug)'}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <span className={`ol-tab ${view === 'outline' ? 'active' : ''}`} style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); setView('outline') }}>outline</span>
            <span className={`ol-tab ${view === 'md' ? 'active' : ''}`} style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); setView('md') }}>md</span>
          </span>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflow: 'auto', padding: view === 'md' ? 0 : '4px 0' }}>
          {status === 'loading' && <div style={{ padding: 12, color: dim }}>loading…</div>}
          {status === 'error' && <div style={{ padding: 12, color: '#c55' }}>no outline model for this slug<br /><span style={{ fontSize: 11, opacity: 0.7 }}>{errMsg}</span></div>}

          {status === 'ready' && view === 'outline' && (
            <div onPointerMove={onGripMove} onPointerUp={onGripUp}>
              {rows.map((r, i) => (
                <div key={r.key}>
                  {dropIdx === i && dragKey && <div style={{ height: 2, background: 'rgba(124,58,237,0.7)', margin: '0 8px' }} />}
                  <div
                    className="ol-row"
                    ref={(el) => { if (el) rowRefs.current.set(r.key, el); else rowRefs.current.delete(r.key) }}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 4,
                      padding: '2px 8px 2px 4px',
                      paddingLeft: 4 + r.level * 16,
                      opacity: r.deleted ? 0.4 : dragKey === r.key ? 0.5 : 1,
                      textDecoration: r.deleted ? 'line-through' : 'none',
                    }}
                  >
                    {/* drag grip */}
                    <span
                      className="ol-handle"
                      style={{ ...hoverShow, cursor: 'grab', color: dim, userSelect: 'none', lineHeight: '18px', touchAction: 'none' }}
                      onPointerDown={(e) => onGripDown(e, r.key)}
                      title="Drag to reorder"
                    >⠿</span>
                    {/* up/down arrows */}
                    <span className="ol-handle" style={{ ...hoverShow, display: 'flex', flexDirection: 'column', lineHeight: '9px', fontSize: 9, color: dim }}>
                      <span className="ol-arrow" style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); move(r.key, -1) }} title="Move up">▲</span>
                      <span className="ol-arrow" style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); move(r.key, 1) }} title="Move down">▼</span>
                    </span>
                    {/* bullet + body */}
                    <span style={{ color: dim, lineHeight: '18px' }}>•</span>
                    {r.kind !== 'clause' && <span style={{ color: dim, fontSize: 10, lineHeight: '18px' }}>{KIND_BADGE[r.kind]}</span>}
                    <span style={{ flex: 1, lineHeight: '18px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {r.id ? r.body : (
                        <input
                          value={r.newText}
                          placeholder="new candidate…"
                          onPointerDown={(e) => stopEventPropagation(e)}
                          onChange={(e) => setNewText(r.key, e.target.value)}
                          style={{ width: '100%', border: 'none', borderBottom: '1px dashed rgba(124,58,237,0.5)', background: 'transparent', font: 'inherit', color: 'inherit', outline: 'none' }}
                        />
                      )}
                    </span>
                    {/* row actions */}
                    <span className="ol-handle" style={{ ...hoverShow, display: 'flex', gap: 4, color: dim }}>
                      <span className="ol-ins" style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); insertAfter(i) }} title="Insert below">＋</span>
                      <span className="ol-del" style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); toggleDelete(r.key) }} title={r.deleted ? 'Undo delete' : 'Delete'}>×</span>
                    </span>
                  </div>
                </div>
              ))}
              {dropIdx === rows.length && dragKey && <div style={{ height: 2, background: 'rgba(124,58,237,0.7)', margin: '0 8px' }} />}
              {rows.length === 0 && <div style={{ padding: 12, color: dim }}>empty outline</div>}
            </div>
          )}

          {status === 'ready' && view === 'md' && (
            <pre style={{ margin: 0, padding: 10, fontSize: 11.5, fontFamily: '"SF Mono", Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text,#1a1a1a)' }}>{emitMd(rows)}</pre>
          )}
        </div>

        {/* footer / apply */}
        <div style={{ flexShrink: 0, borderTop: '1px solid rgba(127,127,127,0.12)', padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: dim }}>
          <span style={{ cursor: 'pointer' }} onPointerDown={(e) => { stopEventPropagation(e); load() }} title="Reload from model">↻ reset</span>
          <span style={{ flex: 1 }} />
          {apply && (
            apply.error ? <span style={{ color: '#c55' }}>error</span>
              : apply.ok ? <span style={{ color: '#4a9' }}>✓ {(apply.moves?.length ? 'moved ' : '')}{apply.inserts?.length ? `+${apply.inserts.length} ` : ''}{apply.deletes?.length ? `−${apply.deletes.length}` : ''}valid</span>
                : <span style={{ color: '#c55' }} title={(apply.violations || []).join('\n')}>✕ {apply.violations?.length || 0} violation(s)</span>
          )}
          <span
            onPointerDown={(e) => { stopEventPropagation(e); if (dirty) doApply() }}
            style={{ cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.4, fontWeight: 600, color: dirty ? 'var(--accent,#7c3aed)' : dim }}
            title="Validate the edited outline against the move-only model"
          >apply</span>
        </div>
      </div>
    </HTMLContainer>
  )
}

export class OutlineShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'outline' as const
  static override props = outlineProps

  getDefaultProps() {
    return { w: 380, h: 460, doc: '', slug: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override isAspectRatioLocked = () => false

  component(shape: any) {
    return <OutlineComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={6} ry={6} />
  }
}
