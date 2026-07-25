import type { Editor, TLShapeId } from 'tldraw'
import { log } from '../logger'
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
  sourcePath?: string
  sourceSection?: string
  logPrefix: string
}

type ChipSource = {
  path?: string
  section?: string
}

type OpenMarkdownChipOptions = {
  target: HTMLElement
  stopPropagation: () => void
  openMarkdownColumn: (title: string, markdown: string, sourceEl: HTMLElement, source?: ChipSource) => void
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

export type MaterializeChipResult = {
  ok: boolean
  outputFile?: string
  error?: string
}

// Writes the chip's markdown as a real, synced column (project part) of the
// document currently open on canvas — not a separate project, not a
// throwaway snapshot. The target project is whatever `?doc=` is loaded; the
// server writes the file and rebuilds, so the existing reload/signal
// pipeline that already keeps project parts live also keeps this part live.
export async function materializeMarkdownChip({
  markdown,
  title,
  sourcePath,
  sourceSection,
}: {
  markdown: string
  title: string
  sourcePath?: string
  sourceSection?: string
}): Promise<MaterializeChipResult> {
  const docName = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('doc')
  if (!docName) return { ok: false, error: 'no open document to attach to' }
  try {
    const res = await fetch(`/api/projects/${docName}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown,
        title,
        sourcePath,
        provenance: sourceSection ? { section: sourceSection } : undefined,
      }),
    })
    const result = await res.json().catch(() => null)
    if (!res.ok || !result?.ok) {
      return { ok: false, error: result?.error || `materialize failed: HTTP ${res.status}` }
    }
    return { ok: true, outputFile: result.outputFile }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function openChatMarkdownColumn(options: MarkdownColumnOptions) {
  const { editor, sourceShapeId, title, markdown, sourceEl, placementEl, sourcePath, sourceSection, logPrefix } = options
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

  const docName = new URLSearchParams(window.location.search).get('doc')

  void materializeMarkdownChip({ markdown, title, sourcePath, sourceSection }).then((materialized) => {
    if (!materialized.ok || !materialized.outputFile || !docName) {
      console.warn(`[${logPrefix}] markdown materialize failed:`, materialized.error)
      return
    }
    const url = `/docs/${docName}/${materialized.outputFile}?t=${Date.now()}`
    return createTemporaryMarkdownColumn(mainEditor, anchor, title, markdown || title, {
      sourceChatShapeId: sourceShapeId,
      materializedDoc: docName,
      materializedFile: materialized.outputFile,
    }, url)
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

  const chipUrl = mdChip.dataset.url || ''
  const chipPath = mdChip.dataset.path || ''
  const chipSection = mdChip.dataset.section || undefined

  if (mdChip.classList.contains('src-chip')) {
    stopPropagation()
    const title = mdChip.getAttribute('title') || mdChip.textContent || 'source'
    // Provenance chips are a shared-file chip plus a section focus, not a
    // section-only snapshot — fetch the whole raw source file (same path as
    // a plain file chip), never the rendered chat bubble text.
    fetchMarkdownChipText(chipUrl, chipPath)
      .then(text => openMarkdownColumn(title, text, mdChip, { path: chipPath, section: chipSection }))
      // A load failure opens NO document. It used to open a markdown column whose
      // body was "# Failed to load", which reads to the user as a real but broken
      // document rather than as a failure. The failure goes to the error surface.
      .catch(err => log.error('chat-chip', 'source chip failed to load; opening no document', {
        title, path: chipPath, url: chipUrl, section: chipSection,
        error: err instanceof Error ? err.message : String(err),
      }))
    return true
  }

  const isMd = /\.(?:md|markdown)(?:$|[?#])/i.test(chipUrl || chipPath)
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
      openMarkdownColumn(title, resolved, mdChip, { path: chipPath })
    })
    // Same rule as above: a failed fetch produces no document at all. A chip whose
    // path only exists on the sending agent's machine cannot resolve from the
    // server, and fabricating a "Failed to load" document out of that made a
    // delivery failure look like a broken file.
    .catch(err => log.error('chat-chip', 'file chip failed to load; opening no document', {
      title, path: chipPath, url: chipUrl,
      error: err instanceof Error ? err.message : String(err),
    }))
  return true
}
