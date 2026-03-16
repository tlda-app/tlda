/**
 * useSyncedPlayback — listens for fleet playback broadcasts and replays
 * annotation shapes at historical timestamps.
 *
 * Fleet's playback system broadcasts on BroadcastChannel('fleet-playback'):
 *   { ts: number, playing: boolean, speed: number, sessionId: string }
 *
 * When playing:
 *   1. Fetch shapes at the broadcast timestamp via GET /api/projects/{name}/shapes/at/{ts}
 *   2. Cache current (live) shapes for instant "return to present"
 *   3. Swap annotation shapes on the canvas
 *   4. Expose playback state for UI indicator
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { b64Vecs } from 'tldraw'
import type { Editor, TLRecord, TLShapeId } from 'tldraw'

interface PlaybackMessage {
  ts: number
  absTs?: number  // absolute timestamp for shapes/at endpoint
  playing: boolean
  speed: number
  sessionId: string
}

interface PlaybackShapesResponse {
  shapes: Array<{
    id: string
    type: string
    typeName: string
    x: number
    y: number
    props: Record<string, any>
    meta?: Record<string, any>
  }>
  changelogRange: { first: number; last: number } | null
}

export interface PlaybackState {
  active: boolean
  ts: number | null
  speed: number
  sessionId: string | null
}

// Shape types that are annotation shapes (not page geometry)
const ANNOTATION_TYPES = new Set([
  'math-note', 'draw', 'highlight', 'arrow', 'geo', 'text', 'note',
])

// Convert old-format segments ({type, points[]}) to new format ({type, path: b64string})
function migrateSegments(segments: any[]): any[] {
  if (!segments?.length) return segments
  return segments.map((seg: any) => {
    if (seg.path !== undefined) return seg // already new format
    if (seg.points && Array.isArray(seg.points)) {
      return { type: seg.type, path: b64Vecs.encodePoints(seg.points) }
    }
    return seg
  })
}

export function useSyncedPlayback(
  editorRef: React.RefObject<Editor | null>,
  docName: string,
) {
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    active: false,
    ts: null,
    speed: 1,
    sessionId: null,
  })

  // Cache live shapes before we start swapping
  const liveShapesRef = useRef<TLRecord[] | null>(null)
  const lastFetchedTs = useRef<number>(0)
  const fetchingRef = useRef(false)

  // Fetch shapes at a given timestamp and swap them onto the canvas
  const applyPlaybackShapes = useCallback(async (ts: number) => {
    const editor = editorRef.current
    if (!editor || fetchingRef.current) return
    if (Math.abs(ts - lastFetchedTs.current) < 500) return // debounce close timestamps

    fetchingRef.current = true
    lastFetchedTs.current = ts

    try {
      const res = await fetch(`/api/projects/${docName}/shapes/at/${ts}`)
      if (!res.ok) {
        console.warn(`[playback] shapes/at/${ts} failed: ${res.status}`)
        return
      }
      const data: PlaybackShapesResponse = await res.json()

      // Cache live annotation shapes on first playback fetch
      if (!liveShapesRef.current) {
        liveShapesRef.current = editor.getCurrentPageShapes()
          .filter(s => ANNOTATION_TYPES.has(s.type))
          .map(s => editor.store.get(s.id)!)
          .filter(Boolean)
      }

      // Remove current annotation shapes
      const currentAnnotations = editor.getCurrentPageShapes()
        .filter(s => ANNOTATION_TYPES.has(s.type))
        .map(s => s.id)
      if (currentAnnotations.length > 0) {
        editor.store.remove(currentAnnotations)
      }

      // Add historical shapes (only annotation types) via createShape for proper validation
      const toCreate = data.shapes
        .filter(s => ANNOTATION_TYPES.has(s.type))
        .map(s => {
          // Migrate old-format segments (points[]) to new format (path string)
          const props = s.props && s.props.segments
            ? { ...s.props, segments: migrateSegments(s.props.segments) }
            : s.props
          return {
            id: s.id as TLShapeId,
            type: s.type,
            x: s.x,
            y: s.y,
            rotation: s.rotation ?? 0,
            opacity: 0.7,
            isLocked: true,
            props,
          }
        })

      if (toCreate.length > 0) {
        try {
          editor.createShapes(toCreate as any[])
        } catch (e) {
          console.warn('[playback] createShapes error:', e)
        }
      }
    } catch (e) {
      console.warn('[playback] fetch error:', e)
    } finally {
      fetchingRef.current = false
    }
  }, [editorRef, docName])

  // Restore live shapes when playback ends
  const restoreLive = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !liveShapesRef.current) return

    // Remove playback shapes
    const playbackShapes = editor.getCurrentPageShapes()
      .filter(s => ANNOTATION_TYPES.has(s.type))
      .map(s => s.id)
    if (playbackShapes.length > 0) {
      editor.store.remove(playbackShapes)
    }

    // Restore cached live shapes
    editor.store.put(liveShapesRef.current)
    liveShapesRef.current = null
    lastFetchedTs.current = 0
  }, [editorRef])

  // Handle incoming playback message (shared by BroadcastChannel and SSE)
  const handlePlaybackMessage = useCallback((msg: PlaybackMessage) => {
    if (!msg || typeof msg.ts !== 'number') return

    if (msg.playing) {
      setPlaybackState({
        active: true,
        ts: msg.ts,
        speed: msg.speed || 1,
        sessionId: msg.sessionId || null,
      })
      // Use absolute timestamp for shapes/at endpoint (falls back to relative ts)
      applyPlaybackShapes(msg.absTs || msg.ts)
    } else {
      setPlaybackState({
        active: false,
        ts: null,
        speed: 1,
        sessionId: null,
      })
      restoreLive()
    }
  }, [applyPlaybackShapes, restoreLive])

  // Primary: SSE from fleet server (cross-origin)
  useEffect(() => {
    const FLEET_URL = 'http://localhost:5199/api/playback/stream'
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      es = new EventSource(FLEET_URL)
      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'connected') return
          handlePlaybackMessage(msg as PlaybackMessage)
        } catch {}
      }
      es.onerror = () => {
        es?.close()
        retryTimer = setTimeout(connect, 5000)
      }
    }

    connect()

    return () => {
      es?.close()
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [handlePlaybackMessage])

  // Fallback: BroadcastChannel (same-origin only)
  useEffect(() => {
    let channel: BroadcastChannel
    try {
      channel = new BroadcastChannel('fleet-playback')
    } catch {
      return
    }

    channel.onmessage = (event: MessageEvent<PlaybackMessage>) => {
      handlePlaybackMessage(event.data)
    }

    return () => {
      channel.close()
      restoreLive()
    }
  }, [handlePlaybackMessage, restoreLive])

  return playbackState
}
