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
import type { Editor, TLRecord, TLShapeId } from 'tldraw'

interface PlaybackMessage {
  ts: number
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

      // Add historical shapes (only annotation types)
      const historicalShapes = data.shapes
        .filter(s => ANNOTATION_TYPES.has(s.type))
        .map(s => ({
          ...s,
          id: s.id as TLShapeId,
          typeName: 'shape' as const,
          parentId: editor.getCurrentPageId(),
          index: 'a1' as any,
          isLocked: true, // prevent editing historical shapes
          rotation: 0,
          opacity: 0.7, // subtle visual hint that these are historical
        }))

      if (historicalShapes.length > 0) {
        editor.store.put(historicalShapes as any[])
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

  // Listen for BroadcastChannel messages
  useEffect(() => {
    let channel: BroadcastChannel
    try {
      channel = new BroadcastChannel('fleet-playback')
    } catch {
      // BroadcastChannel not supported (e.g. some WebKit versions)
      return
    }

    channel.onmessage = (event: MessageEvent<PlaybackMessage>) => {
      const msg = event.data
      if (!msg || typeof msg.ts !== 'number') return

      if (msg.playing) {
        setPlaybackState({
          active: true,
          ts: msg.ts,
          speed: msg.speed || 1,
          sessionId: msg.sessionId || null,
        })
        applyPlaybackShapes(msg.ts)
      } else {
        // Playback stopped
        setPlaybackState({
          active: false,
          ts: null,
          speed: 1,
          sessionId: null,
        })
        restoreLive()
      }
    }

    return () => {
      channel.close()
      // Restore live shapes if we unmount during playback
      restoreLive()
    }
  }, [applyPlaybackShapes, restoreLive])

  return playbackState
}
