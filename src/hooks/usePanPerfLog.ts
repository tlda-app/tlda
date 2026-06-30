/**
 * usePanPerfLog — sample camera-pan frame-health and POST it to the client log.
 *
 * Captures real on-device numbers (median/max frame delta, dropped-frame count,
 * zoom, visible SVG node count) during an active camera pan/zoom gesture, so a
 * user's actual hardware + gesture + zoom can be read out of
 * ~/.config/tlda/client.log instead of being reproduced on another machine.
 *
 * It logs once per gesture and only for gestures long enough to be meaningful
 * (MIN_FRAMES) — no idle spam. It goes through the standard logger at `info`
 * level: below the default `warn` console threshold, so nothing shows in the
 * user's DevTools, but it is always POSTed to the server sink. No UI.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'
import { react, type Editor } from 'tldraw'
import { log } from '../logger'

const GESTURE_END_MS = 200 // camera quiet for this long ends the gesture
const MIN_FRAMES = 12 // ignore tiny nudges

export function usePanPerfLog(editorRef: RefObject<Editor | null>, editorMounted: number) {
  useEffect(() => {
    // editorMounted is a re-run trigger: the tldraw editor mounts asynchronously
    // (after this effect first runs), so editorRef.current is null on the initial
    // pass. SvgDocument bumps editorMounted in onMount, which re-runs this effect
    // with the editor available so the camera reaction actually installs.
    const editor = editorRef.current
    if (!editor) return

    let active = false
    let rafId: number | null = null
    let lastTs = 0
    let deltas: number[] = []
    let endTimer: ReturnType<typeof setTimeout> | null = null
    let prev = editor.getCamera()
    let startNodes = 0
    let startPages = 0

    const tick = (ts: number) => {
      if (!active) { rafId = null; return }
      if (lastTs) deltas.push(ts - lastTs)
      lastTs = ts
      rafId = requestAnimationFrame(tick)
    }

    const visibleSvgPages = () => {
      const viewport = editor.getViewportScreenBounds()
      const pageIds = new Set(
        editor.getCurrentPageShapes()
          .filter((shape) => (shape.type as string) === 'svg-page')
          .map((shape) => shape.id as string),
      )
      const pages: Element[] = []
      for (const el of document.querySelectorAll('[data-shape-id]')) {
        const id = el.getAttribute('data-shape-id')
        if (!id || !pageIds.has(id) || !el.querySelector('svg')) continue
        const rect = el.getBoundingClientRect()
        if (rect.right < viewport.x || rect.left > viewport.x + viewport.w || rect.bottom < viewport.y || rect.top > viewport.y + viewport.h) continue
        pages.push(el)
      }
      return pages
    }

    const visibleNodes = () => {
      let n = 0
      for (const el of visibleSvgPages()) {
        n += el.querySelectorAll('path,use,text,tspan').length
      }
      return n
    }

    const endGesture = () => {
      endTimer = null
      active = false
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
      const d = deltas
      deltas = []
      lastTs = 0
      if (d.length < MIN_FRAMES) return
      const sorted = [...d].sort((a, b) => a - b)
      const cam = editor.getCamera()
      // metric() is sink-only (no console, no level gate) so these land in the
      // client log by default — pan frame-health from a user's real device.
      log.metric('pan-perf', 'pan', {
        frames: d.length,
        median: Math.round(sorted[Math.floor(sorted.length / 2)]),
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
        max: Math.round(Math.max(...d)),
        over33: d.filter((x) => x > 33).length,
        over50: d.filter((x) => x > 50).length,
        zoom: Number(cam.z.toFixed(3)),
        nodes: startNodes,
        pages: startPages,
      })
    }

    // Reaction fires on every camera change (~1/frame during a pan). It only
    // arms a frame-sampling rAF loop and a debounced gesture-end timer; the
    // actual frame deltas come from the rAF loop, not from this callback.
    const stop = react('pan-perf', () => {
      const cam = editor.getCamera() // subscribe to camera changes
      if (cam.x === prev.x && cam.y === prev.y && cam.z === prev.z) return
      prev = cam
      if (!active) {
        active = true
        deltas = []
        lastTs = 0
        startNodes = visibleNodes()
        startPages = visibleSvgPages().length
        rafId = requestAnimationFrame(tick)
      }
      if (endTimer != null) clearTimeout(endTimer)
      endTimer = setTimeout(endGesture, GESTURE_END_MS)
    })

    return () => {
      stop()
      if (rafId != null) cancelAnimationFrame(rafId)
      if (endTimer != null) clearTimeout(endTimer)
    }
  }, [editorRef, editorMounted])
}
