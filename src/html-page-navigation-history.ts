import type { Editor, TLPageId } from 'tldraw'

export const HTML_NAV_STATE_KEY = '__tldaHtmlNavigation'
const HTML_NAV_RECORD_DELAY_MS = 350

type HtmlNavigationLocation = {
  pageId: string
  camera: { x: number; y: number; z: number }
}

let htmlNavigationHistoryRefCount = 0
let htmlNavigationHistoryEditor: Editor | null = null
let htmlNavigationPopstateHandler: ((event: PopStateEvent) => void) | null = null
let restoringHtmlNavigationState = false

function isHtmlNavigationLocation(value: unknown): value is HtmlNavigationLocation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { pageId?: unknown; camera?: { x?: unknown; y?: unknown; z?: unknown } }
  return (
    typeof candidate.pageId === 'string' &&
    typeof candidate.camera?.x === 'number' &&
    typeof candidate.camera?.y === 'number' &&
    typeof candidate.camera?.z === 'number'
  )
}

function currentHtmlNavigationLocation(editor: Editor): HtmlNavigationLocation {
  const camera = editor.getCamera()
  return {
    pageId: String(editor.getCurrentPageId()),
    camera: { x: camera.x, y: camera.y, z: camera.z },
  }
}

function historyStateWithHtmlNavigation(baseState: unknown, location: HtmlNavigationLocation) {
  const state = baseState && typeof baseState === 'object' && !Array.isArray(baseState)
    ? { ...(baseState as Record<string, unknown>) }
    : {}
  state[HTML_NAV_STATE_KEY] = location
  return state
}

export function htmlNavigationLocationFromHistoryState(state: unknown) {
  if (!state || typeof state !== 'object') return null
  const location = (state as Record<string, unknown>)[HTML_NAV_STATE_KEY]
  return isHtmlNavigationLocation(location) ? location : null
}

function restoreHtmlNavigationLocation(editor: Editor, location: HtmlNavigationLocation) {
  restoringHtmlNavigationState = true
  if (location.pageId && location.pageId !== editor.getCurrentPageId()) {
    editor.setCurrentPage(location.pageId as TLPageId)
  }
  editor.setCamera(location.camera, { animation: { duration: 300 } })
  window.setTimeout(() => { restoringHtmlNavigationState = false }, 0)
}

function ensureHtmlNavigationHistoryBaseline(editor: Editor) {
  const existing = htmlNavigationLocationFromHistoryState(window.history.state)
  if (existing) return
  window.history.replaceState(
    historyStateWithHtmlNavigation(window.history.state, currentHtmlNavigationLocation(editor)),
    '',
  )
}

function pushHtmlNavigationHistoryLocation(editor: Editor) {
  if (restoringHtmlNavigationState) return
  ensureHtmlNavigationHistoryBaseline(editor)
  const location = currentHtmlNavigationLocation(editor)
  window.history.pushState(historyStateWithHtmlNavigation(window.history.state, location), '')
}

export function recordHtmlNavigationStart(editor: Editor) {
  if (restoringHtmlNavigationState) return
  ensureHtmlNavigationHistoryBaseline(editor)
}

export function recordHtmlNavigationEnd(editor: Editor) {
  if (restoringHtmlNavigationState) return
  window.setTimeout(() => pushHtmlNavigationHistoryLocation(editor), HTML_NAV_RECORD_DELAY_MS)
}

export function installHtmlNavigationHistory(editor: Editor) {
  htmlNavigationHistoryRefCount += 1
  htmlNavigationHistoryEditor = editor
  if (!htmlNavigationPopstateHandler) {
    htmlNavigationPopstateHandler = event => {
      const location = htmlNavigationLocationFromHistoryState(event.state)
      if (!location || !htmlNavigationHistoryEditor) return
      restoreHtmlNavigationLocation(htmlNavigationHistoryEditor, location)
    }
    window.addEventListener('popstate', htmlNavigationPopstateHandler)
  }

  return () => {
    htmlNavigationHistoryRefCount = Math.max(0, htmlNavigationHistoryRefCount - 1)
    if (htmlNavigationHistoryRefCount > 0) return
    if (htmlNavigationPopstateHandler) {
      window.removeEventListener('popstate', htmlNavigationPopstateHandler)
      htmlNavigationPopstateHandler = null
    }
    htmlNavigationHistoryEditor = null
  }
}
