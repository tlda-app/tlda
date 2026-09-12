/**
 * useEditBridge — the compare view with its history expanded into the gap.
 *
 * This is a second mode of the existing shadow compare, not a second viewer.
 * The compare view already puts the scrubbed version beside the live document
 * and aligns them; the bridge moves the compare column further out and lays
 * the builds between the two endpoints into the space that opens up, one card
 * each. Collapsing puts the column back where the compare view had it.
 *
 * Endpoints are the two the compare view already has: the version in the
 * compare column, and the newest build (the one the live column renders).
 * Choosing an arbitrary pair is a larger question about the compare view
 * itself and is deliberately not answered here.
 *
 * The cards are real shapes in the room rather than an overlay, because the
 * note on a card is the durable product of this feature -- a person's judgment
 * about one build, left where the next person and the cleanup agent will find
 * it. An overlay would lose it on reload and hide it from everyone else.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { createShapeId } from 'tldraw'
import { EDIT_CARD_H, EDIT_CARD_W } from '../shapes/EditCardShape'
import { PAGE_GAP, PDF_HEIGHT, PDF_WIDTH, TARGET_WIDTH } from '../layoutConstants'
import { createFleetShape } from '../shapes/fleet-utils'
import { chatInsertBus } from '../shapes/FleetPillShape'

const PAGE_HEIGHT = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
const CARD_GAP_X = 40
const CARD_GAP_Y = 24
/** How many cards stack vertically before the next column of cards starts. */
const CARDS_PER_COLUMN = 6

export interface BridgeEditor {
  agentId: string
  name: string | null
  taskId: string | null
  files: string[]
}

export interface BridgeBuild {
  hash: string
  timestamp: number
  message: string
  files: string[]
  editors: BridgeEditor[]
}

export async function fetchBridge(
  projectName: string,
  from: string,
  to: string,
): Promise<{ builds: BridgeBuild[] } | { error: string }> {
  try {
    const res = await fetch(
      `/api/projects/${projectName}/history/shadow/bridge?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
    const body = await res.json()
    if (!res.ok) return { error: body?.error || `bridge failed: ${res.status}` }
    return { builds: Array.isArray(body.builds) ? body.builds : [] }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Where the bridge's cards go, in the gap the widened compare opens up. */
export function cardLayout(index: number, originX: number, originY: number) {
  const column = Math.floor(index / CARDS_PER_COLUMN)
  const row = index % CARDS_PER_COLUMN
  return {
    x: originX + column * (EDIT_CARD_W + CARD_GAP_X),
    y: originY + row * (EDIT_CARD_H + CARD_GAP_Y),
  }
}

/** The extra width the compare column moves out by to make room for `count` cards. */
export function bridgeGapWidth(count: number): number {
  if (count <= 0) return 0
  const columns = Math.ceil(count / CARDS_PER_COLUMN)
  return columns * (EDIT_CARD_W + CARD_GAP_X) + CARD_GAP_X
}

const cardShapeId = (hash: string) => createShapeId(`edit-card-${hash.slice(0, 7)}`)

/**
 * The cleanup brief: the interval, and what a person said about it.
 *
 * This is the payload the whole feature exists to produce -- the point is that
 * a person supplies judgment cheaply and an agent does the integration, so
 * what leaves here has to carry the judgment and enough context to act on it:
 * which versions, which builds, which files, who edited them, and the note.
 *
 * Builds nobody annotated are listed without commentary rather than dropped.
 * An interval is a sequence, and an agent told only about the annotated builds
 * would be reading a different history from the one the person looked at.
 */
export function buildCleanupBrief(
  from: string,
  to: string,
  builds: BridgeBuild[],
  notes: Map<string, string>,
): string {
  const lines = [
    `Clean up the interval \`${from.slice(0, 7)}..${to.slice(0, 7)}\` using these annotations.`,
    '',
    `${builds.length} build${builds.length === 1 ? '' : 's'} between the two versions, oldest first.`,
    '',
  ]
  for (const build of builds) {
    const who = build.editors.length
      ? build.editors.map(e => e.name || e.agentId).join(', ')
      : 'no recorded author'
    lines.push(`- \`${build.hash.slice(0, 7)}\` ${new Date(build.timestamp).toISOString()} — ${who}`)
    if (build.files.length) lines.push(`  files: ${build.files.join(', ')}`)
    const note = notes.get(build.hash)?.trim()
    if (note) lines.push(`  note: ${note}`)
  }
  return lines.join('\n')
}

export function useEditBridge(
  editorRef: React.MutableRefObject<Editor | null>,
  projectName: string,
  /** The version in the compare column — the earlier endpoint. */
  compareHash: string | null,
  /** The newest build — the version the live column renders. */
  newestHash: string | null,
  /** Where the compare column sits when the bridge is collapsed. */
  baseColumnX: number,
) {
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [builds, setBuilds] = useState<BridgeBuild[]>([])
  const cardIdsRef = useRef<Set<TLShapeId>>(new Set())

  const clearCards = useCallback(() => {
    const editor = editorRef.current
    const ids = [...cardIdsRef.current].filter(id => editor?.getShape(id))
    cardIdsRef.current.clear()
    if (editor && ids.length > 0) editor.deleteShapes(ids)
  }, [editorRef])

  // Fetch the interval whenever the endpoints or the mode change.
  useEffect(() => {
    if (!visible || !compareHash || !newestHash || compareHash === newestHash) {
      // Functional updates that return the same value when there is nothing
      // to clear: no new state, so no cascading render, and no need to read
      // builds or error here -- which would put them in this effect's deps
      // and make a successful fetch re-trigger the fetch.
      setBuilds(prev => (prev.length ? [] : prev))
      setError(prev => (prev === null ? prev : null))
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void fetchBridge(projectName, compareHash, newestHash).then(result => {
      if (cancelled) return
      setLoading(false)
      if ('error' in result) { setError(result.error); setBuilds([]); return }
      setBuilds(result.builds)
    })
    return () => { cancelled = true }
  }, [visible, compareHash, newestHash, projectName])

  // Put a card on the canvas for each build. Keyed on the build hash so a
  // re-fetch of the same interval updates the cards it already made instead of
  // making a second set -- and so a note already written survives the update.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (!visible || builds.length === 0) { clearCards(); return }

    const originX = baseColumnX + CARD_GAP_X
    const originY = -(PAGE_HEIGHT + PAGE_GAP) / 2 + PAGE_GAP

    const wanted = new Set<TLShapeId>()
    builds.forEach((build, index) => {
      const id = cardShapeId(build.hash)
      wanted.add(id)
      const { x, y } = cardLayout(index, originX, originY)
      const props = {
        w: EDIT_CARD_W,
        h: EDIT_CARD_H,
        hash: build.hash,
        timestamp: build.timestamp,
        filesJson: JSON.stringify(build.files),
        editorsJson: JSON.stringify(build.editors),
      }
      // Cast to any throughout: custom shape types are not in tldraw's
      // built-in type union, the same reason usePageColumn casts 'svg-page'.
      const existing = editor.getShape(id) as any
      if (existing) {
        // The note is the person's, not ours. Carry it across untouched.
        editor.updateShape({ id, type: 'edit-card' as any, x, y, props: { ...props, note: existing.props.note ?? '' } })
      } else {
        editor.createShape({ id, type: 'edit-card' as any, x, y, props: { ...props, note: '' } })
      }
    })

    for (const id of cardIdsRef.current) {
      if (!wanted.has(id) && editor.getShape(id)) editor.deleteShapes([id])
    }
    cardIdsRef.current = wanted
  }, [visible, builds, baseColumnX, editorRef, clearCards])

  useEffect(() => clearCards, [clearCards])

  const toggle = useCallback(() => setVisible(v => !v), [])

  /**
   * Hand the annotated interval to an agent.
   *
   * It opens a chat with the brief in the composer rather than spawning
   * anything: who does the cleanup, on which machine, under which profile, is
   * not a question this button gets to answer, and the app has no other place
   * where a person delegates. Addressing an agent in chat is how work is
   * handed over here, so that is what this does -- the person picks the
   * recipient and sends.
   */
  const handOffCleanup = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !compareHash || !newestHash || builds.length === 0) return
    const notes = new Map<string, string>()
    for (const build of builds) {
      const shape = editor.getShape(cardShapeId(build.hash)) as any
      if (shape?.props?.note) notes.set(build.hash, shape.props.note)
    }
    const brief = buildCleanupBrief(compareHash, newestHash, builds, notes)
    const vp = editor.getViewportPageBounds()
    const id = await createFleetShape(editor, 'fleet-chat', vp.x + vp.w * 0.55, vp.y + vp.h * 0.1, {})
    if (!id) return
    editor.bringToFront([id as any])
    chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: id, text: brief } }))
  }, [editorRef, compareHash, newestHash, builds])

  return {
    bridgeVisible: visible,
    bridgeLoading: loading,
    bridgeError: error,
    bridgeBuilds: builds,
    /** How far the compare column moves out while the bridge is open. */
    bridgeColumnOffset: visible ? bridgeGapWidth(builds.length) : 0,
    toggleEditBridge: toggle,
    handOffCleanup,
  }
}
