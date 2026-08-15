export type WMDropPoint = { x: number; y: number }

export type WMDropPayload<T = unknown> = {
  kind: string
  data: T
}

export type WMDropTarget<T = unknown> = {
  accepts: (payload: WMDropPayload) => payload is WMDropPayload<T>
  preview?: (payload: WMDropPayload<T>, point: WMDropPoint) => void
  leave?: () => void
  drop: (payload: WMDropPayload<T>, point: WMDropPoint) => void | Promise<void>
}

const targets = new WeakMap<HTMLElement, WMDropTarget<any>>()
let active: { element: HTMLElement; target: WMDropTarget<any> } | null = null
let pointerClientPoint: WMDropPoint | null = null

export function recordWMDropPointer(point: WMDropPoint) {
  pointerClientPoint = { x: point.x, y: point.y }
}

export function currentWMDropPointer() {
  return pointerClientPoint
}

if (typeof window !== 'undefined') {
  const recordPointerEvent = (event: PointerEvent) => recordWMDropPointer({ x: event.clientX, y: event.clientY })
  window.addEventListener('pointerdown', recordPointerEvent, true)
  window.addEventListener('pointermove', recordPointerEvent, true)
  window.addEventListener('pointerup', recordPointerEvent, true)
}

export function registerWMDropTarget<T>(
  element: HTMLElement,
  target: WMDropTarget<T>,
  options: { notifyLeaveOnUnregister?: boolean } = {},
) {
  targets.set(element, target)
  return () => {
    if (active?.element === element) {
      if (options.notifyLeaveOnUnregister !== false) active.target.leave?.()
      active = null
    }
    targets.delete(element)
  }
}

// Instrumentation only — it records why resolution went the way it did and
// changes nothing about what is returned.
//
// This exists because a drop that resolves to null is silent: no overlay, no
// error, nothing in any log. When Skip's filter overlay stopped opening, the
// events that would have explained it were produced inside the page and thrown
// away, so the cause could not be established after the fact.
//
// The two null-returns below point at different bugs and must stay
// distinguishable: `detached` means a stale registration whose element left the
// DOM (registration is keyed by element in a WeakMap), while `not-hit-testable`
// means the element is present but excluded from the hit test. Recording "no
// target" without saying which is worthless.
// `display-none` is ordinary: tldraw culls off-screen shapes by toggling
// display, so it fires on every pan and means nothing is wrong. The other three
// are worth reading. Collapsing them into one "not hit-testable" makes the
// buffer cry wolf on normal operation, which is worse than no buffer — the
// first person to read it concludes the bug is everywhere and stops trusting it.
type DropResolveRejection = {
  reason: 'detached' | 'display-none' | 'pointer-events-none' | 'visibility-hidden'
  cls: string
}

function recordDropResolve(detail: Record<string, unknown>) {
  try {
    if (typeof window === 'undefined') return
    const probe = (window as unknown as { __livePerfProbe?: { recordEvent?: (t: string, d?: Record<string, unknown>) => void } }).__livePerfProbe
    probe?.recordEvent?.('wm-drop-resolve', detail)
  } catch {
    // Telemetry must never throw into an interaction path.
  }
}

function targetAt(payload: WMDropPayload, point: WMDropPoint) {
  if (typeof document === 'undefined') return null
  const rejections: DropResolveRejection[] = []
  const hits = document.elementsFromPoint(point.x, point.y)
  const resolved = registeredDropTargetFromElements(
    hits,
    (element: HTMLElement) => {
      if (!element.isConnected) {
        if (targets.has(element)) rejections.push({ reason: 'detached', cls: describeElement(element) })
        return null
      }
      const target = targets.get(element)
      if (!target) return null
      const style = getComputedStyle(element)
      if (style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden') {
        rejections.push({
          reason: style.display === 'none'
            ? 'display-none'
            : style.pointerEvents === 'none'
              ? 'pointer-events-none'
              : 'visibility-hidden',
          cls: describeElement(element),
        })
        return null
      }
      return target
    },
    payload,
  )
  // `registeredHits` is the discriminator between the two failures that look
  // identical to the user. A stale registration means an element under the
  // pointer HAS a WeakMap entry but is no longer in the document; an absent
  // registration means nothing under the pointer was ever registered. Recording
  // only "resolution failed" cannot tell those apart, and they are different bugs.
  const registeredHits = Array.from(hits)
    .map((el) => el as HTMLElement)
    .filter((el) => targets.has(el))
    .slice(0, 6)
    .map((el) => ({ cls: describeElement(el), connected: el.isConnected }))
  recordDropResolve({
    kind: payload.kind,
    point,
    resolved: !!resolved,
    resolvedCls: resolved ? describeElement(resolved.element) : null,
    hitCount: hits.length,
    hits: Array.from(hits).slice(0, 6).map((el) => describeElement(el as HTMLElement)),
    registeredHitCount: registeredHits.length,
    registeredHits,
    rejections,
  })
  return resolved
}

function describeElement(element: Element) {
  const cls = typeof element.className === 'string' ? element.className : ''
  return `${element.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/).slice(0, 3).join('.') : ''}`
}

export function updateWMDrop(payload: WMDropPayload, point: WMDropPoint) {
  const next = targetAt(payload, point)
  if (next?.element !== active?.element) {
    active?.target.leave?.()
    active = next
  }
  active?.target.preview?.(payload, point)
  return !!active
}

export function finishWMDrop(payload: WMDropPayload, point: WMDropPoint) {
  updateWMDrop(payload, point)
  const current = active
  active = null
  if (!current) return false
  void current.target.drop(payload, point)
  current.target.leave?.()
  return true
}

export function cancelWMDrop() {
  active?.target.leave?.()
  active = null
}
// @ts-ignore — vanilla JS module
import { registeredDropTargetFromElements } from './drop-target-resolution.mjs'
