import type { Editor, TLShapeId } from 'tldraw'
import { createTemporaryMarkdownColumn } from './FleetPillShape'
import { getDeviceId, getHumanId, isDeviceReady } from '../fleet/fleet-data.mjs'
import { dispatchManagedAnnotationViewerRequest } from '../wm/annotation-viewer-surface'
import { clientPointToPage } from '../wm/viewport-coordinates'

type MarkdownColumnOptions = {
  editor: Editor
  sourceShapeId: string
  title: string
  markdown: string
  sourceEl: HTMLElement
  placementEl?: HTMLElement | null
  logPrefix: string
}

type OpenMarkdownChipOptions = {
  target: HTMLElement
  stopPropagation: () => void
  openMarkdownColumn: (title: string, markdown: string, sourceEl: HTMLElement) => void
}

function isManagedSurfaceProofFixtureEnabled() {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('wmManagedSurfaceProof') === '1'
}

function currentManagedSurfaceOwner() {
  if (!isDeviceReady()) return { userId: '', deviceId: '' }
  return { userId: getHumanId(), deviceId: getDeviceId() }
}

function managedViewportSize() {
  return {
    w: typeof window === 'undefined' ? 1200 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }
}

export async function fetchMarkdownChipText(chipUrl: string, chipPath: string): Promise<string> {
  const candidates = [
    chipUrl,
    chipPath ? `/api/read-file?path=${encodeURIComponent(chipPath)}` : '',
  ].filter(Boolean)
  let lastError: unknown = null
  for (const url of candidates) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.text()
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('markdown chip fetch failed')
}

export function openChatMarkdownColumn(options: MarkdownColumnOptions) {
  const { editor, sourceShapeId, title, markdown, sourceEl, placementEl, logPrefix } = options
  const sourceRect = sourceEl.getBoundingClientRect()
  const left = Math.max(12, sourceRect.left)
  const top = Math.max(12, sourceRect.bottom + 8)
  const mainEditor = (window as Window & { __tldraw_editor__?: Editor }).__tldraw_editor__ || editor
  const chipAnchor = clientPointToPage(mainEditor, { x: left, y: top })
  const occupiedBounds = (mainEditor.getCurrentPageShapes() as Array<{ id: TLShapeId; meta?: { temporaryMarkdownColumn?: unknown } }>)
    .filter((s) => !s.meta?.temporaryMarkdownColumn)
    .map((s) => mainEditor.getShapePageBounds(s.id))
    .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>
  const anchor = occupiedBounds.length
    ? {
        x: Math.max(...occupiedBounds.map(b => b.x + b.w)) + 10000,
        y: Math.max(...occupiedBounds.map(b => b.y + b.h)) + 10000,
      }
    : chipAnchor

  void createTemporaryMarkdownColumn(mainEditor, anchor, title, markdown || title, {
    sourceChatShapeId: sourceShapeId,
    // CLICK path: render through the REAL main-document path (built project served
    // at /docs/..), not the data:text/html lookalike. Drag-drop stays on the data-URL.
    realRender: true,
    wmManagedSurfaceProofFixture: isManagedSurfaceProofFixtureEnabled(),
  }).then((result) => {
    if (!result?.bounds) return
    const chipRect = sourceEl.getBoundingClientRect()
    const placementRect = placementEl?.getBoundingClientRect() ?? chipRect
    dispatchManagedAnnotationViewerRequest({
      surfaceKey: result.surface.surfaceId,
      bounds: { x: result.bounds.x, y: result.bounds.y, w: result.bounds.w, h: result.bounds.h },
      shapeIds: [result.surface.payload.shapeId],
      label: title || 'Markdown chip',
      chipRect: {
        left: placementRect.left,
        top: placementRect.top,
        right: placementRect.right,
        bottom: placementRect.bottom,
        width: placementRect.width,
        height: placementRect.height,
      },
      useFullBounds: true,
      pinned: true,
      owner: currentManagedSurfaceOwner(),
      source: result.surface.surfaceId,
      viewport: managedViewportSize(),
      centerOnAnchor: true,
    })
  }).catch((err) => {
    console.warn(`[${logPrefix}] markdown annotation viewer create failed:`, err?.message || err)
  })
}

export function openMarkdownChipFromTarget(options: OpenMarkdownChipOptions): boolean {
  const { target, stopPropagation, openMarkdownColumn } = options
  const mdChip = target.closest('.ref-chip-doc, .md-file-card') as HTMLElement | null
  if (!mdChip) return false

  if (mdChip.classList.contains('src-chip')) {
    stopPropagation()
    const line = mdChip.closest('.chat-line')
    const body = line?.querySelector('.message-body') as HTMLElement | null
    const title = mdChip.getAttribute('title') || mdChip.textContent || 'source'
    openMarkdownColumn(title, body?.innerText || body?.textContent || title, mdChip)
    return true
  }

  const chipUrl = mdChip.dataset.url || ''
  const chipPath = mdChip.dataset.path || ''
  const isMd = /\.md$/i.test(chipUrl || chipPath)
  const fetchUrl = chipUrl || (chipPath ? `/api/read-file?path=${encodeURIComponent(chipPath)}` : '')
  if (!isMd || !fetchUrl) return false

  stopPropagation()
  const title = mdChip.querySelector('.md-file-chip')?.textContent || mdChip.textContent || chipPath.split('/').pop() || 'file'
  fetchMarkdownChipText(chipUrl, chipPath)
    .then(text => {
      const baseUrl = chipUrl ? chipUrl.substring(0, chipUrl.lastIndexOf('/') + 1) : ''
      const resolved = baseUrl ? text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
        if (src.startsWith('http') || src.startsWith('/')) return match
        return `![${alt}](${baseUrl}${src})`
      }) : text
      openMarkdownColumn(title, resolved, mdChip)
    })
    .catch(() => {
      openMarkdownColumn(title, `# Failed to load\n\n${chipUrl || chipPath || title}`, mdChip)
    })
  return true
}
