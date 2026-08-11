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

export function registerWMDropTarget<T>(element: HTMLElement, target: WMDropTarget<T>) {
  targets.set(element, target)
  return () => {
    if (active?.element === element) {
      active.target.leave?.()
      active = null
    }
    targets.delete(element)
  }
}

function targetAt(payload: WMDropPayload, point: WMDropPoint) {
  if (typeof document === 'undefined') return null
  return registeredDropTargetFromElements(
    document.elementsFromPoint(point.x, point.y),
    (element: HTMLElement) => {
      if (!element.isConnected) return null
      const target = targets.get(element)
      if (!target) return null
      const style = getComputedStyle(element)
      if (style.pointerEvents === 'none' || style.display === 'none' || style.visibility === 'hidden') return null
      return target
    },
    payload,
  )
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
