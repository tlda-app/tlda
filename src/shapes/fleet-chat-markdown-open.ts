import type { Editor } from 'tldraw'
import { log } from '../logger'
import { createTemporaryMarkdownColumn } from './FleetPillShape'
import { getDeviceId, getHumanId, isDeviceReady } from '../fleet/fleet-data.mjs'
import { dispatchManagedAnnotationViewerRequest } from '../wm/annotation-viewer-surface'
import { clientPointToPage } from '../wm/viewport-coordinates'

type MarkdownColumnOptions = {
  editor: Editor
  sourceShapeId: string
  title: string
  sourceEl: HTMLElement
  placementEl?: HTMLElement | null
  sourcePath?: string
  logPrefix: string
  showError?: (message: string) => void
}

type ChipSource = {
  path?: string
  section?: string
}

type OpenMarkdownChipOptions = {
  target: HTMLElement
  stopPropagation: () => void
  openMarkdownColumn: (title: string, sourceEl: HTMLElement, source?: ChipSource) => void | Promise<void>
  showError?: (message: string) => void
}

// Opening a chip is a live-resolve POST before anything appears on screen.
// Nothing marked the chip as working and nothing kept a second click from
// starting a second chain, so a click that looked ignored and was clicked
// again opened a second column and a second viewer request — one intent, N
// objects. One open per chip at a time, and the chip says so for as long as
// it runs.
const openingChips = new Set<string>()

// Every way a chip open can fail says the same sentence, because they are the
// same event to the person who clicked: the thing did not open. Which of the
// three it was -- the path would not resolve, the column would not place, the
// viewer would not take the surface -- is in the log line beside it, and that
// is where it belongs. A message naming the stage would ask him to care about a
// distinction he cannot act on.
//
// It exists at all because the second annotation viewer of a page load threw
// into a swallowed warning for eleven days. The chip glowed, the file joined
// the projects tab, nothing opened, and the only instrument that reported it
// was Skip. A failure nobody can see is a failure only he can find.
export const CHIP_OPEN_FAILED = 'That file didn’t open. Nothing was lost — try it again.'

function chipOpenKey(url: string, path: string, section?: string) {
  return `${url} | ${path} | ${section || ''}`
}

function beginChipOpen(chip: HTMLElement, key: string): boolean {
  if (openingChips.has(key)) return false
  openingChips.add(key)
  chip.classList.add('chip-opening')
  chip.setAttribute('aria-busy', 'true')
  return true
}

function endChipOpen(chip: HTMLElement, key: string) {
  openingChips.delete(key)
  chip.classList.remove('chip-opening')
  chip.removeAttribute('aria-busy')
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

/**
 * Open a clicked Markdown chip as a live versioned document column.
 *
 * Frozen byte-copies were removed from this path: the chip's path resolves
 * server-side (adopt-then-match against the project's declared markdown
 * roots), and a path that is not a live document fails loudly with
 * CHIP_OPEN_FAILED instead of snapshotting. No message bytes are fetched,
 * uploaded, or stored anywhere along the way.
 */
export function openChatMarkdownColumn(options: MarkdownColumnOptions): Promise<void> {
  const { editor, sourceShapeId, title, sourceEl, placementEl, sourcePath, logPrefix, showError } = options
  const sourceRect = sourceEl.getBoundingClientRect()
  const left = Math.max(12, sourceRect.left)
  const top = Math.max(12, sourceRect.bottom + 8)
  const mainEditor = (window as Window & { __tldraw_editor__?: Editor }).__tldraw_editor__ || editor
  const chipAnchor = clientPointToPage(mainEditor, { x: left, y: top })

  const projectName = new URLSearchParams(window.location.search).get('project')

  // Returned, not voided: the caller's re-entrancy guard clears when this
  // settles, so the chip stays marked for exactly as long as the work runs.
  const resolveLive = (!projectName || !sourcePath)
    ? Promise.resolve<{ ok: false; error: string }>({
        ok: false,
        error: projectName ? 'no source path' : 'no open document',
      })
    : fetch(`/api/projects/${projectName}/parts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath, title }),
      }).then(async (res) => {
        const result = await res.json().catch(() => null)
        if (!res.ok || !result?.ok || !result?.outputFile) {
          return { ok: false as const, error: result?.error || `HTTP ${res.status}` }
        }
        return { ok: true as const, outputFile: result.outputFile as string }
      }).catch((err) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }))
  return resolveLive.then((resolved) => {
    if (!resolved.ok || !projectName) {
      log.error(logPrefix, 'markdown live resolve failed; opening no document', {
        title, sourcePath, project: projectName,
        error: resolved.ok ? 'no output file' : resolved.error,
      })
      showError?.(CHIP_OPEN_FAILED)
      return
    }
    const url = `/docs/${projectName}/${resolved.outputFile}?t=${Date.now()}`
    return createTemporaryMarkdownColumn(mainEditor, chipAnchor, title, '', {
      sourceChatShapeId: sourceShapeId,
      materializedDoc: projectName,
      materializedFile: resolved.outputFile,
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
    log.error(logPrefix, 'markdown annotation viewer create failed; nothing opened', {
      title, sourcePath,
      error: err instanceof Error ? err.message : String(err),
    })
    showError?.(CHIP_OPEN_FAILED)
  })
}

export function openMarkdownChipFromTarget(options: OpenMarkdownChipOptions): boolean {
  const { target, stopPropagation, openMarkdownColumn, showError } = options
  const mdChip = target.closest('.ref-chip-doc, .md-file-card') as HTMLElement | null
  if (!mdChip) return false

  const chipUrl = (mdChip as HTMLElement).dataset.url || ''
  const chipPath = (mdChip as HTMLElement).dataset.path || ''
  const chipSection = (mdChip as HTMLElement).dataset.section || undefined

  if (mdChip.classList.contains('src-chip')) {
    stopPropagation()
    const openKey = chipOpenKey(chipUrl, chipPath, chipSection)
    // The click is consumed either way — a second click while the first is
    // still running is the same intent, not a second document.
    if (!beginChipOpen(mdChip, openKey)) return true
    const title = mdChip.getAttribute('title') || mdChip.textContent || 'source'
    // Provenance chips are a shared-file chip plus a section focus. The path
    // opens as the live versioned document; a chip with no path opens nothing
    // and the failure goes to the error surface.
    void Promise.resolve()
      .then(() => {
        if (!chipPath) throw new Error('source chip has no path')
        return openMarkdownColumn(title, mdChip, { path: chipPath, section: chipSection })
      })
      .catch(err => {
        log.error('chat-chip', 'source chip failed to open; opening no document', {
          title, path: chipPath, url: chipUrl, section: chipSection,
          error: err instanceof Error ? err.message : String(err),
        })
        showError?.(CHIP_OPEN_FAILED)
      })
      .finally(() => endChipOpen(mdChip, openKey))
    return true
  }

  const isMd = /\.(?:md|markdown)(?:$|[?#])/i.test(chipUrl || chipPath)
  if (!isMd || !chipPath) return false

  stopPropagation()
  const openKey = chipOpenKey(chipUrl, chipPath)
  if (!beginChipOpen(mdChip, openKey)) return true
  const title = mdChip.querySelector('.md-file-chip')?.textContent || mdChip.textContent || chipPath.split('/').pop() || 'file'
  // Same rule as above: a failed resolve produces no document at all. A chip
  // whose path is not a live document of the open project cannot resolve from
  // the server, and fabricating a "Failed to load" document out of that made a
  // delivery failure look like a broken file.
  void Promise.resolve()
    .then(() => openMarkdownColumn(title, mdChip, { path: chipPath }))
    .catch(err => {
      log.error('chat-chip', 'file chip failed to open; opening no document', {
        title, path: chipPath, url: chipUrl,
        error: err instanceof Error ? err.message : String(err),
      })
      showError?.(CHIP_OPEN_FAILED)
    })
    .finally(() => endChipOpen(mdChip, openKey))
  return true
}
