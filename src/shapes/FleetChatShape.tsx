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
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext } from 'react'

import katex from 'katex'
import MarkdownIt from 'markdown-it'
// @ts-ignore — vanilla JS module
import { renderChatLine, esc } from '../fleet/chat-render.mjs'
// @ts-ignore — vanilla JS module
import { renderActivityGroup } from '../fleet/activity-render.mjs'
// @ts-ignore — vanilla JS module
import { highlightSyntax, langFromFilePath } from '../fleet/utils.mjs'
// @ts-ignore — vanilla JS module
// @ts-ignore — vanilla JS module
import { initVoice, setVoiceTarget, clearVoiceTarget, resetTranscript, toggleRecording, sendCurrentText } from '../voice.mjs'
// @ts-ignore — vanilla JS module
import { initTrackpad } from '../fleet/trackpad.mjs'
// @ts-ignore — vanilla JS module
import { isTldaUrl } from '../fleet/tldaUrl.mjs'
import { useFleetAgents, useFleetEvents, useFleetTasks, useFleetThinking, useFleetCompacting, sendMessage, loadBefore } from '../fleet-data-adapter'
import { dropPillOnTarget, chatInsertBus, filterDropPreview } from './FleetPillShape'
import { DocContext } from '../PanelContext'
import { loadLookup, type LookupData } from '../synctexLookup'
import { linkifyDocRefs, linkifyArrowRefs, buildRefResolver, refToCanvas, type DocRef, type ResolvedRef, type LabelRegionInfo } from '../docLinks'
import { appendToken } from '../authToken'
import { PDF_HEIGHT, PDF_WIDTH } from '../layoutConstants'
import './fleet-chat.css'

const DEFAULT_W = 400
const DEFAULT_H = 600
const FLEET_API = 'http://localhost:5199'

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

let _tldaEditor: any = null
initTrackpad({
  getEditor: () => _tldaEditor,
  onDoubleClick: () => toggleRecording(),
  onTripleClick: () => sendCurrentText(),
})


// --- Markdown renderer using markdown-it + KaTeX ---

const md = new MarkdownIt({ html: true, breaks: true, linkify: true })

// Wrap fenced code blocks with .code-block-wrap and a copy button (GitHub-style)
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const lang = token.info.trim()
  const code = token.content
  const langLabel = lang ? `<span class="code-block-lang">${lang}</span>` : ''
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<div class="code-block-wrap"><div class="code-block-header">${langLabel}<span class="code-block-copy" title="Copy">⎘</span></div><pre><code>${escaped}</code></pre></div>`
}

function tldaRenderMarkdown(escapedHtml: string): string {
  // Input is esc()'d — unescape for markdown-it
  let text = escapedHtml
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')

  // Strip system metadata tags
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')

  // KaTeX: display math $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false, strict: false })
    } catch { return `<div class="math-display">${esc(tex)}</div>` }
  })

  // KaTeX: inline math $...$
  text = text.replace(/(?<![\\$\w])\$([^$\n]+?)\$(?![\\$\w\d])/g, (_, tex) => {
    try {
      return katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false, strict: false })
    } catch { return `<span class="math-inline">${esc(tex)}</span>` }
  })

  // Render markdown
  let result = md.render(text)

  // Unwrap single <p> for inline chat layout
  const trimmed = result.trim()
  if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
    result = trimmed.slice(3, -4)
  }

  // Make links open in new tab
  result = result.replace(/<a(?![^>]*target=)([^>]*href=")/g, '<a target="_blank"$1')

  return result
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
    renderMarkdown: tldaRenderMarkdown,
    highlightSyntax,
    langFromFilePath,
    preambleMacros,
  }
}


function FleetChatComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  // Expose editor to trackpad input adapter
  _tldaEditor = editor
  const doc = useContext(DocContext)
  const { w, h, filter } = shape.props as { w: number; h: number; filter: [string, string][][] }
  void useValue('editing', () => editor.getEditingShapeId() === shape.id, [editor, shape.id])
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterOpenByPill, setFilterOpenByPill] = useState(false)


  // DNF filter: [[a,b],[c]] means (a AND b) OR c
  const dnfFilter = (filter.length > 0 ? filter : null) as string[][] | null

  // Load lookup data for doc reference resolution
  const [lookup, setLookup] = useState<LookupData | null>(null)
  const [labelRegions, setLabelRegions] = useState<Record<string, LabelRegionInfo>>({})
  useEffect(() => {
    if (!doc?.docName) return
    loadLookup(doc.docName).then(setLookup)
    // Load proof-info.json for label regions (arrow refs)
    const ws = (import.meta as any).env?.VITE_SYNC_SERVER as string | undefined
    const base = ws ? ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/' : (import.meta as any).env?.BASE_URL || '/'
    fetch(`${base}docs/${doc.docName}/proof-info.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.labelRegions) setLabelRegions(data.labelRegions)
      })
      .catch(() => {})
  }, [doc?.docName])

  const refResolver = useMemo(() => lookup ? buildRefResolver(lookup) : null, [lookup])

  // Live data from fleet-data.mjs via SSE (or playback data if inside a PlaybackFrame)
  const frameId = shape.parentId as string | undefined
  const agents = useFleetAgents(frameId)
  const liveEvents = useFleetEvents(dnfFilter, frameId)
  const tasks = useFleetTasks(frameId)
  const thinkingAgents = useFleetThinking(dnfFilter, frameId)
  const compactingAgents = useFleetCompacting(dnfFilter, frameId)
  const [olderEvents, setOlderEvents] = useState<any[]>([])

  // Input history (up/down arrow navigation like terminal)
  const sentHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)
  // Esc interrupt: track last Esc timestamp for soft/hard distinction
  const lastEscRef = useRef<number>(0)
  // Keep sendTargets accessible from native event listener without re-registering
  const sendTargetsRef = useRef<string[]>([])

  // Merge older (scrollback) events with live events
  const events = useMemo(() => {
    if (olderEvents.length === 0) return liveEvents
    // Deduplicate by _dbId or timestamp+from
    const seen = new Set(liveEvents.map((e: any) => e._dbId || `${e.timestamp}:${e.from}`))
    const unique = olderEvents.filter((e: any) => !seen.has(e._dbId || `${e.timestamp}:${e.from}`))
    return [...unique, ...liveEvents]
  }, [liveEvents, olderEvents])

  // Reset older events when filter changes
  const filterKey = JSON.stringify(filter)
  useEffect(() => { setOlderEvents([]) }, [filterKey])


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

  const chatMessages = useMemo(() => {
    const sorted = events
      .filter((m: any) => {
        const t = m.type
        return t === 'chat' || t === 'delegate' || t === 'task_done' || t === 'activity'
      })
      .filter((m: any) => !m._timer) // skip timer-fired messages
      .sort((a: any, b: any) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0
        return ta - tb
      })

    return sorted
  }, [events])


  const renderedHtml = useMemo(() => {
    // Group consecutive activity events from the same agent into cards
    const parts: string[] = []
    let activityGroup: any[] = []

    function flushActivity() {
      if (activityGroup.length === 0) return
      parts.push(
        `<div class="chat-activity-inline-wrap">${renderActivityGroup(activityGroup, ctx)}</div>`
      )
      activityGroup = []
    }

    for (const m of chatMessages) {
      if (m._activity) {
        // Continue grouping if same agent, otherwise flush and start new group
        if (activityGroup.length > 0 && activityGroup[0].from !== m.from) {
          flushActivity()
        }
        activityGroup.push(m)
      } else {
        flushActivity()
        const line = renderChatLine(m, ctx)
        if (line) parts.push(line)
      }
    }
    flushActivity()

    return parts.join('')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, ctx])

  // Post-process HTML to add clickable doc links
  const linkedHtml = useMemo(() => {
    let html = renderedHtml
    // Turn «type:label» reference tokens into chips BEFORE linkifyDocRefs
    // (otherwise "Theorem 3.2" inside a token gets wrapped in a doc-link span
    // and the regex can't match the original token)
    html = html.replace(/«(.+?)»/g, (_match, inner) => {
      const token = `«${inner}»`
      // Display: strip the "type:" prefix and any #uid suffix, show just the label
      const colonIdx = inner.indexOf(':')
      const typePrefix = colonIdx >= 0 ? inner.slice(0, colonIdx) : ''
      const display = (colonIdx >= 0 ? inner.slice(colonIdx + 1) : inner).replace(/#[^#»]+$/, '')
      // Extract embedded shape ID (format: «type:label#shape:xxx»)
      const shapeIdMatch = inner.match(/#(shape:[^»]+)$/)
      const embeddedShapeId = shapeIdMatch?.[1]
      let ref: any = undefined
      // For shape-backed chips, resolve metadata live from the tldraw store
      if (embeddedShapeId) {
        const srcShape = editor.getShape(embeddedShapeId as any) as any
        if (srcShape) {
          const highlightId = srcShape.props?.highlightId
          const highlight = highlightId ? editor.getShape(highlightId as any) as any : null
          const refShape = highlight || srcShape
          const refBounds = editor.getShapePageBounds(refShape.id)
          const anchor = highlight?.meta?.sourceAnchor || srcShape.meta?.sourceAnchor
          ref = {
            type: typePrefix || 'annotation',
            label: display,
            content: srcShape.props?.text || '',
            color: srcShape.props?.color,
            canvasBounds: refBounds ? { x: refBounds.x, y: refBounds.y, w: refBounds.w, h: refBounds.h } : undefined,
            shapeId: embeddedShapeId,
            highlightShapeId: highlight?.id,
            screenshotRef: refBounds ? `tlda-screenshot:page:page:${refBounds.x.toFixed(0)},${refBounds.y.toFixed(0)},${refBounds.w.toFixed(0)},${refBounds.h.toFixed(0)}` : undefined,
            file: anchor?.file,
            lineno: anchor?.line,
          }
        }
      }
      const displayEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const content = ref?.content || ''
      const contentEsc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const isAnnotation = ref?.type === 'annotation'
      const isImage = typePrefix === 'img'

      // Images render as block-level, not as chips
      if (isImage) {
        const uid = inner.split('#')[1] || ''
        const src = imageSrcs.get('asset:' + uid) || content
        if (src) {
          const nameEsc = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          return `<img src="${src}" alt="${nameEsc}" style="display:block;width:75%;max-width:100%;border-radius:4px;margin:4px 0;" />`
        }
        // Asset not yet loaded — render placeholder chip
        return `<span class="ref-chip ref-chip-image">${displayEsc}</span>`
      }

      const preview = !isAnnotation && content ? `<span class="ref-chip-preview">${contentEsc}</span>` : ''
      const colorDot = isAnnotation && ref?.color
        ? `<span class="ref-chip-dot" style="background:${ref.color}"></span>`
        : ''
      const locBadge = isAnnotation && ref?.file
        ? `<span class="ref-chip-loc">${ref.file.split('/').pop()}${ref.lineno ? ':' + ref.lineno : ''}</span>`
        : ''
      const boundsAttr = ref?.canvasBounds
        ? ` data-bounds="${ref.canvasBounds.x},${ref.canvasBounds.y},${ref.canvasBounds.w},${ref.canvasBounds.h}"`
        : ''
      const shapeAttr = ref?.shapeId ? ` data-shape-ref="${ref.shapeId}"` : ''
      const highlightAttr = isAnnotation && ref?.highlightShapeId ? ` data-highlight-ref="${ref.highlightShapeId}"` : ''
      const screenshotAttr = ref?.screenshotRef ? ` data-screenshot-ref="${ref.screenshotRef}"` : ''
      const cls = isAnnotation ? 'ref-chip ref-chip-annotation' : 'ref-chip'
      const tokenAttr = ` data-token="${token.replace(/"/g, '&quot;')}"`

      return `<span class="${cls}"${tokenAttr}${boundsAttr}${shapeAttr}${highlightAttr}${screenshotAttr}>${colorDot}${displayEsc}${locBadge}${preview}</span>`
    })
    // Convert tlda URLs (with ?doc=) to tlda-card widgets.
    // Handles both raw URLs and already-linkified <a href="..."> anchors.
    html = html.replace(
      /<a\s[^>]*href="(https?:\/\/[^"]*\?[^"]*\bdoc=([^"&\s]+)[^"]*)"[^>]*>[^<]*<\/a>/g,
      (_match, url, docName) => {
        if (!isTldaUrl(url)) return _match
        const safeDoc = decodeURIComponent(docName).replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const id = 'tlda-' + btoa(url).slice(0, 16)
        // Add embed=1 then append auth token
        const embedUrl = url.includes('embed=') ? url : url + (url.includes('?') ? '&' : '?') + 'embed=1'
        const iframeSrc = appendToken(embedUrl).replace(/"/g, '&quot;')
        const openUrl = url.replace(/"/g, '&quot;')
        return `<div class="tlda-card" data-tlda-src="${openUrl}" data-tlda-id="${id}"><div class="tlda-card-header"><span class="doc-name">${safeDoc}</span><a href="${openUrl}" target="_blank" class="doc-open-link">open ↗</a></div><iframe src="${iframeSrc}" style="width:75%;height:auto;aspect-ratio:8.5/11;border:none;display:block;margin:0 auto" loading="lazy"></iframe></div>`
      }
    )
    // Process [->ref] arrow links BEFORE auto-detection (linkifyDocRefs)
    // so that [->Theorem 3.2] is consumed before "Theorem 3.2" gets auto-linked
    if (doc && Object.keys(labelRegions).length > 0) {
      html = linkifyArrowRefs(html, labelRegions)
    }
    if (doc) html = linkifyDocRefs(html)
    return html
  }, [renderedHtml, doc, labelRegions, imageSrcs, editor])

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
    // Also check for annotation chip clicks
    const chipTarget = (e.target as HTMLElement).closest('.ref-chip-annotation')
    if (chipTarget) { handleRefChipClick(e); return }

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
    editor.centerOnPoint(canvasPos, { animation: { duration: 300 } })
  }, [doc, refResolver, editor])

  // Hover preview for doc-link spans
  const shapeContainerRef = useRef<HTMLDivElement>(null)
  const [docLinkHover, setDocLinkHover] = useState<{
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
      // Skip unresolved arrow refs
      if (target.classList.contains('doc-link-unresolved')) return

      // Debounce slightly to avoid flicker
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(() => {
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

        // Convert screen coords → shape-local coords
        const containerEl = shapeContainerRef.current
        if (!containerEl) return
        const containerRect = containerEl.getBoundingClientRect()
        const anchorRect = target.getBoundingClientRect()
        const zoom = containerRect.width / w  // screen px per local px
        const localX = (anchorRect.left - containerRect.left) / zoom
        const localY = (anchorRect.top - containerRect.top) / zoom
        const localW = anchorRect.width / zoom

        setDocLinkHover({ resolved, localX, localY, localW, text: target.textContent || '' })
      }, 150)
    }

    function onMouseOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.doc-link')) return
      const related = e.relatedTarget as HTMLElement | null
      if (related?.closest('.doc-link-preview')) return
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      setDocLinkHover(null)
    }

    logEl.addEventListener('mouseover', onMouseOver)
    logEl.addEventListener('mouseout', onMouseOut)
    return () => {
      logEl.removeEventListener('mouseover', onMouseOver)
      logEl.removeEventListener('mouseout', onMouseOut)
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    }
  }, [doc, refResolver, w])

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
      const chip = (e.target as HTMLElement).closest('.ref-chip-annotation') as HTMLElement | null
      if (!chip) return
      if (annotationHoverTimerRef.current) clearTimeout(annotationHoverTimerRef.current)
      annotationHoverTimerRef.current = setTimeout(() => {
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
      }, 100)
    }

    function onAnnotationOut(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('.ref-chip-annotation')) return
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

  // Auto-scroll to bottom on new messages — only if user was already at bottom
  const prevScrollHeight = useRef(0)
  useEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    const onScroll = () => { prevScrollHeight.current = el.scrollHeight }
    prevScrollHeight.current = el.scrollHeight
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = chatLogRef.current
    if (!el) return
    const wasAtBottom = el.scrollTop + el.clientHeight >= prevScrollHeight.current - 30
    if (wasAtBottom) el.scrollTop = el.scrollHeight
  }, [linkedHtml])

  // After images inside the log load, they expand the scroll height. Scroll to
  // bottom if we were close enough that we should follow new content.
  useEffect(() => {
    const logEl = chatLogRef.current
    if (!logEl) return
    function onImgLoad(e: Event) {
      if ((e.target as HTMLElement).tagName !== 'IMG') return
      const el = logEl!
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
        el.scrollTop = el.scrollHeight
      }
    }
    logEl.addEventListener('load', onImgLoad, true)
    return () => logEl.removeEventListener('load', onImgLoad, true)
  }, [])

  // Esc interrupt via native listener — TLDraw's capture-phase stopPropagation blocks React
  // synthetic keydown for Escape, so we attach directly at the target element.
  useEffect(() => {
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta) return
    function onEscKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (ta!.value !== '') return
      const targets = sendTargetsRef.current
      if (targets.length === 0) return
      e.preventDefault()
      const now = Date.now()
      const agent = targets[0]
      if (now - lastEscRef.current < 500) {
        // Hard interrupt: Esc twice within 500ms
        lastEscRef.current = 0
        fetch(`${FLEET_API}/api/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) })
      } else {
        // Soft interrupt: single Esc
        lastEscRef.current = now
        fetch(`${FLEET_API}/api/send-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, key: 'Escape' }) })
      }
    }
    ta.addEventListener('keydown', onEscKey)
    return () => ta.removeEventListener('keydown', onEscKey)
  }, [])

  // When textarea grows (multi-line input), keep chat scrolled to bottom
  useEffect(() => {
    const ta = inputRef.current as HTMLTextAreaElement | null
    if (!ta) return
    let prevHeight = ta.offsetHeight
    const ro = new ResizeObserver(() => {
      const newHeight = ta.offsetHeight
      if (newHeight > prevHeight && chatLogRef.current) {
        chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight
      }
      prevHeight = newHeight
    })
    ro.observe(ta)
    return () => ro.disconnect()
  }, [])

  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      if (a.id) map[a.id] = a.friendly_name || (a.id || '').replace('fleet:', '')
    }
    map['fleet:skip'] = 'skip'
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

  // Derive a loadBefore agent: use first agent in filter
  const loadBeforeAgent = sendTargets[0] ?? undefined

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

      // When the shape is selected in tldraw (handles visible), let tldraw handle
      // the pointer so the user can drag the whole shape to move/resize it.
      if (isSelectedRef.current) return

      const names = agentNamesRef.current

      // Only intercept on draggable elements
      const isDraggable = target.closest('.chat-nick span[class*="nick-"], .chat-ts, .chat-activity-card, .code-block-header, .tool-ref, .md-file-card, .ref-chip[data-doc], .tlda-card, .ref-chip-annotation, .ref-chip:not(.ref-chip-annotation)')
      if (!isDraggable) return

      let drag: typeof dragRef.current = null

      // Agent name
      const nickSpan = target.closest('.chat-nick span[class*="nick-"]') as HTMLElement
      if (nickSpan) {
        const line = nickSpan.closest('.chat-line') as HTMLElement
        const agentId = line?.dataset.msgFrom
        if (agentId) {
          drag = {
            pillId: null, pillType: 'agent', value: agentId,
            displayName: nickSpan.textContent?.replace(/:$/, '') || agentId,
            color: '#7a9ec8', startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      // Timestamp → message reference
      if (!drag) {
        const tsEl = target.closest('.chat-ts') as HTMLElement
        if (tsEl) {
          const line = tsEl.closest('.chat-line') as HTMLElement
          if (line) {
            const from = line.dataset.msgFrom || ''
            const ts = line.dataset.msgTs || ''
            const text = line.textContent?.slice(0, 200)?.trim() || ''
            const nick = names[from] || from.replace('fleet:', '')
            drag = {
              pillId: null, pillType: 'msg', value: `msg:${from}:${ts}`,
              displayName: `${nick} ${tsEl.textContent || ''}`.trim(),
              color: '#8888a0', content: text,
              startX: e.clientX, startY: e.clientY,
              started: false, captureEl: logEl, pointerId: e.pointerId,
            }
          }
        }
      }

      // Activity card
      if (!drag) {
        const actCard = target.closest('.chat-activity-card') as HTMLElement
        if (actCard) {
          const agentId = actCard.dataset.agent || ''
          const ts = actCard.dataset.ts || ''
          const text = actCard.textContent?.slice(0, 300)?.trim() || ''
          const nick = names[agentId] || agentId.replace('fleet:', '')
          drag = {
            pillId: null, pillType: 'activity', value: `activity:${agentId}:${ts}`,
            displayName: `${nick} activity`,
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
          const name = mdCard.querySelector('.md-file-chip')?.textContent || mdCard.textContent?.trim() || filePath.split('/').pop() || 'file'
          drag = {
            pillId: null, pillType: 'doc' as any, value: `file:${filePath}`,
            displayName: name, color: '#9370db', content: filePath,
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
          const clone = fileChip.cloneNode(true) as HTMLElement
          clone.querySelectorAll('.ref-chip-preview').forEach(el => el.remove())
          const label = clone.textContent?.trim() || 'file'
          drag = {
            pillId: null, pillType: 'file' as any, value: token,
            displayName: label, color: '#9370db',
            content: label,
            startX: e.clientX, startY: e.clientY,
            started: false, captureEl: logEl, pointerId: e.pointerId,
          }
        }
      }

      if (!drag) return

      e.stopImmediatePropagation()
      e.preventDefault()
      dragRef.current = drag

      document.addEventListener('pointermove', onPointerMove, { capture: true })
      document.addEventListener('pointerup', onPointerUp, { capture: true })
    }

    function onPointerMove(e: PointerEvent) {
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
      e.preventDefault()
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
      document.removeEventListener('pointermove', onPointerMove, { capture: true })
      document.removeEventListener('pointerup', onPointerUp, { capture: true })
      const drag = dragRef.current
      if (!drag) return
      e.stopImmediatePropagation()
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
      // Also clean up move/up in case they were left attached (e.g. unmount during drag)
      document.removeEventListener('pointermove', onPointerMove, { capture: true })
      document.removeEventListener('pointerup', onPointerUp, { capture: true })
    }
  }, [editor])

  // --- chatInsertBus listener: content drops insert into textarea ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { chatId, text } = (e as CustomEvent).detail
      if (chatId !== shape.id) return
      const ta = inputRef.current as HTMLTextAreaElement | null
      if (!ta) return
      const pos = ta.selectionStart ?? ta.value.length
      const before = ta.value.slice(0, pos)
      const after = ta.value.slice(pos)
      const insert = (before && !before.endsWith('\n') ? '\n' : '') + text + (after && !after.startsWith('\n') ? '\n' : '')
      ta.value = before + insert + after
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
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

        {/* Messages */}
        <div
          ref={chatLogRef}
          className="fleet-chat-log"
          style={{
            flex: 1,
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
              opacity: 0.3,
              textAlign: 'center',
              fontSize: 10,
            }}>
              {filter.length > 0 ? 'No messages' : 'No filter set'}
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: linkedHtml }} />
          )}
          {[...thinkingAgents.entries()].map(([agentId, startTs]) => (
              <div key={agentId} className="chat-line chat-thinking">
                <span className={ctx.getNickClass(agentId)}>{ctx.agentLabel(agentId)}</span>
                {' '}<span className="thinking-text">thinking…</span>
                {' '}<ElapsedTime startMs={startTs} />
              </div>
            ))}
          {[...compactingAgents.entries()].map(([agentId, startTs]) => (
              <div key={`compact-${agentId}`} className="chat-line chat-thinking">
                <span className={ctx.getNickClass(agentId)}>{ctx.agentLabel(agentId)}</span>
                {' '}<span className="thinking-text">compacting…</span>
                {' '}<ElapsedTime startMs={startTs} />
              </div>
            ))}
        </div>

        {/* Doc-link hover preview — positioned relative to shape container */}
        {docLinkHover && doc && (
          <DocLinkPreview
            resolved={docLinkHover.resolved}
            localX={docLinkHover.localX}
            localY={docLinkHover.localY}
            text={docLinkHover.text}
            docName={doc.docName}
            shapeW={w}
            onDismiss={() => setDocLinkHover(null)}
          />
        )}

        {/* Input */}
        <div
          className="fleet-chat-input-area"
          style={{
            borderTop: '1px solid rgba(128, 128, 128, 0.15)',
            padding: 4,
            flexShrink: 0,
            position: 'relative',
          }}
        >
          <SendHint
            filter={filter}
            sendTargets={sendTargets}
            agentNames={agentNames}
            inputRef={inputRef}
          />
          <div style={{ position: 'relative' }}>
            {/* Highlight underlay — mirrors textarea text, highlights <<ref>> tokens */}
            <InputHighlightUnderlay inputRef={inputRef} />
            <textarea
              ref={inputRef as any}
              placeholder={sendTargets.length > 0 ? `→ ${sendTargets.map(t => agentNames[t] || t.replace('fleet:', '')).join(', ')}` : ''}
              rows={1}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                stopEventPropagation(e)
                const ta = e.currentTarget
                if (e.key === 'ArrowUp') {
                  const history = sentHistoryRef.current
                  if (history.length === 0) return
                  if (historyIndexRef.current === -1 && ta.value !== '') return
                  e.preventDefault()
                  const nextIdx = historyIndexRef.current + 1
                  if (nextIdx < history.length) {
                    historyIndexRef.current = nextIdx
                    ta.value = history[history.length - 1 - nextIdx]
                    ta.style.height = 'auto'
                    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
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
                    ta.style.height = 'auto'
                  } else {
                    const history = sentHistoryRef.current
                    ta.value = history[history.length - 1 - nextIdx]
                    ta.style.height = 'auto'
                    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
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
                  // Get text before cursor on current line
                  const before = val.substring(0, ta.selectionStart || val.length)
                  const lastNewline = before.lastIndexOf('\n')
                  const lineText = before.substring(lastNewline + 1)

                  if (lineText.trim() === '') {
                    // Blank line (double-enter) = send
                    e.preventDefault()
                    const text = val.trim()
                    if (text && sendTargets.length > 0) {
                      for (const t of sendTargets) sendMessage(t, text, {})
                      sentHistoryRef.current = [...sentHistoryRef.current, text]
                      historyIndexRef.current = -1
                      ta.value = ''
                      ta.style.height = 'auto'
                      resetTranscript()
                    }
                  } else if (lineText.endsWith(' ')) {
                    // Trailing space = newline (let default happen)
                    return
                  } else {
                    // Non-blank, no trailing space = send
                    e.preventDefault()
                    const text = val.trim()
                    if (text && sendTargets.length > 0) {
                      for (const t of sendTargets) sendMessage(t, text, {})
                      sentHistoryRef.current = [...sentHistoryRef.current, text]
                      historyIndexRef.current = -1
                      ta.value = ''
                      ta.style.height = 'auto'
                      resetTranscript()
                    }
                  }
                }
              }}
              onInput={(e) => {
                // Auto-resize
                const ta = e.currentTarget
                ta.style.height = 'auto'
                ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
              }}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                // Register voice target on pointerdown — onFocus can be unreliable in tldraw
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, (targets: string[], text: string) => {
                  for (const t of targets) sendMessage(t, text)
                }, sendTargets.length > 0 ? ctx.getAgentColor(sendTargets[0]) : undefined)
              }}
              onFocus={(e) => {
                stopEventPropagation(e)
                setVoiceTarget(e.currentTarget, sendTargets, agentNames, (targets: string[], text: string) => {
                  for (const t of targets) sendMessage(t, text)
                }, sendTargets.length > 0 ? ctx.getAgentColor(sendTargets[0]) : undefined)
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
              }}
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

/** Floating preview panel — shows a clipped SVG region on doc-link hover */
function DocLinkPreview({
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
  const svgUrl = `${base}docs/${docName}/page-${resolved.page}.svg`

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
    } else {
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.replacePreview = null
      filterDropPreview.activePaneRole = null
    }
    return () => {
      filterDropPreview.shapeId = null
      filterDropPreview.toPreview = null
      filterDropPreview.fromPreview = null
      filterDropPreview.replacePreview = null
      filterDropPreview.activePaneRole = null
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
