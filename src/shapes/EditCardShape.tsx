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
import { useCallback } from 'react'
import { buildFleetAgentFilter } from '../../shared/filter-semantics.mjs'
import { createFleetShape } from './fleet-utils'
// @ts-ignore — vanilla JS module
import { getHumanName, getHumanId } from '../fleet/fleet-data.mjs'
import './EditCardShape.css'

import { EDIT_CARD_H, EDIT_CARD_W } from '../../shared/edit-card-metrics.mjs'
import type { BridgeEditor } from '../hooks/editBridgeLayout'

/** What the edit did, as the server summarised it. */
interface EditCardChange {
  kind: 'addition' | 'deletion' | 'replacement'
  addedWords: number
  removedWords: number
  rewordedWords: number
  hunkCount: number
  excerpt: {
    file: string | null
    before: string
    after: string
    /** The same text, split so the words that differ can be marked. */
    beforeParts?: { text: string; changed: boolean }[]
    afterParts?: { text: string; changed: boolean }[]
  } | null
}

/**
 * A passage with the words that differ marked.
 *
 * Showing two whole passages answers "something in here changed" and nothing
 * more -- on his course a one-command fix rendered as two identical lines.
 * Marking the span is what makes a correction visible at card size.
 */
function MarkedText({ parts, fallback }: { parts?: { text: string; changed: boolean }[]; fallback: string }) {
  if (!parts?.length) return <>{fallback}</>
  return <>{parts.map((part, i) => (
    part.changed
      ? <mark key={i} className="edit-card-word">{part.text}</mark>
      : <span key={i}>{part.text}</span>
  ))}</>
}

/**
 * How an edit reads in one line.
 *
 * A replacement leads with how much of his writing was displaced, because that
 * is the edit worth stopping on -- "a large pure addition is usually fine;
 * replacing prose he already wrote is where the subtlety dies." An addition
 * says so plainly so it can be skimmed past.
 */
function changeHeadline(change: EditCardChange): string {
  const words = (n: number) => `${n} ${n === 1 ? 'word' : 'words'}`
  if (change.kind === 'addition') return `added ${words(change.addedWords)}`
  if (change.kind === 'deletion') return `deleted ${words(change.removedWords)}`
  return `rewrote ~${words(change.rewordedWords)}  (+${change.addedWords} / −${change.removedWords})`
}

export { EDIT_CARD_H, EDIT_CARD_W }

/**
 * Who to sign a note with when it is written in this browser.
 *
 * The friendly name, because a card is read by people and a fleet id is an
 * address rather than a name. Falls back to the id only when there is no name
 * yet, and to nothing at all rather than inventing an author.
 */
function localAnnotator(): string {
  try {
    return getHumanName() || getHumanId() || ''
  } catch {
    return ''
  }
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
    // What the edit did, from the server. The card is named for this and did
    // not carry it: it named the file and the time, and his verdict was that
    // zero edits were visible in the bridge.
    changeJson: T.string,
    note: T.string,
    // Who wrote the note. Empty when there is no note. A person's judgment and
    // an agent's guess must never be indistinguishable on the card -- that is
    // the same rule as not fabricating an author for a build, one level up.
    noteAuthor: T.string,
  }

  getDefaultProps() {
    return {
      w: EDIT_CARD_W,
      h: EDIT_CARD_H,
      hash: '',
      timestamp: 0,
      filesJson: '[]',
      editorsJson: '[]',
      changeJson: '',
      note: '',
      noteAuthor: '',
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
  const { w, h, hash, timestamp, note, noteAuthor } = shape.props
  const files = parseJsonProp<string[]>(shape.props.filesJson, [])
  const editors = parseJsonProp<BridgeEditor[]>(shape.props.editorsJson, [])
  const change = parseJsonProp<EditCardChange | null>(shape.props.changeJson, null)
  // The note goes into shape props as it is typed, with no local draft.
  //
  // A draft is a second copy of the note, and it is the copy everything else
  // cannot see: the guard that decides whether a card is scaffolding or
  // somebody's judgment reads props, so a note still being typed read as an
  // empty card and was deleted when the bridge collapsed. Measured from
  // outside -- three notes typed in sequence, the two that had been blurred
  // survived and the one still in hand did not, by both teardown routes.
  //
  // Collapsing is the natural next action after annotating, so that window is
  // exactly where the person is standing when they reach for it. One copy,
  // written as you type, removes the window rather than narrowing it.
  const commitNote = useCallback((value: string) => {
    if (value === shape.props.note) return
    const author = value.trim() ? (localAnnotator() || shape.props.noteAuthor || '') : ''
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      props: { ...shape.props, note: value, noteAuthor: author },
    })
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
          {/* What the edit did, first, because that is what the bridge is for.
              The file is where it happened and comes after. */}
          {change ? (
            <div className={`edit-card-change edit-card-change--${change.kind}`}>
              <div className="edit-card-change-headline">{changeHeadline(change)}</div>
              {change.excerpt && (
                <div className="edit-card-diff">
                  {change.excerpt.before && (
                    <div className="edit-card-was" title={change.excerpt.before}>
                      <MarkedText parts={change.excerpt.beforeParts} fallback={change.excerpt.before} />
                    </div>
                  )}
                  {change.excerpt.after && (
                    <div className="edit-card-now" title={change.excerpt.after}>
                      <MarkedText parts={change.excerpt.afterParts} fallback={change.excerpt.after} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="edit-card-quiet">no textual change</div>
          )}

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

        {noteAuthor && (
          <div className="edit-card-note-author" title="Who wrote this note">{noteAuthor}</div>
        )}
        <textarea
          className="edit-card-note"
          value={note}
          placeholder="keep · bad rewrite · good idea, bad implementation…"
          onPointerDown={stopEventPropagation}
          onChange={(e) => commitNote(e.target.value)}
        />
      </div>
    </HTMLContainer>
  )
}
