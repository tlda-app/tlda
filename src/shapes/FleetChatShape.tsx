/**
 * FleetChatShape — tldraw canvas shape that renders fleet chat messages.
 *
 * Uses fleet-data.mjs (via adapter) for live SSE updates — no polling.
 * Renders with chat-render.mjs from the fleet dashboard.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapeId,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext, memo, useSyncExternalStore, forwardRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

// @ts-ignore — vanilla JS module
import { renderChatLine, resolveInlineAttachments, esc } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath, renderMarkdown as renderMarkdownUtil } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { initVoice, setVoiceTarget, clearVoiceTarget, resetTranscript, restartRecording, toggleRecording, sendCurrentText, isRecording } from '../voice.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanName, updateEventById, sendViewingContext, setViewingEnrichFn } from '../fleet/fleet-data.mjs'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'
import { useFleetAgents, useFleetEvents, useFleetTasks, useFleetThinking, useFleetCompacting, useFleetContext, useElizaPending, sendMessage, loadBefore, resolveFilter, injectOptimisticEvent, updateOptimisticEvent } from '../fleet-data-adapter'
import type { ElizaNudge } from '../fleet-data-adapter'
import { dropPillOnTarget, chatInsertBus, filterDropPreview, chipContentStore } from './FleetPillShape'
import { agentDisplayName } from './fleet-utils'
import { AgentName, PhaseIcon } from './PhaseIcon'
import { baseName, phaseFromName } from '../../shared/lineage-name.mjs'
import { dragCoordinator } from './dragCoordinator'
import { DocContext, PanelContext } from '../PanelContext'
import { loadLookup, type LookupData } from '../synctexLookup'
import { getSourceAnchor } from '../synctexAnchor'
import { log } from '../logger'
import { linkifyDocRefs, linkifyArrowRefs, linkifyAtRefs, linkifyLabelRefs, linkifyRefCommands, buildRefResolver, refToCanvas, type DocRef, type ResolvedRef, type LabelRegionInfo, type TheoremMapEntry } from '../docLinks'
import { fetchProofInfo, fetchTheoremMap } from '../docInfoCache'
import { PDF_HEIGHT } from '../layoutConstants'
import { TerminalCard } from './TerminalCard'
import { Terminal } from 'xterm'
import { useIsInViewport } from './useIsInViewport'
import { broadcastSharedDoc } from '../useYjsSync'
import { consumeBulletContexts, subscribeBulletContext, getBulletContexts } from '../stores/bulletContextStore'
import { getPref, subscribePref } from '../preferences'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600
const FLEET_API = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'

function getFleetStyleVars(): React.CSSProperties {
  return {
    '--fleet-base-font': `${getPref('fleet-font-size')}px`,
    '--fleet-chrome-alpha': String(getPref('fleet-chrome-opacity')),
    '--fleet-content-alpha': String(getPref('fleet-content-opacity')),
    '--fleet-age-fade': getPref('fleet-age-fade') ? '1' : '0',
  } as React.CSSProperties
}

function useFleetStyleVars() {
  const [vars, setVars] = useState(getFleetStyleVars)
  useEffect(() => subscribePref(() => setVars(getFleetStyleVars())), [])
  return vars
}

// ---- Terminal hover pane ----

const TERM_HOVER_WS_HOST = typeof window !== 'undefined'
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
  : 'ws://localhost:5176'

// Terminal peek overlay — shown when hovering the terminal icon on a chat shape.
// Fixed grid for the peek. MUST match the daemon's tmux-attach PTY size in
// fleet-daemon.mjs (rpcStartTerminalWatch spawns at cols:120, rows:40). The
// agent's TUI repaints at the PTY column count with absolute cursor moves, so
// the xterm grid has to be the same width or every frame garbles.
const PEEK_COLS = 120
const PEEK_ROWS = 40
// Lightbox height. When lightboxed the pane is bottom-anchored so it grows
// UPWARD from the (fixed) input bar instead of pushing the input off-screen.
const LIGHTBOX_H = 480

// Hover mode: read-only snapshot that resets on each server push.
// Pinned mode: stays open, shows input bar for sending commands, resizable.
function TerminalHoverPane({ agentId, pinned, onDismiss, onMouseEnter, onMouseLeave }: {
  agentId: string
  pinned: boolean
  onDismiss: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pinnedRef = useRef(pinned)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [height, setHeight] = useState(210)
  const [lightboxed, setLightboxed] = useState(false)
  const [scale, setScale] = useState(1)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => { pinnedRef.current = pinned }, [pinned])

  // Render at a FIXED grid that matches the daemon's tmux-attach PTY
  // (PEEK_COLS × PEEK_ROWS == fleet-daemon.mjs rpcStartTerminalWatch). The two
  // MUST agree: the agent's TUI repaints at the PTY's column count using
  // absolute cursor positioning, so a mismatched xterm grid garbles every
  // frame. We never reflow the grid to fit the popup — instead we scale the
  // rendered terminal visually (see the scale effect below).
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      cols: PEEK_COLS,
      rows: PEEK_ROWS,
      fontSize: 11,
      fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
      theme: {
        background: '#0d0d14',
        foreground: '#c8c8d8',
        cursor: '#c8c8d8',
        black: '#1e1e1e', brightBlack: '#555',
        red: '#f44747', brightRed: '#f44747',
        green: '#6a9955', brightGreen: '#6a9955',
        yellow: '#dcdcaa', brightYellow: '#dcdcaa',
        blue: '#569cd6', brightBlue: '#569cd6',
        magenta: '#c678dd', brightMagenta: '#c678dd',
        cyan: '#4ec9b0', brightCyan: '#4ec9b0',
        white: '#d4d4d4', brightWhite: '#ffffff',
      },
      scrollback: 200,
      cursorBlink: false,
      disableStdin: true,
    })
    term.open(containerRef.current)
    termRef.current = term
    return () => {
      term.dispose()
      termRef.current = null
    }
  }, [])

  // Scale the fixed-grid terminal to fit the pane width. Peek/pinned shrink it
  // to fit (no horizontal scroll); the lightbox renders it at natural size.
  useEffect(() => {
    let raf = 0
    const measure = () => {
      const inner = containerRef.current?.querySelector('.xterm') as HTMLElement | null
      const body = bodyRef.current
      if (!inner || !body) return
      const natW = inner.offsetWidth
      if (!natW) { raf = requestAnimationFrame(measure); return }
      setScale(lightboxed ? 1 : Math.min(1, body.clientWidth / natW))
    }
    raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => measure())
    if (bodyRef.current) ro.observe(bodyRef.current)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [lightboxed, height, status])

  // Leaving pinned mode also leaves the lightbox.
  useEffect(() => { if (!pinned) setLightboxed(false) }, [pinned])

  // On lightbox, scroll the body to the bottom so the live (cursor) region of
  // the terminal is what's visible, not the top of the screen.
  useEffect(() => {
    if (!lightboxed) return
    requestAnimationFrame(() => {
      const body = bodyRef.current
      if (body) body.scrollTop = body.scrollHeight
    })
  }, [lightboxed])

  useEffect(() => {
    if (!agentId) return
    wsRef.current?.close()
    setStatus('connecting')
    const ws = new WebSocket(`${TERM_HOVER_WS_HOST}/ws/terminal?agent=${encodeURIComponent(agentId)}`)
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('connected')
    }
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'output' && msg.data && termRef.current) {
          if (msg.encoding === 'base64') {
            const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0))
            termRef.current.write(bytes)
          } else {
            termRef.current.write(msg.data)
          }
        } else if (msg.type === 'error') {
          setStatus('error')
        }
      } catch {}
    }
    ws.onerror = () => setStatus('error')
    ws.onclose = () => {}
    return () => { ws.close() }
  }, [agentId])

  const sendInput = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  }

  const shortId = agentId.replace('fleet:', '')

  // Make this field the active voice target — dictation flows in, and saying
  // "send" runs the command in the terminal pane (mirrors the chat textarea's
  // setVoiceTarget wiring, but with a terminal-specific send).
  const registerVoice = (el: HTMLTextAreaElement) => {
    setVoiceTarget(el, [agentId], { [agentId]: shortId }, async (_targets: string[], text: string) => {
      sendInput(text + '\r')
      el.value = ''
    })
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    stopEventPropagation(e as any)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendInput((inputRef.current?.value ?? '') + '\r')
      if (inputRef.current) inputRef.current.value = ''
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      sendInput('\x03')
      if (inputRef.current) inputRef.current.value = ''
    } else if (e.key === 'd' && e.ctrlKey) {
      e.preventDefault()
      sendInput('\x04')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      sendInput('\t')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      sendInput('\x1b[A')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      sendInput('\x1b[B')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      sendInput('\x1b')
    }
  }

  const handleResizePointerDown = (e: React.PointerEvent) => {
    stopEventPropagation(e)
    dragRef.current = { startY: e.clientY, startH: height }
    dragCoordinator.claim(
      (ev) => {
        if (!dragRef.current) return
        const delta = ev.clientY - dragRef.current.startY
        setHeight(Math.max(100, dragRef.current.startH + delta))
      },
      () => { dragRef.current = null },
    )
  }

  return (
    <div
      className={`fleet-terminal-hover-pane${pinned ? ' fleet-terminal-hover-pane-pinned' : ''}${lightboxed ? ' fleet-terminal-hover-pane-lightboxed' : ''}`}
      style={lightboxed
        ? { top: 'auto', bottom: -height, height: LIGHTBOX_H }
        : { height }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={pinned ? undefined : onMouseLeave}
      onPointerDown={stopEventPropagation}
      onPointerMove={stopEventPropagation}
    >
      <div className="fleet-terminal-hover-header">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.5, flexShrink: 0 }}>
          <polyline points="2,2 5,5 8,2" />
          <line x1="2" y1="8" x2="8" y2="8" />
        </svg>
        <span className="fleet-terminal-hover-title">{shortId}</span>
        {status === 'connecting' && <span className="fleet-terminal-hover-status">connecting…</span>}
        {status === 'error' && <span className="fleet-terminal-hover-status error">error</span>}
        {pinned && (
          <button
            className="fleet-terminal-hover-close"
            title="Close terminal"
            onPointerDown={stopEventPropagation}
            onClick={(e) => { stopEventPropagation(e as any); onDismiss() }}
          >
            ×
          </button>
        )}
      </div>
      <div ref={bodyRef} className="fleet-terminal-hover-body">
        <div
          className="fleet-terminal-hover-scale"
          style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <div ref={containerRef} />
        </div>
      </div>
      {pinned && status === 'connected' && (
        <div className="fleet-terminal-hover-input-bar"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
        >
          <span className="fleet-terminal-hover-prompt">$</span>
          <textarea
            ref={inputRef}
            className="fleet-terminal-hover-input"
            rows={1}
            onKeyDown={handleInputKeyDown}
            onKeyUp={(e) => stopEventPropagation(e as any)}
            onPointerDown={(e) => { stopEventPropagation(e as any); setLightboxed(true); registerVoice(e.currentTarget) }}
            onFocus={(e) => { stopEventPropagation(e); setLightboxed(true); registerVoice(e.currentTarget) }}
            onBlur={(e) => { clearVoiceTarget(e.currentTarget); e.currentTarget.style.boxShadow = ''; setLightboxed(false) }}
            placeholder="type or speak a command…"
            spellCheck={false}
            autoComplete="off"
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px solid rgba(128, 128, 128, 0.15)',
              borderRadius: 4,
              padding: '3px 26px 3px 18px',
              fontSize: 11,
              color: 'inherit',
              outline: 'none',
              resize: 'none',
              lineHeight: 1.4,
              fontFamily: 'inherit',
              fieldSizing: 'content',
              maxHeight: 120,
              boxSizing: 'border-box',
            } as any}
          />
          <button
            className="fleet-terminal-hover-ctrl-c"
            title="Send Ctrl+C"
            onPointerDown={(e) => { stopEventPropagation(e as any); sendInput('\x03') }}
          >
            ^C
          </button>
        </div>
      )}
      {pinned && (
        <div
          className="fleet-terminal-hover-resize-handle"
          onPointerDown={handleResizePointerDown}
          title="Drag to resize"
        />
      )}
    </div>
  )
}

// Recursively read a FileSystemDirectoryEntry, returning { file, path } pairs
// where path is relative to the dropped folder root (e.g. "figures/foo.png")
async function traverseDirectory(entry: FileSystemEntry, prefix = ''): Promise<{ file: File, path: string }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej))
    return [{ file, path: prefix + entry.name }]
  }
  const dirEntry = entry as FileSystemDirectoryEntry
  const reader = dirEntry.createReader()
  const results: { file: File, path: string }[] = []
  let batch: FileSystemEntry[]
  do {
    batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
    for (const child of batch) {
      results.push(...await traverseDirectory(child, prefix + entry.name + '/'))
    }
  } while (batch.length > 0)
  return results
}

// Upload a markdown file, rewriting local image refs to stable URLs for any
// companion files present in the same drop event.
// companions: { file, path } pairs where path is relative to the drop root.
// mdRelPath: path of the md file itself relative to the drop root (for resolving relative image refs).
// warnOnUnresolved: if true and some image refs couldn't be matched, appends a hint to the returned link.
async function uploadMarkdownWithImages(
  mdFile: File,
  companions: { file: File, path: string }[],
  mdRelPath?: string,
  warnOnUnresolved?: boolean,
): Promise<string> {
  const text = await mdFile.text()
  // Find local image paths: ![alt](path) where path is not http
  const localPathRe = /!\[[^\]]*\]\(([^)]+)\)/g
  const localPaths = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = localPathRe.exec(text)) !== null) {
    if (!m[1].startsWith('http')) localPaths.add(m[1])
  }
  // Directory of the md file relative to the drop root (e.g. "report/" or "")
  const mdDir = mdRelPath ? mdRelPath.split('/').slice(0, -1).join('/') : ''
  // Upload companions that match a local path by relative path or basename fallback
  const urlMap = new Map<string, string>()
  for (const localPath of localPaths) {
    const ref = localPath.replace(/^\.\//, '')
    const resolvedPath = mdDir ? `${mdDir}/${ref}` : ref
    const base = ref.split('/').pop() || ref
    const match =
      companions.find(c => c.path === resolvedPath) ||
      companions.find(c => c.file.name === base)
    if (!match) continue
    try {
      const fd = new FormData()
      fd.append('file', match.file, match.file.name)
      const r = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: fd })
      if (!r.ok) continue
      const { url } = await r.json()
      urlMap.set(localPath, `${FLEET_API}${url}`)
    } catch {}
  }
  // Rewrite markdown and upload
  let rewritten = text
  for (const [orig, stable] of urlMap) {
    rewritten = rewritten.split(`](${orig})`).join(`](${stable})`)
  }
  const rewrittenFile = new File([new Blob([rewritten], { type: 'text/markdown' })], mdFile.name, { type: 'text/markdown' })
  const fd = new FormData()
  fd.append('file', rewrittenFile, rewrittenFile.name)
  const r = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error(`markdown upload failed: ${r.status}`)
  const { url, name } = await r.json()
  let link = `[${name}](${FLEET_API}${url})`
  if (warnOnUnresolved && localPaths.size > 0) {
    const hasUnresolved = [...localPaths].some(p => !urlMap.has(p))
    if (hasUnresolved) {
      link += '\n⚠️ Some images couldn\'t be uploaded — drag the containing folder instead of the file.'
    }
  }
  return link
}

// --- Voice + trackpad input (global, one-time init) ---
initVoice()



// --- Markdown renderer using markdown-it + KaTeX ---

// Thin wrapper: delegate to the canonical renderMarkdown in utils.mjs.
// Input may be esc()'d (from chat-render) or raw (from delegation cards).
// renderMarkdown expects esc()'d input and un-escapes internally.
function tldaRenderMarkdown(input: string, macros?: Record<string, string>): string {
  // If input looks raw (not escaped), escape it first so renderMarkdown
  // can un-escape and process normally.
  const looksEscaped = input.includes('&amp;') || input.includes('&lt;') || input.includes('&gt;')
  const escapedInput = looksEscaped ? input : esc(input)
  // Extract «...» chip tokens before KaTeX rendering — math inside tokens
  // (e.g. «highlight:text $x^2$#shape:ID») would otherwise be converted to
  // HTML spans, breaking the postProcess regex.
  const chipSlots: string[] = []
  const safeInput = escapedInput.replace(/«[^»]+»/g, (tok) => {
    chipSlots.push(tok)
    return `\x00CHIP${chipSlots.length - 1}\x00`
  })
  let rendered = renderMarkdownUtil(safeInput, macros)
  for (let i = 0; i < chipSlots.length; i++) {
    rendered = rendered.replace(`\x00CHIP${i}\x00`, chipSlots[i])
  }
  return rendered
}

// --- Viewer context helper ---

function gatherViewerContext(editor: any, doc: any, chatShapeId?: string, version?: string | null) {
  if (!editor || !doc) return null
  const mainEd = (window as any).__tldraw_editor__ || editor
  const camera = mainEd.getCamera()
  const viewport = mainEd.getViewportPageBounds()
  const visiblePages: number[] = []
  const viewportEdges: { page: number; topY: number; bottomY: number }[] = []
  if (doc.pages && viewport) {
    doc.pages.forEach((page: any, i: number) => {
      const b = page.bounds
      if (!b) return
      const bw = b.w ?? b.width ?? 0
      const bh = b.h ?? b.height ?? 0
      if (b.x + bw > viewport.minX && b.x < viewport.maxX &&
          b.y + bh > viewport.minY && b.y < viewport.maxY) {
        visiblePages.push(i + 1)
        const topY = Math.max(viewport.minY - b.y, 0)
        const bottomY = Math.min(viewport.maxY - b.y, bh)
        viewportEdges.push({ page: i + 1, topY, bottomY })
      }
    })
  }
  const compareRef = (window as any).__tlda_compare_ref__ || null
  const ctx = {
    doc: doc.docName || null,
    version: version || null,
    compareRef,
    page: visiblePages.length === 1 ? visiblePages[0] : visiblePages.length > 1 ? visiblePages : null,
    camera: { x: Math.round(camera.x), y: Math.round(camera.y), z: Math.round(camera.z * 100) / 100 },
    chatShapeId: chatShapeId || undefined,
    browser: /Chrome/.test(navigator.userAgent) ? 'chrome' : /Safari/.test(navigator.userAgent) ? 'safari' : /Firefox/.test(navigator.userAgent) ? 'firefox' : 'unknown',
    _viewportEdges: viewportEdges,
  }
  sendViewingContext(ctx)
  return ctx
}

async function enrichContextWithSourceLines(context: any): Promise<void> {
  const edges = context?._viewportEdges
  delete context?._viewportEdges
  if (!context?.doc || !edges?.length) return
  const first = edges[0]
  const last = edges[edges.length - 1]
  try {
    const [topAnchor, bottomAnchor] = await Promise.all([
      getSourceAnchor(context.doc, first.page, 300, first.topY),
      getSourceAnchor(context.doc, last.page, 300, last.bottomY),
    ])
    if (topAnchor) {
      context.sourceLine = {
        file: topAnchor.file,
        startLine: topAnchor.line,
        endLine: bottomAnchor?.line || topAnchor.line,
        endFile: bottomAnchor?.file,
      }
    }
  } catch {}
  delete context._viewportEdges
}

setViewingEnrichFn(async (ctx: any) => {
  await enrichContextWithSourceLines(ctx)
  return ctx
})

/**
 * Resolve the document version the user is currently viewing. Prefer the
 * shadow-repo version since that's what the MCP build pipeline considers
 * authoritative. If the user has scrubbed the shadow slider, use the active
 * snapshot; otherwise use the latest. Falls back to historyEntries for git
 * commits if no shadow data is available. Returns a short hash that travels
 * well in chat metadata.
 */
function currentDocVersion(panel: any): string | null {
  // If user has scrubbed to a historical version, stamp that version's hash
  const sav = panel?.shadowActiveVersion
  if (sav?.hash) return String(sav.hash).slice(0, 7)
  const entries = panel?.historyEntries
  if (entries && entries.length > 0) {
    const idx = (typeof panel.activeHistoryIdx === 'number' && panel.activeHistoryIdx >= 0)
      ? panel.activeHistoryIdx
      : entries.length - 1  // entries are oldest-first; -1/default = current = newest
    // Prefer the scrubbed entry if it has a real git hash; otherwise find most recent git entry
    const scrubbed = entries[idx]
    if (scrubbed?.commitHash) return String(scrubbed.commitHash).slice(0, 7)
    // Fall back to most recent entry that has a real commitHash (skip build-type entries)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.commitHash) return String(entries[i].commitHash).slice(0, 7)
    }
  }
  return null
}

/**
 * Scan message text for «highlight:...#shape:ID» and «annotation:...#shape:ID» tokens,
 * look up each shape in the editor, and return an attachments array for sendMessage().
 * The receiving side (fleet.mjs resolveChipTokens) looks up attachments by token to
 * expand them into formatted source-line references for agents.
 */
function buildRefAttachments(text: string, _editor: any): Array<{
  token: string; type: string; label: string;
  color?: string; file?: string; sourceLines?: any[]; content?: string
}> {
  if (!text || !text.includes('«')) return []
  const chipPattern = /«(.+?)»/g
  const attachments = []
  for (const match of text.matchAll(chipPattern)) {
    const inner = match[1]
    const colonIdx = inner.indexOf(':')
    if (colonIdx < 0) continue
    const type = inner.slice(0, colonIdx)
    if (type !== 'highlight' && type !== 'annotation') continue

    const token = match[0]
    const hashIdx = inner.lastIndexOf('#')
    if (hashIdx < 0) continue
    const shapeRef = inner.slice(hashIdx + 1)  // e.g. "shape:V2nwXJKv2uYjzQia8ll1E"
    const label = inner.slice(colonIdx + 1, hashIdx)

    const mainEditor = (window as any).__tldraw_editor__
    if (!mainEditor) continue
    const shape = mainEditor.getShape(shapeRef as any)
    if (!shape) continue
    const meta = shape.meta as any

    // sourceLines: [{line, content, file, highlighted, hlStart?, hlEnd?}]
    // hlStart/hlEnd are character offsets within the line for precise column ranges.
    const sourceLines: any[] = meta?.sourceLines || []
    const highlighted = sourceLines.filter((sl: any) => sl.highlighted === true)
    const firstLine = highlighted.length > 0 ? highlighted[0] : sourceLines[0]

    const attachment: any = {
      token,
      type,
      label,
      color: meta?.glowColor,
      file: firstLine?.file,
      sourceLines,
      content: meta?.highlightText || label,
    }
    // Include screenshot for unresolved highlights
    if (meta?.unresolved && meta?.screenshotDataUrl) {
      attachment.screenshotDataUrl = meta.screenshotDataUrl
      attachment.unresolved = true
    }
    attachments.push(attachment)
  }
  return attachments
}

// --- Shape definition ---

export class FleetChatShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-chat' as const
  static override props = {
    w: T.number,
    h: T.number,
    filter: T.arrayOf(T.arrayOf(T.arrayOf(T.string))),  // DNF of [role, label] tuples
    userId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: [], userId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <FleetChatComponent shape={shape} />
  }

  indicator() {
    return null
  }
}

// --- Elapsed time display (isolated to avoid re-rendering entire chat) ---
function ElapsedTime({ startMs }: { startMs: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const secs = Math.floor((Date.now() - startMs) / 1000)
  const str = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`
  return <span className="thinking-elapsed">({str})</span>
}

function ContextBadge({ percent }: { percent?: number }) {
  if (percent == null) return null
  const color = percent <= 15 ? '#e57373' : percent <= 30 ? '#ffb74d' : '#81c784'
  return (
    <span style={{ fontSize: 10, color, opacity: 0.8, flexShrink: 0, marginLeft: 8 }}>
      {percent}%
    </span>
  )
}

/**
 * ThinkingStatus — one status line per agent (thinking / compacting).
 * When all agents stop, the space persists (ghost) until a new chat item
 * arrives to fill it. Ghost detection uses useEffect — not during-render
 * ref mutation — so the transition is never missed across render batches.
 */
function ThinkingStatus({ thinkingAgents, compactingAgents, contextPercent, hibernatingAgents, ctx, lastItemKey, agents: _agents, escalationState }: {
  thinkingAgents: Map<string, number>
  compactingAgents: Map<string, number>
  contextPercent: Map<string, number>
  hibernatingAgents: Set<string>
  ctx: any
  lastItemKey: string | null
  agents: any[]
  escalationState?: Record<string, { level: number; confirmed: number }>
}) {
  // Build status display from server-authoritative agent status field.
  // thinkingAgents/compactingAgents are pre-filtered to chat targets and provide elapsed timestamps.
  // hibernatingAgents is pre-filtered to chat targets.
  const statusAgents = useMemo(() => {
    const merged = new Map<string, { status: 'thinking' | 'compacting' | 'hibernating', startTs: number }>()
    for (const [id, ts] of thinkingAgents) {
      merged.set(id, { status: 'thinking', startTs: ts })
    }
    for (const [id, ts] of compactingAgents) {
      if (!merged.has(id)) merged.set(id, { status: 'compacting', startTs: ts })
    }
    for (const id of hibernatingAgents) {
      if (!merged.has(id)) merged.set(id, { status: 'hibernating', startTs: 0 })
    }
    return merged
  }, [thinkingAgents, compactingAgents, hibernatingAgents])

  const hasActive = statusAgents.size > 0
  const lastStatusRef = useRef(statusAgents)
  if (hasActive) lastStatusRef.current = statusAgents

  const [ghost, setGhost] = useState(false)
  // Bottom-row key captured when the slot is reserved; the slot is "absorbed"
  // (released) only when a genuinely new row lands at the bottom.
  const ghostKeyRef = useRef<string | null>(null)
  // Bottom-row key as of the previous render — lets the reserve check tell
  // whether a new message landed in the same tick the agent went inactive.
  const prevKeyRef = useRef<string | null>(lastItemKey)

  // Reserve the slot when the agent goes inactive — in a LAYOUT effect so the
  // footer never paints a collapsed frame (which itself read as a bounce). Skip
  // reserving if a new bottom row landed this same tick: that row already
  // absorbed the space, so reserving would leave a leftover gap.
  useLayoutEffect(() => {
    const bottomJustChanged = lastItemKey !== prevKeyRef.current
    if (!hasActive && lastStatusRef.current.size > 0 && !ghost && !bottomJustChanged) {
      setGhost(true)
      ghostKeyRef.current = lastItemKey
    }
    if (hasActive && ghost) {
      setGhost(false)
    }
  // lastItemKey intentionally omitted — this fires only on the hasActive
  // transition; prevKeyRef carries the previous render's bottom key.
  }, [hasActive]) // eslint-disable-line react-hooks/exhaustive-deps -- intentional: transition-only detection

  // Release the slot only when a NEW row lands at the bottom (its key changes) —
  // NOT on raw item-count churn (dividers, activity grouping, other agents'
  // activity), which collapsed the slot with nothing to fill it.
  useEffect(() => {
    if (ghost && lastItemKey !== ghostKeyRef.current) {
      setGhost(false)
    }
  }, [ghost, lastItemKey])

  // Track the bottom key every render (after the reserve check above reads the
  // previous value) so the same-tick-absorb detection works.
  useLayoutEffect(() => { prevKeyRef.current = lastItemKey })

  if (!hasActive && !ghost) return null

  return (
    <div style={{
      padding: '0 8px',
      fontSize: 11,
      flexShrink: 0,
      opacity: ghost ? 0 : 0.6,
      transition: 'opacity 0.2s',
    }}>
      {[...(hasActive ? statusAgents : lastStatusRef.current).entries()].map(([agentId, { status, startTs }]) => {
        const esc = escalationState?.[agentId]
        const escLevel = esc?.level || 0
        const escConfirmed = esc?.confirmed || 0
        function tierOpacity(tier: number) {
          if (escLevel < tier) return 0.15
          if (escConfirmed >= tier) return 1
          return 0.55
        }
        const statusText = status === 'hibernating' ? 'is hibernating'
          : status === 'compacting' ? 'compacting…'
          : 'thinking…'
        return (
          <div key={agentId} className="chat-line chat-thinking" style={{ padding: '2px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>
              <span className="thinking-text">
                <PhaseIcon phase={phaseFromName(ctx.agentFullName(agentId))} />{baseName(ctx.agentFullName(agentId)).replace('fleet:', '')}
              </span>
              {' '}<span className="thinking-text">{statusText}</span>
              {status !== 'hibernating' && <>{' '}<ElapsedTime startMs={startTs} /></>}
              {escLevel > 0 && (
                <span className="escalation-meter" style={{ marginLeft: 6, letterSpacing: 2, fontSize: '0.9em' }}>
                  <span style={{ opacity: tierOpacity(1), transition: 'opacity 0.15s' }}>↑</span>
                  <span style={{ opacity: tierOpacity(2), transition: 'opacity 0.15s' }}>⏸</span>
                  <span style={{ opacity: tierOpacity(3), transition: 'opacity 0.15s' }}>💀</span>
                </span>
              )}
            </span>
            <ContextBadge percent={contextPercent.get(agentId)} />
          </div>
        )
      })}
    </div>
  )
}

function ElizaSuggestion({ nudge, isFirst, agentName }: { nudge: ElizaNudge, isFirst: boolean, agentName: string }) {
  // Release nudges fire via "eliza <label>"; action suggestions (hand off / get qa)
  // carry an explicit command. Either way, sending it as a real message keeps a
  // visible record of what fired and reuses eliza's existing routing.
  const command = nudge.command || `eliza ${nudge.label}`
  const canSayIt = isFirst && nudge.kind !== 'action'
  const fire = (e: React.SyntheticEvent) => {
    stopEventPropagation(e as any)
    sendMessage(nudge.targetId, command)
  }
  return (
    <span
      className="eliza-suggestion"
      onPointerDown={stopEventPropagation}
      onClick={fire}
    >
      <span className="eliza-suggestion-label">{nudge.label}</span>
      <span className="eliza-suggestion-tip" onPointerDown={stopEventPropagation}>
        <span className="eliza-tip-trigger">
          Say <b>"{command}"</b>{canSayIt ? <> or <b>"say it"</b></> : null} — or click to send now
        </span>
        <span className="eliza-tip-target">→ {agentName}</span>
        <span className="eliza-tip-text">{nudge.text}</span>
      </span>
    </span>
  )
}

function ElizaStatus({ pending, ctx, rawItemsLength }: { pending: ElizaNudge[], ctx: any, rawItemsLength: number }) {
  const hasActive = pending.length > 0
  const lastPendingRef = useRef(pending)
  if (hasActive) lastPendingRef.current = pending

  const [ghost, setGhost] = useState(false)
  const ghostRawItemsRef = useRef(rawItemsLength)

  useEffect(() => {
    if (!hasActive && lastPendingRef.current.length > 0 && !ghost) {
      setGhost(true)
      ghostRawItemsRef.current = rawItemsLength
    }
    if (hasActive && ghost) setGhost(false)
  }, [hasActive]) // eslint-disable-line react-hooks/exhaustive-deps -- intentional: transition-only detection

  useEffect(() => {
    if (ghost && rawItemsLength > ghostRawItemsRef.current) setGhost(false)
  }, [ghost, rawItemsLength])

  if (!hasActive && !ghost) return null

  return (
    <div style={{
      padding: '2px 8px',
      fontSize: 11,
      flexShrink: 0,
      opacity: ghost ? 0 : 1,
      transition: 'opacity 0.2s',
    }}
    className="eliza-status"
    >
      {!ghost && (
        <div className="chat-line" style={{ padding: '2px 0' }}>
          <span className="eliza-status-prefix">eliza:</span>{' '}
          {pending.map((n, i) => (
            <span key={n.id}>
              {i > 0 ? <span className="eliza-suggestion-label">, </span> : null}
              <ElizaSuggestion nudge={n} isFirst={i === 0} agentName={ctx.agentLabel(n.targetId)} />
            </span>
          ))}
        </div>
      )}
      {ghost && <div style={{ padding: '2px 0', visibility: 'hidden' }}>placeholder</div>}
    </div>
  )
}

// --- Nick color system (matches dashboard) ---

const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickHex = ['#7a9ec8','#9370db','#c8956a','#6aafb0','#b87a95','#c8b060']
const nickMap = new Map<string, string>()
const nickHexMap = new Map<string, string>()
let nickIdx = 0

function makeCtx(agents: any[], tasks: any[], preambleMacros: Record<string, string>) {
  const agentLabel = (id: string) => {
    if (!id) return '[unknown]'
    const a = agents.find((a: any) => a.id === id)
    if (a) return agentDisplayName(a)
    return typeof id === 'string' ? id : String(id)
  }
  const getNickClass = (id: string) => {
    if (!id) return 'nick-agent-0'
    const a = agents.find((a: any) => a.id === id)
    if (a?.human) return 'nick-human'
    if (id === 'keepalive') return 'nick-keepalive'
    if (!nickMap.has(id)) {
      const idx = nickIdx % nickColors.length
      nickMap.set(id, nickColors[idx])
      nickHexMap.set(id, nickHex[idx])
      nickIdx++
    }
    return nickMap.get(id)!
  }
  const getAgentColor = (id: string) => nickHexMap.get(id) || '#9370db'
  // Full friendly name (e.g. "conc5:day") — keeps the phase suffix so AgentName
  // can render the dawn/day/dusk glyph. agentLabel strips it; use this where the
  // lineage lift should show.
  const agentFullName = (id: string) => {
    if (!id) return ''
    const a = agents.find((a: any) => a.id === id)
    return a?.friendly_name || (typeof id === 'string' ? id : String(id))
  }
  return {
    agentLabel,
    agentFullName,
    getNickClass,
    getAgentColor,
    isHumanId: (id: string) => {
      const a = agents.find((a: any) => a.id === id)
      return !!(a?.human)
    },
    getAgents: () => agents,
    getTasks: () => tasks,
    tldaToken: null as string | null,
    renderMarkdown: (input: string) => tldaRenderMarkdown(input, preambleMacros),
    highlightSyntax,
    langFromFilePath,
    preambleMacros,
  }
}


// Apply a text transform only to non-code regions of HTML.
// Iterates alternating tag and text segments; tracks <code>/<pre> nesting depth
// so that transforms are never applied to content inside code spans or blocks.
function transformNonCode(html: string, transform: (text: string) => string): string {
  let inCode = 0
  return html.replace(/((?:<[^>]*>)|(?:[^<]+))/g, (segment) => {
    if (segment.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(segment)) inCode++
      else if (/^<\/(code|pre)>/i.test(segment)) inCode = Math.max(0, inCode - 1)
      return segment
    }
    return inCode > 0 ? segment : transform(segment)
  })
}

// --- Virtual chat message row ---
// Defined outside FleetChatInner so React.memo comparisons are stable.
// Receives raw rendered HTML from renderChatLine/renderActivityGroup and a
// postProcess function (useCallback-stable) for chip/link resolution.
const ChatMessageRow = memo(function ChatMessageRow({
  html,
  postProcess,
  itemKey,
  expandedRowsRef,
}: {
  html: string
  postProcess: (html: string) => string
  itemKey: string
  expandedRowsRef: React.RefObject<Set<string>>
}) {
  const processed = useMemo(() => postProcess(html), [html, postProcess])
  const divRef = useRef<HTMLDivElement>(null)

  // Restore expand state after dangerouslySetInnerHTML replaces the DOM.
  useLayoutEffect(() => {
    const el = divRef.current
    if (!el) return
    const expanded = expandedRowsRef.current
    if (expanded.has(itemKey)) {
      const moreRows = el.querySelector('.pretty-more-rows') as HTMLElement | null
      if (moreRows) {
        moreRows.style.display = ''
        const btn = el.querySelector('.pretty-expand-btn') as HTMLElement | null
        if (btn) btn.textContent = 'collapse'
      }
    }
    // Restore code-block expand state (each block keyed by index within the row)
    el.querySelectorAll('.code-block-wrap').forEach((wrap, i) => {
      if (expanded.has(`${itemKey}:code:${i}`)) {
        const pre = wrap.querySelector('pre')
        if (pre) pre.classList.remove('code-collapsed')
        const toggle = wrap.querySelector('.code-block-toggle') as HTMLElement | null
        if (toggle) toggle.textContent = 'collapse'
      }
    })
  }, [processed, itemKey, expandedRowsRef])

  return <div ref={divRef} data-item-key={itemKey} dangerouslySetInnerHTML={{ __html: processed }} />
}, (prev, next) => prev.html === next.html && prev.postProcess === next.postProcess && prev.itemKey === next.itemKey)


function FleetChatInner({ shape }: { shape: any }) {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const panel = useContext(PanelContext)
  const fleetStyleVars = useFleetStyleVars()
  const { w, h, filter } = shape.props as { w: number; h: number; filter: [string, string][][] }
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)

  // Keep a ref to the current filter so the rename effect can read it without a stale closure
  const filterRef = useRef(filter)
  filterRef.current = filter

  // Track previous agent friendly names to detect renames (populated after agents is declared below)
  const prevAgentNamesRef = useRef<Record<string, string>>({})

  const activeBullets = useSyncExternalStore(subscribeBulletContext, getBulletContexts)

  // DNF filter: [[[role,label],...],...]  — OR of AND-groups of [role, label] tuples
  const dnfFilter = filter.length > 0 ? filter : null

  // Load lookup data for doc reference resolution
  const [lookup, setLookup] = useState<LookupData | null>(null)
  const [labelRegions, setLabelRegions] = useState<Record<string, LabelRegionInfo>>({})
  const [theoremMap, setTheoremMap] = useState<Record<string, TheoremMapEntry>>({})
  useEffect(() => {
    if (!doc?.docName) return
    loadLookup(doc.docName).then(setLookup)
    fetchProofInfo(doc.docName).then(data => {
      if (data?.labelRegions) setLabelRegions(data.labelRegions)
    })
    fetchTheoremMap(doc.docName).then(data => {
      if (data) setTheoremMap(data)
    })
  }, [doc?.docName])

  const refResolver = useMemo(() => lookup ? buildRefResolver(lookup, theoremMap) : null, [lookup, theoremMap])

  // Live data from fleet-data.mjs via SSE (or playback data if inside a PlaybackFrame)
  const frameId = shape.parentId as string | undefined
  const agents = useFleetAgents(frameId)
  const liveEvents = useFleetEvents(dnfFilter, frameId)
  const tasks = useFleetTasks(frameId)
  const thinkingAgents = useFleetThinking(dnfFilter, frameId)
  const compactingAgents = useFleetCompacting(dnfFilter, frameId)
  const contextPercent = useFleetContext(dnfFilter, frameId)
  const elizaPendingAll = useElizaPending()

  // When an agent renames itself, auto-update any filter terms that used the old name.
  useEffect(() => {
    const prev = prevAgentNamesRef.current
    const curr: Record<string, string> = {}
    for (const a of agents) {
      if (a.id && a.friendly_name) curr[a.id] = a.friendly_name
    }
    const currentFilter = filterRef.current
    let newFilter = currentFilter
    let changed = false
    for (const [id, oldName] of Object.entries(prev)) {
      const newName = curr[id]
      if (!newName || oldName === newName) continue
      const hasOldName = newFilter.some(clause => clause.some(([, label]) => label === oldName))
      if (!hasOldName) continue
      newFilter = newFilter.map(clause =>
        clause.map(([role, label]) => [role, label === oldName ? newName : label] as [string, string])
      )
      changed = true
    }
    prevAgentNamesRef.current = curr
    if (changed) {
      editor.updateShape({ id: shape.id, type: 'fleet-chat' as any, props: { filter: newFilter } })
    }
  }, [agents])

  // Terminal card — hover to show, click to pin. Replaces the old auto-open set.
  const [termCardHoverId, setTermCardHoverId] = useState<string | null>(null)
  const [termCardPinnedId, setTermCardPinnedId] = useState<string | null>(null)
  const termCardHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismissTermCard = useCallback((agentId: string) => {
    // Mark terminal events from this agent as read when dismissed.
    const unreadEventIds = liveEvents
      .filter((e: any) =>
        (e._evType === 'terminal_card' || e._evType === 'terminal_attention') &&
        e.from === agentId &&
        e.read !== true && (e._dbId || e.id)
      )
      .map((e: any) => e._dbId || e.id)
    for (const eid of unreadEventIds) {
      fetch(`${FLEET_API}/api/mark-event-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: eid, agent: getHumanId() }),
      }).catch(e => console.warn('[fleet-chat] mark-read failed:', e.message))
    }
    setTermCardPinnedId(null)
    setTermCardHoverId(null)
  }, [liveEvents])

  // Input history (up/down arrow navigation like terminal)
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  // Esc interrupt: track last Esc timestamp for soft/hard distinction
  const escCountRef = useRef<number>(0)
  // Track whether the user last clicked inside this fleet chat shape.
  // Voice/touch users don't focus the textarea, so activeElement-based checks fail.
  const chatActiveRef = useRef(false)
  // Keep sendTargets accessible from native event listener without re-registering
  const sendTargetsRef = useRef<string[]>([])
  // Per-agent escalation state: tracks Esc presses for thinking indicator display.
  // { [agentId]: { level, confirmed } } — level = optimistic (on keypress), confirmed = server ack'd
  const [escalationState, setEscalationState] = useState<Record<string, { level: number; confirmed: number }>>({})

  // Clear escalation state when an agent stops thinking
  useEffect(() => {
    setEscalationState(prev => {
      let changed = false
      const next = { ...prev }
      for (const agentId of Object.keys(next)) {
        if (!thinkingAgents.has(agentId) && !compactingAgents.has(agentId)) {
          delete next[agentId]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [thinkingAgents, compactingAgents])
  const setEscLevel = (agentId: string, level: number) => {
    setEscalationState(prev => ({ ...prev, [agentId]: { level, confirmed: prev[agentId]?.confirmed || 0 } }))
  }
  const confirmEscLevel = (agentId: string, level: number) => {
    setEscalationState(prev => {
      const cur = prev[agentId]
      if (!cur) return prev
      return { ...prev, [agentId]: { ...cur, confirmed: Math.max(cur.confirmed, level) } }
    })
  }
  const clearEscState = (agentId: string) => {
    setEscalationState(prev => { const next = { ...prev }; delete next[agentId]; return next })
  }

  // Escape un-queues messages: messages sent before this timestamp are above the divider
  const [unqueuedAt, setUnqueuedAt] = useState(0)

  // One buffer: liveEvents IS the full id-keyed store view (live + backfilled
  // history, deduped by id in fleet-data). No live/older merge here — that merge
  // seam was what rendered a slipped event twice. Scrollback is folded into the
  // same store by loadBefore(), so it just appears in this list.
  const events = liveEvents

  // Reset scroll state when filter changes (history for the new filter is folded
  // into the store by the backfill effect below).
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    isAtBottomRef.current = true
    setAtBottom(true)
  }, [filterKey])

  // Resolve a friendly name/label to fleet IDs for DB queries. Uses the shared
  // labelsForAgent so send-targeting matches the live/history filters — incl.
  // pseudo-labels (awake/hibernating/human), bare lineage names, and
  // `lineage:phase` tags (all subsumed by the label set).
  const resolveToFleetIds = useCallback((label: string): string[] => {
    if (label.startsWith('fleet:')) return [label]
    const matched = agents.filter((a: any) => labelsForAgent(a).includes(label))
    return matched.length > 0 ? matched.map((a: any) => a.id) : [label]
  }, [agents])

  const resolveToFleetId = useCallback((label: string): string => {
    if (label.startsWith('fleet:')) return label
    return resolveToFleetIds(label)[0] || label
  }, [resolveToFleetIds])

  const hibernatingAgents = useMemo(() => {
    const targetIds = new Set<string>()
    if (dnfFilter && dnfFilter.length > 0) {
      for (const andGroup of dnfFilter) {
        for (const [, label] of andGroup) {
          for (const id of resolveToFleetIds(label)) targetIds.add(id)
        }
      }
    }
    const result = new Set<string>()
    for (const a of agents) {
      if (a.status === 'hibernating' && (!dnfFilter || targetIds.has(a.id))) {
        result.add(a.id)
      }
    }
    return result
  }, [agents, dnfFilter, resolveToFleetIds])

  const elizaPending = useMemo(() => {
    let filtered = elizaPendingAll
    if (dnfFilter && dnfFilter.length > 0) {
      const targetIds = new Set<string>()
      for (const andGroup of dnfFilter) {
        for (const [, label] of andGroup) {
          for (const id of resolveToFleetIds(label)) targetIds.add(id)
        }
      }
      filtered = filtered.filter(n => targetIds.has(n.targetId))
    }
    const seen = new Set<string>()
    return filtered.filter(n => {
      // Key on target too: the same label (e.g. "hand off") can be pending for
      // multiple agents at once, and each must stay clickable against its own target.
      const key = `${n.targetId}::${n.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [elizaPendingAll, dnfFilter, resolveToFleetIds])

  // Fetch per-agent history on mount / filter change.
  // The global event buffer (MAX_EVENTS=150) is shared across all agents.
  // A quiet agent's messages may not be in the buffer at all, making the
  // chat appear empty. Fix: always fetch agent-specific history from the DB.
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)

  // Resolve the filter to its fleet-id set ONCE per (filter, agents) change, as a
  // stable sorted string. The backfill effect below depends on THIS string, not
  // the churning `agents` array — so it only re-fires when the resolved id-set
  // actually changes, not on every agent heartbeat (the 6-panels × 600-agents
  // re-fire that was pegging the browser at 112% CPU).
  const resolvedFilterIdKey = useMemo(() => {
    if (!dnfFilter || dnfFilter.length === 0) return ''
    return [...resolveFilter(dnfFilter)].sort().join(',')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on filterKey (the stable string form of dnfFilter) not dnfFilter (new array identity each render); resolveFilter is a stable module import
  }, [filterKey, agents])

  const historyLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!dnfFilter || dnfFilter.length === 0) return
    if (!resolvedFilterIdKey) {
      // Filter set but resolved to nothing. Once agents are loaded this is a
      // genuine no-match; surface it (no silent fallback). Before agents load the
      // memo re-runs and this effect re-fires when the id-set appears.
      if (agents.length > 0) {
        log.warn('chat', 'filter resolved to no fleet ids; no history will load', { filter: dnfFilter })
      }
      return
    }
    const ids = resolvedFilterIdKey.split(',')
    const loadKey = `${filterKey}:${resolvedFilterIdKey}`
    if (historyLoadedRef.current === loadKey) return
    historyLoadedRef.current = loadKey
    // loadBefore folds the scrollback into the single store (deduping by id) and
    // returns the count of genuinely-new rows. No local olderEvents list — the
    // history just appears in `events` via the store view.
    loadBefore(ids, new Date().toISOString(), 200).then((added: number) => {
      if (added <= 0) return
      isAtBottomRef.current = true
      setAtBottom(true)
      // The history lands as an async PREPEND into the store; Virtuoso's
      // followOutput only follows bottom appends, and initialTopMostItemIndex
      // applied at first mount (while data was empty). So without this the list
      // stays parked at the top and a freshly-filtered view renders blank until a
      // live event arrives. Scroll to the end once the prepend has committed.
      requestAnimationFrame(() => {
        try { virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' }) }
        catch (e) { log.debug('chat', 'post-backfill scrollToIndex skipped (virtuoso not mounted)', { e: String(e) }) }
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedFilterIdKey, filterKey])


  const chatLogRef = useRef<HTMLDivElement>(null)
  // chatLogEl tracks the scroller element in state so effects can attach
  // listeners as soon as Virtuoso mounts its scroll container.
  const [chatLogEl, setChatLogEl] = useState<HTMLDivElement | null>(null)

  // Stable Scroller component for Virtuoso. Owns the .fleet-chat-log class
  // (so CanvasClipPanel's wheel reroute keeps targeting it) and captures the
  // element into chatLogRef / chatLogEl. Event listeners are attached in
  // separate effects keyed off chatLogEl — keeps this component free of
  // changing callback closures.
  const ChatLogScroller = useMemo(
    () => forwardRef<HTMLDivElement, any>(function ChatLogScroller(props, ref) {
      return (
        <div
          {...props}
          ref={(el: HTMLDivElement | null) => {
            if (typeof ref === 'function') ref(el)
            else if (ref) (ref as any).current = el
            chatLogRef.current = el
            setChatLogEl(el)
          }}
          className="fleet-chat-log"
          style={{ ...props.style, padding: '4px 0' }}
        />
      )
    }),
    [],
  )
  const inputRef = useRef<HTMLInputElement>(null)

  // Reactive map of image asset ID → src URL (populated from tldraw store).
  // Image chips use tldraw asset IDs for persistence — assets survive page reload.
  const [imageSrcs, setImageSrcs] = useState<Map<string, string>>(() => {
    const map = new Map<string, string>()
    for (const record of editor.store.allRecords()) {
      const r = record as any
      if (r.typeName === 'asset' && r.type === 'image' && r.props?.src) {
        map.set(r.id, r.props.src)
      }
    }
    return map
  })
  useEffect(() => {
    return editor.store.listen(({ changes }) => {
      const added = Object.values(changes.added).filter((r: any) => r.typeName === 'asset' && r.type === 'image')
      if (!added.length) return
      setImageSrcs(prev => {
        const next = new Map(prev)
        for (const r of added) {
          const a = r as any
          if (a.props?.src) next.set(a.id, a.props.src)
        }
        return next
      })
    }, { source: 'all', scope: 'document' })
  }, [editor])

  // Preamble macros — fetched once per doc from /api/projects/:name/macros
  const [preambleMacros, setPreambleMacros] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!doc?.docName) return
    fetch(`/api/projects/${doc.docName}/macros`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.macros) setPreambleMacros(data.macros) })
      .catch(e => console.warn('[fleet-chat] macros fetch failed:', e.message))
  }, [doc?.docName])

  // Build context and render messages
  const ctx = useMemo(() => makeCtx(agents, tasks, preambleMacros), [agents, tasks, preambleMacros])
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const labelRegionsRef = useRef<Record<string, LabelRegionInfo>>({})
  const docRef = useRef<typeof doc>(doc)
  useEffect(() => { labelRegionsRef.current = labelRegions }, [labelRegions])
  useEffect(() => { docRef.current = doc }, [doc])

  // Incremental render cache: non-activity messages are independent and can be
  // cached by (msgKey, ctxVersion). When ctx changes (agent rename, task done),
  // bump ctxVersion to invalidate stale lines. This turns O(N) re-render on
  // every new message into O(1) for the common case of appending one message.
  const msgLineCache = useRef<Map<string, string>>(new Map())
  const ctxVersionRef = useRef(0)
  const prevCtxRef = useRef(ctx)
  if (prevCtxRef.current !== ctx) {
    prevCtxRef.current = ctx
    ctxVersionRef.current++
    msgLineCache.current.clear()
  }

  const chatMessages = useMemo(() => {
    const sorted = events
      .filter((m: any) => {
        const t = m.type
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity' || t === 'kill-session' || t === 'interrupt' || t === 'terminal_attention' || t === 'terminal_card' || t === 'plan_approval'
      })
      .filter((m: any) => !m._timer) // skip timer-fired messages
      .sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })

    return sorted
  }, [events])

  // Amend events (type 'amend', metadata.amends = original id) are folded into
  // their original message as version history — they never render standalone
  // (chatMessages excludes type 'amend'). Grouped here off the full events list.
  const amendsByOrig = useMemo(() => {
    const map = new Map<number, any[]>()
    for (const e of events as any[]) {
      if (e.type !== 'amend') continue
      const orig = e.metadata?.amends
      if (orig == null) continue
      if (!map.has(orig)) map.set(orig, [])
      map.get(orig)!.push(e)
    }
    for (const list of map.values()) list.sort((a, b) => (a._dbId || 0) - (b._dbId || 0))
    return map
  }, [events])
  // Which version index the user is viewing, per original message id (default:
  // latest). The ◀▶ stepper arrows step through.
  const [amendView, setAmendView] = useState<Map<number, number>>(new Map())


  // Build per-item raw HTML array — each item is an independent renderable unit.
  // This replaces the old joined renderedHtml string and enables virtualization.
  // Items tagged _queued render below the thinking indicator; _interrupt items
  // render between the indicator and the queue (they "jump the line").
  type RawItem = { key: string; html: string; _queued?: boolean; _interrupt?: boolean; _divider?: boolean }
  // Short hash of the version currently shown in the viewer (accounts for
  // scrubbing to a historical version). Build cards compare against this to
  // style themselves green (you're viewing this build) vs gray (stale).
  const viewingVersion = currentDocVersion(panel)
  const rawItems = useMemo(() => {
    // Extend ctx with thinking state so renderChatLine can apply queued styling
    const renderCtx = { ...ctx, thinkingAgents }
    const items: RawItem[] = []
    let activityGroup: any[] = []
    function flushActivity() {
      if (activityGroup.length === 0) return
      const a0: any = activityGroup[0]
      const aid = a0._dbId != null ? `db${a0._dbId}` : a0._tempId ? `tmp${a0._tempId}` : `${a0.from}:${a0.timestamp}`
      const key = `activity:${aid}`
      items.push({
        key,
        html: `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, renderCtx)}</div>`,
      })
      activityGroup = []
    }

    // Helper: is this message queued behind a thinking agent?
    function isMessageQueued(m: any): boolean {
      const isFromUser = renderCtx.isHumanId?.(m.from)
      if (!isFromUser) return false
      const targetThinkingSince = thinkingAgents?.get?.(m.to)
      if (!targetThinkingSince) return false
      const msgTs = m.timestamp ? new Date(m.timestamp).getTime() : 0
      if (msgTs < targetThinkingSince) return false
      if (unqueuedAt && msgTs <= unqueuedAt) return false
      return true
    }

    for (let i = 0; i < chatMessages.length; i++) {
      const m = chatMessages[i]
      if (m._activity) {
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) flushActivity()
        activityGroup.push(m)
      } else if (m.metadata?.type === 'build_result') {
        flushActivity()
        const { name: docName, hash, summary, lintFindings = [], mirrorFailed } = m.metadata
        const hasDetails = !!(summary || lintFindings.length > 0)
        const lintCount = lintFindings.length
        const lintBadge = lintCount > 0
          ? `<span class="build-result-lint-badge">${lintCount} finding${lintCount !== 1 ? 's' : ''}</span>`
          : ''
        const summaryHtml = summary ? renderCtx.renderMarkdown(esc(summary)) : ''
        const lintHtml = lintFindings.map((f: any) => renderCtx.renderMarkdown(esc(f.text))).join('')
        const toggle = hasDetails ? `<span class="build-result-toggle">▾</span>` : ''
        // Status color: red = mirror/build failed; green = the version you're
        // viewing is this build; gray = a newer build you haven't loaded (or a
        // card for a doc you're not currently viewing).
        const builtHash = String(hash || '').slice(0, 7)
        let statusCls = 'build-result-neutral'
        if (mirrorFailed) statusCls = 'build-result-failed'
        else if (docName === doc) statusCls = (viewingVersion && viewingVersion === builtHash) ? 'build-result-current' : 'build-result-stale'
        const html = `<div class="build-result-card ${statusCls}">` +
          `<div class="build-result-header">` +
          `<span class="build-result-icon">🔨</span>` +
          `<span class="build-result-title">Build <code>${esc(hash)}</code> — <strong>${esc(docName)}</strong></span>` +
          lintBadge +
          toggle +
          `</div>` +
          (hasDetails
            ? `<div class="build-result-body">${summaryHtml}${lintHtml}</div>`
            : '') +
          `</div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:build`, html })
      } else if (m._evType === 'plan_approval' || m.type === 'plan_approval') {
        flushActivity()
        const agentId: string = m.from || ''
        const agentObjs: any[] = renderCtx.getAgents()
        const agentObj = agentObjs.find((a: any) => a.id === agentId)
        const agentName = agentObj?.friendly_name || agentId.replace('fleet:', '')
        const planBodyHtml = renderCtx.renderMarkdown(esc(m.text || ''))
        const planResponseCls = m._planResponse === 'approved' ? ' plan-card-approved' : m._planResponse === 'supervised' ? ' plan-card-supervised' : m._planResponse === 'rejected' ? ' plan-card-rejected' : ''
        const html = `<div class="plan-card${planResponseCls}" data-agent-id="${esc(agentId)}">` +
          `<div class="plan-card-header"><span class="plan-card-icon">📋</span>` +
          `<span class="plan-card-title">Plan from <strong>${esc(agentName)}</strong></span></div>` +
          `<div class="plan-card-body">${planBodyHtml}</div>` +
          `<div class="plan-card-actions">` +
          `<button class="plan-approve-btn" data-agent-id="${esc(agentId)}">✓ Auto</button>` +
          `<button class="plan-supervised-btn" data-agent-id="${esc(agentId)}">✓ Supervised</button>` +
          `<button class="plan-reject-btn" data-agent-id="${esc(agentId)}">✗</button>` +
          `</div></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:plan`, html })
      } else if (m.type === 'kill-session') {
        flushActivity()
        const agentObjs: any[] = renderCtx.getAgents()
        const targetId = m.to || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⚡</span><span class="kill-session-text">Session killed: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:kill`, html })
      } else if (m.type === 'interrupt') {
        flushActivity()
        const agentObjs: any[] = renderCtx.getAgents()
        const targetId = m.to || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⏸</span><span class="kill-session-text">Interrupted: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || m._tempId || `${m.timestamp}:${m.from}:interrupt`, html })
      } else {
        flushActivity()
        // Fold amends: if this message has amend events, show the viewed
        // version's text (+ its own source, so the chip is per-version) and a
        // V{n} ◀▶ stepper. Un-amended messages render untouched.
        let renderM = m
        const amends = (m._dbId != null) ? amendsByOrig.get(m._dbId) : undefined
        if (amends && amends.length) {
          const versions = [
            { text: m.text, source: m.metadata?.source ?? null },
            ...amends.map((a: any) => ({ text: a.text, source: a.metadata?.source ?? null })),
          ]
          const total = versions.length
          const viewIdx = Math.min(amendView.get(m._dbId) ?? (total - 1), total - 1)
          const backDis = viewIdx <= 0 ? ' disabled' : ''
          const fwdDis = viewIdx >= total - 1 ? ' disabled' : ''
          const oid = esc(String(m._dbId))
          const stepper = `<span class="amend-versions" data-orig="${oid}"><button class="amend-arrow"${backDis} data-orig="${oid}" data-total="${total}" data-dir="back" title="older version">◀</button><span class="amend-vlabel">V${viewIdx + 1}</span><button class="amend-arrow"${fwdDis} data-orig="${oid}" data-total="${total}" data-dir="fwd" title="newer version">▶</button></span>`
          const v = versions[viewIdx]
          renderM = { ...m, text: v.text, metadata: { ...(m.metadata || {}), source: v.source }, _amendStepper: stepper }
        }
        const html = renderChatLine(renderM, renderCtx)
        if (html) {
          const item: RawItem = { key: m._dbId || m._tempId || `${m.timestamp}:${m.from}`, html }
          // Tag interrupt system_notices so they jump ahead of queued messages
          if (m._evType === 'system_notice' && m._isInterrupt) {
            item._interrupt = true
          }
          // Tag queued messages so they render below the thinking indicator
          if (isMessageQueued(m)) {
            item._queued = true
          }
          items.push(item)
        }
      }
    }
    flushActivity()
    return items
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, ctx, thinkingAgents, unqueuedAt, viewingVersion, doc, amendsByOrig, amendView])

  // Per-item post-processing: applies chip replacement, URL linkification, and
  // doc-link resolution to a single item's HTML. Called by ChatMessageRow only
  // for visible items, so the cost scales with the viewport not the message count.
  const postProcess = useCallback((html: string): string => {
    // Turn «type:label» reference tokens into chips — only in non-code regions
    // and not when immediately preceded by a quote character (quoted = literal).
    html = transformNonCode(html, (text) => text.replace(/(?<!["'])«(.+?)»/g, (_match, inner) => {
      const token = `«${inner}»`
      const colonIdx = inner.indexOf(':')
      const typePrefix = colonIdx >= 0 ? inner.slice(0, colonIdx) : ''
      const display = (colonIdx >= 0 ? inner.slice(colonIdx + 1) : inner).replace(/#[^#»]+$/, '')
      if (typePrefix === 'bullet') {
        // Bullet cards are rendered server-side in chat-render.mjs using metadata.
        // If a «bullet:ID» token reaches here, the metadata was missing — show as plain text.
        return `<span class="bullet-card-fallback">[bullet ref]</span>`
      }
      const shapeIdMatch = inner.match(/#(shape:[^»]+)$/)
      const embeddedShapeId = shapeIdMatch?.[1]
      let ref: any = undefined
      if (embeddedShapeId) {
        const mainEditor = (window as any).__tldraw_editor__
        const srcShape = (editor.getShape(embeddedShapeId as any) || mainEditor?.getShape(embeddedShapeId as any)) as any
        if (srcShape) {
          const highlightId = srcShape.props?.highlightId
          const highlight = highlightId ? (editor.getShape(highlightId as any) || mainEditor?.getShape(highlightId as any)) as any : null
          const refShape = highlight || srcShape
          const shapeEditor = mainEditor?.getShape(refShape.id) ? mainEditor : editor
          const refBounds = shapeEditor.getShapePageBounds(refShape.id)
          const meta = (highlight?.meta || srcShape.meta) as any
          const srcLineArr: any[] = meta?.sourceLines || []
          const hlSrcLines = srcLineArr.filter((sl: any) => sl.highlighted)
          const firstSrcLine = hlSrcLines.length > 0 ? hlSrcLines[0] : srcLineArr[0]
          const anchor = meta?.sourceAnchor  // fallback for old shapes
          ref = {
            type: typePrefix || 'annotation',
            label: display,
            content: srcShape.props?.text || meta?.highlightText || '',
            color: srcShape.props?.color || meta?.glowColor,
            canvasBounds: refBounds ? { x: refBounds.x, y: refBounds.y, w: refBounds.w, h: refBounds.h } : undefined,
            shapeId: embeddedShapeId,
            highlightShapeId: highlight?.id,
            screenshotRef: refBounds ? `tlda-screenshot:page:page:${refBounds.x.toFixed(0)},${refBounds.y.toFixed(0)},${refBounds.w.toFixed(0)},${refBounds.h.toFixed(0)}` : undefined,
            file: firstSrcLine?.file || anchor?.file,
            lineno: firstSrcLine?.line || anchor?.line,
          }
        }
      }
      const displayEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const content = ref?.content || chipContentStore.get(token) || ''
      const contentEsc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const isAnnotation = ref?.type === 'annotation' || ref?.type === 'highlight'
      const isImage = typePrefix === 'img'
      if (isImage) {
        const uid = inner.split('#')[1] || ''
        const src = imageSrcs.get('asset:' + uid) || content
        if (src) {
          const nameEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          return `<img src="${src}" alt="${nameEsc}" style="display:block;width:75%;max-width:100%;border-radius:4px;margin:4px 0;" />`
        }
        return `<span class="ref-chip ref-chip-image">${displayEsc}</span>`
      }
      const preview = !isAnnotation && content ? `<span class="ref-chip-preview">${contentEsc}</span>` : ''
      const colorDot = isAnnotation && ref?.color ? `<span class="ref-chip-dot" style="background:${ref.color}"></span>` : ''
      const locBadge = isAnnotation && ref?.file
        ? `<span class="ref-chip-loc">${ref.file.split('/').pop()}${ref.lineno ? ':' + ref.lineno : ''}</span>` : ''
      const boundsAttr = ref?.canvasBounds
        ? ` data-bounds="${ref.canvasBounds.x},${ref.canvasBounds.y},${ref.canvasBounds.w},${ref.canvasBounds.h}"` : ''
      const shapeAttr = ref?.shapeId ? ` data-shape-ref="${ref.shapeId}"` : ''
      const highlightAttr = isAnnotation && ref?.highlightShapeId ? ` data-highlight-ref="${ref.highlightShapeId}"` : ''
      const screenshotAttr = ref?.screenshotRef ? ` data-screenshot-ref="${ref.screenshotRef}"` : ''
      const cls = isAnnotation ? 'ref-chip ref-chip-annotation' : 'ref-chip'
      const tokenAttr = ` data-token="${token.replace(/"/g, '&quot;')}"`
      return `<span class="${cls}"${tokenAttr}${boundsAttr}${shapeAttr}${highlightAttr}${screenshotAttr}>${colorDot}${displayEsc}${locBadge}${preview}</span>`
    }))
    // Process [->ref] arrow links BEFORE auto-detection (linkifyDocRefs)
    // so that [->Theorem 3.2] is consumed before "Theorem 3.2" gets auto-linked
    if (doc && Object.keys(labelRegions).length > 0) {
      // Raw \ref/\eqref/\cref commands first — convert to their compiled form
      // so the inner label isn't double-processed by the passes below.
      html = linkifyRefCommands(html, labelRegions, theoremMap)
      html = linkifyAtRefs(html, labelRegions)
      html = linkifyArrowRefs(html, labelRegions)
      html = linkifyLabelRefs(html, labelRegions)
    }
    if (doc) html = linkifyDocRefs(html)
    return html
  }, [doc, labelRegions, theoremMap, imageSrcs, editor])

  // Mark the queue divider position inline — the last non-queued item before
  // the first queued item gets _divider: true. All items stay in one list.
  const allItems = useMemo(() => {
    const items = [...rawItems]
    let firstQueuedIdx = -1
    for (let i = 0; i < items.length; i++) {
      if (items[i]._queued) { firstQueuedIdx = i; break }
    }
    if (firstQueuedIdx > 0) {
      items[firstQueuedIdx - 1] = { ...items[firstQueuedIdx - 1], _divider: true }
    }
    return items
  }, [rawItems])

  // Virtual scroll — only mount DOM nodes for visible messages.
  // Handle clicks on ref-chip annotations → navigate to canvas bounds
  const handleRefChipClick = useCallback((e: React.MouseEvent) => {
    const chip = (e.target as HTMLElement).closest('.ref-chip-annotation') as HTMLElement | null
    if (!chip) return
    const boundsStr = chip.dataset.bounds
    if (boundsStr) {
      const [x, y, w, h] = boundsStr.split(',').map(Number)
      if ([x, y, w, h].every(n => isFinite(n))) {
        e.stopPropagation()
        editor.zoomToBounds({ x: x - 20, y: y - 20, w: w + 40, h: h + 40 }, { animation: { duration: 300 } })
        const shapeRef = chip.dataset.shapeRef
        if (shapeRef) {
          try { editor.select(shapeRef as any) } catch {}
        }
      }
    }
  }, [editor])

  // Handle clicks on doc-link spans
  const handleDocLinkClick = useCallback((e: React.MouseEvent) => {
    // Plain URL links — open in new tab (TLDraw intercepts native <a> navigation)
    const chatLink = (e.target as HTMLElement).closest('.chat-link') as HTMLAnchorElement | null
    if (chatLink?.href) { e.preventDefault(); window.open(chatLink.href, '_blank'); return }

    // Also check for annotation chip clicks
    const chipTarget = (e.target as HTMLElement).closest('.ref-chip-annotation')
    if (chipTarget) { handleRefChipClick(e); return }

    // Markdown chip → lightbox overlay (ref-chip-doc chips AND md-file-card chips in activity cards)
    const mdChip = (e.target as HTMLElement).closest('.ref-chip-doc, .md-file-card') as HTMLElement | null
    if (mdChip) {
      const chipUrl = mdChip.dataset.url || ''
      const chipPath = mdChip.dataset.path || ''
      const isMd = /\.md$/i.test(chipUrl || chipPath)
      const fetchUrl = chipUrl || (chipPath ? `/api/local-image?path=${encodeURIComponent(chipPath)}` : '')
      if (isMd && fetchUrl) {
        e.stopPropagation()
        const existing = document.querySelector('.chat-lightbox-md')
        if (existing) { existing.remove(); return }
        const overlay = document.createElement('div')
        overlay.className = 'chat-lightbox-md'
        overlay.innerHTML = '<div class="chat-lightbox-md-card"><div class="chat-lightbox-md-loading">Loading…</div></div>'
        overlay.addEventListener('click', (ev) => {
          if (ev.target === overlay) overlay.remove()
        })
        document.body.appendChild(overlay)
        fetch(fetchUrl)
          .then(r => r.ok ? r.text() : Promise.reject(r.status))
          .then(text => {
            const baseUrl = chipUrl ? chipUrl.substring(0, chipUrl.lastIndexOf('/') + 1) : ''
            const resolved = baseUrl ? text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
              if (src.startsWith('http') || src.startsWith('/')) return match
              return `![${alt}](${baseUrl}${src})`
            }) : text
            const title = mdChip.querySelector('.md-file-chip')?.textContent || mdChip.textContent || chipPath.split('/').pop() || 'file'
            let renderedHtml = tldaRenderMarkdown(resolved)
            const lr = labelRegionsRef.current
            if (lr && Object.keys(lr).length > 0) {
              renderedHtml = linkifyAtRefs(renderedHtml, lr)
            }
            const cardEl = overlay.querySelector('.chat-lightbox-md-card')!
            cardEl.innerHTML = `<div class="chat-lightbox-md-header"><span>${title}</span><button class="chat-lightbox-md-close" title="Close">✕</button></div><div class="chat-lightbox-md-body">${renderedHtml}</div>`
            cardEl.querySelector('.chat-lightbox-md-close')?.addEventListener('click', () => overlay.remove())
          })
          .catch(() => {
            const cardEl = overlay.querySelector('.chat-lightbox-md-card')
            if (cardEl) cardEl.innerHTML = '<div class="chat-lightbox-md-loading">Failed to load</div>'
          })
        return
      }
    }

    // Copy button on code blocks
    const copyBtn = (e.target as HTMLElement).closest('.code-block-copy') as HTMLElement | null
    if (copyBtn) {
      const pre = copyBtn.closest('.code-block-wrap')?.querySelector('pre')
      if (pre) {
        navigator.clipboard.writeText(pre.textContent || '').then(() => {
          copyBtn.textContent = '✓'
          copyBtn.classList.add('code-block-copy-success')
          setTimeout(() => { copyBtn.textContent = '⎘'; copyBtn.classList.remove('code-block-copy-success') }, 1500)
        })
      }
      return
    }

    const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
    if (!target || !doc) return

    const refType = target.dataset.refType

    let resolved: ResolvedRef | null = null

    if (refType === 'label') {
      // Label-based ref — page/y are in data attributes
      const page = parseInt(target.dataset.refPage || '')
      const yTop = parseFloat(target.dataset.refYTop || '')
      if (!isNaN(page)) {
        resolved = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
      }
    } else if (refResolver) {
      const refValue = target.dataset.refValue || ''
      const envType = target.dataset.envType
      const ref: DocRef = { type: refType as DocRef['type'], value: refValue, text: target.textContent || '', envType }
      resolved = refResolver(ref)
    }

    if (!resolved) return

    const canvasPos = refToCanvas(resolved, doc.pages, PDF_HEIGHT)
    if (!canvasPos) return

    e.stopPropagation()
    // Update docview shape directly if one exists
    const mainEd = (window as any).__tldraw_editor__
    if (mainEd) {
      const dvShape = mainEd.getCurrentPageShapes().find((s: any) => s.type === 'fleet-docview')
      if (dvShape) {
        const lbl = target.dataset.refLabel || ''
        const dvTitle = lbl || `p.${resolved.page}`
        if ((dvShape as any).isLocked) mainEd.updateShape({ id: dvShape.id, type: dvShape.type, isLocked: false })
        mainEd.updateShape({
          id: dvShape.id, type: dvShape.type,
          props: { ...(dvShape as any).props, mode: 'manual', label: lbl, page: resolved.page, yTop: resolved.pdfY || 0, yBottom: (resolved.pdfY || 0) + 200, title: dvTitle },
        })
      }
    }
    editor.centerOnPoint(canvasPos, { animation: { duration: 300 } })
  }, [doc, refResolver, editor])

  const shapeContainerRef = useRef<HTMLDivElement>(null)
  const inputAreaRef = useRef<HTMLDivElement>(null)
  const dragClearTimerRef = useRef<number | null>(null)
  const [dragLozenges, setDragLozenges] = useState<Array<'image' | 'file'> | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function onMouseOver(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
      if (!target || !doc) return
      if (target.classList.contains('doc-link-unresolved')) return

      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
        // Re-check that cursor is still over a doc-link (user may have moved away)
        const stillOver = document.querySelector('.doc-link:hover')
        if (!stillOver) return
        const refType = target.dataset.refType

        let resolved: ResolvedRef | null = null

        if (refType === 'label') {
          const page = parseInt(target.dataset.refPage || '')
          const yTop = parseFloat(target.dataset.refYTop || '')
          if (!isNaN(page)) {
            resolved = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
          }
        } else if (refResolver) {
          const refValue = target.dataset.refValue || ''
          const envType = target.dataset.envType
          const ref: DocRef = { type: refType as DocRef['type'], value: refValue, text: target.textContent || '', envType }
          resolved = refResolver(ref)
        }
        if (!resolved) return

        // Convert resolved ref to canvas bounds for AnnotationViewer
        const pageIdx = resolved.page - 1
        if (pageIdx < 0 || pageIdx >= doc.pages.length) return
        const pageBounds = doc.pages[pageIdx].bounds
        const REGION_H = pageBounds.height * 0.3  // show ~30% of the page around the reference
        let cy: number
        if (resolved.pdfY != null) {
          const scale = pageBounds.height / PDF_HEIGHT
          cy = pageBounds.y + resolved.pdfY * scale
        } else {
          cy = pageBounds.y + pageBounds.height / 2
        }
        const bounds = {
          x: pageBounds.x,
          y: cy - REGION_H / 2,
          w: pageBounds.width,
          h: REGION_H,
        }
        const chipRect = target.getBoundingClientRect()
        const label = target.textContent?.trim() || `p.${resolved.page}`
        window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
          detail: { bounds, shapeIds: [], label, chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height } }
        }))
      }, 800)
    }

    function onMouseOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.doc-link') && !target.closest('.screenshot-inline')) return
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.annotation-viewer')) return
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      window.dispatchEvent(new CustomEvent('annotation-viewer-hide'))
    }

    // Chip hover — show popover for msg/activity/tool reference chips
    async function onChipOver(e: MouseEvent) {
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-token]') as HTMLElement | null
      if (!chip) return
      // Don't handle annotation chips here (they use AnnotationViewer)
      if (chip.classList.contains('ref-chip-annotation')) return
      // Delay to avoid accidental triggers
      await new Promise(r => setTimeout(r, 500))
      if (!chip.matches(':hover')) return
      const token = chip.getAttribute('data-token') || ''
      const refId = token.replace(/^«/, '').replace(/»$/, '').split('#')[1]
      if (!refId) return
      // Find matching event by timestamp embedded in the refId
      // New format: msg:<dbId> or activity:<dbId> or activity:<dbId>:line<N>
      // Legacy format: msg:fleet:skip:2026-04-18T... or activity:fleet:xxx:ISO
      const chipType = refId.match(/^(msg|activity|tool)/)?.[1] || ''
      const lineMatch = refId.match(/:line(\d+)$/)
      const highlightLine = lineMatch ? lineMatch[1] : null
      const refBody = refId.replace(/^(msg|activity|tool):/, '').replace(/:line\d+$/, '')
      // Try local events first, then fetch from server
      let matchEvent = liveEvents.find((ev: any) => {
        const isActivity = !!ev._activity
        if (chipType === 'activity' && !isActivity) return false
        if (chipType === 'msg' && isActivity) return false
        if (ev._dbId?.toString() === refBody) return true
        const tsPart = refBody.replace(/^fleet:[^:]+:/, '')
        if (ev.timestamp === tsPart) return true
        return false
      })
      // If not found locally, fetch from server by DB ID and expand outward for activity grouping
      let fetchedGroup: any[] | null = null
      if (!matchEvent && /^\d+$/.test(refBody)) {
        try {
          const id = parseInt(refBody)
          const { convertChatEvent } = await import('../fleet/fleet-data.mjs')

          // Fetch the target event first
          const res0 = await fetch(`/api/store/events?after=${id - 1}&limit=1`)
          if (!res0.ok) throw new Error()
          const d0 = await res0.json()
          const targetRaw = (d0.events || [])[0]
          if (!targetRaw) throw new Error()
          const target = convertChatEvent(targetRaw) as any
          matchEvent = target

          // For activity events, expand outward to find the group boundaries
          if (target._activity) {
            const agentId = target.from
            const group = [target]

            // Expand backwards
            let backId = id
            let backDone = false
            while (!backDone) {
              const res = await fetch(`/api/store/events?before=${backId}&limit=10`)
              if (!res.ok) break
              const d = await res.json()
              const evts = (d.events || []).map(convertChatEvent)
              if (evts.length === 0) break
              for (let i = evts.length - 1; i >= 0; i--) {
                if (evts[i]._activity && evts[i].from === agentId) {
                  group.unshift(evts[i])
                  backId = evts[i]._dbId
                } else {
                  backDone = true
                  break
                }
              }
              if (evts.length < 10) break
            }

            // Expand forwards
            let fwdId = id
            let fwdDone = false
            while (!fwdDone) {
              const res = await fetch(`/api/store/events?after=${fwdId}&limit=10`)
              if (!res.ok) break
              const d = await res.json()
              const evts = (d.events || []).map(convertChatEvent)
              if (evts.length === 0) break
              for (const ev of evts) {
                if (ev._activity && ev.from === agentId) {
                  group.push(ev)
                  fwdId = ev._dbId
                } else {
                  fwdDone = true
                  break
                }
              }
              if (evts.length < 10) break
            }

            fetchedGroup = group
          }
        } catch {}
      }
      if (!matchEvent) return

      // Remove any existing popover
      document.querySelector('.chip-hover-popover')?.remove()

      // Render the event as chat HTML
      const popover = document.createElement('div')
      popover.className = 'chip-hover-popover fleet-chat-shape'
      let rendered: string
      if (matchEvent._activity && ctxRef.current) {
        // Use pre-fetched group or find from local events
        let group: any[]
        if (fetchedGroup && fetchedGroup.length > 0) {
          group = fetchedGroup
        } else {
          const matchIdx = liveEvents.indexOf(matchEvent)
          const agentId = matchEvent.from
          let start = matchIdx
          while (start > 0 && liveEvents[start - 1]._activity && liveEvents[start - 1].from === agentId) start--
          let end = matchIdx
          while (end < liveEvents.length - 1 && liveEvents[end + 1]._activity && liveEvents[end + 1].from === agentId) end++
          group = liveEvents.slice(start, end + 1)
        }
        const { renderActivityGroup } = await import('../fleet/activity-render.mjs')
        rendered = `<div class="chat-activity-inline-wrap">${renderActivityGroup(group.length > 0 ? group : [matchEvent], ctxRef.current)}</div>`
      } else {
        rendered = ctxRef.current ? renderChatLine(matchEvent, ctxRef.current) : `<div class="chat-line">${matchEvent.text || '(no content)'}</div>`
      }
      popover.innerHTML = rendered

      const chipRect = chip.getBoundingClientRect()
      popover.style.position = 'fixed'
      popover.style.left = `${chipRect.left}px`
      popover.style.bottom = `${window.innerHeight - chipRect.top + 4}px`
      popover.style.zIndex = '10000'
      popover.style.maxWidth = `${w}px`
      document.body.appendChild(popover)

      // Scroll to and highlight the specific tool line
      if (highlightLine) {
        const targetLine = popover.querySelector(`.tool-line[data-line="${highlightLine}"]`) as HTMLElement
        if (targetLine) {
          targetLine.style.background = 'rgba(147, 112, 219, 0.2)'
          targetLine.style.borderRadius = '3px'
          targetLine.scrollIntoView({ block: 'center' })
        }
      }
    }

    function onChipOut(e: MouseEvent) {
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-token]')
      if (!chip) return
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.chip-hover-popover')) return
      setTimeout(() => {
        if (!document.querySelector('.chip-hover-popover:hover')) {
          document.querySelector('.chip-hover-popover')?.remove()
        }
      }, 200)
    }

    logEl.addEventListener('mouseover', onMouseOver)
    logEl.addEventListener('mouseover', onChipOver)
    logEl.addEventListener('mouseout', onMouseOut)
    logEl.addEventListener('mouseout', onChipOut)
    return () => {
      logEl.removeEventListener('mouseover', onMouseOver)
      logEl.removeEventListener('mouseover', onChipOver)
      logEl.removeEventListener('mouseout', onMouseOut)
      logEl.removeEventListener('mouseout', onChipOut)
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      document.querySelector('.chip-hover-popover')?.remove()
    }
  }, [chatLogEl, doc, refResolver, w, liveEvents])

  // Native capture-phase drop handler — intercepts OS file drops (from Finder etc.)
  // on the chat shape before tldraw can create a canvas image shape. A file only
  // ATTACHES when dropped over the input field; over the rest of the shape it's
  // swallowed (does nothing). While dragging over the field, ghost lozenges
  // preview the incoming attachment(s). Files upload to the fleet server and are
  // referenced by stable URL.
  useEffect(() => {
    const el = shapeContainerRef.current
    if (!el) return

    // True when the pointer is over the input field's drop zone.
    function overInput(e: DragEvent) {
      const r = inputAreaRef.current?.getBoundingClientRect()
      if (!r) return false
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    }

    function clearDrag() {
      if (dragClearTimerRef.current) { clearTimeout(dragClearTimerRef.current); dragClearTimerRef.current = null }
      setDragLozenges(null)
    }

    function onDragOver(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      if (overInput(e)) {
        e.dataTransfer.dropEffect = 'copy'
        // dataTransfer.items is only readable inside the event — snapshot the
        // per-file kind (image vs other) now so we can render ghost lozenges.
        const kinds = [...(e.dataTransfer.items || [])]
          .filter(it => it.kind === 'file')
          .map(it => (it.type.startsWith('image/') ? 'image' : 'file') as 'image' | 'file')
        setDragLozenges(kinds.length ? kinds : ['file'])
        if (dragClearTimerRef.current) clearTimeout(dragClearTimerRef.current)
        dragClearTimerRef.current = window.setTimeout(clearDrag, 250)
      } else {
        e.dataTransfer.dropEffect = 'none'
        clearDrag()
      }
    }

    async function onDrop(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      const wasOverInput = overInput(e)
      clearDrag()
      // Only the input field accepts the drop; elsewhere on the shape, swallow it.
      if (!wasOverInput) return

      // Use items API to support folder drops
      const items = e.dataTransfer.items ? [...e.dataTransfer.items] : []
      let entries: { file: File, path: string }[] = []
      let isFlat = true

      if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
        for (const item of items) {
          const entry = item.webkitGetAsEntry()
          if (entry) {
            if (entry.isDirectory) isFlat = false
            entries.push(...await traverseDirectory(entry))
          }
        }
      } else {
        for (const f of [...(e.dataTransfer.files || [])]) {
          entries.push({ file: f, path: f.name })
        }
      }

      if (!entries.length) return

      const mdEntries = entries.filter(({ file: f }) => f.name.endsWith('.md') || f.type === 'text/markdown')
      const otherEntries = entries.filter(({ file: f }) => !f.name.endsWith('.md') && f.type !== 'text/markdown')

      for (const { file, path } of mdEntries) {
        try {
          const companions = entries.filter(e => e.path !== path)
          const link = await uploadMarkdownWithImages(file, companions, path, isFlat)
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: link } }))
        } catch (err) {
          console.error('[fleet-chat] folder-drag md upload error', err)
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: `[${file.name}]` } }))
        }
      }
      for (const { file } of otherEntries) {
        if (mdEntries.length > 0 && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.name)) continue
        try {
          const formData = new FormData()
          formData.append('file', file, file.name)
          const resp = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: formData })
          if (!resp.ok) throw new Error(`upload failed: ${resp.status}`)
          const { url, name } = await resp.json()
          const link = file.type.startsWith('image/')
            ? `![${name}](${FLEET_API}${url})`
            : `[${name}](${FLEET_API}${url})`
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: link } }))
        } catch (err) {
          console.error('[fleet-chat] folder-drag file upload error', err)
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: shape.id, text: `[${file.name}]` } }))
        }
      }
    }

    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('drop', onDrop, true)
    el.addEventListener('dragleave', clearDrag, true)
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('drop', onDrop, true)
      el.removeEventListener('dragleave', clearDrag, true)
      if (dragClearTimerRef.current) clearTimeout(dragClearTimerRef.current)
    }
  }, [shape.id, editor])

  // Hover events on annotation ref-chips → dispatch to AnnotationViewer
  const annotationHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function onAnnotationOver(e: MouseEvent) {
      // Match annotation chips AND any ref-chip with bounds data (doc region refs)
      const chip = (e.target as HTMLElement).closest('.ref-chip[data-bounds]') as HTMLElement | null
      if (!chip) return
      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
      annotationHoverTimerRef.current = setTimeout(() => {
        // Re-check cursor is still over the chip
        if (!chip.matches(':hover')) return
        const boundsStr = chip.dataset.bounds
        if (!boundsStr) return
        const [x, y, w, h] = boundsStr.split(',').map(Number)
        if (![x, y, w, h].every(n => isFinite(n))) return
        // Extract label and color from the chip
        const label = chip.textContent?.trim() || 'Annotation'
        const dotEl = chip.querySelector('.ref-chip-dot') as HTMLElement | null
        const color = dotEl?.style.background || undefined
        const shapeIds: string[] = []
        if (chip.dataset.shapeRef) shapeIds.push(chip.dataset.shapeRef)
        if (chip.dataset.highlightRef) shapeIds.push(chip.dataset.highlightRef)
        // Anchor viewer to the chip element, not the cursor
        const chipRect = chip.getBoundingClientRect()
        window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
          detail: { bounds: { x, y, w, h }, shapeIds, label, color, chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height } }
        }))
      }, 500)
    }

    function onAnnotationOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.ref-chip[data-bounds]')) return
      // Check if moving into the viewer itself
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.annotation-viewer')) return
      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
      window.dispatchEvent(new CustomEvent('annotation-viewer-hide'))
    }

    logEl.addEventListener('mouseover', onAnnotationOver)
    logEl.addEventListener('mouseout', onAnnotationOut)
    return () => {
      logEl.removeEventListener('mouseover', onAnnotationOver)
      logEl.removeEventListener('mouseout', onAnnotationOut)
      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
    }
  }, [chatLogEl])

  // Live countdown ticker: timer-countdown lines render a frozen number, so each
  // second we recompute remaining from data-timer-until and update the text in
  // place. Pure DOM — doesn't fight the dangerouslySetInnerHTML items. Terminal
  // states (cancelled/fired) arrive via event-update and re-render the item.
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return
    const tick = () => {
      const nodes = logEl.querySelectorAll<HTMLElement>('.chat-timer-countdown[data-timer-until]')
      for (const node of nodes) {
        const until = node.getAttribute('data-timer-until')
        const span = node.querySelector<HTMLElement>('.timer-msg')
        if (!until || !span) continue
        const r = Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000))
        const mins = Math.floor(r / 60)
        const secs = r % 60
        const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`
        const txt = span.textContent || ''
        const arrowIdx = txt.indexOf('→')
        const tail = arrowIdx >= 0 ? txt.slice(arrowIdx) : ''
        span.textContent = `⏱ ${timeStr} ${tail}`.trimEnd()
      }
    }
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [chatLogEl])

  // Hover events on bullet cards → dispatch to AnnotationViewer
  const bulletHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function onBulletOver(e: MouseEvent) {
      const card = (e.target as HTMLElement).closest('.bullet-card') as HTMLElement | null
      if (!card) return
      if (bulletHoverTimerRef.current) clearTimeout(bulletHoverTimerRef.current)
      bulletHoverTimerRef.current = setTimeout(() => {
        if (!card.matches(':hover')) return
        const shapeId = card.dataset.shapeId
        if (!shapeId) return
        const mainEd = (window as any).__tldraw_editor__ || editor
        const noteShape = mainEd.getShape(shapeId as any)
        if (!noteShape) return
        const bounds = mainEd.getShapePageBounds(noteShape.id)
        if (!bounds) return
        const chipRect = card.getBoundingClientRect()
        const label = card.querySelector('.bullet-card-source')?.textContent?.trim() || 'Note'
        const bulletIdx = parseInt(card.dataset.bulletIdx || '', 10)
        window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
          detail: {
            bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
            shapeIds: [shapeId],
            label,
            chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height },
            useFullBounds: true,
            bulletIdx: isNaN(bulletIdx) ? undefined : bulletIdx,
          }
        }))
      }, 500)
    }

    function onBulletOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.bullet-card')) return
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.annotation-viewer')) return
      if (bulletHoverTimerRef.current) clearTimeout(bulletHoverTimerRef.current)
      window.dispatchEvent(new CustomEvent('annotation-viewer-hide'))
    }

    logEl.addEventListener('mouseover', onBulletOver)
    logEl.addEventListener('mouseout', onBulletOut)
    return () => {
      logEl.removeEventListener('mouseover', onBulletOver)
      logEl.removeEventListener('mouseout', onBulletOut)
      if (bulletHoverTimerRef.current) clearTimeout(bulletHoverTimerRef.current)
    }
  }, [chatLogEl, editor])

  // Auto-scroll to bottom — event-driven, not every frame.
  // CanvasClipPanel already routes wheel events to .fleet-chat-log via
  // scrollable.scrollTop += e.deltaY, so we must NOT fight it with a
  // continuous rAF loop. Instead: scroll to bottom when new content arrives
  // or the container resizes, but only if the user hasn't scrolled up.
  const isAtBottomRef = useRef(true)
  // Pin decisions gate on "did the user deliberately scroll up" (userScrolledUpRef),
  // NOT Virtuoso's raw at-bottom bool. A transient sub-threshold reflow gap (late
  // markdown/KaTeX/image growth) must not latch auto-follow off — only a deliberate
  // scroll-up past 200px counts as intent.
  const userScrolledUpRef = useRef(false)
  // TRACE: timestamp until which scroll events are attributable to our own
  // programmatic pinning (pinHard). Lets the scroll-trace tell "my pin" apart
  // from "user wheel" and "Virtuoso/virtualization". Temporary diagnostic.
  const programmaticUntilRef = useRef(0)
  // Reactive bottom-position state. Drives the unified follow/jump button:
  // at bottom → follow-mode toggle (horseshoe); off bottom → ⇣ jump-to-bottom.
  // Position (not scroll-intent) is the right signal here — matches the spec
  // "at the bottom it toggles the mode; off the bottom it's click-to-go-down."
  const [atBottom, setAtBottom] = useState(true)
  const [termHoverVisible, setTermHoverVisible] = useState(false)
  const [termHoverPinned, setTermHoverPinned] = useState(false)
  const termHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termAutoPinnedRef = useRef(false)
  const lastAttentionTsRef = useRef<string | null>(null)
  // Tracks which chat rows have been expanded (by item key) so the state
  // survives dangerouslySetInnerHTML re-renders.
  const expandedRowsRef = useRef<Set<string>>(new Set())
  // Hard-lock toggle: when on, every pin path fires unconditionally
  // (ignores isAtBottomRef), and atBottomStateChange can't un-pin us.
  // Persisted per browser in localStorage.
  const HARD_LOCKED_KEY = 'fleet-chat-hard-locked'
  const [hardLocked, setHardLocked] = useState(() => localStorage.getItem(HARD_LOCKED_KEY) === 'true')
  const hardLockedRef = useRef(hardLocked)
  useEffect(() => {
    hardLockedRef.current = hardLocked
    localStorage.setItem(HARD_LOCKED_KEY, String(hardLocked))
  }, [hardLocked])

  // pin-to-bottom: two complementary mechanisms, each needed.
  //  - scrollToIndex(LAST) forces Virtuoso to render+measure the last items
  //    (virtualization-aware); without it the raw scrollTop undershoots while
  //    the tail is unmeasured.
  //  - raw scrollTop = scrollHeight reaches the ABSOLUTE bottom past the Virtuoso
  //    Footer (eliza/thinking status). scrollToIndex(LAST, 'end') only aligns the
  //    last DATA item, stopping ~the footer's height above true bottom — that was
  //    the consistent ~514px residual gap when raw was removed.
  // The bounded loop re-runs as height settles. The standing watchdog below is
  // what guarantees convergence after this loop's frame budget — the original
  // bug was that nothing re-applied this once events stopped firing.
  const pinHard = useCallback(() => {
    programmaticUntilRef.current = performance.now() + 400
    let frames = 0
    const step = () => {
      // Stop if the user has taken over since we started (unless hard-locked).
      if (userScrolledUpRef.current && !hardLockedRef.current) return
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      const el = chatLogEl
      if (el) el.scrollTop = el.scrollHeight
      programmaticUntilRef.current = performance.now() + 120
      const gap = el ? (el.scrollHeight - (el.scrollTop + el.clientHeight)) : 0
      if (gap > 8 && ++frames < 12) requestAnimationFrame(step)
    }
    step()
  }, [chatLogEl])

  // Imperative scroll-to-bottom for the floating ⇣ button.
  const scrollToBottom = useCallback(() => {
    log.warn('chat-scroll', 'scrollToBottom (user click ⇣)')
    // Clear the scroll-up flag BEFORE pinHard: pinHard's step() bails
    // immediately when userScrolledUp is set (and we're not hard-locked), so
    // calling it first made the click a no-op — that was the "click twice to
    // reach the bottom" bug. Reset intent + position first, then pin.
    userScrolledUpRef.current = false
    isAtBottomRef.current = true
    setAtBottom(true)
    pinHard()
  }, [pinHard])

  // When the scroll container resizes — textarea growing as you type
  // (shrinks chat-log) OR shrinking back after send (grows chat-log) — pin
  // to bottom if we were at bottom. Virtuoso's followOutput only fires on
  // *content* change, not container resize, so without this you drift off
  // the bottom whenever the input area changes height.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    let prevH = el.clientHeight
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight
      if (h !== prevH) {
        const pin = !userScrolledUpRef.current || hardLockedRef.current
        log.warn('chat-scroll', 'container resize', { prevH, h, atBottom: isAtBottomRef.current, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current, action: pin ? 'pin' : 'skip' })
        if (pin) pinHard()
      }
      prevH = h
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [chatLogEl, pinHard])

  // Force-pin when new items arrive AND we were at bottom. Virtuoso's
  // followOutput="auto" sometimes scrolls against a stale measurement of
  // the new item's height, ending up ~20px short — enough to trip
  // atBottomThreshold and surface the ⇣ arrow even though the user didn't
  // scroll. This redundant scroll catches that.
  const prevItemCountRef = useRef(allItems.length)
  // Tracks Virtuoso's total list height for totalListHeightChanged — catches
  // in-place item growth that doesn't tick items.length.
  const prevTotalHeightRef = useRef(0)
  useEffect(() => {
    const prev = prevItemCountRef.current
    prevItemCountRef.current = allItems.length
    if (allItems.length > prev && (!userScrolledUpRef.current || hardLockedRef.current)) {
      log.warn('chat-scroll', 'force-pin on item grow', { prev, now: allItems.length, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current })
      requestAnimationFrame(pinHard)
    }
  }, [allItems.length, pinHard])

  // Single source of user-scroll intent. In the HUD, a user can only scroll the
  // chat log via CanvasClipPanel's wheel handler (wheel is captured there and
  // never reaches the scroller natively), which fires 'fleet-user-scroll' right
  // after it moves scrollTop. Because programmatic pins (pinHard/scrollToIndex)
  // never fire this event, we can set follow intent from real user motion
  // without the programmatic-vs-user ambiguity that broke every prior approach.
  // Scroll away from bottom → stop following (+ show ⇣); land within EPS of the
  // true bottom → resume following. No gap thresholds, no timing magic.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    // SINGLE threshold, no dead band. This handler fires ONLY on real user wheel
    // motion (programmatic pins never dispatch fleet-user-scroll), so we can set
    // follow intent directly from the gap the user scrolled to: above the
    // threshold = "I'm reading, don't follow"; within it = "I'm at the bottom,
    // follow." The old asymmetric 120/200 dead band left scrolledUp=FALSE in the
    // 120–200 zone, so a small scroll-up followed by a message or thinking-status
    // growth pinned the user back down — the "jerked to the bottom when scrolled
    // up" bug. A single threshold means ANY deliberate scroll-up past it
    // disengages follow until the user returns to the bottom. Content-induced
    // gaps never reach here (no wheel event), so false-bottom recovery — which
    // keys off scrolledUp staying false while content grows — is unaffected.
    const FOLLOW_THRESHOLD = 120
    const onUserScroll = () => {
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (!hardLockedRef.current) {
        userScrolledUpRef.current = gap > FOLLOW_THRESHOLD
      }
      log.warn('chat-scroll', 'user scroll', { gap, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current })
    }
    el.addEventListener('fleet-user-scroll', onUserScroll as EventListener)
    return () => el.removeEventListener('fleet-user-scroll', onUserScroll as EventListener)
  }, [chatLogEl])

  // Convergence watchdog — the reconciler of last resort. scrollToIndex(LAST)
  // can land SHORT while freshly-added tall items are still being measured, and
  // once Virtuoso reports "not at bottom" no further event necessarily re-fires
  // (atBottomStateChange only fires on a state TRANSITION, not while stuck), so
  // a single short pin could strand the view above a persistent gap — the
  // reproduced false-bottom (dist stuck 500–1100px). This low-rate check re-pins
  // whenever we SHOULD be following (user hasn't scrolled up) but a large gap
  // persists, guaranteeing convergence as items finish measuring.
  //
  // Threshold 200 == the user-scroll DISENGAGE distance, so this can NEVER fight
  // a user reading in the 120–200 dead band: any gap >200 with userScrolledUp
  // false can only be a failed pin, never user intent (a real scroll past 200
  // sets userScrolledUp=true synchronously in the wheel handler before this
  // timer next fires). 200ms cadence is well below human-perceptible and can't
  // thrash — pinHard converges to bottom, gap drops under 200, this goes quiet.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    const id = setInterval(() => {
      if (userScrolledUpRef.current && !hardLockedRef.current) return
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (gap > 200) pinHard()
    }, 200)
    return () => clearInterval(id)
  }, [chatLogEl, pinHard])

  // Refilter → bottom. Changing the filter swaps the whole rendered list out
  // from under Virtuoso; the scroll-position reset effect above (keyed on
  // filterKey) resets the atBottom *state*, but it runs before
  // userScrolledUpRef exists and never actually pins. So a refilter while at the
  // bottom could strand the user mid-list (Virtuoso keeps the old scrollTop
  // against new content) and, worse, a stale userScrolledUp=true would keep
  // every follow path disabled in the new view. Reset follow intent and pin:
  // the filtered history loads async, so the one pin here lands at the current
  // tail and the existing force-pin-on-item-grow + followOutput + watchdog ride
  // the new content down as it arrives. A refilter is a fresh view — bottom is
  // the right default, which is exactly what the user asked for.
  useEffect(() => {
    userScrolledUpRef.current = false
    isAtBottomRef.current = true
    setAtBottom(true)
    requestAnimationFrame(pinHard)
  }, [filterKey, pinHard])

  // TRACE (temporary diagnostic — remove once scroll is solid): make the log
  // tell the WHOLE story so the fix comes from ground truth, not theory.
  // Logs the chat's mount/unmount (to confirm or rule out remount-resets) and
  // every scroll event with its attributed cause (our pin vs. anything else).
  useEffect(() => {
    log.warn('chat-scroll', 'TRACE mount')
    return () => log.warn('chat-scroll', 'TRACE unmount')
  }, [])
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    let prevTop = Math.round(el.scrollTop)
    const onTrace = () => {
      const now = performance.now()
      const top = Math.round(el.scrollTop)
      const gap = Math.round(el.scrollHeight - (el.scrollTop + el.clientHeight))
      const dir = top > prevTop ? 'down' : top < prevTop ? 'up' : 'same'
      const cause = now < programmaticUntilRef.current ? 'pin' : 'other'
      log.warn('chat-scroll', 'TRACE scroll', {
        top, sh: el.scrollHeight, ch: el.clientHeight, gap, dir, cause,
        scrolledUp: userScrolledUpRef.current, atBottom: isAtBottomRef.current,
      })
      prevTop = top
    }
    el.addEventListener('scroll', onTrace, { passive: true })
    return () => el.removeEventListener('scroll', onTrace)
  }, [chatLogEl])


  // Terminal card hover — mouseover on .lc-terminal-card shows the terminal overlay.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    const onOver = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest('.lc-terminal-card') as HTMLElement | null
      const agentId = card?.dataset.agentId || null
      if (agentId) {
        if (termCardHideTimerRef.current) { clearTimeout(termCardHideTimerRef.current); termCardHideTimerRef.current = null }
        setTermCardHoverId(agentId)
      }
    }
    const onOut = (e: MouseEvent) => {
      const leaving = (e.target as HTMLElement).closest('.lc-terminal-card')
      const entering = (e.relatedTarget as HTMLElement | null)?.closest?.('.lc-terminal-card')
      if (leaving && !entering) {
        termCardHideTimerRef.current = setTimeout(() => setTermCardHoverId(null), 200)
      }
    }
    el.addEventListener('mouseover', onOver)
    el.addEventListener('mouseout', onOut)
    return () => { el.removeEventListener('mouseover', onOver); el.removeEventListener('mouseout', onOut) }
  }, [chatLogEl])

  // --- Shared doc: auto-create sticky when a .md file chip appears in chat ---
  // Track which messages we've already processed to avoid duplicates.
  const sharedDocProcessed = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (chatMessages.length === 0) return
    const mainEditor = (window as any).__tldraw_editor__ as any
    if (!mainEditor) return

    for (const m of chatMessages) {
      const msgKey = m._dbId != null ? `db${m._dbId}` : m._tempId ? `tmp${m._tempId}` : `${m.timestamp}:${m.from}`
      if (sharedDocProcessed.current.has(msgKey)) continue
      sharedDocProcessed.current.add(msgKey)

      // Skip messages from the human user — only auto-display agent-shared files
      if (m.from && !m.from.startsWith('fleet:')) continue

      // Extract .md file attachments (the chipifier already replaced raw paths
      // with {{att:N}} tokens — inline_attachments metadata is the sole source)
      const mdAtts: Array<{ path: string; url?: string }> = []
      if (m._inlineAttachments) {
        for (const att of m._inlineAttachments) {
          if (att?.path && /\.md$/i.test(att.path)) {
            mdAtts.push(att)
          }
        }
      }

      if (mdAtts.length === 0) continue

      // Create a sticky for each .md file found
      for (const att of mdAtts) {
        const filePath = att.path
        ;(async () => {
          try {
            // Prefer the uploaded copy (works cross-machine), fall back to direct path
            const fetchUrl = att.url || `/api/read-file?path=${encodeURIComponent(filePath)}`
            const res = await fetch(fetchUrl)
            if (!res.ok) return
            const content = await res.text()
            if (!content.trim()) return

            // Check if a shared sticky for this file already exists — update it instead
            const allShapes = mainEditor.getCurrentPageShapes()
            let existingId: string | null = null
            for (const s of allShapes) {
              if ((s as any).type === 'math-note' && (s as any).meta?.sharedDocPath === filePath) {
                existingId = s.id
                break
              }
            }

            if (existingId) {
              // Update existing sticky content + ensure backingFile and authorId are set
              const existing = mainEditor.getShape(existingId) as any
              mainEditor.updateShape({
                id: existingId,
                type: 'math-note',
                props: { text: content, backingFile: filePath },
                meta: { ...existing?.meta, authorId: existing?.meta?.authorId || m.from },
              })
              broadcastSharedDoc(existingId, filePath)
            } else {
              // Find open canvas space for the new sticky (2D grid search)
              const noteW = 550, noteH = 400, gap = 30
              const startX = 2000, startY = 100
              const blockers = allShapes.filter((s: any) =>
                s.type === 'math-note' ||
                s.type === 'fleet-docview'
              ).map((s: any) => mainEditor.getShapePageBounds(s.id)).filter(Boolean)

              let newX = startX, newY = startY
              const maxX = startX + (noteW + gap) * 4
              let placed = false
              for (let y = startY; !placed; y += noteH + gap) {
                for (let x = startX; x < maxX; x += noteW + gap) {
                  const collides = blockers.some((sb: any) =>
                    x < sb.x + sb.w + gap && x + noteW > sb.x - gap &&
                    y < sb.y + sb.h + gap && y + noteH > sb.y - gap
                  )
                  if (!collides) {
                    newX = x
                    newY = y
                    placed = true
                    break
                  }
                }
              }
              const stickyId = createShapeId()
              mainEditor.createShape({
                id: stickyId,
                type: 'math-note' as any,
                x: newX,
                y: newY,
                isLocked: false,
                props: {
                  w: 550,
                  h: 400,
                  text: content,
                  color: 'light-violet',
                  autoSize: true,
                  backingFile: filePath,
                },
                meta: {
                  sharedDocPath: filePath,
                  sharedDoc: true,
                  fromAgent: m.from,
                  authorId: m.from,
                  createdAt: Date.now(),
                },
              })
              broadcastSharedDoc(stickyId, filePath)
            }
          } catch (e) {
            console.error('[fleet] Failed to create shared doc sticky:', e)
          }
        })()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages])

  // Lightbox: click on chat-image opens full-size overlay
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return
    function onClick(e: Event) {
      // Amend version stepper ◀▶ — step through a message's versions in place.
      const amendArrow = (e.target as HTMLElement).closest('.amend-arrow') as HTMLElement | null
      if (amendArrow) {
        e.stopPropagation()
        if (amendArrow.hasAttribute('disabled')) return
        const orig = Number(amendArrow.dataset.orig)
        const total = Number(amendArrow.dataset.total) || 1
        const dir = amendArrow.dataset.dir
        if (!orig) return
        setAmendView(prev => {
          const next = new Map(prev)
          const cur = next.get(orig) ?? (total - 1)
          const nv = dir === 'back' ? Math.max(0, cur - 1) : Math.min(total - 1, cur + 1)
          next.set(orig, nv)
          return next
        })
        return
      }
      // Resend a failed ("not sent") message — re-send with the same _tempId so
      // the existing optimistic-echo reconcile clears it on success; re-mark
      // failed if it fails again.
      const resendBtn = (e.target as HTMLElement).closest('.chat-resend-btn') as HTMLElement
      if (resendBtn) {
        e.stopPropagation()
        const to = resendBtn.dataset.resendTo
        const text = resendBtn.dataset.resendText
        const tempId = resendBtn.dataset.resendTempid
        if (to && text && tempId) {
          updateOptimisticEvent(tempId, { _failed: false })
          const resendOpts: any = { _tempId: tempId }
          sendMessage(to, text, resendOpts)
            .then((r: any) => { if (!r?.ok) throw new Error('resend failed') })
            .catch(() => updateOptimisticEvent(tempId, { _failed: true }))
        }
        return
      }
      // Plan approval buttons
      const approveBtn = (e.target as HTMLElement).closest('.plan-approve-btn') as HTMLElement
      if (approveBtn) {
        e.stopPropagation()
        const agentId = approveBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'approve' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .catch(err => sendMessage(getHumanId(), `⚠️ plan approve failed: ${err.message}`, {}))
        }
        return
      }
      const supervisedBtn = (e.target as HTMLElement).closest('.plan-supervised-btn') as HTMLElement
      if (supervisedBtn) {
        e.stopPropagation()
        const agentId = supervisedBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'supervised' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .catch(err => sendMessage(getHumanId(), `⚠️ plan supervised-approve failed: ${err.message}`, {}))
        }
        return
      }
      const rejectBtn = (e.target as HTMLElement).closest('.plan-reject-btn') as HTMLElement
      if (rejectBtn) {
        e.stopPropagation()
        const agentId = rejectBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'reject' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .catch(err => sendMessage(getHumanId(), `⚠️ plan reject failed: ${err.message}`, {}))
        }
        return
      }
      // Plan mode badge click — toggle plan mode off
      const planBadge = (e.target as HTMLElement).closest('.plan-badge-click') as HTMLElement
      if (planBadge) {
        e.stopPropagation()
        const agentId = planBadge.dataset.agentId
        if (agentId) {
          const agentName = agentNamesRef.current[agentId] || agentId.replace('fleet:', '')
          fetch(`${FLEET_API}/api/plan-mode-toggle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId }),
          })
            .then(r => r.json().then(data => ({ ok: r.ok, data })))
            .then(({ ok, data }) => {
              if (!ok || data?.error) {
                sendMessage(getHumanId(), `⚠️ plan mode toggle failed for ${agentName}: ${data?.error || 'unknown error'}`, {})
              } else if (data?.mode) {
                const modeLabel = data.mode === 'plan' ? 'plan mode ✓' : data.mode === 'default' ? 'plan mode off ✓' : data.mode
                sendMessage(getHumanId(), `📋 ${agentName} → ${modeLabel}`, {})
              }
            })
            .catch(err => sendMessage(getHumanId(), `⚠️ plan mode toggle failed for ${agentName}: ${err.message}`, {}))
        }
        return
      }
      // Expand/collapse delegation message
      const lcMsg = (e.target as HTMLElement).closest('.lc-message') as HTMLElement
      if (lcMsg) {
        lcMsg.classList.toggle('lc-message-collapsed')
        return
      }
      // Approve/deny buttons on permission prompt cards
      const lcApproveBtn = (e.target as HTMLElement).closest('.lc-approve-btn') as HTMLElement | null
      if (lcApproveBtn) {
        const agentId = lcApproveBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, text: '1', enter: true }) })
          const eventId = lcApproveBtn.dataset.eventId || lcApproveBtn.closest('[data-msg-id]')?.getAttribute('data-msg-id')
          if (eventId) {
            fetch(`${FLEET_API}/api/prompt-respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, response: 'approved' }) })
              .then(r => { if (r.ok) updateEventById(eventId, { _promptResponse: 'approved', metadata: { approvedAt: new Date().toISOString() } }) })
              .catch(e => console.warn('[fleet-chat] prompt approve failed:', e.message))
          }
          return
        }
      }
      const lcDenyBtn = (e.target as HTMLElement).closest('.lc-deny-btn') as HTMLElement | null
      if (lcDenyBtn) {
        const agentId = lcDenyBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, text: '3', enter: true }) })
          const eventId = lcDenyBtn.dataset.eventId || lcDenyBtn.closest('[data-msg-id]')?.getAttribute('data-msg-id')
          if (eventId) {
            fetch(`${FLEET_API}/api/prompt-respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, response: 'rejected' }) })
              .then(r => { if (r.ok) updateEventById(eventId, { _promptResponse: 'rejected', metadata: { rejectedAt: new Date().toISOString() } }) })
              .catch(e => console.warn('[fleet-chat] prompt reject failed:', e.message))
          }
          return
        }
      }
      // Bullet card "go" button — navigate to note shape + highlight bullet
      const bulletGoBtn = (e.target as HTMLElement).closest('.bullet-card-go') as HTMLElement | null
      if (bulletGoBtn) {
        e.stopPropagation()
        const sid = bulletGoBtn.dataset.shapeId
        const tupleStr = bulletGoBtn.dataset.bulletTuple
        const idx = parseInt(bulletGoBtn.dataset.bulletIdx || '', 10)
        if (sid) {
          const mainEd = (window as any).__tldraw_editor__ || editor
          const noteShape = mainEd.getShape(sid as any)
          if (noteShape) {
            const bounds = mainEd.getShapePageBounds(noteShape.id)
            if (bounds) {
              mainEd.centerOnPoint({ x: bounds.midX, y: bounds.midY }, { animation: { duration: 300 } })
              mainEd.select(noteShape.id)
              setTimeout(() => {
                const el = document.querySelector(`[data-shape-id="${sid}"]`)
                if (!el) return
                let targetLi: Element | null = null
                if (tupleStr) {
                  // Follow tuple path: [i, j, k] → root list → i-th li → nested list → j-th li → ...
                  try {
                    const tuple = JSON.parse(tupleStr) as number[]
                    let scope: Element = el.querySelector('.math-note-prose') || el
                    for (const idx of tuple) {
                      const list = scope.tagName === 'LI' ? scope.querySelector('ul, ol') : scope.querySelector('ul, ol')
                      if (!list) break
                      const lis = Array.from(list.children).filter(c => c.tagName === 'LI')
                      if (idx < lis.length) {
                        targetLi = lis[idx]
                        scope = lis[idx]
                      } else break
                    }
                  } catch {}
                } else if (!isNaN(idx) && idx >= 0) {
                  // Legacy flat index
                  const lis = el.querySelectorAll('.math-note-prose li')
                  targetLi = lis[idx] || null
                }
                if (targetLi) {
                  targetLi.classList.add('bullet-flash')
                  setTimeout(() => targetLi!.classList.remove('bullet-flash'), 1500)
                }
              }, 400)
            }
          }
        }
        return
      }
      // Terminal lifecycle card — click to pin/unpin terminal
      const termCard = (e.target as HTMLElement).closest('.lc-terminal-card') as HTMLElement | null
      if (termCard) {
        const agentId = termCard.dataset.agentId
        if (agentId) {
          setTermCardPinnedId(prev => prev === agentId ? null : agentId)
          return
        }
      }
      // Build result card — toggle expand/collapse
      const buildHeader = (e.target as HTMLElement).closest('.build-result-header') as HTMLElement
      if (buildHeader) {
        const card = buildHeader.closest('.build-result-card') as HTMLElement
        if (card) {
          card.classList.toggle('build-result-expanded')
          return
        }
      }
      // Code block fold/unfold — track in expandedRowsRef so state survives re-renders
      const codeToggle = (e.target as HTMLElement).closest('.code-block-toggle') as HTMLElement
      if (codeToggle) {
        const wrap = codeToggle.closest('.code-block-wrap') as HTMLElement
        const itemRow = codeToggle.closest('[data-item-key]') as HTMLElement
        if (wrap && itemRow) {
          const itemKey = itemRow.getAttribute('data-item-key')
          const allWraps = Array.from(itemRow.querySelectorAll('.code-block-wrap'))
          const idx = allWraps.indexOf(wrap)
          const key = `${itemKey}:code:${idx}`
          const pre = wrap.querySelector('pre')
          if (pre) {
            // Inline onclick already toggled the class, so check current state
            const isNowExpanded = !pre.classList.contains('code-collapsed')
            if (isNowExpanded) expandedRowsRef.current.add(key)
            else expandedRowsRef.current.delete(key)
          }
        }
      }
      // Expand tool result (show more search results / earlier thread messages)
      const expandBtn = (e.target as HTMLElement).closest('.pretty-expand-btn') as HTMLElement
      if (expandBtn) {
        const moreRows = expandBtn.parentElement?.querySelector('.pretty-more-rows') as HTMLElement
        if (moreRows) {
          const wasExpanded = moreRows.style.display !== 'none'
          moreRows.style.display = wasExpanded ? 'none' : ''
          expandBtn.textContent = wasExpanded ? expandBtn.textContent! : 'collapse'
          const itemKey = expandBtn.closest('[data-item-key]')?.getAttribute('data-item-key')
          if (itemKey) {
            if (wasExpanded) expandedRowsRef.current.delete(itemKey)
            else expandedRowsRef.current.add(itemKey)
          }
        }
        return
      }
      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement
      if (!img) return
      e.stopPropagation()
      const overlay = document.createElement('div')
      overlay.className = 'chat-lightbox'
      overlay.innerHTML = `<img src="${img.src}" alt="${img.alt || ''}">`
      overlay.addEventListener('click', () => overlay.remove())
      document.body.appendChild(overlay)
    }
    logEl.addEventListener('click', onClick)
    return () => logEl.removeEventListener('click', onClick)
  }, [chatLogEl])

  // Unquote: double-click on <code> spans inside chat messages.
  // TLDraw intercepts the native dblclick event in its capture-phase handler on .tl-canvas,
  // so we detect double-click via two consecutive click events on the same <code> element.
  // click events reach bubble phase normally (markEventAsHandled on pointerdown handles TLDraw).
  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    function isLatexLabel(text: string): boolean {
      if (/^https?:/i.test(text)) return false
      return /^[a-z][a-z0-9]{0,9}:[a-z][a-z0-9_.-]{0,50}$/i.test(text)
    }

    function matchesUnquotePattern(text: string): boolean {
      if (!text || text.length > 500) return false
      if (/^https?:\/\/\S+/.test(text)) return true
      if (/^\/\S+/.test(text)) return true
      if (/^~\/\S+/.test(text)) return true
      // Relative paths: no spaces, contains / or ends with a known file extension
      if (!/\s/.test(text) && (/\//.test(text) || /\.(png|jpg|jpeg|gif|svg|pdf|tex|md|r|py|js|mjs|ts|json|csv|txt|log)$/i.test(text))) return true
      if (isLatexLabel(text)) return true
      return false
    }

    function isFilePath(text: string): boolean {
      return text.startsWith('/') || text.startsWith('~/') || (!/\s/.test(text) && (/\//.test(text) || /\.(png|jpg|jpeg|gif|svg|pdf|tex|md|r|py|js|mjs|ts|json|csv|txt|log)$/i.test(text)))
    }

    function applyTierLabel(codeEl: HTMLElement, text: string) {
      const html = linkifyLabelRefs(text, labelRegionsRef.current)
      const wrapper = document.createElement('span')
      wrapper.innerHTML = html
      codeEl.replaceWith(...Array.from(wrapper.childNodes))
    }

    function applyTier1(codeEl: HTMLElement, text: string) {
      const rendered = renderMarkdownUtil(esc(text))
      const wrapper = document.createElement('span')
      wrapper.innerHTML = rendered
      codeEl.replaceWith(...Array.from(wrapper.childNodes))
    }

    async function applyTier2(codeEl: HTMLElement, text: string, eventId: string, agentId: string) {
      const spinner = document.createElement('span')
      spinner.textContent = '⏳'
      spinner.style.opacity = '0.6'
      codeEl.replaceWith(spinner)

      try {
        const resp = await fetch('/api/unquote-file', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: parseInt(eventId, 10), path: text, agentId }),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const { resolvedMessage, inlineAttachments } = await resp.json()
        const rendered = resolveInlineAttachments(resolvedMessage, inlineAttachments || [], renderMarkdownUtil)
        const wrapper = document.createElement('span')
        wrapper.innerHTML = rendered
        spinner.replaceWith(...Array.from(wrapper.childNodes))
      } catch {
        const fallback = document.createElement('span')
        fallback.textContent = text
        fallback.title = 'Unquote failed — file not found or daemon unreachable'
        fallback.style.opacity = '0.5'
        spinner.replaceWith(fallback)
      }
    }

    let lastClickEl: HTMLElement | null = null
    let lastClickTime = 0
    let pendingTimer: ReturnType<typeof setTimeout> | null = null

    function clearPending() {
      if (lastClickEl) lastClickEl.classList.remove('code-unquote-pending')
      lastClickEl = null
      lastClickTime = 0
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    }

    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      const codeEl = target.closest('code') as HTMLElement | null
      if (!codeEl) { clearPending(); return }

      const chatLine = codeEl.closest('.chat-line') as HTMLElement | null
      if (!chatLine) { clearPending(); return }

      const text = codeEl.textContent || ''
      if (!matchesUnquotePattern(text)) { clearPending(); return }

      const now = Date.now()
      if (lastClickEl === codeEl && now - lastClickTime < 1000) {
        // Second click within 500ms on the same element = double-click
        clearPending()
        e.preventDefault()
        e.stopPropagation()
        if (isLatexLabel(text)) {
          applyTierLabel(codeEl, text)
        } else if (isFilePath(text)) {
          const eventId = chatLine.dataset.msgId || ''
          const agentId = chatLine.dataset.msgFrom || ''
          applyTier2(codeEl, text, eventId, agentId)
        } else {
          applyTier1(codeEl, text)
        }
      } else {
        clearPending()
        lastClickEl = codeEl
        lastClickTime = now
        codeEl.classList.add('code-unquote-pending')
        pendingTimer = setTimeout(clearPending, 1000)
      }
    }

    logEl.addEventListener('click', onClick)
    return () => logEl.removeEventListener('click', onClick)
  }, [chatLogEl])

  // Track clicks to determine which fleet chat shape the user is interacting with.
  // Escape interrupt scopes to the shape the user last clicked on.
  useEffect(() => {
    function onPointerDownForEsc(e: PointerEvent) {
      const container = shapeContainerRef.current
      if (!container) return
      chatActiveRef.current = container.contains(e.target as Node)
    }
    document.addEventListener('pointerdown', onPointerDownForEsc, true)
    return () => document.removeEventListener('pointerdown', onPointerDownForEsc, true)
  }, [])

  // Esc interrupt — document-level listener, scoped to fire only when the user
  // last clicked inside this fleet chat shape (chatActiveRef).
  // Three tiers: 1×Esc = soft (single Escape to tmux), 2×Esc = hard (Escape+poll loop),
  // 3×Esc = kill session (tmux kill-session, agent dies immediately).
  useEffect(() => {
    let escTempCounter = 0
    function onEscKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!chatActiveRef.current) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (ta && ta.value !== '') return
      const targets = sendTargetsRef.current
      if (targets.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const now = Date.now()
      setUnqueuedAt(now)
      const agent = resolveToFleetIdRef.current(targets[0])
      // Escalation is action-based: each Esc increments; any non-Esc action
      // (keydown, pointer, message send) resets. No timing window.
      escCountRef.current++
      const count = escCountRef.current
      const agentLabel = agentNamesRef.current[agent] || agent.replace('fleet:', '')
      log.info('esc', 'interrupt', { count, agent, agentLabel })
      const tempId = `esc-${++escTempCounter}-${now}`
      const ts = new Date().toISOString()
      setEscLevel(agent, count >= 3 ? 3 : count)
      if (count >= 3) {
        escCountRef.current = 0
        injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `💀 Killing ${agentLabel}…`, timestamp: ts })
        fetch(`${FLEET_API}/api/kill-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
          .then(r => r.json())
          .then(d => {
            updateOptimisticEvent(tempId, { text: d.error ? `⚠ Kill failed: ${d.error}` : `💀 Killed ${agentLabel}` })
            if (!d.error) confirmEscLevel(agent, 3)
            setTimeout(() => clearEscState(agent), 2000)
          })
          .catch(() => { updateOptimisticEvent(tempId, { text: `⚠ Kill failed (server unreachable)` }) })
      } else if (count === 2) {
        fetch(`${FLEET_API}/api/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
          .then(r => r.json())
          .then(d => {
            if (d.error) injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `⚠ Interrupt failed: ${d.error}`, timestamp: ts })
            else confirmEscLevel(agent, 2)
          })
          .catch(() => { injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `⚠ Interrupt failed (server unreachable)`, timestamp: ts }) })
      } else {
        injectOptimisticEvent({ _tempId: tempId, _evType: 'system_notice', _isInterrupt: true, from: 'system', to: agent, text: `⏸ Escape → ${agentLabel}…`, timestamp: ts })
        fetch(`${FLEET_API}/api/send-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, key: 'Escape' }) })
          .then(r => r.json())
          .then(d => {
            if (d.error) { updateOptimisticEvent(tempId, { text: `⚠ Escape failed: ${d.error}` }) }
            else { updateOptimisticEvent(tempId, { text: `⏸ Escape → ${agentLabel}` }); confirmEscLevel(agent, 1) }
          })
          .catch(() => { updateOptimisticEvent(tempId, { text: `⚠ Escape failed (server unreachable)` }) })
      }
    }
    function resetEscState() {
      if (escCountRef.current === 0) return
      escCountRef.current = 0
      setEscalationState({})
    }
    function onNonEscKey(e: KeyboardEvent) {
      if (e.key === 'Escape') return
      resetEscState()
    }
    function onPointerDownReset() {
      if (!chatActiveRef.current) return
      resetEscState()
    }
    document.addEventListener('keydown', onEscKey, true)
    document.addEventListener('keydown', onNonEscKey, true)
    document.addEventListener('pointerdown', onPointerDownReset, true)
    return () => {
      document.removeEventListener('keydown', onEscKey, true)
      document.removeEventListener('keydown', onNonEscKey, true)
      document.removeEventListener('pointerdown', onPointerDownReset, true)
    }
  }, [])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = agentDisplayName(a)
    }
    if (getHumanId()) map[getHumanId()] = getHumanName() || 'user'
    return map
  }, [agents])

  // Detect pill drag hovering over this chat — returns stable string to avoid flicker
  // Only agent/label pills trigger filter overlay, not content pills (msg, code, etc.)
  const pillOverKey = useValue('pill-over', () => {
    const pills = editor.getCurrentPageShapes().filter(s => (s.type as string) === 'fleet-pill') as any[]
    if (pills.length === 0) return ''
    const myBounds = editor.getShapePageBounds(shape.id)
    if (!myBounds) return ''
    for (const pill of pills) {
      const props = pill.props
      if (props.pillType !== 'agent' && props.pillType !== 'label') continue
      const pb = editor.getShapePageBounds(pill.id)
      if (!pb) continue
      const cx = pb.x + pb.w / 2
      const cy = pb.y + pb.h / 2
      if (cx >= myBounds.x && cx <= myBounds.x + myBounds.w &&
          cy >= myBounds.y && cy <= myBounds.y + myBounds.h) {
        const role = cy < myBounds.y + myBounds.h / 2 ? 'to' : 'from'
        return `${role}\0${props.value}\0${props.displayName}`
      }
    }
    return ''
  }, [editor, shape.id])
  const pillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [role, value, displayName] = pillOverKey.split('\0')
    return { role, value, displayName }
  }, [pillOverKey])

  // Auto-open filter overlay when pill hovers over this chat
  useEffect(() => {
    if (pillOver && !filterOpen) {
      setFilterOpenByPill(true)
      setFilterOpen(true)
    } else if (!pillOver && filterOpenByPill) {
      setFilterOpenByPill(false)
      setFilterOpen(false)
    }
  }, [!!pillOver])

  // Derive send targets: unique agents in "to" clauses only
  const sendTargets = useMemo(() => {
    const seen = new Set<string>()
    for (const clause of filter) {
      for (const [role, label] of clause) {
        if (role === 'to') seen.add(label)
      }
    }
    return [...seen]
  }, [filterKey])
  sendTargetsRef.current = sendTargets

  // Resolve a send-target label to an agent. The friendly name is an opaque
  // atom — you address an agent by its exact full name (or id, or a label it
  // carries). No suffix games: dawn is "base", day is "base:day", etc.
  const resolveTargetAgent = useCallback((label: string, agentList: any[]) => {
    if (label.startsWith('fleet:')) return agentList.find((a: any) => a.id === label) || null
    return agentList.find((a: any) => a.friendly_name === label || a.id === label || (a.labels || []).includes(label)) || null
  }, [])

  const hoverTargetAgentId = useMemo(() => {
    const diag: any[] = []
    for (const label of sendTargets) {
      const agent = resolveTargetAgent(label, agents)
      diag.push({ label, fleetId: agent?.id || label, found: !!agent, tmux: agent?.tmux_session || null, dead: agent?.dead ?? null })
      if (agent?.tmux_session && !agent?.dead) {
        log.info('terminal-icon', 'resolved target', { sendTargets, fleetId: agent.id, diag, agentCount: agents.length })
        return agent.id
      }
    }
    log.info('terminal-icon', 'no terminal target', { sendTargets, diag, agentCount: agents.length })
    return null
  }, [sendTargets, agents, resolveTargetAgent])

  const deadTargetAgent = useMemo(() => {
    for (const label of sendTargets) {
      const agent = resolveTargetAgent(label, agents)
      if (agent?.dead) return { id: agent.id, name: agent.friendly_name || agent.id.replace('fleet:', '') }
    }
    return null
  }, [sendTargets, agents, resolveTargetAgent])

  // Reset auto-pin tracking when the target agent changes
  useEffect(() => {
    termAutoPinnedRef.current = false
    lastAttentionTsRef.current = null
  }, [hoverTargetAgentId])

  // (Terminal auto-pin on permission prompts removed — chat cards handle this now)

  // Detect impossible filter: filter is set but no AND group can match any known agent
  const isImpossibleFilter = useMemo(() => {
    if (filter.length === 0) return false
    const allIds = agents.map((a: any) => {
      const labels = [...(a.labels || []), a.friendly_name, a.id].filter(Boolean)
      return { id: a.id, labels }
    })
    // Also include human
    if (getHumanId()) allIds.push({ id: getHumanId(), labels: [getHumanName() || 'user', getHumanId()] })
    // For each OR clause, check if there's any agent that matches ALL terms
    return !filter.some(clause =>
      allIds.some(agent =>
        clause.every(([_role, label]) => agent.labels.includes(label))
      )
    )
  }, [filterKey, agents])

  // Resolve the filter to the fleet-id set for history paging — same resolver
  // as the initial load and the live display. null = no filter (unfiltered
  // view loads global history); [] = filtered but nothing resolved yet (don't
  // fall back to global history inside a filtered view).
  const loadBeforeAgents = useMemo<string[] | null>(
    () => (dnfFilter ? [...resolveFilter(dnfFilter)] : null),
    // filterKey is the stable string encoding of dnfFilter (avoids re-running on
    // a fresh array identity each render); resolveFilter is a stable module import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, agents]
  )

  // Infinite scroll — load older messages
  const loadingMore = useRef(false)
  const handleScroll = useCallback(async (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop > 50 || loadingMore.current || chatMessages.length === 0) return
    // Filtered view that hasn't resolved to any id yet — don't page in global history.
    if (loadBeforeAgents !== null && loadBeforeAgents.length === 0) return
    loadingMore.current = true
    const oldestTs = chatMessages[0]?.timestamp
    if (oldestTs) {
      const prevHeight = el.scrollHeight
      // Older rows fold into the single store (deduped by id); the view re-renders
      // off the store. Restore scroll position so the viewport doesn't jump.
      await loadBefore(loadBeforeAgents || [], oldestTs, 50)
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    }
    loadingMore.current = false
  }, [chatMessages, loadBeforeAgents])

  // Attach scroll + click handlers to the Virtuoso-owned scroll container.
  // Listener-based (not JSX prop) because the Scroller is memoized and
  // doesn't close over changing callbacks.
  useEffect(() => {
    const el = chatLogEl
    if (!el) return
    const onScroll = (e: Event) => handleScroll(e as any)
    const onClick = (e: Event) => handleDocLinkClick(e as any)
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('click', onClick)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('click', onClick)
    }
  }, [chatLogEl, handleScroll, handleDocLinkClick])

  // Auto-load more history when content doesn't fill the scroll container.
  // Without this, if initial messages are too few to create a scrollbar,
  // handleScroll never fires and the user can't get more messages.
  useEffect(() => {
    const el = chatLogEl
    // Auto-load only for a resolved filtered view (a specific id set) — not for
    // the unfiltered view (null) and not while a filter is still unresolved ([]).
    if (!el || loadingMore.current || chatMessages.length === 0 || !loadBeforeAgents || loadBeforeAgents.length === 0) return
    if (el.scrollHeight > el.clientHeight) return
    const oldestTs = chatMessages[0]?.timestamp
    if (!oldestTs) return
    loadingMore.current = true
    loadBefore(loadBeforeAgents, oldestTs, 50).then(() => {
      // Older rows fold into the single store; the view re-renders off it.
      loadingMore.current = false
    })
  }, [chatLogEl, chatMessages, loadBeforeAgents])

  // --- Chat log drag → ghost pill ---
  // Uses native capture-phase listeners because tldraw intercepts React events
  const DRAG_THRESHOLD = 5
  const dragRef = useRef<{
    pillId: string | null
    pillType: string
    value: string
    displayName: string
    color: string
    content?: string
    sourceAgent?: string
    filePath?: string
    fileUrl?: string
    startX: number
    startY: number
    started: boolean
    captureEl: HTMLElement | null
    pointerId: number
  } | null>(null)

  // Store agentNames in a ref so native listeners can access current value
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames
  const resolveToFleetIdRef = useRef(resolveToFleetId)
  resolveToFleetIdRef.current = resolveToFleetId

  // Store shape.id in a ref so document-level listeners can access it
  const shapeIdRef = useRef(shape.id)
  shapeIdRef.current = shape.id

  // Track selection state via ref so native capture listeners can read it.
  // useValue makes this reactive — component re-renders when selection changes,
  // keeping isSelectedRef.current fresh. Without this, the ref is always stale
  // because tldraw doesn't re-render shapes on selection changes.
  const isSelectedRef = useRef(false)
  isSelectedRef.current = useValue('isSelected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])

  useEffect(() => {
    const logEl = chatLogEl
    if (!logEl) return

    // Document-level capture listeners: fires before tldraw's tl-container
    // listener can intercept. We scope to this chat by checking if the target
    // is inside our logEl.

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!logEl!.contains(target)) return

      // If this shape is selected for drag/resize (fleet-drag-mode), let
      // TLDraw handle everything — don't intercept pointer events.
      if (isSelectedRef.current) return

      // Only proceed with drag logic on draggable elements.
      // Large items (activity cards, code block headers, tool lines) require
      // clicking on their .drag-handle left-edge element. Small inline items
      // (chips, timestamps) are draggable from the whole element.
      const isDraggable = target.closest(
        '.drag-handle, .chat-ts, .tool-ref, .md-file-card, .ref-chip[data-doc], .tlda-card, .build-result-card, .ref-chip-annotation, .ref-chip:not(.ref-chip-annotation), .pretty-search-ts, .agent-nick'
      )

      if (!isDraggable) {
        // Non-drag click — mark handled so tldraw skips setPointerCapture,
        // but let the event propagate to the target so the browser can start
        // text selection naturally (requires user-select:text on .chat-line).
        editor.markEventAsHandled(e)
        return
      }

      const names = agentNamesRef.current

      let drag: typeof dragRef.current = null

      // Lifecycle cards (delegate, task_done, bounced) — drag from their drag-handle
      {
        const lcCard = target.closest('.lifecycle-card') as HTMLElement
        if (lcCard && target.closest('.drag-handle')) {
          const chatLine = lcCard.closest('.chat-line') as HTMLElement
          const lcDbId = chatLine?.dataset.msgId || ''
          const lcFrom = chatLine?.dataset.msgFrom || ''
          const lcTs = chatLine?.dataset.msgTs || ''
          const lcType = lcCard.dataset.lcType || 'delegate'
          const lcNick = names[lcFrom] || lcFrom.replace('fleet:', '')
          const lcTime = lcTs ? new Date(lcTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
          const lcTitle = lcCard.querySelector('.lc-title')?.textContent || lcType
          drag = {
            pillId: null, pillType: 'msg', value: lcDbId ? `msg:${lcDbId}` : `msg:${lcFrom}:${lcTs}`,
            displayName: `${lcNick} ${lcTime} ${lcTitle}`.trim(),
            color: '#c8b060', content: lcCard.textContent?.slice(0, 300)?.trim() || '',
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Timestamp → message reference (works in main chat, search results, thread views)
      {
        const tsEl = target.closest('.chat-ts, .pretty-search-ts, .pretty-ts') as HTMLElement
        if (tsEl) {
          const line = tsEl.closest('.chat-line, .pretty-search-row, .pretty-thread-msg') as HTMLElement
          if (line) {
            const from = line.dataset.msgFrom || ''
            const ts = line.dataset.msgTs || tsEl.getAttribute('title') || tsEl.textContent || ''
            const dbId = line.dataset.msgId || ''
            const text = line.textContent?.slice(0, 200)?.trim() || ''
            const nick = from ? (names[from] || from.replace('fleet:', '')) : ''
            drag = {
              pillId: null, pillType: 'msg', value: dbId ? `msg:${dbId}` : `msg:${from}:${ts}`,
              displayName: `${nick} ${tsEl.textContent || ''} chat`.trim(),
              color: '#8888a0', content: text,
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Tool line (individual tool call row in activity card) — must check BEFORE
      // activity card since tool lines are nested inside activity cards.
      if (!drag) {
        const toolLine = target.closest('.tool-line') as HTMLElement
        if (toolLine) {
          const toolName = toolLine.dataset.toolName || toolLine.querySelector('.tool-name')?.textContent || 'tool'
          const toolArg = toolLine.dataset.toolArg || toolLine.querySelector('.tool-arg')?.textContent || ''
          // Get DB ID from the parent activity card + line number for highlighting
          const activityCard = toolLine.closest('.chat-activity-card') as HTMLElement
          const toolDbId = activityCard?.dataset.msgId || ''
          const lineNum = toolLine.dataset.line || ''
          const toolTs = activityCard?.dataset.ts || ''
          const toolNick = names[activityCard?.dataset.agent || ''] || ''
          const toolTime = toolTs ? new Date(toolTs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
          drag = {
            pillId: null, pillType: 'tool', value: toolDbId ? `activity:${toolDbId}:line${lineNum}` : `tool:unknown`,
            displayName: `${toolNick} ${toolTime} ${toolName}`.trim(),
            color: '#c8b060', content: toolArg ? `${toolName}: ${toolArg}` : toolName,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Activity card (only when NOT dragging from inside a tool line or md-file chip)
      if (!drag) {
        const actCard = target.closest('.chat-activity-card') as HTMLElement
        if (actCard && !target.closest('.md-file-card')) {
          const agentId = actCard.dataset.agent || ''
          const ts = actCard.dataset.ts || ''
          const actDbId = actCard.dataset.msgId || ''
          const text = actCard.textContent?.slice(0, 300)?.trim() || ''
          const nick = names[agentId] || agentId.replace('fleet:', '')
          const actTime = ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
          drag = {
            pillId: null, pillType: 'activity', value: actDbId ? `activity:${actDbId}` : `activity:${agentId}:${ts}`,
            displayName: `${nick} ${actTime} activity`.trim(),
            color: '#c8b060', content: text,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Code block header (but not the copy button or md-file chip — let those through)
      if (!drag) {
        const codeHeader = target.closest('.code-block-header') as HTMLElement
        if (codeHeader && !target.closest('.code-block-copy') && !target.closest('.md-file-card')) {
          const wrap = codeHeader.closest('.code-block-wrap')
          const code = wrap?.querySelector('pre code')
          if (code) {
            const langEl = codeHeader.querySelector('.code-block-lang')
            drag = {
              pillId: null, pillType: 'code', value: 'code',
              displayName: langEl?.textContent || 'code',
              color: '#6aafb0', content: code.textContent || '',
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Tool ref
      if (!drag) {
        const toolRef = target.closest('.tool-ref') as HTMLElement
        if (toolRef) {
          const preview = toolRef.querySelector('.tool-ref-preview')
          drag = {
            pillId: null, pillType: 'tool', value: 'tool',
            displayName: toolRef.querySelector('.tool-ref-type')?.textContent || 'tool',
            color: '#c8b060', content: (preview?.textContent || toolRef.textContent || '').trim(),
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // MD file card or shared-doc ref-chip → drag as doc reference
      if (!drag) {
        const mdCard = target.closest('.md-file-card, .ref-chip[data-doc]') as HTMLElement
        if (mdCard) {
          const filePath = mdCard.dataset.path || ''
          const docName = mdCard.dataset.doc || ''
          // Prefer data-title (set by renderAttachChip for shared-doc chips), then chip text, then filename
          const name = mdCard.dataset.title || mdCard.querySelector('.md-file-chip')?.textContent || mdCard.textContent?.trim() || filePath.split('/').pop() || 'file'
          // Use doc:name for tlda-shared docs so canvas drop creates inline-doc; file: for local files
          const value = docName ? `doc:${docName}` : `file:${filePath}`
          drag = {
            pillId: null, pillType: 'doc' as any, value,
            displayName: name, color: '#63a0db', content: filePath || docName,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }
      if (!drag) {
        const tldaCard = target.closest('.tlda-card') as HTMLElement
        if (tldaCard) {
          const tldaSrc = tldaCard.dataset.tldaSrc || ''
          const docName = tldaCard.querySelector('.doc-name')?.textContent || ''
          // Use 'tlda:URL' to carry the full src URL for inline-doc creation
          drag = {
            pillId: null, pillType: 'doc' as any, value: `tlda:${tldaSrc}`,
            displayName: docName, color: '#9370db', content: docName,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Annotation ref-chip → drag as note (creates collapsed math-note on canvas drop)
      if (!drag) {
        const refChip = target.closest('.ref-chip-annotation') as HTMLElement
        if (refChip) {
          // Get label text excluding location badge and dot elements
          const clone = refChip.cloneNode(true) as HTMLElement
          clone.querySelectorAll('.ref-chip-loc, .ref-chip-dot, .ref-chip-preview').forEach(el => el.remove())
          const label = clone.textContent?.trim() || 'note'
          // Use the stored token (contains embedded shapeId for new chips)
          const token = refChip.dataset.token || `«annotation:${label}»`
          const embShapeId = token.match(/#(shape:[^»]+)»/)?.[1]
          const srcShape = embShapeId ? editor.getShape(embShapeId as any) as any : null
          const dotEl = refChip.querySelector('.ref-chip-dot') as HTMLElement | null
          const chipColor = dotEl?.style.background || srcShape?.props?.color || '#3b82f6'
          drag = {
            pillId: null, pillType: 'annotation' as any, value: token,
            displayName: label, color: chipColor,
            content: srcShape?.props?.text || label,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // File ref-chip → drag as note (creates collapsed math-note on canvas drop)
      if (!drag) {
        const fileChip = target.closest('.ref-chip:not(.ref-chip-annotation)') as HTMLElement
        if (fileChip) {
          const token = fileChip.dataset.token || ''
          const fileUrl = fileChip.dataset.url || ''
          const clone = fileChip.cloneNode(true) as HTMLElement
          clone.querySelectorAll('.ref-chip-preview').forEach(el => el.remove())
          const label = clone.textContent?.trim() || 'file'
          // Fetch file content from URL for the drop (async, updates content before drop)
          // Resolve absolute image paths in the markdown; warn about relative paths
          let fileContent = label
          if (fileUrl) {
            fetch(fileUrl).then(r => r.ok ? r.text() : label).then(async (text) => {
              const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
              let resolved = text
              let hasUnresolved = false
              const uploads: Promise<void>[] = []
              let match: RegExpExecArray | null
              while ((match = imgRe.exec(text)) !== null) {
                const imgPath = match[2]
                if (imgPath.startsWith('http')) continue
                if (!imgPath.startsWith('/')) { hasUnresolved = true; continue }
                uploads.push((async () => {
                  try {
                    const readRes = await fetch(`/api/read-file?path=${encodeURIComponent(imgPath)}`)
                    if (!readRes.ok) { hasUnresolved = true; return }
                    const blob = await readRes.blob()
                    const fd = new FormData()
                    fd.append('file', blob, imgPath.split('/').pop() || 'image.png')
                    const upRes = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: fd })
                    if (!upRes.ok) { hasUnresolved = true; return }
                    const { url } = await upRes.json()
                    resolved = resolved.split(`](${imgPath})`).join(`](${FLEET_API}${url})`)
                  } catch { hasUnresolved = true }
                })())
              }
              await Promise.all(uploads)
              if (hasUnresolved) {
                resolved += '\n\n⚠️ Some embedded images couldn\'t be resolved. Drag the containing folder instead of the file to include all images.'
              }
              if (dragRef.current) dragRef.current.content = resolved
            }).catch(e => console.warn('[fleet-chat] file content resolve failed:', e.message))
          }
          const chatLine = fileChip.closest('[data-msg-from]') as HTMLElement | null
          const filePath = fileChip.dataset.path || ''
          drag = {
            pillId: null, pillType: 'file' as any, value: token,
            displayName: label, color: '#9370db',
            content: fileContent, sourceAgent: chatLine?.dataset.msgFrom || undefined,
            filePath, fileUrl,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Agent nick → drag as agent filter pill
      if (!drag) {
        const nickEl = target.closest('.agent-nick') as HTMLElement
        if (nickEl) {
          const agentId = nickEl.dataset.agentId || ''
          const agentName = names[agentId] || agentId.replace('fleet:', '')
          drag = {
            pillId: null, pillType: 'agent' as any, value: agentName,
            displayName: agentName, color: '#7a9ec8',
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      if (!drag) return

      e.stopImmediatePropagation()
      e.preventDefault()
      dragRef.current = drag

      // Use shared drag coordinator instead of per-drag capture listeners
      dragCoordinator.claim(onPointerMove, onPointerUp)
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      // stopImmediatePropagation/preventDefault handled by dragCoordinator
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (!drag.started) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        drag.started = true
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
          props: {
            w: 70, h: 18,
            pillType: drag.pillType,
            value: drag.value,
            displayName: drag.displayName,
            color: drag.color,
          },
          meta: {
            ...(drag.sourceAgent ? { sourceAgent: drag.sourceAgent } : {}),
            ...(drag.filePath ? { filePath: drag.filePath } : {}),
            ...(drag.fileUrl ? { fileUrl: drag.fileUrl } : {}),
          },
        })
        drag.pillId = pillId as unknown as string
        // Reset tldraw's state machine via API — avoids cancelling the real pointer stream.
        editor.cancel()
      }
      if (drag.pillId) {
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        editor.updateShape({
          id: drag.pillId as any,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
        })
      }

      // Membrane handoff: when pointer leaves the chat, move the pill
      // from the panel editor to the main editor (and vice versa)
      const isMembraneType = drag.pillType === 'doc' || drag.pillType === 'annotation' || drag.pillType === 'file'
      if (drag.started && isMembraneType && drag.pillId) {
        const mainEditor = (window as any).__tldraw_editor__ as any
        const chatEl = logEl!.closest('[data-shape-id]') as HTMLElement | null
        const chatRect = chatEl?.getBoundingClientRect()
        const outside = chatRect && (
          e.clientX < chatRect.left || e.clientX > chatRect.right ||
          e.clientY < chatRect.top || e.clientY > chatRect.bottom
        )

        if (mainEditor && mainEditor !== editor) {
          const onMain = !!(drag as any)._onMain
          if (outside && !onMain) {
            // Handoff: panel → main
            try { editor.deleteShapes([drag.pillId as any]) } catch {}
            const mainPos = mainEditor.screenToPage({ x: e.clientX, y: e.clientY })
            mainEditor.createShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: mainPos.x - 5,
              y: mainPos.y - 5,
              props: {
                w: 10, h: 10,
                pillType: drag.pillType,
                value: drag.value,
                displayName: drag.displayName,
                color: drag.color,
              },
              meta: {
                ...(drag.sourceAgent ? { sourceAgent: drag.sourceAgent } : {}),
                ...(drag.filePath ? { filePath: drag.filePath } : {}),
                ...(drag.fileUrl ? { fileUrl: drag.fileUrl } : {}),
              },
            })
            ;(drag as any)._onMain = true
          } else if (!outside && onMain) {
            // Handoff back: main → panel
            try { mainEditor.deleteShapes([drag.pillId as any]) } catch {}
            const panelPos = editor.screenToPage({ x: e.clientX, y: e.clientY })
            editor.createShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: panelPos.x - 35,
              y: panelPos.y - 9,
              props: {
                w: 70, h: 18,  // chip form inside panel
                pillType: drag.pillType,
                value: drag.value,
                displayName: drag.displayName,
                color: drag.color,
              },
            })
            ;(drag as any)._onMain = false
          } else if (onMain) {
            // Move on main editor
            const mainPos = mainEditor.screenToPage({ x: e.clientX, y: e.clientY })
            mainEditor.updateShape({
              id: drag.pillId as any,
              type: 'fleet-pill' as any,
              x: mainPos.x - 5,
              y: mainPos.y - 5,
            })
            // Skip the panel updateShape below
            return
          }
        }
      }

      // Membrane glow: when dragging an annotation/doc pill near the fleet-chat edge
      if (drag.started && (drag.pillType === 'annotation' || drag.pillType === 'doc')) {
        const shapeEl = logEl!.closest('.fleet-shape') as HTMLElement | null
        if (shapeEl) {
          const rect = shapeEl.getBoundingClientRect()
          const edgeDist = Math.min(
            e.clientX - rect.left, rect.right - e.clientX,
            e.clientY - rect.top, rect.bottom - e.clientY,
          )
          const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                         e.clientY >= rect.top && e.clientY <= rect.bottom
          if (inside && edgeDist < 60) {
            const intensity = Math.max(0, 1 - edgeDist / 60)
            shapeEl.style.boxShadow = `0 0 ${12 + intensity * 12}px rgba(59, 130, 246, ${0.1 + intensity * 0.35})`
          } else {
            shapeEl.style.boxShadow = ''
          }
        }
      }
    }

    function onPointerUp(e: PointerEvent) {
      // Coordinator handles listener cleanup and stopImmediatePropagation
      const drag = dragRef.current
      if (!drag) return
      // Clear membrane glow
      const shapeEl = logEl!.closest('.fleet-shape') as HTMLElement | null
      if (shapeEl) shapeEl.style.boxShadow = ''
      dragRef.current = null
      if (!drag.started || !drag.pillId) return

      const onMain = !!(drag as any)._onMain
      const mainEditor = (window as any).__tldraw_editor__ as any
      const dropEditor = (onMain && mainEditor) ? mainEditor : editor
      const pagePos = dropEditor.screenToPage({ x: e.clientX, y: e.clientY })
      dropPillOnTarget(dropEditor, drag.pillId as any, drag.value, pagePos, drag.content)
      try { dropEditor.deleteShapes([drag.pillId as any]) } catch {}
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      // Release coordinator if this component unmounts during a drag
      if (dragRef.current) dragCoordinator.release()
    }
  }, [chatLogEl, editor])

  // --- chatInsertBus listener: content drops insert into textarea ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId, text, owner } = (e as CustomEvent).detail
      if (chatId && chatId !== shape.id) return
      if (owner && !sendTargetsRef.current.includes(owner)) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (!ta) return
      const pos = ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)
      const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + (after && !after.startsWith('\n') ? '\n' : '')
      ta.value = before + insert + after
      ta.focus()
    }
    const filterHandler = (e: Event) => {
      const { chatId } = (e as CustomEvent).detail
      if (chatId !== shape.id) return
      setFilterOpen(false)
      setFilterOpenByPill(false)
    }
    chatInsertBus.addEventListener('insert', handler)
    chatInsertBus.addEventListener('filter-applied', filterHandler)
    return () => {
      chatInsertBus.removeEventListener('insert', handler)
      chatInsertBus.removeEventListener('filter-applied', filterHandler)
    }
  }, [shape.id])

  // Auto-focus textarea + start voice when a bullet tap targets this chat
  useEffect(() => {
    if (activeBullets.length === 0) return
    const myTargets = sendTargetsRef.current
    const relevant = activeBullets.some(b => b.owner && myTargets.includes(b.owner))
    if (!relevant) return
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta || ta.getBoundingClientRect().width === 0) return
    ta.focus()
    if (!isRecording()) toggleRecording()
  }, [activeBullets])

  return (
    <HTMLContainer
      style={{
        width: w,
        height: h,
        pointerEvents: 'all',
        overflow: 'visible',
      }}
    >
      <div
        ref={shapeContainerRef}
        className="fleet-shape fleet-chat-shape"
        style={{
          ...fleetStyleVars,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          fontSize: 11,
          overflow: 'visible',
          fontFamily: "'Helvetica Neue', 'Helvetica', 'Arial', sans-serif",
          fontWeight: 300,
          lineHeight: 1.4,
          position: 'relative',
        }}
      >
        {/* Close, filter edit, and layout buttons */}
        <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
          <button
            className="fleet-close-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              editor.deleteShapes([shape.id])
            }}
          >
            ×
          </button>
          <button
            className="fleet-layout-btn"
            onPointerUp={(e) => {
              e.stopPropagation()
              // Must be in select tool for resize handles to appear.
              // The HUD mirrors the main editor's tool (hand/browse/etc),
              // so switch explicitly before selecting.
              editor.setCurrentTool('select')
              editor.select(shape.id)
            }}
            title="Resize / move"
          >
            ⊞
          </button>
          <button
            className="fleet-filter-btn"
            onClick={() => setFilterOpen(prev => !prev)}
          >
            {filterOpen
              ? <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 2h12v9H6l-4 3v-3z"/></svg>
              : <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1 2h14M3 7h10M6 12h4"/></svg>
            }
          </button>
        </div>

        {/* Filter editor — full overlay showing DNF expression */}
        {filterOpen && (
          <FilterOverlay
            filter={filter}
            shapeId={shape.id}
            editor={editor}
            onClose={() => setFilterOpen(false)}
            externalPillOver={pillOver}
          />
        )}

        {/* Messages — Virtuoso owns the scroll container via components.Scroller.
            Dropping customScrollParent: with Virtuoso-owned scroll,
            initialTopMostItemIndex is reliably honored and the previous
            "start at top" / RAF pin loop / scroll race is gone. */}
        {chatMessages.length === 0 ? (
          <div
            className="fleet-chat-log"
            ref={(el) => { chatLogRef.current = el; setChatLogEl(el) }}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: '20px 8px',
              opacity: isImpossibleFilter ? 0.6 : 0.3,
              textAlign: 'center',
              fontSize: 10,
              color: isImpossibleFilter ? 'var(--red, #e55)' : undefined,
            }}
          >
            {isImpossibleFilter
              ? '⚠ Filter matches no known agents'
              : filter.length > 0 ? 'No messages' : 'No filter set'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={allItems}
            style={{ flex: 1, minHeight: 0 }}
            initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
            // Virtuoso owns the actual scrolling (it's virtualization-aware, so it
            // reaches the TRUE list bottom); our scroll-intent just gates WHEN it
            // follows. Follow on new content unless the user deliberately scrolled up.
            followOutput={() => (!userScrolledUpRef.current || hardLockedRef.current) ? 'auto' : false}
            // Generous enough to absorb the Virtuoso Footer (eliza/thinking
            // status, ~40px): scrollToIndex(LAST) aligns the last DATA item, so
            // the footer sits just below the viewport and "true bottom" is ~40px
            // past the last item. With the tight 24px value, that residual read
            // as "not at bottom" and surfaced the ⇣ arrow even though the user
            // never scrolled. 120 (the long-proven value) keeps follow engaged
            // through the footer. Safe because user-intent is now owned by the
            // single-source fleet-user-scroll handler, not inferred from this gap.
            atBottomThreshold={120}
            // Fires whenever Virtuoso's computed total list height changes —
            // catches in-place item growth (markdown/font/image late-render
            // adds pixels to existing items) which doesn't tick items.length
            // and so isn't caught by force-pin-on-item-grow.
            totalListHeightChanged={(h) => {
              const prev = prevTotalHeightRef.current
              prevTotalHeightRef.current = h
              const grew = h > prev
              const follow = !userScrolledUpRef.current || hardLockedRef.current
              // TRACE: log the gap the MOMENT content grows, follow-or-not. This
              // catches the "doesn't follow" symptom directly — content grew, we
              // were supposed to be at bottom, but the view didn't move. The plain
              // scroll-trace is blind to this (no scrollTop change => no event).
              const el = chatLogEl
              const gapNow = el ? Math.round(el.scrollHeight - (el.scrollTop + el.clientHeight)) : null
              if (grew) {
                log.warn('chat-scroll', 'TRACE content grew', { prev, h, gapNow, follow, scrolledUp: userScrolledUpRef.current, hardLocked: hardLockedRef.current })
              }
              if (grew && follow) {
                pinHard()
                requestAnimationFrame(() => {
                  const el2 = chatLogEl
                  const gapAfter = el2 ? Math.round(el2.scrollHeight - (el2.scrollTop + el2.clientHeight)) : null
                  log.warn('chat-scroll', 'TRACE after pin', { gapAfter })
                })
              }
            }}
            atBottomStateChange={(atBottom) => {
              const el = chatLogEl
              const gap = el ? (el.scrollHeight - (el.scrollTop + el.clientHeight)) : null
              if (isAtBottomRef.current !== atBottom) {
                log.warn('chat-scroll', atBottom ? 'pinned to bottom' : 'left bottom', {
                  scrollTop: el?.scrollTop,
                  scrollHeight: el?.scrollHeight,
                  clientHeight: el?.clientHeight,
                  gap,
                  items: allItems.length,
                  scrolledUp: userScrolledUpRef.current,
                  hardLocked: hardLockedRef.current,
                })
              }
              isAtBottomRef.current = atBottom
              setAtBottom(atBottom)
              // Auto-follow intent is owned by the fleet-user-scroll handler.
              // Here we ONLY resume-follow when we genuinely reach bottom.
              // We deliberately do NOT re-pin on a spurious "left bottom" here:
              // doing so created an INFINITE BOUNCE when content barely exceeds
              // the viewport — pin→bottom→(recompute)→left-bottom→pin→… every
              // ~50ms. The persistent false-bottom (a short pin that strands the
              // view above a growing gap because no further event re-fires) is
              // now closed by the standing convergence watchdog above, which is
              // bounce-safe: it samples on a 200ms cadence, so a transient
              // sub-200ms left-bottom that self-heals never triggers it.
              // Hard-lock is the one exception: it means "always pinned".
              if (atBottom) {
                userScrolledUpRef.current = false
              } else if (hardLockedRef.current) {
                requestAnimationFrame(pinHard)
              }
            }}
            itemContent={(_index, item) => (
              <div className={item?._divider ? 'queue-divider' : undefined}>
                <ChatMessageRow html={item.html} postProcess={postProcess} itemKey={item.key} expandedRowsRef={expandedRowsRef} />
              </div>
            )}
            computeItemKey={(_index, item) => item?.key ?? _index}
            components={{
              Scroller: ChatLogScroller,
              // Eliza/thinking status as Footer so they sit inside Virtuoso's
              // tracked layout — sibling rendering would float over/under
              // the virtualized list.
              Footer: () => (
                <div>
                  <ElizaStatus pending={elizaPending} ctx={ctx} rawItemsLength={rawItems.length} />
                  <ThinkingStatus
                    thinkingAgents={thinkingAgents}
                    compactingAgents={compactingAgents}
                    contextPercent={contextPercent}
                    hibernatingAgents={hibernatingAgents}
                    ctx={ctx}
                    lastItemKey={rawItems.length ? rawItems[rawItems.length - 1].key : null}
                    agents={agents}
                    escalationState={escalationState}
                  />
                </div>
              ),
            }}
          />
        )}

        {/* Terminal card overlay — shown on hover or when pinned; outside scroll container */}
        {(termCardPinnedId || termCardHoverId) && (() => {
          const activeId = termCardPinnedId ?? termCardHoverId!
          return (
            <TerminalCard
              key={`terminal-${activeId}`}
              agentId={activeId}
              agentName={agentNames[activeId] || activeId.replace('fleet:', '')}
              pinned={!!termCardPinnedId}
              onMouseEnter={() => { if (termCardHideTimerRef.current) { clearTimeout(termCardHideTimerRef.current); termCardHideTimerRef.current = null } }}
              onMouseLeave={() => { if (!termCardPinnedId) { termCardHideTimerRef.current = setTimeout(() => setTermCardHoverId(null), 200) } }}
              onDismiss={() => dismissTermCard(activeId)}
            />
          )
        })()}

        {/* Input — outside scroll container, flex sibling with flexShrink:0 */}
        <div
          ref={inputAreaRef}
          className="fleet-chat-input-area"
          style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
            position: 'relative',
          }}
        >
          {/* Terminal hover pane — floats below the input area when the terminal icon is hovered or pinned */}
          {(termHoverVisible || termHoverPinned) && hoverTargetAgentId && (
            <TerminalHoverPane
              agentId={hoverTargetAgentId}
              pinned={termHoverPinned}
              onDismiss={() => { setTermHoverPinned(false); setTermHoverVisible(false) }}
              onMouseEnter={() => {
                if (termHideTimerRef.current) {
                  clearTimeout(termHideTimerRef.current)
                  termHideTimerRef.current = null
                }
              }}
              onMouseLeave={() => setTermHoverVisible(false)}
            />
          )}
          <SendHint
            filter={filter}
            sendTargets={sendTargets}
            inputRef={inputRef}
          />
          {deadTargetAgent && (
            <div
              className="fleet-dead-agent-notice"
              onPointerDown={stopEventPropagation}
            >
              <span>{deadTargetAgent.name} is dead</span>
              <span
                className="fleet-dead-resurrect"
                onClick={(e) => {
                  stopEventPropagation(e as any)
                  fetch(`/api/agents/${encodeURIComponent(deadTargetAgent.id)}/resurrect`, { method: 'POST' })
                }}
              >resurrect?</span>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            {/* Ghost drop preview — purple lozenges per dragged file (picture
                glyph for images, document glyph otherwise) shown while a file is
                dragged over the field. */}
            {dragLozenges && (
              <div className="fleet-drop-ghost">
                {dragLozenges.map((kind, i) => (
                  <span key={i} className="fleet-drop-lozenge">
                    {kind === 'image' ? (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                        <circle cx="5.5" cy="6" r="1.3" fill="currentColor" stroke="none" />
                        <path d="M2 12 L6 8 L9 11 L11 9 L14 12" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <path d="M4 1.5 H9.5 L13 5 V14 a0.5 0.5 0 0 1 -0.5 0.5 H4 a0.5 0.5 0 0 1 -0.5 -0.5 V2 a0.5 0.5 0 0 1 0.5 -0.5 Z" strokeLinejoin="round" />
                        <path d="M9.5 1.5 V5 H13" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                ))}
              </div>
            )}
            {/* Highlight underlay — mirrors textarea text, highlights <<ref>> tokens */}
            <InputHighlightUnderlay inputRef={inputRef} />
            {/* Unified follow / jump-to-bottom control. One button, fixed here:
                  - off bottom → ⇣ arrow; click jumps to bottom (does NOT change
                    follow mode — you return to the bottom first, then it's a
                    toggle again),
                  - at bottom → follow-mode toggle (horseshoe); open = smart-follow,
                    engaged (field lines) = hard-lock (always pinned).
                This replaces the separate floating ⇣ arrow. */}
            <button
              className={`fleet-hardlock-toggle${!atBottom ? ' jump-mode' : ''}`}
              onPointerDown={stopEventPropagation}
              onClick={(e) => {
                stopEventPropagation(e as any)
                if (!atBottom) {
                  // Off bottom: this click only returns to the bottom.
                  scrollToBottom()
                  return
                }
                // At bottom: toggle follow mode.
                setHardLocked(prev => {
                  const next = !prev
                  if (next) requestAnimationFrame(pinHard)
                  return next
                })
              }}
              title={!atBottom
                ? 'Scroll to bottom'
                : hardLocked
                  ? 'Hard-locked — always pinned to bottom (click to release)'
                  : 'Smart scroll — click to hard-lock to bottom'}
            >
              {!atBottom ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 1 L6 10 M2.5 6.5 L6 10 L9.5 6.5"/>
                </svg>
              ) : (
                <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 9 L2 4 Q2 1 5 1 Q8 1 8 4 L8 9"/>
                  {hardLocked && <>
                    <path d="M1 11 Q2.5 10 5 11 Q7.5 12 9 11" strokeWidth="1"/>
                    <path d="M2 13 Q3.5 12 5 13 Q6.5 14 8 13" strokeWidth="0.8"/>
                  </>}
                </svg>
              )}
            </button>
            {/* Terminal peek icon — hover to show agent's tmux output. Hidden when no targeted agent has a tmux session. */}
            {hoverTargetAgentId && (
              <button
                className={`fleet-terminal-icon${termHoverPinned ? ' active' : ''}`}
                onPointerDown={stopEventPropagation}
                onClick={(e) => {
                  stopEventPropagation(e as any)
                  setTermHoverPinned(p => !p)
                  setTermHoverVisible(true)
                }}
                onMouseEnter={() => {
                  if (termHideTimerRef.current) {
                    clearTimeout(termHideTimerRef.current)
                    termHideTimerRef.current = null
                  }
                  setTermHoverVisible(true)
                }}
                onMouseLeave={() => {
                  if (!termHoverPinned) {
                    termHideTimerRef.current = setTimeout(() => setTermHoverVisible(false), 80)
                  }
                }}
                title={termHoverPinned ? 'Click to unpin terminal' : 'Hover to peek · click to pin'}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="1" width="8" height="8" rx="1.5"/>
                  <polyline points="2.5,4 4.5,6 2.5,8"/>
                  <line x1="5.5" y1="8" x2="7.5" y2="8"/>
                </svg>
              </button>
            )}
            <textarea
              ref={inputRef as any}
              placeholder=""
              rows={1}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                stopEventPropagation(e)
                const ta = e.currentTarget
                if (e.key === 'Escape') {
                  e.preventDefault()
                  if (ta.value !== '') {
                    ta.value = ''
                    ta.style.height = ''
                  }
                  return
                }
                if (escCountRef.current > 0) {
                  escCountRef.current = 0
                  setEscalationState({})
                }
                if (e.key === 'ArrowUp') {
                  const history = sentHistoryRef.current
                  if (history.length === 0) return
                  if (historyIndexRef.current === -1 && ta.value !== '') return
                  e.preventDefault()
                  const nextIdx = historyIndexRef.current + 1
                  if (nextIdx < history.length) {
                    historyIndexRef.current = nextIdx
                    ta.value = history[history.length - 1 - nextIdx]
                    // field-sizing: content handles auto-resize
                    ta.setSelectionRange(ta.value.length, ta.value.length)
                  }
                  return
                }
                if (e.key === 'ArrowDown') {
                  if (historyIndexRef.current === -1) return
                  e.preventDefault()
                  const nextIdx = historyIndexRef.current - 1
                  historyIndexRef.current = nextIdx
                  if (nextIdx < 0) {
                    ta.value = ''
                    ta.style.height = ''
                  } else {
                    const history = sentHistoryRef.current
                    ta.value = history[history.length - 1 - nextIdx]
                    // field-sizing: content handles auto-resize
                    ta.setSelectionRange(ta.value.length, ta.value.length)
                  }
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  const val = ta.value
                  if (val.trim() === '') {
                    e.preventDefault() // suppress on empty
                    return
                  }
                  // /terminal command — open terminal card for target agent
                  const termMatch = val.trim().match(/^\/terminal\s*(.*)$/i)
                  if (termMatch) {
                    e.preventDefault()
                    const arg = termMatch[1].trim()
                    // Find agent by name or ID
                    let targetId = ''
                    if (arg) {
                      const match = agents.find((a: any) =>
                        a.friendly_name === arg || a.id === arg || a.id?.endsWith(arg)
                      )
                      targetId = match?.id || arg
                    } else if (sendTargets.length > 0) {
                      targetId = sendTargets[0]
                    }
                    if (targetId) {
                      setTermCardPinnedId(targetId)
                      ta.value = ''
                      ta.style.height = ''
                    }
                    return
                  }
                  // Get text before cursor on current line
                  const before = val.substring(0, ta.selectionStart || val.length)
                  const lastNewline = before.lastIndexOf('\n')
                  const lineText = before.substring(lastNewline + 1)

                  const doSend = async () => {
                    const text = val.trim()
                    if (!text || sendTargets.length === 0) return
                    // Echo the message and clear the box synchronously, BEFORE any awaited
                    // work. The source-line context lookup below can hit the network; if the
                    // echo/clear waited on it, the message looked unsent and a second Enter
                    // queued another send — one Enter-mash → many duplicate rows.
                    const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
                    injectOptimisticEvent({
                      _tempId: tempId,
                      type: 'chat',
                      event_type: 'chat',
                      from: getHumanId(),
                      to: sendTargets[0],
                      text,
                      timestamp: new Date().toISOString(),
                      read: false,
                    })
                    ta.value = ''
                    ta.style.height = ''
                    ta.dispatchEvent(new Event('input', { bubbles: true }))
                    resetTranscript()
                    restartRecording()
                    sentHistoryRef.current = [...sentHistoryRef.current, text]
                    historyIndexRef.current = -1
                    // Now resolve viewer context (may hit the network) off the critical path.
                    const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel))
                    if (context) await enrichContextWithSourceLines(context)
                    const bullets = consumeBulletContexts()
                    if (bullets.length > 0 && context) {
                      ;(context as any).bullets = bullets
                    }

                    // Plan mode verbal approval: detect approval/rejection phrases and
                    // forward them to the agent's terminal as plan-mode-respond calls.
                    // We still send the message normally so the agent sees the text in context.
                    const lc = text.toLowerCase().replace(/[.,!?]+$/, '').trim()
                    const APPROVE_PHRASES = new Set([
                      'go for it', 'do it', 'proceed', 'implement it', 'implement', 'approve',
                      'yes', 'yes do it', "let's go", 'lets go', 'sounds good', 'looks good',
                      'go ahead', 'yeah go for it', 'yep', 'yeah', 'ok', 'okay', 'ship it',
                    ])
                    const REJECT_PHRASES = new Set([
                      'stop', 'abort', "don't do it", 'cancel', 'no', 'reject', 'hold off',
                      'wait', 'hold on', 'never mind', 'nevermind', 'nope', 'nah',
                    ])
                    if (APPROVE_PHRASES.has(lc) || REJECT_PHRASES.has(lc)) {
                      const planResponse = APPROVE_PHRASES.has(lc) ? 'approve' : 'reject'
                      for (const agentId of sendTargets) {
                        // Only respond if this agent has a visible plan card
                        const chatLog = chatLogRef.current
                        const hasCard = chatLog
                          ? Array.from(chatLog.querySelectorAll(`.plan-card[data-agent-id="${CSS.escape(agentId)}"]`))
                              .some(el => !el.classList.contains('plan-card-approved') && !el.classList.contains('plan-card-rejected'))
                          : false
                        if (hasCard) {
                          fetch(`${FLEET_API}/api/plan-mode-respond`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ agent: agentId, response: planResponse }),
                          }).catch(e => console.warn('[fleet-chat] plan-mode-respond failed:', e.message))
                        }
                      }
                    }

                    // Plan mode toggle: enter only ("let's plan", "planning mode", etc.).
                    // Exit is handled by clicking the plan badge or approving the plan card.
                    const ENTER_PLAN_RE = /^\/plan\b|\blet'?s plan\b|\bplan mode\b|\bplanning mode\b|\bchat in planning\b|\bstay in planning\b|\bplan first\b|\bthink before\b/i
                    if (ENTER_PLAN_RE.test(text)) {
                      for (const agentId of sendTargets) {
                        const agentName = agentNames[agentId] || agentId
                        fetch(`${FLEET_API}/api/plan-mode-toggle`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ agent: agentId }),
                        })
                          .then(r => r.json().then(data => ({ ok: r.ok, data })))
                          .then(({ ok, data }) => {
                            if (!ok || data?.error) {
                              sendMessage(getHumanId(), `⚠️ plan mode failed for ${agentName}: ${data?.error || 'unknown error'}`, {})
                            } else if (data?.mode) {
                              const modeLabel = data.mode === 'plan' ? 'plan mode ✓' : data.mode
                              sendMessage(getHumanId(), `📋 ${agentName} → ${modeLabel}`, {})
                            }
                          })
                          .catch(err => sendMessage(getHumanId(), `⚠️ plan mode failed for ${agentName}: ${err.message}`, {}))
                      }
                    }

                    // No explicit scroll on send — Virtuoso's followOutput
                    // handles this: if the user was at bottom, the new
                    // message gets followed; if scrolled up, position holds.
                    const refAttachments = buildRefAttachments(text, editor)
                    const sendOpts: any = context ? { context, _tempId: tempId } : { _tempId: tempId }
                    if (refAttachments.length > 0) sendOpts.attachments = refAttachments
                    const sendWithRetry = (attempt: number) => {
                      Promise.all(
                        sendTargets.map(t => sendMessage(t, text, sendOpts))
                      ).then((results: {ok: boolean, event_id: number}[]) => {
                        if (!results.every(r => r.ok)) throw new Error('send failed')
                        // reconcileOptimistic already called synchronously in the WS reply handler
                      }).catch(() => {
                        if (attempt < 3) {
                          setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
                        } else {
                          updateOptimisticEvent(tempId, { _failed: true })
                        }
                      })
                    }
                    sendWithRetry(1)
                  }

                  if (lineText.trim() === '') {
                    // Blank line (double-enter) = send
                    e.preventDefault()
                    doSend()
                  } else if (lineText.endsWith(' ')) {
                    // Trailing space = newline (let default happen)
                    return
                  } else {
                    // Non-blank, no trailing space = send
                    e.preventDefault()
                    doSend()
                  }
                }
              }}
              onInput={() => {
                if (escCountRef.current > 0) {
                  escCountRef.current = 0
                  setEscalationState({})
                }
              }}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                // Register voice target on pointerdown — onFocus can be unreliable in tldraw
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, async (targets: string[], text: string) => {
                  const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel))
                  if (context) await enrichContextWithSourceLines(context)
                  const bullets = consumeBulletContexts()
                  if (bullets.length > 0 && context) {
                    ;(context as any).bullets = bullets
                  }
                  const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
                  injectOptimisticEvent({
                    _tempId: tempId,
                    type: 'chat',
                    event_type: 'chat',
                    from: getHumanId(),
                    to: targets[0],
                    text,
                    timestamp: new Date().toISOString(),
                    read: false,
                  })
                  // No explicit scroll on send — Virtuoso's followOutput handles it.
                  const refAttachments = buildRefAttachments(text, editor)
                  const sendOpts: any = context ? { context, _tempId: tempId } : { _tempId: tempId }
                  if (refAttachments.length > 0) sendOpts.attachments = refAttachments
                  const sendWithRetry = (attempt: number) => {
                    Promise.all(
                      targets.map(t => sendMessage(t, text, sendOpts))
                    ).then((results: {ok: boolean, event_id: number}[]) => {
                      if (!results.every(r => r.ok)) throw new Error('send failed')
                      // reconcileOptimistic already called synchronously in the WS reply handler
                    }).catch(() => {
                      if (attempt < 3) {
                        setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
                      } else {
                        updateOptimisticEvent(tempId, { _failed: true })
                      }
                    })
                  }
                  sendWithRetry(1)
                })
              }}
              onFocus={(e) => {
                stopEventPropagation(e)
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, async (targets: string[], text: string) => {
                  const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel))
                  if (context) await enrichContextWithSourceLines(context)
                  const bullets = consumeBulletContexts()
                  if (bullets.length > 0 && context) {
                    ;(context as any).bullets = bullets
                  }
                  const tempId = `opt-${Date.now()}-${Math.random().toString(36).slice(2)}`
                  injectOptimisticEvent({
                    _tempId: tempId,
                    type: 'chat',
                    event_type: 'chat',
                    from: getHumanId(),
                    to: targets[0],
                    text,
                    timestamp: new Date().toISOString(),
                    read: false,
                  })
                  // No explicit scroll on send — Virtuoso's followOutput handles it.
                  const refAttachments = buildRefAttachments(text, editor)
                  const sendOpts: any = context ? { context, _tempId: tempId } : { _tempId: tempId }
                  if (refAttachments.length > 0) sendOpts.attachments = refAttachments
                  const sendWithRetry = (attempt: number) => {
                    Promise.all(
                      targets.map(t => sendMessage(t, text, sendOpts))
                    ).then((results: {ok: boolean, event_id: number}[]) => {
                      if (!results.every(r => r.ok)) throw new Error('send failed')
                      // reconcileOptimistic already called synchronously in the WS reply handler
                    }).catch(() => {
                      if (attempt < 3) {
                        setTimeout(() => sendWithRetry(attempt + 1), 2000 * attempt)
                      } else {
                        updateOptimisticEvent(tempId, { _failed: true })
                      }
                    })
                  }
                  sendWithRetry(1)
                })
              }}
              style={{
                width: '100%',
                background: 'transparent',
                border: '1px solid rgba(128, 128, 128, 0.15)',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.4,
                fontFamily: 'inherit',
                position: 'relative',
                zIndex: 1,
                fieldSizing: 'content',
                maxHeight: 200,
              } as any}
              onDrop={async (e) => {
                e.preventDefault()
                e.stopPropagation()
                const ta = e.currentTarget

                // External file drops — upload to fleet server, insert markdown link
                const dtItems = e.dataTransfer?.items ? [...e.dataTransfer.items] : []
                let entries: { file: File, path: string }[] = []
                let isFlat = true

                if (dtItems.length > 0 && typeof dtItems[0].webkitGetAsEntry === 'function') {
                  for (const item of dtItems) {
                    const entry = item.webkitGetAsEntry()
                    if (entry) {
                      if (entry.isDirectory) isFlat = false
                      entries.push(...await traverseDirectory(entry))
                    }
                  }
                } else {
                  for (const f of [...(e.dataTransfer?.files || [])]) {
                    entries.push({ file: f, path: f.name })
                  }
                }

                if (entries.length > 0) {
                  const mdEntries = entries.filter(({ file: f }) => f.name.endsWith('.md') || f.type === 'text/markdown')
                  const otherEntries = entries.filter(({ file: f }) => !f.name.endsWith('.md') && f.type !== 'text/markdown')

                  for (const { file, path } of mdEntries) {
                    try {
                      const companions = entries.filter(en => en.path !== path)
                      const link = await uploadMarkdownWithImages(file, companions, path, isFlat)
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + link + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    } catch (err) {
                      console.error('[fleet-chat] file upload failed:', err)
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + `[${file.name}]` + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    }
                  }
                  for (const { file } of otherEntries) {
                    if (mdEntries.length > 0 && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(file.name)) continue
                    try {
                      const formData = new FormData()
                      formData.append('file', file, file.name)
                      const resp = await fetch(`${FLEET_API}/api/upload`, { method: 'POST', body: formData })
                      if (!resp.ok) throw new Error(`upload failed: ${resp.status}`)
                      const { url, name } = await resp.json()
                      const link = file.type.startsWith('image/')
                        ? `![${name}](${FLEET_API}${url})`
                        : `[${name}](${FLEET_API}${url})`
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + link + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    } catch (err) {
                      console.error('[fleet-chat] file upload failed:', err)
                      const pos = ta.selectionStart || ta.value.length
                      ta.value = ta.value.slice(0, pos) + `[${file.name}]` + ta.value.slice(pos)
                      ta.dispatchEvent(new Event('input', { bubbles: true }))
                    }
                  }
                  return
                }

                // Text/attachment drops (from other chat elements)
                const text = e.dataTransfer?.getData('text/plain') || ''
                if (text) {
                  const pos = ta.selectionStart || ta.value.length
                  ta.value = ta.value.slice(0, pos) + text + ta.value.slice(pos)
                }
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
          />
          </div>
        </div>

      </div>
    </HTMLContainer>
  )
}

/**
 * Viewport-culling shell for FleetChatInner.
 *
 * All the expensive hooks (useFleetEvents, useFleetAgents, etc.) live inside
 * FleetChatInner. When the shape is off-screen we render a cheap transparent
 * placeholder instead, which unmounts FleetChatInner and tears down every
 * subscription. Shapes scrolled back into view remount and resubscribe — a
 * one-time cost that is far cheaper than re-rendering on every fleet event
 * while off-screen.
 */
const FleetChatComponent = memo(function FleetChatComponent({ shape }: { shape: any }) {
  const { w, h } = shape.props as { w: number; h: number }
  const isInViewport = useIsInViewport(shape.id)
  if (!isInViewport) {
    return <HTMLContainer id={shape.id}><div style={{ width: w, height: h }} /></HTMLContainer>
  }
  return <FleetChatInner shape={shape} />
}, (prev, next) => prev.shape.props === next.shape.props)


function SendHint({
  filter: _filter,
  sendTargets,
  inputRef,
}: {
  filter: [string, string][][]
  sendTargets: string[]
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  // kind: '' (hidden) | 'empty' (no text, show target) | 'newline' | 'enter'
  const [kind, setKind] = useState<'' | 'empty' | 'newline' | 'enter'>('')

  const hasTargets = sendTargets.length > 0

  const update = useCallback(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    const val = el?.value ?? ''
    if (!val) {
      setKind(hasTargets ? 'empty' : '')
      return
    }
    const pos = el!.selectionStart ?? val.length
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1
    const currentLine = val.slice(lineStart, pos)
    setKind(currentLine.endsWith(' ') ? 'newline' : 'enter')
  }, [hasTargets, inputRef])

  useEffect(() => {
    update()
  }, [hasTargets, update])

  useEffect(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) return
    const handler = () => update()
    el.addEventListener('input', handler)
    el.addEventListener('keyup', handler)
    el.addEventListener('focus', handler)
    el.addEventListener('blur', handler)
    return () => {
      el.removeEventListener('input', handler)
      el.removeEventListener('keyup', handler)
      el.removeEventListener('focus', handler)
      el.removeEventListener('blur', handler)
    }
  }, [inputRef, update])

  if (kind === '') return null
  if (kind === 'newline') return <span className="fleet-chat-send-hint">↵ newline</span>

  // 'empty' and 'enter' both show the target list (with phase icons, mirroring the
  // agents panel). 'enter' prefixes the ↵ glyph; with no targets it's just ↵.
  const enterPrefix = kind === 'enter' ? '↵ ' : ''
  if (!hasTargets) return <span className="fleet-chat-send-hint">↵</span>

  const targets = sendTargets.map((t, i) => (
    <span key={t} className="send-hint-target" style={{ display: 'inline-flex', alignItems: 'center' }}>
      {i > 0 ? ' + ' : null}
      <AgentName name={t} />
    </span>
  ))

  return (
    <span className="fleet-chat-send-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
      {enterPrefix}→&nbsp;{targets}
    </span>
  )
}

/** Filter overlay — uses native click listeners to bypass tldraw event interception */
/** Simplify a DNF expression: dedup within groups, dedup identical groups, absorption */
function simplifyDnf(dnf: [string, string][][]): [string, string][][] {
  // Dedup within each AND group
  let groups = dnf.map(g => {
    const seen = new Set<string>()
    return g.filter(([r, l]) => {
      const key = `${r}\0${l}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  })
  // Dedup identical OR groups
  const seenGroups = new Set<string>()
  groups = groups.filter(g => {
    const key = g.map(([r, l]) => `${r}\0${l}`).sort().join('\n')
    if (seenGroups.has(key)) return false
    seenGroups.add(key); return true
  })
  // Absorption: if group A ⊆ group B, drop B (A is less restrictive)
  return groups.filter((g, i) =>
    !groups.some((other, j) => i !== j && other.length < g.length &&
      other.every(([r, l]) => g.some(([gr, gl]) => gr === r && gl === l)))
  )
}

/** Build preview DNF: add a new term at andGroupIdx (AND) or as new OR clause (andGroupIdx < 0) */
function buildFilterPreview(
  filter: [string, string][][],
  role: string,
  value: string,
  andGroupIdx: number,
): [string, string][][] {
  const newTerm: [string, string] = [role, value]
  if (filter.length === 0) return [[newTerm]]
  // Already exists in the target group?
  if (andGroupIdx >= 0 && filter[andGroupIdx]) {
    if (filter[andGroupIdx].some(([r, l]) => r === role && l === value)) return filter
    const result = filter.map((cl, i) => i === andGroupIdx ? [...cl, newTerm] : cl)
    return simplifyDnf(result)
  }
  // New OR clause
  return simplifyDnf([...filter, [newTerm]])
}

function FilterOverlay({
  filter,
  shapeId,
  editor,
  onClose,
  externalPillOver,
}: {
  filter: [string, string][][]
  shapeId: any
  editor: any
  onClose: () => void
  externalPillOver?: { role: string; value: string; displayName: string } | null
}) {
  // Native click delegation on document capture — bypasses tldraw completely
  const overlayRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef(filter)
  filterRef.current = filter

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      const overlay = overlayRef.current
      if (!overlay || !overlay.contains(target)) return

      // Remove term ×
      const termX = target.closest('.fleet-filter-term-x') as HTMLElement
      if (termX) {
        const ci = parseInt(termX.dataset.clause || '0', 10)
        const ti = parseInt(termX.dataset.term || '0', 10)
        const f = filterRef.current
        const newFilter = f.map((cl, i) => {
          if (i !== ci) return cl
          return cl.filter((_, j) => j !== ti)
        }).filter(cl => cl.length > 0)
        editor.updateShape({
          id: shapeId,
          type: 'fleet-chat',
          props: { filter: newFilter },
        })
        return
      }

      // Clear all
      if (target.closest('.fleet-filter-clear')) {
        editor.updateShape({
          id: shapeId,
          type: 'fleet-chat',
          props: { filter: [] },
        })
        return
      }
    }
    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [shapeId, editor, onClose])

  // Detect pill hovering over the shape — show two-pane drop preview
  const pillOverKey = useValue('filter-pill-over', () => {
    const pills = editor.getCurrentPageShapes().filter((s: any) => s.type === 'fleet-pill')
    if (pills.length === 0) return ''
    const pill = pills[0] as any
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) return ''
    const cx = pb.x + pb.w / 2
    const cy = pb.y + pb.h / 2
    const shapeBounds = editor.getShapePageBounds(shapeId)
    if (!shapeBounds || cx < shapeBounds.x || cx > shapeBounds.x + shapeBounds.w ||
        cy < shapeBounds.y || cy > shapeBounds.y + shapeBounds.h) return ''
    return `${pill.props.value}\0${pill.props.displayName}`
  }, [editor, shapeId])

  const internalPillOver = useMemo(() => {
    if (!pillOverKey) return null
    const [value, displayName] = pillOverKey.split('\0')
    return { value, displayName }
  }, [pillOverKey])
  const pillOver = externalPillOver ?? internalPillOver

  // AND-group hover detection via pill shape position vs DOM bounding rects.
  // Pointer events don't work during drag because FleetAgentsShape holds pointer capture.
  // Instead, poll the pill's screen position each frame and check against clause box rects.
  const toPaneRef = useRef<HTMLDivElement>(null)
  const fromPaneRef = useRef<HTMLDivElement>(null)
  const replaceZoneRef = useRef<HTMLDivElement>(null)

  // AND-group hover detection with hysteresis to prevent oscillation.
  // Once hovering a group, stick to it until the pill clearly leaves (EXIT_PAD away).
  // Enter a group with ENTER_PAD tolerance.
  const lastGroupRef = useRef<{ pane: string; idx: number; rect: DOMRect } | null>(null)

  const hoveredGroup = useValue('filter-hovered-group', () => {
    if (!pillOver) { lastGroupRef.current = null; return null }
    const pills = editor.getCurrentPageShapes().filter((s: any) => s.type === 'fleet-pill')
    if (pills.length === 0) { lastGroupRef.current = null; return null }
    const pill = pills[0]
    const pb = editor.getShapePageBounds(pill.id)
    if (!pb) return null
    const screenPt = editor.pageToScreen({ x: pb.x + pb.w / 2, y: pb.y + pb.h / 2 })

    const ENTER_PAD = 8
    const EXIT_PAD = 30

    // If we have a sticky group, check if pill is still near it
    const last = lastGroupRef.current
    if (last) {
      const r = last.rect
      if (screenPt.x >= r.x - EXIT_PAD && screenPt.x <= r.x + r.width + EXIT_PAD &&
          screenPt.y >= r.y - EXIT_PAD && screenPt.y <= r.y + r.height + EXIT_PAD) {
        return { pane: last.pane as 'to' | 'from', idx: last.idx }
      }
      lastGroupRef.current = null
    }

    // Check replace zone first (bottom-left corner)
    const replaceEl = replaceZoneRef.current
    if (replaceEl) {
      const r = replaceEl.getBoundingClientRect()
      if (screenPt.x >= r.x - ENTER_PAD && screenPt.x <= r.x + r.width + ENTER_PAD &&
          screenPt.y >= r.y - ENTER_PAD && screenPt.y <= r.y + r.height + ENTER_PAD) {
        lastGroupRef.current = { pane: 'replace', idx: -1, rect: DOMRect.fromRect(r) }
        return { pane: 'replace' as any, idx: -1 }
      }
    }

    // Check each pane
    for (const [pane, ref] of [['to', toPaneRef], ['from', fromPaneRef]] as const) {
      const paneEl = ref.current
      if (!paneEl) continue
      const paneRect = paneEl.getBoundingClientRect()
      if (screenPt.x < paneRect.x || screenPt.x > paneRect.x + paneRect.width ||
          screenPt.y < paneRect.y || screenPt.y > paneRect.y + paneRect.height) continue
      // Inside this pane — check clause boxes
      const clauseEls = paneEl.querySelectorAll('.fleet-filter-and-group')
      let foundIdx = -1
      for (let i = 0; i < clauseEls.length; i++) {
        const r = clauseEls[i].getBoundingClientRect()
        if (screenPt.x >= r.x - ENTER_PAD && screenPt.x <= r.x + r.width + ENTER_PAD &&
            screenPt.y >= r.y - ENTER_PAD && screenPt.y <= r.y + r.height + ENTER_PAD) {
          foundIdx = i
          lastGroupRef.current = { pane, idx: i, rect: DOMRect.fromRect(r) }
          break
        }
      }
      return { pane, idx: foundIdx }
    }
    return null
  }, [editor, pillOver])

  // Compute preview DNF for each pane based on hovered AND group
  const toGroupIdx = hoveredGroup?.pane === 'to' ? hoveredGroup.idx : -1
  const fromGroupIdx = hoveredGroup?.pane === 'from' ? hoveredGroup.idx : -1

  const toPreview = useMemo(() => {
    if (!pillOver) return null
    return buildFilterPreview(filter, 'to', pillOver.value, toGroupIdx)
  }, [pillOver, filter, toGroupIdx])

  const fromPreview = useMemo(() => {
    if (!pillOver) return null
    return buildFilterPreview(filter, 'from', pillOver.value, fromGroupIdx)
  }, [pillOver, filter, fromGroupIdx])

  // Highlight index: if hovering a group, that group; if new OR clause, the last group
  const toHighlightIdx = toGroupIdx >= 0 ? toGroupIdx : (toPreview && toPreview.length > filter.length ? toPreview.length - 1 : -1)
  const fromHighlightIdx = fromGroupIdx >= 0 ? fromGroupIdx : (fromPreview && fromPreview.length > filter.length ? fromPreview.length - 1 : -1)

  // Publish preview state so dropPillOnTarget can apply the right filter on release.
  // useLayoutEffect (not useEffect) — runs before the browser paint so filterDropPreview
  // is always current when pointerup fires. useEffect runs after paint, creating a window
  // where the preview is visible but activePaneRole is still null/stale.
  useLayoutEffect(() => {
    if (pillOver) {
      const replacePreview: [string, string][][] = [[['to', pillOver.value]], [['from', pillOver.value]]]
      filterDropPreview.shapeId = shapeId
      filterDropPreview.toPreview = toPreview
      filterDropPreview.fromPreview = fromPreview
      filterDropPreview.replacePreview = replacePreview
      filterDropPreview.activePaneRole = (hoveredGroup?.pane as any) ?? null
    } else if (filterDropPreview.shapeId === shapeId) {
      // Only clear if WE are the current owner. If another chat has taken
      // ownership in the interim (multiple FilterOverlays mounted), leave its
      // state alone — otherwise this effect re-running on Chat A would wipe
      // the preview Chat B just published, and the next pointerup on B would
      // see a null shapeId and silently fall through to the position-based
      // fallback (the longstanding "this chat won't filter anymore" bug).
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.replacePreview = null
      filterDropPreview.activePaneRole = null
    }
    return () => {
      // Same ownership guard for unmount/re-run cleanup. The cleanup function
      // fires on every dep change, not just unmount, so an unconditional clear
      // would race with another chat's effect body publishing fresh state.
      if (filterDropPreview.shapeId === shapeId) {
        filterDropPreview.shapeId = null
        filterDropPreview.toPreview = null
        filterDropPreview.fromPreview = null
        filterDropPreview.replacePreview = null
        filterDropPreview.activePaneRole = null
      }
    }
  }, [pillOver, toPreview, fromPreview, hoveredGroup, shapeId])

  // Render a single chip (role:label) — matches dashboard's chipHtml
  function renderChip(role: string, label: string, opts?: { ghost?: boolean; x?: { ci: number; ti: number } }) {
    // The value is always the full name (an opaque atom); AgentName is the one
    // display split — full name → base text + glyph. A plain (non-agent) label
    // has no suffix, so it renders verbatim with no glyph.
    return (
      <span className={`fleet-filter-chip fleet-filter-chip-${role}${opts?.ghost ? ' fleet-filter-chip-ghost' : ''}`}>
        <span className="fleet-filter-chip-role">{role}:</span>
        <span className="fleet-filter-chip-label">
          <AgentName name={label} />
        </span>
        {opts?.x && (
          <span className="fleet-filter-term-x" data-clause={opts.x.ci} data-term={opts.x.ti}>×</span>
        )}
      </span>
    )
  }

  // Render AND group box — vertical stack of chips, matching dashboard's .filter-and-group
  function renderAndGroup(
    clause: [string, string][],
    ci: number,
    opts?: { highlight?: boolean; ghostRole?: string; ghostValue?: string; showX?: boolean },
  ) {
    const cls = opts?.highlight
      ? 'fleet-filter-and-group fleet-filter-and-group-highlight'
      : 'fleet-filter-and-group fleet-filter-and-group-normal'
    return (
      <div className={cls} data-group-idx={ci}>
        {clause.map(([role, label], ti) => (
          <div key={ti}>
            {renderChip(role, label, opts?.showX ? { x: { ci, ti } } : undefined)}
          </div>
        ))}
        {opts?.ghostRole && opts?.ghostValue && (
          <div>{renderChip(opts.ghostRole, opts.ghostValue, { ghost: true })}</div>
        )}
      </div>
    )
  }

  // Render full DNF as AND group boxes separated by "or"
  function renderDnfExpression(
    dnf: [string, string][][],
    opts?: {
      showX?: boolean
      highlightIdx?: number
      ghostRole?: string
      ghostValue?: string
    },
  ) {
    const groups = dnf.map((clause, ci) => {
      const isHighlighted = opts?.highlightIdx === ci
      return (
        <div key={ci} className="fleet-filter-group-row">
          {ci > 0 && <span className="fleet-filter-or-sep">or</span>}
          {renderAndGroup(clause, ci, {
            highlight: isHighlighted,
            ghostRole: isHighlighted ? opts?.ghostRole : undefined,
            ghostValue: isHighlighted ? opts?.ghostValue : undefined,
            showX: opts?.showX,
          })}
        </div>
      )
    })

    // Show new OR group when ghosting and not highlighting any existing group
    const showNewGroup = opts?.ghostRole && opts?.ghostValue &&
      (opts?.highlightIdx === undefined || opts?.highlightIdx < 0) && dnf.length > 0

    return (
      <div className="fleet-filter-group-container">
        {groups}
        {showNewGroup && (
          <div className="fleet-filter-group-row">
            <span className="fleet-filter-or-sep">or</span>
            <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
              {renderChip(opts!.ghostRole!, opts!.ghostValue!, { ghost: true })}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={overlayRef} className="fleet-filter-overlay" onPointerDown={stopEventPropagation}>
      {pillOver ? (
        /* Two-pane drop preview: top = to, bottom = from, with replace zone in bottom-left */
        <div className="fleet-filter-drop-panes">
          <div
            ref={replaceZoneRef}
            className={`fleet-filter-replace-zone${hoveredGroup?.pane === 'replace' ? ' fleet-filter-replace-zone-active' : ''}`}
          >
            <span className="fleet-filter-replace-label">only</span>
            {renderChip('to', pillOver.value)}
            <span className="fleet-filter-replace-sep">+</span>
            {renderChip('from', pillOver.value)}
          </div>
          <div
            ref={toPaneRef}
            className={`fleet-filter-drop-pane fleet-filter-pane-to${hoveredGroup?.pane === 'to' ? ' fleet-filter-pane-active' : ''}`}
          >
            <span className="fleet-filter-pane-label">to</span>
            {toPreview ? renderDnfExpression(toPreview, {
              highlightIdx: toHighlightIdx,
            }) : (
              <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
                {renderChip('to', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
          <div
            ref={fromPaneRef}
            className={`fleet-filter-drop-pane fleet-filter-pane-from${hoveredGroup?.pane === 'from' ? ' fleet-filter-pane-active' : ''}`}
          >
            <span className="fleet-filter-pane-label">from</span>
            {fromPreview ? renderDnfExpression(fromPreview, {
              highlightIdx: fromHighlightIdx,
            }) : (
              <div className="fleet-filter-and-group fleet-filter-and-group-highlight">
                {renderChip('from', pillOver.value, { ghost: true })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Normal edit mode */
        <>
          <div className="fleet-filter-overlay-header">
            <span style={{ fontSize: 9, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>Filter</span>
          </div>
          {filter.length === 0 ? (
            <div className="fleet-filter-empty">
              No filter — drag agent pills here
            </div>
          ) : (
            <>
              {renderDnfExpression(filter, { showX: true })}
              <div className="fleet-filter-footer">
                <span className="fleet-filter-clear">Clear all</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Underlay div that mirrors textarea content, highlighting <<ref>> tokens */
function InputHighlightUnderlay({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [html, setHtml] = useState('')

  useEffect(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) return
    const sync = () => {
      const val = el.value
      if (!val || !val.includes('«')) {
        setHtml('')
        return
      }
      // Escape HTML, then highlight «...» tokens
      const escaped = val
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const highlighted = escaped.replace(
        /(«.+?»)/g,
        '<span class="ref-chip-underlay">$1</span>'
      )
      setHtml(highlighted)
    }
    el.addEventListener('input', sync)
    // Also sync on external value changes (chatInsertBus)
    const observer = new MutationObserver(sync)
    observer.observe(el, { attributes: true })
    sync()
    return () => {
      el.removeEventListener('input', sync)
      observer.disconnect()
    }
  }, [inputRef])

  if (!html) return null

  return (
    <div
      className="fleet-chat-input-underlay"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
