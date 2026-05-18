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
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext, memo, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// @ts-ignore — vanilla JS module
import { renderChatLine, resolveInlineAttachments, esc } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath, renderMarkdown as renderMarkdownUtil } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
import { initVoice, setVoiceTarget, clearVoiceTarget, resetTranscript, restartRecording, toggleRecording, sendCurrentText, isRecording } from '../voice.mjs'
// @ts-ignore — vanilla JS module
import { getHumanId, getHumanName } from '../fleet/fleet-data.mjs'
import { useFleetAgents, useFleetEvents, useFleetTasks, useFleetThinking, useFleetCompacting, useFleetContext, sendMessage, loadBefore, injectOptimisticEvent, updateOptimisticEvent } from '../fleet-data-adapter'
import { dropPillOnTarget, chatInsertBus, filterDropPreview, chipContentStore } from './FleetPillShape'
import { dragCoordinator } from './dragCoordinator'
import { DocContext, PanelContext } from '../PanelContext'
import { loadLookup, type LookupData } from '../synctexLookup'
import { log } from '../logger'
import { linkifyDocRefs, linkifyArrowRefs, linkifyLabelRefs, buildRefResolver, refToCanvas, type DocRef, type ResolvedRef, type LabelRegionInfo, type TheoremMapEntry } from '../docLinks'
import { fetchProofInfo, fetchTheoremMap } from '../docInfoCache'
import { PDF_HEIGHT, PDF_WIDTH } from '../layoutConstants'
import { TerminalCard } from './TerminalCard'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useIsInViewport } from './useIsInViewport'
import { broadcastSharedDoc } from '../useYjsSync'
import { getPageFilename } from '../stores/pageUrlStore'
import { consumeBulletContext, subscribeBulletContext, getBulletContext } from '../stores/bulletContextStore'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600
const FLEET_API = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5176'

// ---- Terminal hover pane ----

const TERM_HOVER_WS_HOST = typeof window !== 'undefined'
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
  : 'ws://localhost:5176'

// Terminal peek overlay — shown when hovering the terminal icon on a chat shape.
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
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pinnedRef = useRef(pinned)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting')
  const [height, setHeight] = useState(210)
  const [inputValue, setInputValue] = useState('')
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => { pinnedRef.current = pinned }, [pinned])

  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      fontSize: 10,
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
      scrollback: 100,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    requestAnimationFrame(() => { try { fit.fit() } catch {} })
    termRef.current = term
    fitRef.current = fit
    return () => {
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Re-fit when height changes
  useEffect(() => {
    requestAnimationFrame(() => {
      try { fitRef.current?.fit() } catch {}
    })
  }, [height])

  useEffect(() => {
    if (!agentId) return
    wsRef.current?.close()
    setStatus('connecting')
    const ws = new WebSocket(`${TERM_HOVER_WS_HOST}/ws/terminal?agent=${encodeURIComponent(agentId)}`)
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('connected')
      try { fitRef.current?.fit() } catch {}
    }
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'output' && msg.data && termRef.current) {
          // Peek mode: reset each time so we always show the current screen bottom.
          // Pinned mode: don't reset so user can scroll through accumulated output.
          if (!pinnedRef.current) termRef.current.reset()
          termRef.current.write(msg.data)
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

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    stopEventPropagation(e as any)
    if (e.key === 'Enter') {
      e.preventDefault()
      sendInput(inputValue + '\r')
      setInputValue('')
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      sendInput('\x03')
      setInputValue('')
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

  const shortId = agentId.replace('fleet:', '')

  return (
    <div
      className={`fleet-terminal-hover-pane${pinned ? ' fleet-terminal-hover-pane-pinned' : ''}`}
      style={{ height }}
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
      <div ref={containerRef} className="fleet-terminal-hover-body" />
      {pinned && status === 'connected' && (
        <div className="fleet-terminal-hover-input-bar"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
        >
          <span className="fleet-terminal-hover-prompt">$</span>
          <input
            className="fleet-terminal-hover-input"
            type="text"
            value={inputValue}
            onChange={(e) => { stopEventPropagation(e as any); setInputValue(e.target.value) }}
            onKeyDown={handleInputKeyDown}
            onKeyUp={(e) => stopEventPropagation(e as any)}
            placeholder="type command…"
            spellCheck={false}
            autoComplete="off"
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
  return renderMarkdownUtil(escapedInput, macros)
}

// --- Viewer context helper ---

function gatherViewerContext(editor: any, doc: any, chatShapeId?: string, version?: string | null) {
  if (!editor || !doc) return null
  const camera = editor.getCamera()
  const viewport = editor.getViewportPageBounds()
  const visiblePages: number[] = []
  if (doc.pages && viewport) {
    doc.pages.forEach((page: any, i: number) => {
      const b = page.bounds
      if (!b) return
      // Page is visible if it overlaps the viewport
      // Box uses w/h, not width/height
      const bw = b.w ?? b.width ?? 0
      const bh = b.h ?? b.height ?? 0
      if (b.x + bw > viewport.minX && b.x < viewport.maxX &&
          b.y + bh > viewport.minY && b.y < viewport.maxY) {
        visiblePages.push(i + 1)
      }
    })
  }
  const compareRef = (window as any).__tlda_compare_ref__ || null
  return {
    doc: doc.docName || null,
    version: version || null,
    compareRef,
    page: visiblePages.length === 1 ? visiblePages[0] : visiblePages.length > 1 ? visiblePages : null,
    camera: { x: Math.round(camera.x), y: Math.round(camera.y), z: Math.round(camera.z * 100) / 100 },
    chatShapeId: chatShapeId || undefined,
    browser: /Chrome/.test(navigator.userAgent) ? 'chrome' : /Safari/.test(navigator.userAgent) ? 'safari' : /Firefox/.test(navigator.userAgent) ? 'firefox' : 'unknown',
  }
}

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
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, filter: [] }
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
 * When all agents stop, the space persists (ghost) until rawItemsLength changes
 * (i.e. a real message arrives to replace it). No timeout — no bounce.
 */
function ThinkingStatus({ thinkingAgents, compactingAgents, contextPercent, ctx, rawItemsLength }: {
  thinkingAgents: Map<string, number>
  compactingAgents: Map<string, number>
  contextPercent: Map<string, number>
  ctx: any
  rawItemsLength: number
}) {
  // Merge thinking + compacting into one map keyed by agentId
  const statusAgents = useMemo(() => {
    const merged = new Map<string, { status: 'thinking' | 'compacting', startTs: number }>()
    for (const [id, ts] of thinkingAgents) {
      merged.set(id, { status: 'thinking', startTs: ts })
    }
    for (const [id, ts] of compactingAgents) {
      merged.set(id, { status: 'compacting', startTs: ts })
    }
    return merged
  }, [thinkingAgents, compactingAgents])

  const hasActive = statusAgents.size > 0
  const prevActiveRef = useRef(hasActive)
  const [ghost, setGhost] = useState(false)
  const ghostRawItemsRef = useRef(rawItemsLength)

  if (prevActiveRef.current && !hasActive && !ghost) {
    setGhost(true)
    ghostRawItemsRef.current = rawItemsLength
  }
  if (hasActive && ghost) {
    setGhost(false)
  }
  prevActiveRef.current = hasActive

  useEffect(() => {
    if (ghost && rawItemsLength !== ghostRawItemsRef.current) {
      setGhost(false)
    }
  }, [ghost, rawItemsLength])

  if (!hasActive && !ghost) return null

  return (
    <div style={{
      padding: '0 8px',
      fontSize: 11,
      flexShrink: 0,
      opacity: ghost ? 0 : 0.6,
      transition: 'opacity 0.2s',
    }}>
      {!ghost && [...statusAgents.entries()].map(([agentId, { status, startTs }]) => (
        <div key={agentId} className="chat-line chat-thinking" style={{ padding: '2px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span>
            <span className={ctx.getNickClass(agentId)}>{ctx.agentLabel(agentId)}</span>
            {' '}<span className="thinking-text">{status === 'compacting' ? 'compacting…' : 'thinking…'}</span>
            {' '}<ElapsedTime startMs={startTs} />
          </span>
          <ContextBadge percent={contextPercent.get(agentId)} />
        </div>
      ))}
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
    if (a) return a.friendly_name || a.id
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
  return {
    agentLabel,
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
  const { w, h, filter } = shape.props as { w: number; h: number; filter: [string, string][][] }
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)

  // Keep a ref to the current filter so the rename effect can read it without a stale closure
  const filterRef = useRef(filter)
  filterRef.current = filter

  // Track previous agent friendly names to detect renames (populated after agents is declared below)
  const prevAgentNamesRef = useRef<Record<string, string>>({})

  const activeBullet = useSyncExternalStore(subscribeBulletContext, getBulletContext)

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
  const [olderEvents, setOlderEvents] = useState<any[]>([])

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
      }).catch(() => {})
    }
    setTermCardPinnedId(null)
    setTermCardHoverId(null)
  }, [liveEvents])

  // Input history (up/down arrow navigation like terminal)
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  // Esc interrupt: track last Esc timestamp for soft/hard distinction
  const lastEscRef = useRef<number>(0)
  const escCountRef = useRef<number>(0)
  // Keep sendTargets accessible from native event listener without re-registering
  const sendTargetsRef = useRef<string[]>([])

  // Merge older (scrollback) events with live events
  const events = useMemo(() => {
    if (olderEvents.length === 0) return liveEvents
    // Deduplicate by _dbId AND timestamp+from (covers pre-reconciliation optimistic events)
    const seen = new Set<string>()
    for (const e of liveEvents) {
      if (e._dbId) seen.add(String(e._dbId))
      seen.add(`${e.timestamp}:${e.from}`)
    }
    const unique = olderEvents.filter((e: any) => {
      if (e._dbId && seen.has(String(e._dbId))) return false
      if (seen.has(`${e.timestamp}:${e.from}`)) return false
      return true
    })
    return [...unique, ...liveEvents]
  }, [liveEvents, olderEvents])

  // Reset older events and scroll state when filter changes
  const filterKey = JSON.stringify(filter)
  useEffect(() => {
    setOlderEvents([])
    isAtBottomRef.current = true
    setShowScrollBtn(false)
    prevTotalSizeRef.current = 0
  }, [filterKey])

  // Resolve a friendly name/label to a fleet ID for DB queries.
  const resolveToFleetId = useCallback((label: string): string => {
    if (label.startsWith('fleet:')) return label
    const agent = agents.find((a: any) =>
      a.friendly_name === label || a.id === label || (a.labels || []).includes(label)
    )
    return agent?.id || label
  }, [agents])

  // Fetch per-agent history on mount / filter change.
  // The global event buffer (MAX_EVENTS=150) is shared across all agents.
  // A quiet agent's messages may not be in the buffer at all, making the
  // chat appear empty. Fix: always fetch agent-specific history from the DB.
  const historyLoadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!dnfFilter || dnfFilter.length === 0) return
    const firstLabel = dnfFilter[0]?.[0]?.[1]
    if (!firstLabel) return
    const fleetId = resolveToFleetId(firstLabel)
    // Agents start as [] (async init). If the label didn't resolve to a
    // fleet ID yet, bail out — the effect re-runs when agents populate.
    if (fleetId === firstLabel && !firstLabel.startsWith('fleet:')) return
    const loadKey = `${filterKey}:${fleetId}`
    if (historyLoadedRef.current === loadKey) return
    historyLoadedRef.current = loadKey
    loadBefore(fleetId, new Date().toISOString(), 50).then((older: any[]) => {
      if (older.length > 0) {
        // Deduplicate against live events already in the buffer.
        // convertChatEvent stores DB id in _dbId, not id.
        setOlderEvents(prev => {
          const existingIds = new Set([
            ...prev.map((e: any) => e._dbId || e._tempId),
            ...liveEvents.map((e: any) => e._dbId || e._tempId),
          ])
          const fresh = older.filter((e: any) => !existingIds.has(e._dbId))
          if (fresh.length > 0) {
            isAtBottomRef.current = true
            setShowScrollBtn(false)
            return [...fresh, ...prev]
          }
          return prev
        })
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dnfFilter, filterKey, resolveToFleetId])


  const chatLogRef = useRef<HTMLDivElement>(null)
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
      .catch(() => {})
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
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity' || t === 'kill-session' || t === 'terminal_attention' || t === 'terminal_card'
      })
      .filter((m: any) => !m._timer) // skip timer-fired messages
      .sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })

    return sorted
  }, [events])


  // Build per-item raw HTML array — each item is an independent renderable unit.
  // This replaces the old joined renderedHtml string and enables virtualization.
  type RawItem = { key: string; html: string }
  const rawItems = useMemo(() => {
    // Extend ctx with thinking state so renderChatLine can apply queued styling
    const renderCtx = { ...ctx, thinkingAgents }
    const items: RawItem[] = []
    let activityGroup: any[] = []
    function flushActivity() {
      if (activityGroup.length === 0) return
      const key = `activity:${activityGroup[0].from}:${activityGroup[0].timestamp}`
      items.push({
        key,
        html: `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, renderCtx)}</div>`,
      })
      activityGroup = []
    }

    for (let i = 0; i < chatMessages.length; i++) {
      const m = chatMessages[i]
      if (m._activity) {
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) flushActivity()
        activityGroup.push(m)
      } else if (m.metadata?.type === 'build_result') {
        flushActivity()
        const { name: docName, hash, summary, lintFindings = [] } = m.metadata
        const hasDetails = !!(summary || lintFindings.length > 0)
        const lintCount = lintFindings.length
        const lintBadge = lintCount > 0
          ? `<span class="build-result-lint-badge">${lintCount} finding${lintCount !== 1 ? 's' : ''}</span>`
          : ''
        const summaryHtml = summary ? renderCtx.renderMarkdown(esc(summary)) : ''
        const lintHtml = lintFindings.map((f: any) => renderCtx.renderMarkdown(esc(f.text))).join('')
        const toggle = hasDetails ? `<span class="build-result-toggle">▾</span>` : ''
        const html = `<div class="build-result-card">` +
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
        items.push({ key: m._dbId || `${m.timestamp}:${m.from}:build`, html })
      } else if (m.metadata?.type === 'plan_approval') {
        flushActivity()
        const agentId: string = m.from || ''
        const agentObjs: any[] = renderCtx.getAgents()
        const agentObj = agentObjs.find((a: any) => a.id === agentId)
        const agentName = agentObj?.friendly_name || agentId.replace('fleet:', '')
        const planBodyHtml = renderCtx.renderMarkdown(esc(m.text || ''))
        const html = `<div class="plan-card" data-agent-id="${esc(agentId)}">` +
          `<div class="plan-card-header"><span class="plan-card-icon">📋</span>` +
          `<span class="plan-card-title">Plan from <strong>${esc(agentName)}</strong></span></div>` +
          `<div class="plan-card-body">${planBodyHtml}</div>` +
          `<div class="plan-card-actions">` +
          `<button class="plan-approve-btn" data-agent-id="${esc(agentId)}">✓ Go for it</button>` +
          `<button class="plan-reject-btn" data-agent-id="${esc(agentId)}">✗ Stop</button>` +
          `</div></div>`
        items.push({ key: m._dbId || `${m.timestamp}:${m.from}:plan`, html })
      } else if (m.type === 'kill-session') {
        flushActivity()
        const agentObjs: any[] = renderCtx.getAgents()
        const targetId = m.to || ''
        const targetAgent = agentObjs.find((a: any) => a.id === targetId)
        const targetName = targetAgent?.friendly_name || targetId.replace('fleet:', '')
        const html = `<div class="kill-session-card"><span class="kill-session-icon">⚡</span><span class="kill-session-text">Session killed: <strong>${esc(targetName)}</strong></span></div>`
        items.push({ key: m._dbId || `${m.timestamp}:${m.from}:kill`, html })
      } else {
        flushActivity()
        const html = renderChatLine(m, renderCtx)
        if (html) {
          items.push({ key: `${m.timestamp}:${m.from}`, html })
        }
      }
    }
    flushActivity()
    return items
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, ctx, thinkingAgents])

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
      const shapeIdMatch = inner.match(/#(shape:[^»]+)$/)
      const embeddedShapeId = shapeIdMatch?.[1]
      let ref: any = undefined
      if (embeddedShapeId) {
        const srcShape = editor.getShape(embeddedShapeId as any) as any
        if (srcShape) {
          const highlightId = srcShape.props?.highlightId
          const highlight = highlightId ? editor.getShape(highlightId as any) as any : null
          const refShape = highlight || srcShape
          const refBounds = editor.getShapePageBounds(refShape.id)
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
      const isAnnotation = ref?.type === 'annotation'
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
      html = linkifyArrowRefs(html, labelRegions)
      html = linkifyLabelRefs(html, labelRegions)
    }
    if (doc) html = linkifyDocRefs(html)
    return html
  }, [doc, labelRegions, imageSrcs, editor])

  // Virtual scroll — only mount DOM nodes for visible messages.
  // Placed after rawItems so count is always defined.
  // estimateSize: 65px ≈ average message height (2-3 lines + padding).
  // A close estimate prevents the "scrolled to middle" bug where setting
  // scrollTop = estimated-total puts you far from the actual bottom.
  const virtualizer = useVirtualizer({
    count: rawItems.length,
    getScrollElement: () => chatLogRef.current,
    estimateSize: () => 65,
    overscan: 8,
  })

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

    // Expandable markdown chips — click .ref-chip-doc for .md files to toggle inline card
    const mdChip = (e.target as HTMLElement).closest('.ref-chip-doc') as HTMLElement | null
    if (mdChip) {
      const chipUrl = mdChip.dataset.url || ''
      const chipPath = mdChip.dataset.path || ''
      const isMd = /\.md$/i.test(chipUrl || chipPath)
      if (isMd && chipUrl) {
        e.stopPropagation()
        // Prevent auto-scroll from pushing the chip out of view when the expand card grows the content.
        // isAtBottomRef is declared later but accessed at call time (ref identity is stable).
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        isAtBottomRef.current = false
        // Toggle: if already expanded, collapse
        const existing = mdChip.nextElementSibling as HTMLElement | null
        if (existing?.classList.contains('md-expand-card')) {
          existing.remove()
          mdChip.classList.remove('md-chip-expanded')
          return
        }
        // Create card
        mdChip.classList.add('md-chip-expanded')
        const card = document.createElement('div')
        card.className = 'md-expand-card'
        card.innerHTML = '<div class="md-expand-loading">Loading…</div>'
        mdChip.insertAdjacentElement('afterend', card)
        // Fetch and render
        fetch(chipUrl)
          .then(r => r.ok ? r.text() : Promise.reject(r.status))
          .then(text => {
            // Resolve relative image paths to absolute URLs based on the chip URL
            const baseUrl = chipUrl.substring(0, chipUrl.lastIndexOf('/') + 1)
            const resolved = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
              if (src.startsWith('http') || src.startsWith('/')) return match
              return `![${alt}](${baseUrl}${src})`
            })
            card.innerHTML = `<div class="md-expand-header"><span class="md-expand-title">${mdChip.textContent || 'file'}</span><span class="md-expand-close" title="Collapse">✕</span></div><div class="md-expand-body">${tldaRenderMarkdown(resolved)}</div>`
            card.querySelector('.md-expand-close')?.addEventListener('click', (ev) => {
              ev.stopPropagation()
              card.remove()
              mdChip.classList.remove('md-chip-expanded')
            })
          })
          .catch(() => {
            card.innerHTML = '<div class="md-expand-error">Failed to load</div>'
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
    setDocLinkHover(null) // dismiss preview on click
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

  // Hover preview for doc-link spans
  const shapeContainerRef = useRef<HTMLDivElement>(null)
  const [_docLinkHover, setDocLinkHover] = useState<{
    resolved: ResolvedRef
    /** Anchor position in shape-local coordinates */
    localX: number
    localY: number
    localW: number
    text: string
  } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const logEl = chatLogRef.current
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
  }, [doc, refResolver, w, liveEvents])

  // Native capture-phase drop handler — intercepts OS file drops (from Finder etc.)
  // anywhere on the chat shape before tldraw can create a canvas image shape.
  // Files are uploaded to the fleet server and referenced by stable URL.
  useEffect(() => {
    const el = shapeContainerRef.current
    if (!el) return

    function onDragOver(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
    }

    async function onDrop(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()

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
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('drop', onDrop, true)
    }
  }, [shape.id, editor])

  // Hover events on annotation ref-chips → dispatch to AnnotationViewer
  const annotationHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const logEl = chatLogRef.current
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
  }, [])

  // Auto-scroll to bottom — event-driven, not every frame.
  // CanvasClipPanel already routes wheel events to .fleet-chat-log via
  // scrollable.scrollTop += e.deltaY, so we must NOT fight it with a
  // continuous rAF loop. Instead: scroll to bottom when new content arrives
  // or the container resizes, but only if the user hasn't scrolled up.
  const isAtBottomRef = useRef(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  // Hard-locked mode: every content change scrolls to bottom unconditionally.
  // Persisted to localStorage so it survives reloads.
  const HARD_LOCKED_KEY = 'fleet-chat-hard-locked'
  const [hardLocked, setHardLocked] = useState(() => localStorage.getItem(HARD_LOCKED_KEY) === 'true')
  const hardLockedRef = useRef(hardLocked)
  useEffect(() => {
    hardLockedRef.current = hardLocked
    localStorage.setItem(HARD_LOCKED_KEY, String(hardLocked))
  }, [hardLocked])
  const [termHoverVisible, setTermHoverVisible] = useState(false)
  const [termHoverPinned, setTermHoverPinned] = useState(false)
  const termHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const termAutoPinnedRef = useRef(false)
  const lastAttentionTsRef = useRef<string | null>(null)
  // Tracks which chat rows have been expanded (by item key) so the state
  // survives dangerouslySetInnerHTML re-renders.
  const expandedRowsRef = useRef<Set<string>>(new Set())
  // scrollToBottom sets scrollTop = scrollHeight. The ResizeObserver on the
  // virtualizer's inner div calls it again after measurement, catching the
  // race where scrollHeight grows after the initial scroll.
  const scrollSuppressUntilRef = useRef(0)
  const scrollToBottom = useCallback(() => {
    const el = chatLogRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    scrollSuppressUntilRef.current = Date.now() + 100
    isAtBottomRef.current = true
  }, [])

  // Track whether user is at bottom (within 30px threshold).
  // Also detect container resizes (e.g. textarea growing via field-sizing: content)
  // which shrink the chat log without the user scrolling.
  const prevClientHeightRef = useRef(0)
  useEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    prevClientHeightRef.current = el.clientHeight
    const onScroll = () => {
      if (Date.now() < scrollSuppressUntilRef.current) return
      const ch = el.clientHeight
      const resized = ch !== prevClientHeightRef.current
      prevClientHeightRef.current = ch
      const dist = el.scrollHeight - el.scrollTop - ch
      const atBottom = dist < 30
      if (resized && isAtBottomRef.current && !atBottom) {
        scrollToBottom()
        return
      }
      isAtBottomRef.current = atBottom
      setShowScrollBtn(!atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollToBottom])

  // Terminal card hover — mouseover on .lc-terminal-card shows the terminal overlay.
  useEffect(() => {
    const el = chatLogRef.current
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
  }, [])

  // Scroll to bottom when new messages arrive or activity cards grow.
  //
  // rawItems.length alone is not enough: activity messages from the same
  // agent merge into a single rawItem, so a burst of tool-call events can
  // make scrollHeight grow by hundreds of px without changing rawItems.length.
  // Tracking getTotalSize() catches both new items AND measurement updates.
  const virtualizerTotalSize = virtualizer.getTotalSize()
  const prevTotalSizeRef = useRef(0)
  useEffect(() => {
    if (virtualizerTotalSize === 0) return
    const firstLoad = prevTotalSizeRef.current === 0
    prevTotalSizeRef.current = virtualizerTotalSize
    if (firstLoad || isAtBottomRef.current || hardLocked) {
      scrollToBottom()
      requestAnimationFrame(scrollToBottom)
    }
  }, [virtualizerTotalSize, scrollToBottom, hardLocked])

  // rawItems.length effect: reset prevTotalSizeRef on filter change / target switch
  // so the next load is treated as a first load. (filterKey effect handles this
  // for the target-switch case; this handles in-flight rawItems resets.)
  useEffect(() => {
    if (rawItems.length === 0) prevTotalSizeRef.current = 0
  }, [rawItems.length])

  // ResizeObserver on the inner content div (virtualizer total-size container).
  // When the virtualizer measures a new item, this div's height changes, which
  // updates scrollHeight. We scroll to bottom at that point if we should be
  // pinned there. Observing the outer scroll container wouldn't work — its
  // visible size is fixed, only scrollHeight changes.
  //
  // hasMessages re-runs the effect when messages first arrive: el.firstElementChild
  // changes identity (empty-state div → virtualizer total-size div) and the observer
  // must re-attach to the new element. Without this, the observer watches the detached
  // empty-state div and misses all virtualizer height updates during initial load.
  const hasMessages = rawItems.length > 0
  useEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (isAtBottomRef.current || hardLockedRef.current) {
        requestAnimationFrame(scrollToBottom)
      }
    })
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [scrollToBottom, hasMessages])

  // --- Shared doc: auto-create sticky when a .md file chip appears in chat ---
  // Track which messages we've already processed to avoid duplicates.
  const sharedDocProcessed = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (chatMessages.length === 0) return
    const mainEditor = (window as any).__tldraw_editor__ as any
    if (!mainEditor) return

    // Only process the last few messages to avoid re-processing old history
    const recentMessages = chatMessages.slice(-3)
    for (const m of recentMessages) {
      const msgKey = `${m.timestamp}:${m.from}`
      if (sharedDocProcessed.current.has(msgKey)) continue
      sharedDocProcessed.current.add(msgKey)

      // Skip messages from the human user — only auto-display agent-shared files
      if (m.from && !m.from.startsWith('fleet:')) continue

      // Extract .md file paths from message text and inline attachments
      const mdPaths: string[] = []

      // Check inline attachments
      if (m._inlineAttachments) {
        for (const att of m._inlineAttachments) {
          if (att?.path && /\.md$/i.test(att.path)) {
            mdPaths.push(att.path)
          }
        }
      }

      // Check message text for absolute .md paths
      const text = m.text || ''
      const absPathMatches = text.match(/\/Users\/\w+\/[\w/._-]+\.md/g)
      if (absPathMatches) {
        for (const p of absPathMatches) {
          if (!mdPaths.includes(p)) mdPaths.push(p)
        }
      }
      // Check [file:/path.md] syntax
      const fileRefMatches = text.match(/\[file:(\/[\w/._-]+\.md)\]/g)
      if (fileRefMatches) {
        for (const match of fileRefMatches) {
          const p = match.slice(6, -1) // strip [file: and ]
          if (!mdPaths.includes(p)) mdPaths.push(p)
        }
      }

      if (mdPaths.length === 0) continue

      // Create a sticky for each .md file found
      for (const filePath of mdPaths) {
        ;(async () => {
          try {
            const res = await fetch(`/api/read-file?path=${encodeURIComponent(filePath)}`)
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
              // Update existing sticky content
              mainEditor.updateShape({
                id: existingId,
                type: 'math-note',
                props: { text: content },
              })
              broadcastSharedDoc(existingId, filePath)
            } else {
              // Create new sticky off to the right of the document
              // Offset to avoid overlapping all existing math-notes and fleet-docview panels
              let newX = 2000
              const blockers = allShapes.filter((s: any) =>
                s.type === 'math-note' ||
                s.type === 'fleet-docview'
              )
              for (const s of blockers) {
                const sb = mainEditor.getShapePageBounds(s.id)
                if (sb && newX < sb.x + sb.w + 20 && newX + 550 > sb.x) {
                  newX = sb.x + sb.w + 30
                }
              }
              const stickyId = createShapeId()
              mainEditor.createShape({
                id: stickyId,
                type: 'math-note' as any,
                x: newX,
                y: 100,
                isLocked: false,
                props: {
                  w: 550,
                  h: 400,
                  text: content,
                  color: 'light-violet',
                  autoSize: true,
                },
                meta: {
                  sharedDocPath: filePath,
                  sharedDoc: true,
                  fromAgent: m.from,
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
    const logEl = chatLogRef.current
    if (!logEl) return
    function onClick(e: Event) {
      // Plan approval buttons
      const approveBtn = (e.target as HTMLElement).closest('.plan-approve-btn') as HTMLElement
      if (approveBtn) {
        e.stopPropagation()
        const agentId = approveBtn.dataset.agentId
        if (agentId) {
          const card = approveBtn.closest('.plan-card') as HTMLElement
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'approve' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .then(() => { if (card) card.classList.add('plan-card-approved') })
            .catch(err => sendMessage(getHumanId(), `⚠️ plan approve failed: ${err.message}`, {}))
        }
        return
      }
      const rejectBtn = (e.target as HTMLElement).closest('.plan-reject-btn') as HTMLElement
      if (rejectBtn) {
        e.stopPropagation()
        const agentId = rejectBtn.dataset.agentId
        if (agentId) {
          const card = rejectBtn.closest('.plan-card') as HTMLElement
          fetch(`${FLEET_API}/api/plan-mode-respond`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: agentId, response: 'reject' }),
          })
            .then(r => r.ok ? null : r.json().then(d => { throw new Error(d?.error || 'failed') }))
            .then(() => { if (card) card.classList.add('plan-card-rejected') })
            .catch(err => sendMessage(getHumanId(), `⚠️ plan reject failed: ${err.message}`, {}))
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
          return
        }
      }
      const lcDenyBtn = (e.target as HTMLElement).closest('.lc-deny-btn') as HTMLElement | null
      if (lcDenyBtn) {
        const agentId = lcDenyBtn.dataset.agentId
        if (agentId) {
          fetch(`${FLEET_API}/api/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId, text: '3', enter: true }) })
          return
        }
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
  }, [])

  // Unquote: double-click on <code> spans inside chat messages.
  // TLDraw intercepts the native dblclick event in its capture-phase handler on .tl-canvas,
  // so we detect double-click via two consecutive click events on the same <code> element.
  // click events reach bubble phase normally (markEventAsHandled on pointerdown handles TLDraw).
  useEffect(() => {
    const logEl = chatLogRef.current
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
  }, [])

  // Esc interrupt via native listener — TLDraw's capture-phase stopPropagation blocks React
  // synthetic keydown for Escape, so we attach directly at the target element.
  // Three tiers: 1×Esc = soft (single Escape to tmux), 2×Esc = hard (Escape+poll loop),
  // 3×Esc = kill session (tmux kill-session, agent dies immediately).
  // No thinkingAgents dependency — if you're mashing Escape at an agent, you mean it.
  useEffect(() => {
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta) return
    function onEscKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      log.debug('esc', 'keydown', { value: ta!.value, targets: sendTargetsRef.current })
      if (ta!.value !== '') return
      const targets = sendTargetsRef.current
      if (targets.length === 0) return
      e.preventDefault()
      const now = Date.now()
      const agent = targets[0]
      const gap = now - lastEscRef.current
      if (gap < 500) {
        escCountRef.current++
      } else {
        escCountRef.current = 1
      }
      lastEscRef.current = now
      const count = escCountRef.current
      log.debug('esc', 'count', { count, gap, agent })
      if (count >= 3) {
        // Kill session: 3×Esc — tmux kill-session, agent dies immediately
        escCountRef.current = 0
        lastEscRef.current = 0
        log.info('esc', 'kill-session', { agent })
        fetch(`${FLEET_API}/api/kill-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
          .then(r => r.json()).then(d => log.debug('esc', 'kill-session response', d))
          .catch(err => log.warn('esc', 'kill-session failed', { err }))
      } else if (count === 2) {
        // Hard interrupt: 2×Esc — Escape+poll loop
        log.info('esc', 'hard-interrupt', { agent })
        fetch(`${FLEET_API}/api/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
      } else {
        // Soft interrupt: 1×Esc — single Escape to tmux
        log.info('esc', 'soft-interrupt', { agent })
        fetch(`${FLEET_API}/api/send-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, key: 'Escape' }) })
      }
    }
    function onBlur() {
      // TLDraw steals focus after Esc — reclaim it if we're mid-sequence
      if (escCountRef.current > 0 && Date.now() - lastEscRef.current < 500) {
        ta!.focus()
      }
    }
    ta.addEventListener('keydown', onEscKey)
    ta.addEventListener('blur', onBlur)
    return () => {
      ta.removeEventListener('keydown', onEscKey)
      ta.removeEventListener('blur', onBlur)
    }
  }, [])

  // Textarea resize is handled by CSS field-sizing: content.
  // The chat log ResizeObserver catches the container shrink and scrolls to bottom.

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = a.friendly_name || (a.id || '').replace('fleet:', '')
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

  // Resolve the first send target to a fleet ID with an active tmux_session.
  // The terminal icon is hidden when this is null.
  const hoverTargetAgentId = useMemo(() => {
    for (const label of sendTargets) {
      const fleetId = label.startsWith('fleet:') ? label
        : agents.find((a: any) => a.friendly_name === label || a.id === label || (a.labels || []).includes(label))?.id || label
      const agent = agents.find((a: any) => a.id === fleetId)
      if (agent?.tmux_session && !agent?.dead) return fleetId
    }
    return null
  }, [sendTargets, agents])

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

  // Derive a loadBefore agent: use first agent in filter
  const loadBeforeAgent = sendTargets[0] ? resolveToFleetId(sendTargets[0]) : undefined

  // Infinite scroll — load older messages
  const loadingMore = useRef(false)
  const handleScroll = useCallback(async (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop > 50 || loadingMore.current || chatMessages.length === 0) return
    loadingMore.current = true
    const oldestTs = chatMessages[0]?.timestamp
    if (oldestTs) {
      const prevHeight = el.scrollHeight
      const older = await loadBefore(loadBeforeAgent, oldestTs, 50)
      if (older.length > 0) {
        setOlderEvents(prev => [...older, ...prev])
      }
      // Maintain scroll position
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    }
    loadingMore.current = false
  }, [chatMessages, loadBeforeAgent])

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
    startX: number
    startY: number
    started: boolean
    captureEl: HTMLElement | null
    pointerId: number
  } | null>(null)

  // Store agentNames in a ref so native listeners can access current value
  const agentNamesRef = useRef(agentNames)
  agentNamesRef.current = agentNames

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
    const logEl = chatLogRef.current
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

      // Activity card (only when NOT dragging from inside a tool line)
      if (!drag) {
        const actCard = target.closest('.chat-activity-card') as HTMLElement
        if (actCard) {
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

      // Code block header (but not the copy button — let that through to onClick)
      if (!drag) {
        const codeHeader = target.closest('.code-block-header') as HTMLElement
        if (codeHeader && !target.closest('.code-block-copy')) {
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
            }).catch(() => {})
          }
          drag = {
            pillId: null, pillType: 'file' as any, value: token,
            displayName: label, color: '#9370db',
            content: fileContent,
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
  }, [editor])

  // --- chatInsertBus listener: content drops insert into textarea ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId, text } = (e as CustomEvent).detail
      if (chatId && chatId !== shape.id) return // skip if targeted to a different chat; accept broadcasts (no chatId)
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (!ta) return
      const pos = ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)
      const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + (after && !after.startsWith('\n') ? '\n' : '')
      ta.value = before + insert + after
      // field-sizing: content handles auto-resize
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
    if (!activeBullet) return
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta || ta.getBoundingClientRect().width === 0) return
    ta.focus()
    if (!isRecording()) toggleRecording()
  }, [activeBullet])

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
            agentNames={agentNames}
            shapeId={shape.id}
            editor={editor}
            onClose={() => setFilterOpen(false)}
            externalPillOver={pillOver}
          />
        )}

        {/* Messages — scroll container. Textarea is OUTSIDE (flex sibling). */}
        <div
          ref={chatLogRef}
          className="fleet-chat-log"
          style={{
            flex: 1,
            minHeight: 0,  // Allow flex item to shrink below content height
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '4px 0',
          }}
          onScroll={handleScroll}
          onClick={handleDocLinkClick}
        >
          {chatMessages.length === 0 ? (
            <div style={{
              padding: '20px 8px',
              opacity: isImpossibleFilter ? 0.6 : 0.3,
              textAlign: 'center',
              fontSize: 10,
              color: isImpossibleFilter ? 'var(--red, #e55)' : undefined,
            }}>
              {isImpossibleFilter
                ? '⚠ Filter matches no known agents'
                : filter.length > 0 ? 'No messages' : 'No filter set'}
            </div>
          ) : (
            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vItem => (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, transform: `translateY(${vItem.start}px)`, width: '100%' }}
                >
                  <ChatMessageRow html={rawItems[vItem.index].html} postProcess={postProcess} itemKey={rawItems[vItem.index].key} expandedRowsRef={expandedRowsRef} />
                </div>
              ))}
            </div>
          )}
          <ThinkingStatus
            thinkingAgents={thinkingAgents}
            compactingAgents={compactingAgents}
            contextPercent={contextPercent}
            ctx={ctx}
            rawItemsLength={rawItems.length}
          />
        </div>

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
            agentNames={agentNames}
            inputRef={inputRef}
          />
          <div style={{ position: 'relative' }}>
            {/* Highlight underlay — mirrors textarea text, highlights <<ref>> tokens */}
            <InputHighlightUnderlay inputRef={inputRef} />
            {/* Hard-lock scroll toggle — magnet icon, left of textarea */}
            <button
              className="fleet-hardlock-toggle"
              onPointerDown={stopEventPropagation}
              onClick={(e) => {
                stopEventPropagation(e)
                setHardLocked(prev => !prev)
              }}
              title={hardLocked ? 'Hard-locked scroll — click for smart scroll' : 'Smart scroll — click to hard-lock'}
            >
              <svg
                width="10"
                height="14"
                viewBox="0 0 10 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 9 L2 4 Q2 1 5 1 Q8 1 8 4 L8 9"/>
                {hardLocked && <>
                  <path d="M1 11 Q2.5 10 5 11 Q7.5 12 9 11" strokeWidth="1"/>
                  <path d="M2 13 Q3.5 12 5 13 Q6.5 14 8 13" strokeWidth="0.8"/>
                </>}
              </svg>
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
            {activeBullet && (
              <div
                onClick={() => consumeBulletContext()}
                style={{
                  fontSize: '10px',
                  lineHeight: '16px',
                  color: '#7c3aed',
                  background: 'rgba(124, 58, 237, 0.08)',
                  borderRadius: '4px',
                  padding: '1px 6px',
                  marginBottom: '2px',
                  cursor: 'pointer',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title="Click to dismiss"
              >
                {'• ' + activeBullet.text}
              </div>
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
                // Escape: clear text if present. Interrupt escalation (soft/hard/kill)
                // is handled entirely by the native keydown listener above.
                if (e.key === 'Escape') {
                  e.preventDefault()
                  if (ta.value !== '') {
                    ta.value = ''
                    ta.style.height = ''
                  }
                  return
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

                  const doSend = () => {
                    const text = val.trim()
                    if (!text || sendTargets.length === 0) return
                    const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel))
                    const bulletCtx = consumeBulletContext()
                    if (bulletCtx && context) {
                      ;(context as any).bullet = bulletCtx
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
                          }).catch(() => {})
                          // Mark the card visually
                          const cards = chatLog?.querySelectorAll(`.plan-card[data-agent-id="${CSS.escape(agentId)}"]`)
                          cards?.forEach((el) => el.classList.add(planResponse === 'approve' ? 'plan-card-approved' : 'plan-card-rejected'))
                        }
                      }
                    }

                    // Plan mode toggle: enter ("let's plan", "plan first", etc.) or exit
                    // ("exit plan mode", "done planning", "back to normal"). Same endpoint
                    // handles both — it reads current mode and sends the right # of BTabs.
                    const ENTER_PLAN_RE = /^\/plan\b|\blet'?s plan\b|\bplan mode\b|\bplan first\b|\bthink before\b|\bexit plan\b|\bdone planning\b|\bback to normal\b/i
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

                    // Inject optimistic event immediately so the message appears in history
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
                    isAtBottomRef.current = true
                    setShowScrollBtn(false)
                    requestAnimationFrame(() => scrollToBottom())
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
                // field-sizing: content handles auto-resize natively.
                // Chat log ResizeObserver handles scroll-to-bottom.
              }}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                // Register voice target on pointerdown — onFocus can be unreliable in tldraw
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, (targets: string[], text: string) => {
                  // Same optimistic send path as Enter key — one send path for everything
                  const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel))
                  const bulletCtx = consumeBulletContext()
                  if (bulletCtx && context) {
                    ;(context as any).bullet = bulletCtx
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
                  isAtBottomRef.current = true
                  setShowScrollBtn(false)
                  requestAnimationFrame(() => scrollToBottom())
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
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, (targets: string[], text: string) => {
                  const context = gatherViewerContext(editor, doc, shape.id, currentDocVersion(panel))
                  const bulletCtx = consumeBulletContext()
                  if (bulletCtx && context) {
                    ;(context as any).bullet = bulletCtx
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
                  isAtBottomRef.current = true
                  setShowScrollBtn(false)
                  requestAnimationFrame(() => scrollToBottom())
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

        {/* Scroll-to-bottom button — floats over the bottom of the chat */}
        {showScrollBtn && (
          <div style={{ position: 'relative', height: 0, zIndex: 10 }}>
            <button
              className="fleet-scroll-bottom-btn"
              onPointerDown={stopEventPropagation}
              onClick={(e) => {
                stopEventPropagation(e)
                scrollToBottom()
                setShowScrollBtn(false)
              }}
              style={{
                position: 'absolute',
                right: 8,
                bottom: 4,
                width: 22,
                height: 22,
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                color: 'rgba(200, 200, 200, 1)',
                opacity: 0.35,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                fontWeight: 'bold',
                lineHeight: 1,
                padding: 0,
                transition: 'opacity 0.2s',
              }}
              title="Scroll to bottom"
            >↓</button>
          </div>
        )}
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

/** Floating preview panel — shows a clipped SVG region on doc-link hover */
export function DocLinkPreview({
  resolved,
  localX,
  localY,
  text,
  docName,
  shapeW,
  onDismiss,
}: {
  resolved: ResolvedRef
  localX: number
  localY: number
  text: string
  docName: string
  shapeW: number
  onDismiss: () => void
}) {
  // Compute the SVG region to show (in PDF coordinates)
  const PREVIEW_H_PDF = 150
  const pdfY = resolved.pdfY ?? PDF_HEIGHT * 0.3
  const yTop = Math.max(0, pdfY - PREVIEW_H_PDF / 2)
  const yBottom = Math.min(PDF_HEIGHT, yTop + PREVIEW_H_PDF)

  // SVG URL
  const ws = (import.meta as any).env?.VITE_SYNC_SERVER as string | undefined
  const base = ws ? ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/' : (import.meta as any).env?.BASE_URL || '/'
  const svgFilename = getPageFilename(resolved.page - 1) ?? `page-${resolved.page}.svg`
  const svgUrl = `${base}docs/${docName}/${svgFilename}`

  // Preview dimensions — fit within the shape width
  const PREVIEW_W = Math.min(320, shapeW - 16)
  const scale = PREVIEW_W / PDF_WIDTH
  const previewH = (yBottom - yTop) * scale
  const labelH = 20

  // Position above the hovered link, clamped to shape bounds
  const left = Math.max(4, Math.min(localX, shapeW - PREVIEW_W - 4))
  const top = localY - previewH - labelH - 6

  return (
    <div
      className="doc-link-preview"
      style={{
        position: 'absolute',
        left,
        top: Math.max(0, top),
        width: PREVIEW_W,
        zIndex: 50,
      }}
      onMouseLeave={onDismiss}
    >
      <div className="doc-link-preview-label">
        <span>{text}</span>
        <span className="doc-link-preview-page">p.{resolved.page}</span>
      </div>
      <div
        className="doc-link-preview-clip"
        style={{
          width: PREVIEW_W,
          height: previewH,
          overflow: 'hidden',
        }}
      >
        <img
          src={svgUrl}
          alt=""
          style={{
            display: 'block',
            width: PREVIEW_W,
            height: PDF_HEIGHT * scale,
            transform: `translateY(${-yTop * scale}px)`,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  )
}

function SendHint({
  filter: _filter,
  sendTargets,
  agentNames,
  inputRef,
}: {
  filter: [string, string][][]
  sendTargets: string[]
  agentNames: Record<string, string>
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [hint, setHint] = useState('')

  const targetLabel = useMemo(() => {
    if (sendTargets.length === 0) return ''
    return sendTargets.map(t => agentNames[t] || t.replace('fleet:', '')).join(' + ')
  }, [sendTargets, agentNames])

  const update = useCallback(() => {
    const el = inputRef.current as HTMLTextAreaElement | null
    if (!el) {
      setHint(targetLabel ? `→ ${targetLabel}` : '')
      return
    }
    const val = el.value
    if (!val) {
      setHint(targetLabel ? `→ ${targetLabel}` : '')
      return
    }
    const pos = el.selectionStart ?? val.length
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1
    const currentLine = val.slice(lineStart, pos)
    if (currentLine.endsWith(' ')) {
      setHint('↵ newline')
    } else {
      setHint(targetLabel ? `↵ → ${targetLabel}` : '↵')
    }
  }, [targetLabel, inputRef])

  useEffect(() => {
    update()
  }, [targetLabel, update])

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

  if (!hint) return null

  return (
    <span className="fleet-chat-send-hint">
      {hint}
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
  agentNames,
  shapeId,
  editor,
  onClose,
  externalPillOver,
}: {
  filter: [string, string][][]
  agentNames: Record<string, string>
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
    const display = agentNames[label] || label.replace('fleet:', '')
    return (
      <span className={`fleet-filter-chip fleet-filter-chip-${role}${opts?.ghost ? ' fleet-filter-chip-ghost' : ''}`}>
        <span className="fleet-filter-chip-role">{role}:</span>
        <span className="fleet-filter-chip-label">{display}</span>
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
