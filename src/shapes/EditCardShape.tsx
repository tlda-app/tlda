/**
 * EditCardShape — one build in the edit bridge.
 *
 * The bridge is an alternate presentation of the compare view: the two
 * document columns move apart and the builds between them are laid out in the
 * gap, one card each. A card is the visible unit the spec calls an edit
 * object: what changed, who changed it, and a place to say what you think of
 * it.
 *
 * The note lives in shape props rather than beside the shape, because the note
 * is the point. It is what a person leaves behind so an agent can do the
 * cleanup, so it has to be durable, reconnect-safe, and readable by whoever
 * picks the interval up -- which is what putting it in the synced document
 * buys. Everything else on the card is a rendering of what the server sent.
 *
 * A card with no editors is an ordinary card. Not every build has activity
 * behind it -- edits predating the event store, edits made outside a bound
 * checkout, edits whose path the daemon could not resolve -- and the card says
 * so plainly rather than guessing an author. Provenance the system does not
 * have is worse than no provenance, because the whole reason to read this is
 * to find out who actually changed something.
 */
import { BaseBoxShapeUtil, HTMLContainer, T, stopEventPropagation, useEditor } from 'tldraw'
import { useCallback, useState } from 'react'
import { buildFleetAgentFilter } from '../../shared/filter-semantics.mjs'
import { createFleetShape } from './fleet-utils'
import './EditCardShape.css'

export const EDIT_CARD_W = 260
export const EDIT_CARD_H = 190

export interface EditCardEditor {
  agentId: string
  name: string | null
  taskId: string | null
  files: string[]
}

function parseJsonProp<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function relativeTime(ts: number): string {
  const diffMin = Math.floor((Date.now() - ts) / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export class EditCardShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'edit-card' as const
  static override props = {
    w: T.number,
    h: T.number,
    hash: T.string,
    timestamp: T.number,
    filesJson: T.string,
    editorsJson: T.string,
    note: T.string,
  }

  getDefaultProps() {
    return {
      w: EDIT_CARD_W,
      h: EDIT_CARD_H,
      hash: '',
      timestamp: 0,
      filesJson: '[]',
      editorsJson: '[]',
      note: '',
    }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <EditCard shape={shape} />
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

// shape is any for the same reason every custom shape here is: tldraw's shape
// types are a closed union that custom types are not members of.
function EditCard({ shape }: { shape: any }) {
  const editor = useEditor()
  const { w, h, hash, timestamp, note } = shape.props
  const files = parseJsonProp<string[]>(shape.props.filesJson, [])
  const editors = parseJsonProp<EditCardEditor[]>(shape.props.editorsJson, [])
  const [draft, setDraft] = useState(note)

  const commitNote = useCallback((value: string) => {
    if (value === shape.props.note) return
    editor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, note: value } })
  }, [editor, shape])

  // Previewing a build is scrubbing the compare column to it -- the same
  // function the version stamp already calls, so the bridge and the scrubber
  // cannot disagree about which version is on screen.
  const preview = useCallback(() => {
    const scrub = (window as any).__shadowScrubVersion
    if (typeof scrub === 'function') scrub({ hash, timestamp })
  }, [hash, timestamp])

  // The reasoning behind an edit is in chat, so the card points at it rather
  // than restating it. An annotation stays terse when the discussion is one
  // click away.
  const openDiscussion = useCallback(async (agentName: string | null) => {
    if (!agentName) return
    const filter = buildFleetAgentFilter(agentName) as [string, string][][]
    if (!filter.length) return
    const rec = editor.getShape(shape.id) as any
    if (!rec) return
    const id = await createFleetShape(editor, 'fleet-chat', rec.x + rec.props.w + 16, rec.y, { filter })
    if (id) editor.bringToFront([id as any])
  }, [editor, shape.id])

  return (
    <HTMLContainer style={{ width: w, height: h, pointerEvents: 'all', overflow: 'hidden' }}>
      <div className="edit-card">
        <div className="edit-card-header">
          <button
            className="edit-card-hash"
            onPointerDown={stopEventPropagation}
            onPointerUp={(e) => { e.stopPropagation(); preview() }}
            title="Show this version in the compare column"
          >{hash.slice(0, 7)}</button>
          <span className="edit-card-time">{timestamp ? relativeTime(timestamp) : ''}</span>
        </div>

        <div className="edit-card-body" onPointerDown={stopEventPropagation}>
          <div className="edit-card-files">
            {files.length === 0
              ? <span className="edit-card-quiet">no files recorded</span>
              : files.map(file => <div key={file} className="edit-card-file" title={file}>{file}</div>)}
          </div>

          <div className="edit-card-editors">
            {editors.length === 0
              ? <span className="edit-card-quiet">no recorded author</span>
              : editors.map(editor_ => (
                <div key={`${editor_.agentId}:${editor_.taskId ?? ''}`} className="edit-card-editor">
                  <span className="edit-card-editor-name">{editor_.name || editor_.agentId}</span>
                  <button
                    className="edit-card-link"
                    onPointerUp={(e) => { e.stopPropagation(); void openDiscussion(editor_.name) }}
                    title="Open the chat with this agent"
                  >discussion ↗</button>
                </div>
              ))}
          </div>
        </div>

        <textarea
          className="edit-card-note"
          value={draft}
          placeholder="keep · bad rewrite · good idea, bad implementation…"
          onPointerDown={stopEventPropagation}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitNote(draft)}
        />
      </div>
    </HTMLContainer>
  )
}
